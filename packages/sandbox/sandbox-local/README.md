---
description: "Local per-platform sandbox backends for users and maintainers choosing, configuring, or debugging process confinement on Linux, macOS, or Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-local

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-local` confines commands and their descendants on Linux, macOS, and Windows while sharing the host kernel and filesystem. It chooses a supported platform runner automatically and fails with `SANDBOX_UNAVAILABLE` when none is usable, so commands never silently run without confinement. Each execution reports `full` or `partial` enforcement plus denial and runner-failure signatures, allowing callers to distinguish an unavailable or broken sandbox from a policy denial. Choose it for host-local bash or pwsh execution; use a container or remote executor when the process needs an isolated environment.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider behind `ctx.sandbox` and a confined executor, and every command the executor spawns runs confined under the policy you resolve. The shipped [base bundle](../../bundle/base/cordis.patch.yml) owns the default policy and executor wiring.

### When to choose it

Choose it when commands must run confined on the host: it is the default backend for Linux, macOS, and Windows compositions that mount `ctx.sandbox`. Choose a different mechanism when the process must run in an isolated environment — a container or remote executor replaces whole capabilities, and this provider shares the host kernel and filesystem.

### Minimal configuration

Load the sandbox service and mount the provider; the defaults below are the selection policy.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

| Field | Default | Meaning |
|---|---|---|
| `runnerCommand` | `[]` | Custom runner argv; bwrap-compatible profile arguments are appended, full enforcement is asserted, and built-in selection and probes are skipped |
| `runnerFailureSignatures` | `[]` | Case-insensitive stderr substrings identifying the custom runner's own failure dialect; required with `runnerCommand` |
| `probeTimeoutMs` | `5,000` | Timeout for each functional probe of a competing runner candidate |
| `protectedHome` | none | Absolute path of an existing directory, such as the harness home, that confined commands cannot write or read; a `workspace-write` root that overlaps it is refused with `HOME_IN_WRITABLE_ROOT` |
| `protectedHomeReadable` | `[]` | Paths under `protectedHome`, relative to it, that confined commands may still read and execute; requires `protectedHome` |
| `deniedSockets` | `[]` | Absolute Unix socket paths that confined commands cannot connect to, on runners that express the rule |
| `deniedSocketDirectories` | `[]` | Absolute directories that hold only sockets confined commands cannot connect to, such as Docker Desktop's control sockets; bwrap hides each directory, Seatbelt denies each socket present at the wrap |
| `escapeSocketDirectories` | `[]` | Absolute directories whose sockets start programs outside every confinement, such as WSL's interop directory `/run/WSL`. Each is denied like a `deniedSocketDirectories` entry, and while one exists a wrap on a runner that cannot deny socket connects (Landlock, windows-acl) refuses with `SANDBOX_UNSUPPORTED_POLICY` instead of running the command, and bwrap installs the [escape filter](#escape-socket-directories). An entry that does not exist at a wrap denies, filters and refuses nothing. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-local) is the exhaustive source for every accepted field and its JSDoc.

### Confined execution and enforcement

With the provider mounted, a command runs under the mode you resolve per call. Enforcement is a reported fact, not a promise: `full` means the backend governs every promised file effect, while `partial` means it governs only a subset — the Windows ACL rung (hard-link, unconfined-read, and AppContainer-ACL boundaries) and older Landlock ABIs are the current partial cases, so a consumer that requires an absolute boundary can reject or surface them. Denied file effects surface through the backend's denial dialect, and a runner that fails before executing the command reports a structured runner-failure signature.

### Failures and recovery

An unsupported platform or an unusable runner fails closed: `confine()` rejects with `SANDBOX_UNAVAILABLE` and names the runner options for the platform, and the consumer surfaces that error rather than running the command unconfined. A runner that starts but refuses its profile is identified by its fatal stderr signature and exit code, so a broken sandbox is not mistaken for a denied command. The `runnerCommand` override is an operator assertion: it skips functional probes and assumes the configured runner implements the bwrap-compatible profile honestly.

Seatbelt, bwrap, and Landlock include the policy's explicit `additionalWritableRoots` under `workspace-write`. Read-only ignores those grants. Invalid extra directories raise `SANDBOX_INVALID_ROOT` before the command starts.

### Protected home and denied sockets

With `protectedHome` set, confined commands cannot create, change or delete anything under that directory and, on runners that confine reads, cannot read anything under it except its `protectedHomeReadable` entries. A `workspace-write` call whose workspace root or extra root equals, lies inside or contains the home fails with `HOME_IN_WRITABLE_ROOT` before the command starts; read-only calls in such a workspace still run. With `deniedSockets` set, confined commands cannot connect to those sockets on runners that express the rule, while other Unix sockets and the network stay reachable. Without these fields every profile is the stock one. At each wrap the provider also finds the other paths that reach the home or a denied socket — other mounts of the same filesystem on Linux, read from `/proc/self/mountinfo` and confirmed by device and inode, and the Data-volume firmlink spelling on macOS — and protects each like the original. Where the home or a denied socket lies on btrfs, bcachefs or overlayfs, or the mount table does not list its device, those other mounts cannot be found: `aliasCoverage()` on the provider, and `pathAliasCoverage(path)` for any path, report `unknown` so a consumer does not report the home and socket rules as enforced. A readable entry that leads elsewhere inside the home or above it is dropped, and a denied socket inside a readable entry is refused at load.

| Rule | bwrap | Landlock | Seatbelt | Windows ACL |
|---|---|---|---|---|
| Write under the home | Denied: an empty tmpfs over the home and each alias, remounted read-only | Denied: no write grant under the home | Denied: `deny file-write*` on the home after the write allows | Denied: the Low-integrity token writes granted roots only |
| Read under the home | Denied, with readable entries bound read-only | Denied: reads are granted only beside the way to the home, leaving out each other mount that reaches it whole, by resolved paths the launcher opens without following links, plus readable entries | Denied: `deny file-read*`, `file-link` and `file-clone` on the home and its firmlink spelling, readable entries allowed | Not confined |
| Connect to a denied socket | Denied: `/dev/null` bound over the socket's resolved path and each mount alias, never its directory | Not expressed | Denied: `remote unix-socket` path literals of each spelling | Not expressed |

`RUNNER_PROTECTION` exports this table as booleans per runner, so a consumer can report which rules the selected runner does not enforce. The provider also reports the canonical home as `ctx.sandbox.protectedHome`, which the [filesystem fence](../../fs/fs-sandbox/README.md) reads to refuse writes under it.

A consumer passes absolute paths: the home, the entries under it that commands still need, relative to it, and every socket commands must not reach, with a socket's configured path and its real path when they differ. For a home at `/home/me/.delo` whose processes listen on two channel sockets, with a rootful Docker engine:

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  config:
    protectedHome: /home/me/.delo
    protectedHomeReadable: [runtimes, skills, dsh-runtimes]
    deniedSockets:
      - /home/me/.delo/run/default/update.sock
      - /home/me/.delo/run/default/supervisor.sock
      - /var/run/docker.sock
      - /run/docker.sock
    deniedSocketDirectories:
      - /mnt/wsl/docker-desktop/shared-sockets/host-services
      - /mnt/wsl/docker-desktop/shared-sockets/guest-services
```

