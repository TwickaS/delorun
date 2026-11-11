---
description: "Design of native confinement on every command and platform: Delo's protections under every way a Host boots, the per-start probes and the confinement and home-mode checks of delorun verify, the full-access prompt's wording, Docker Desktop's control sockets, Windows, and model-authored writes to instruction files through commands."
---

# Native confinement on every command and platform

English

## Summary

[Contract C1](../contracts/c01-home-layout.md) states the confinement rules Delo adds to upstream's sandbox and what each dialect enforces today. This page holds the rules Delo has adopted for confinement that are not built: the same protections under every command that boots a Host, a check at each start that each rule holds on the machine, the full-access prompt that names what full access reaches, Docker Desktop's control sockets, Windows, and the instruction consent for writes that commands make. The [threat model](../security/threat-model.md) states what holds today.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- Only the CLI profile, which `delorun setup` creates and `delorun` or `delorun start` boots, carries Delo's protections: the protected home on upstream's sandbox row, the denied sockets that `delorun start` writes to `run/<profile>/sandbox.patch.yml`, the consents, the fetch guard and the privacy defaults ([bundle-local](../../packages/bundle-local/README.md)).
- `delorun plugin` runs upstream's own pnpm operation. `delorun headless` boots the home's `headless` profile under the sandbox overlay with `@delo/bundle-headless`, so its confined commands get the CLI profile's rules, the fetch guard, the instruction write, MCP and schedule consents, the full-access consent and the privacy defaults apply, and the composition refuses a `headless` profile without the bundle.
- bwrap, Landlock and Seatbelt deny confined commands writes under the home and reads under it except `runtimes/`, `skills/` and `dsh-runtimes/`. bwrap and Seatbelt deny connections to the update channel's socket and to the Docker context's socket at its path and its real path; Landlock cannot express a socket rule.
- windows-acl confines writes only. It does not confine reads, adds no socket or pipe rule, and the home's mode checks are skipped on Windows. The update channel is a filesystem socket on every platform; no named pipe exists.
- `delorun start` runs no confinement probe. `delorun verify` reports the `confinement-rule` and `home-modes` checks as not run.
- The prompt for full access is upstream's per-call approval prompt, which names the requested mode and the operation and does not name Delo's home. The per-workspace full-access consent of [`@delo/plugin-permission-defaults`](../../packages/plugin-permission-defaults/README.md) has no surface that asks it, so a switch of a workspace's preset to full access is always refused.
- The instruction consent reviews writes that the file tools make. A shell command or PTC code under `workspace-write` writes an `AGENTS.md`, a skill or a preset inside a writable root without that review.
- The sandbox provider can hide whole socket directories (`deniedSocketDirectories`), and `delorun start` does not pass Docker Desktop's control-socket directories to it.

## The rules

### Every way a Host boots

1. Every `delorun` command that boots a Host, `delorun headless` included, composes the same Delo layer as the CLI profile, or refuses to start and names what is missing. A Host that boots without the protected home, the denied sockets, the consents, the fetch guard and the privacy defaults is a failed start, not a warning.

### Checks at each start

2. At each start the home process runs one confined probe per rule (`home-write`, `home-read`, `token-read`, `home-connect`, `docker-connect`) against fixtures in `run/<profile>/probe/`, against a socket it opens there and against the Docker socket path. On Linux the read and connect probes also run through each other mount of the home's filesystem and of the Docker socket, and a rule is `enforced` only when every probe is refused.
3. `delorun verify` reports each rule through the `confinement-rule` check of [C15](../contracts/c15-verification-checks.md): `enforced` (`pass`) only when the dialect expresses the rule and its probe was refused at this start; `not-enforced` when the dialect cannot express it, the endpoint is a network endpoint or the platform has no proving test; `unconfined` (`fail`) when no sandbox runs or the mode is `danger-full-access`; `unknown` when the probe did not run or alias coverage is unknown.
4. `delorun verify` runs the `home-modes` check: the modes of the home, of each Delo directory and of each protected file, with the `chmod` fix, or on Windows the `icacls` fix, for each laxer path.
5. When `docker-connect` is not `enforced`, `delorun verify` says so with the socket's path, and setup's Docker option states that commands in native workspaces can connect to Docker, which can start containers with this computer's files mounted. With Landlock and a rootful engine, setup offers Docker's rootless engine.

### Full access

6. The approval prompt for a `danger-full-access` escalation, whether a command requests it or the person sets the mode, states before the person answers: "Full access lets this command read Delo's home, including its keys and tokens, and reach the Docker supervisor and the update channel." The prompt is shown to the person and is not model-visible.
7. The per-workspace full-access consent has a surface that asks it, so a person can grant full access for one workspace and withdraw it.