The two socket directories are Docker Desktop's under WSL; `host-services/backend.sock` there is world-writable and controls the engine. With Docker Desktop on Linux the directory is `~/.docker/desktop`, and on macOS `~/Library/Containers/com.docker.docker/Data` and `~/.docker/run`, as absolute paths.

<a id="escape-socket-directories"></a>
### Escape socket directories

An `escapeSocketDirectories` entry names a directory whose sockets start programs outside every confinement, such as WSL's interop directory `/run/WSL`. At each wrap the provider checks whether one exists. While one does, bwrap hides it like a denied socket directory and starts under a seccomp filter, and Landlock and the Windows ACL runner refuse the wrap with `SANDBOX_UNSUPPORTED_POLICY`. Where none exists, every profile is unchanged.

The filter is for the host such a directory belongs to: WSL also offers a virtual-machine (`AF_VSOCK`) transport to Windows, which no mount rule hides. It refuses `socket(AF_VSOCK, …)` with `EAFNOSUPPORT` and `io_uring_setup` with `ENOSYS`, because an io_uring request creates a socket without the `socket` call. It covers x86-64 (with x32 numbering), i386, AArch64 and 32-bit Arm, and allows every other call. A 32-bit process that creates a socket through `socketcall` is refused for every family, because the filter cannot read that call's arguments. The program is written instruction by instruction in [`src/seccomp.ts`](src/seccomp.ts). bwrap reads it from descriptor 3, so the wrap starts bwrap from `/bin/sh`, which writes the program into a pipe with its `printf` builtin and keeps the command's standard input and exit status. A kernel that refuses the filter makes bwrap exit with its own `bwrap:` diagnostic before the command runs, which consumers classify as a runner failure. A configured `runnerCommand` gets neither the filter nor the refusal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains runner selection, the per-platform profiles, and the failure dialects; the observable behavior is fully covered in [Use this package](#use-this-package).

### Runner selection

Selection is by platform first, probes second: each platform has a runner chain (`linux`: `bwrap` then Landlock; `darwin`: Seatbelt; `win32`: the ACL restricted-token runner). A sole candidate is selected without a probe; competing candidates are functionally probed once in chain order, and the first usable verdict is cached for the provider's lifetime. A platform with no chain, or a chain where every probe fails, is unavailable and fails closed at `confine()`.

### Platform profiles

The bwrap profile combines a read-only host root, a fresh `/dev`, and `/proc` from a private PID namespace — commands manage their descendants but cannot see host processes, so procfs magic links cannot bypass the mounts; `workspace-write` adds an ephemeral `/tmp` and writable binds for the workspace and each explicit extra root. The [historical private-PID note](../../../.agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.md) records the boundary.

The `@deepseek-ai/node-addon-system/landlock-run` API supplies the platform launcher, functional probe, and grant vocabulary; this provider maps mode to grants only, keeping path resolution and probe parsing with the versioned binary.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists derived from the shared `writableRoots` helper, so exactly the mode's promised file effects are governed; every root is canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`).

The Windows rung keeps one deterministic write SID and standing ACE per workspace, while every live session/workspace pair gets a random private temp directory with a distinct SID and revocable ACE — sessions sharing a workspace share its intended write authority without inheriting one another's temp authority. A fresh provider always chooses a new temp path and SID, so crash residue cannot block or authorize a resumed session. The rung reports `partial` enforcement because NTFS hard links alias one file object across paths, reads stay unconfined, and a tree another AppContainer tool has ACL'd with a package SID is unreadable to the Low-integrity child.

With the built-in Windows runner and a skill registry, this provider registers the [ACL diagnosis skill](../sandbox-windows-acl/README.md#failures-and-recovery). An operator-supplied `runnerCommand` does not register it; provider disposal removes the skill and its extracted resources.

When the built ACL runner is absent, source launch pins the `tsx/esm/api` loader and TypeScript path mapping to this installation. The command's working directory and ambient `TSX_TSCONFIG_PATH` cannot select the runner's source dependencies.

### Denial and runner-failure dialects

Each runner's kernel speaks its own denial dialect, carried on every wrap as `denialSignatures`, and `runnerFailureRules` give each runner's fatal signature, so consumers classify a runner refusal before checking denial signatures. The exact strings and exit codes live in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: runner chain selection, functional probes, per-call wrap, ACL grant lifecycle |
| [`src/profiles.ts`](src/profiles.ts) | Per-platform profile builders: bwrap mounts, Landlock grants, Seatbelt SBPL, and each runner's protected-home rules |
| [`src/mounts.ts`](src/mounts.ts) | Mount aliases from `/proc/self/mountinfo` and macOS firmlink spellings of the protected paths |
| [`src/seccomp.ts`](src/seccomp.ts) | The escape filter's BPF program and the shell loader that hands it to bwrap |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract, the consumers, and the win32 rung.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and classification dialects.
- [Sandbox seam package](../sandbox/README.md) — the service contract this provider implements.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined bash consumer.
- [Windows ACL restricted-token rung](../sandbox-windows-acl/README.md) — the win32 backend this provider mounts.
- [The historical subprocess sandbox decision](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md) — capability boundary and runner selection semantics.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this provider's enforcement and denial facts, while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and this provider owns runner selection, and profiles stay outside context.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general platform comparison or a task backlog.

- **Windows extra roots** — Windows ACL rejects every workspace-write subprocess carrying extra directories with `SANDBOX_UNSUPPORTED_POLICY`, before grants or child creation. Filesystem tools can enforce these grants independently. Remove the extra grants or use a supported host for process operations.
- **Windows ACL enforcement is partial** — NTFS hard links alias one file object across workspace and external paths, reads stay unconfined, and a tree another AppContainer tool has ACL'd with a package SID is unreadable to the Low-integrity child. The provider reports `enforcement: 'partial'` rather than overstating that boundary as full.
- **Landlock may be partial** — older supported kernel ABIs confine only the access classes they expose, reported as `enforcement: 'partial'` rather than overstated as full.
- **Seatbelt depends on deprecated `sandbox-exec`** — macOS still ships it, but this provider cannot replace or probe that private policy engine if Apple removes it.
- **The protected home under Landlock** — Landlock grants reads by directory tree, so each wrap lists the directories on the way from `/` to the home and grants their other entries: those directories cannot be listed, an entry created in them after the wrap is unreadable, and an entry removed between the wrap and the launch makes the launcher refuse the run. A consumer that sees that runner failure retries the wrap once before reporting it. Landlock has no right for connecting to a pathname socket, so denied sockets and sockets under the home stay reachable there.
- **Socket and alias coverage** — bwrap shadows a denied socket only when it exists at the wrap, and Seatbelt denies only the listed socket paths. Aliases on btrfs, bcachefs and overlayfs may go unfound (reported as `unknown`), and a filesystem that mirrors the home under another device, such as a FUSE mirror, is not detected. Aliases are found at each wrap, so a mount added while a command runs is not covered, and no runner covers a hard link made outside the sandbox to a file under the home, nor a bind mount of a home file that was deleted or replaced since, which still reaches its old contents.
- **Sockets recreated after a wrap** — bwrap binds `/dev/null` over the socket file that exists at the wrap; a socket removed and created again at that path, such as after a Docker engine restart, is reachable from commands wrapped before. A consumer that keeps confined commands running for long, such as a terminal or a background job, must rewrap or stop them when a denied socket is recreated.
- **Abstract Unix sockets** — no runner denies a connect to an abstract-namespace socket: the address lies in memory a seccomp filter cannot read, and hiding them would need a network namespace, which also removes network access. A program that listens on one is reachable from confined commands, with an escape directory or without.
- **Runner selection is cached for the provider lifetime** — installing, removing, or repairing a runner requires reloading the plugin before selection changes.
- **`runnerCommand` is an operator assertion** — a configured custom runner skips functional probes and is assumed to implement the bwrap-compatible profile honestly; if it is itself a Bash script, its interpreter startup runs before that script applies confinement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: environment-coherent groups

An environment-coherent capability group example, such as bash plus fs against one container, remains undecided.

</details>