### Docker Desktop's control sockets

8. `delorun start` passes Docker Desktop's control-socket directories as denied socket directories: under WSL `/mnt/wsl/docker-desktop/shared-sockets/host-services/` and `/mnt/wsl/docker-desktop/shared-sockets/guest-services/`, on Linux `~/.docker/desktop/`, and on macOS `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/`.

### Windows

9. A protected file or directory whose DACL allows any SID other than the person's, `SYSTEM` or `BUILTIN\Administrators` is refused with `SECRET_FILE_MODE` or `HOME_MODE`, with the `icacls` fix.
10. The channels are the named pipes `\\.\pipe\delo-<homeId>-<profile>-update` and `\\.\pipe\delo-<homeId>-<profile>-supervisor`, each created with a DACL that grants only the person's SID and rejects remote clients, and the confined token cannot open them for writing.
11. A no-read-up integrity label on the home denies confined commands reads under it, and `delorun verify` reports `home-read` and `token-read` as `enforced` only on a machine where that denial is proven.

### Instruction files

12. Every model-authored write to an instruction-layer file, an `AGENTS.md`, a skill or a preset, needs the instruction consent's approval naming the effect and showing the diff, whether a file tool, a shell command or PTC code makes it.

## What this does not protect against

- **Landlock and sockets.** Landlock cannot deny a connect to a pathname socket; with a rootful Docker socket, a confined command can reach the engine, which is equivalent to root. A report and the rootless offer are the only remedies on such a system.
- **The network and other sockets.** Confined commands reach the network, the ssh-agent socket, D-Bus and the display server on every dialect.
- **Full access.** A command under `danger-full-access` runs unconfined; the prompt states what it reaches and no rule applies.
- **A process of the same user.** A program running as the person outside the sandbox can read and change the home, the probes and the checks.

## Denial tests

| Test | Proves |
| --- | --- |
| `headless boots with Delo's layer or not at all` | `delorun headless` with `@delo/bundle-headless` missing refuses to start; with it, a confined command cannot read a fixture secret under the home and a stdio MCP server is refused. |
| `landlock-token-unreadable` | Under Landlock, a confined command connects to the update channel, fails to read the start token, receives `UNAUTHENTICATED`, and `delorun verify` reports `home-connect` as `not-enforced` and `token-read` as `enforced`. |
| `not-enforced-reported` | On a fixture dialect that cannot express `docker-connect`, `delorun verify` reports the rule as `not-enforced` and setup's Docker option carries the label. |
| `home-mode-reported` | With a protected file at mode 0640, `delorun verify` fails `home-modes` with the fix `chmod 600 <path>`. |
| `windows-dacl-refused` | On Windows, a protected file whose DACL allows `Everyone` is refused with `SECRET_FILE_MODE` and `delorun verify` prints the `icacls` fix. |
| `windows-pipe-connect-denied` | On Windows under windows-acl, a confined command cannot open either channel's pipe for writing or Docker Desktop's engine pipe. |
| `windows-home-read-label` | On Windows under windows-acl, with the no-read-up label on the home, a confined command fails to read a fixture secret and the start token and reads a file under `runtimes/`. |
| `escalation-prompt-names-home` | The approval prompt for a fixture `danger-full-access` escalation contains the statement of rule 6; a declined prompt leaves the command confined, and its read of the start token fails. |
| `landlock-rootful-docker-reported` | On a Landlock fixture with a rootful Docker socket, `delorun verify` reports `docker-connect` as `not-enforced` with the socket's path, and setup names that path and offers the rootless engine. |
| `docker-desktop-control-sockets-denied` | Under bwrap, a confined command cannot connect to a fixture socket in a denied Docker Desktop control directory, including one created after the command starts. |
| `a shell write to AGENTS.md asks` | A confined shell command's write to a workspace `AGENTS.md` under `workspace-write` waits for the instruction consent, and a refused ask leaves the file unchanged. |

## What is built so far

The write and read rules on bwrap, Landlock and Seatbelt, the socket rules on bwrap and Seatbelt, the refusal of a writable root that equals, lies inside or contains the home, the refusal of a lax home, `secrets/` or `run/<profile>/` directory and of a lax protected file on Linux and macOS, and the provider's support for denied socket directories are built, and [C1](../contracts/c01-home-layout.md) describes them. Rule 1 is built: `delorun headless` composes `@delo/bundle-headless` under the sandbox overlay or refuses to start, as `delorun` and `delorun start` compose the CLI profile's layer, and `delorun plugin` boots no Host. Rules 2 to 12 are not built.
