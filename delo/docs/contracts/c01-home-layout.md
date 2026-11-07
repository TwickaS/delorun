---
description: "Contract C1: the ~/.delo home tree, its modes and refusal rule, where secrets and sockets live, the per-start token, the CLI profile, the runtime store with its current and previous pointers, the npm launcher's download and verification, and what each sandbox dialect enforces."
---

# C1 Home layout and runtime store

English | [中文](c01-home-layout.zh.md)

## Summary

This contract fixes where Delo keeps a person's home on disk and how the `delorun` command finds and switches the runtime it runs. It defines the `~/.delo` tree and the owner of each entry, the modes of the home and its protected files with the rule that a component refuses a laxer file, the place of secrets and of the two sockets that refuse confined commands, the token each home-process start writes, the CLI profile beside the desktop app's own profile, the runtime store with its `current` and `previous` pointer files, the override variables and the npm launcher's download and verification. It states which confinement rules each operating system and sandbox dialect enforces, so `delorun verify` reports each rule as it holds on that machine. The types package [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.md) carries the names, codes and limits as constants.

## Contents

- [The home directory](#the-home-directory)
- [The home tree](#the-home-tree)
- [Modes and the refusal rule](#modes-and-the-refusal-rule)
- [Secrets](#secrets)
- [Sockets and the start token](#sockets-and-the-start-token)
- [The home lock](#the-home-lock)
- [Profiles](#profiles)
- [The runtime store](#the-runtime-store)
- [Launcher and store compatibility](#launcher-and-store-compatibility)
- [The npm launcher and the install script](#the-npm-launcher-and-the-install-script)
- [Confinement rules](#confinement-rules)
- [Limits](#limits)
- [Errors](#errors)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Enforcement per platform and dialect](#enforcement-per-platform-and-dialect)

## The home directory

The Delo home is one directory per person and machine. Upstream's harness uses it as its home (`DSH_HOME`), so upstream's data and Delo's data share one tree.

- **Resolution.** `delorun` resolves the home from `DELO_HOME` when it is set and not blank, otherwise from the OS home directory joined with `.delo` (`~/.delo`, on Windows `%USERPROFILE%\.delo`). A leading `~` is expanded as upstream's `expandHomePath` expands it, and the result is normalised to an absolute path.
- **Refusals.** `delorun` refuses a resolved home that is not absolute, that equals the filesystem root or the OS home directory (`HOME_INVALID`), or that equals or lies inside upstream's default home `~/.dsh` (`HOME_IS_DSH_HOME`).
- **Upstream's variable.** `delorun` sets `DSH_HOME` to the resolved home in the environment of every runtime process it starts. An inherited `DSH_HOME` is ignored, and `delorun status` names it when it differed.
- **Upstream's home.** Delo never reads, writes or migrates `~/.dsh`. A person moves upstream data into Delo only through an explicit import.
- **Override variables.** `DELO_HOME` selects the home. `DELO_PROFILE` selects the CLI profile ([profiles](#profiles)). No other variable changes the layout; the runtime store has no override variable, and a runtime other than `current` runs only through the switch rules below.

## The home tree

Delo adds the entries marked Delo at the top of the home. Every other entry is upstream's, keeps upstream's layout and modes, and is described by upstream's documentation.

```text
~/.delo/                         0700  the home; upstream's DSH_HOME
  .credentials.yaml              0600  upstream credentials provider: model keys, the browser session secret
  .env                           0600  upstream credentials fallback, never written by Delo
  cordis.patch.yml                     upstream home patch
  AGENTS.md, skills/                   upstream user instructions and skills
  profiles/default/                    the CLI profile, in upstream's profile layout
  profiles/desktop/                    the desktop app's upstream profile and its lock
  sessions/, attachments/, cache/, storages/, dsh-runtimes/, ...   upstream data
  logs/                                upstream startup reports and the operational logs of C20
  runtimes/                      0700  Delo: the runtime store
  staging/                       0700  Delo: runtime installs in progress
  trust/                         0700  Delo: the verified release root, timestamp and log checkpoint (C2, C18)
  status/                        0700  Delo: each installation's update status record (C3)
  catalogue/                     0700  Delo: the verified catalogue index and revocation list (C13)
  secrets/                       0700  Delo: secret files, 0600 each
  run/<profile>/                 0700  Delo: home lock, start token, sockets, update journal
  supervisor/                    0700  Delo: the Docker supervisor's roots file (C9)
  bin/                           0700  Delo: the launcher copy used by the install script and login items
  alerts/                        0700  Delo: signed certificate-alert files (C5)
```

The operational logs that [C20](c20-operational-logs.md) defines live in per-surface directories under upstream's `logs/`, beside upstream's `startup-*.log` reports.

- **`trust/`.** `root.json` is the newest root that verified, `timestamp.json` the newest timestamp that verified, whose `version` is the highest one stored ([C2](c02-release-manifest.md)), and `checkpoint.json` the latest log checkpoint that verified ([C18](c18-release-log.md)). Each is replaced atomically and never with an older version; the CLI launcher and the desktop updater share them.
- **`status/`.** `cli-home.json` and `desktop-host.json` are the status records of [C3](c03-update-report.md); each installation writes only its own record and reads the other.
- **`catalogue/`.** `index.json` and `revocations.json` are the newest catalogue index and revocation list that verified, and `state.json` holds each one's `sequence` and fetch time ([C13](c13-catalogue-revocation.md)).

## Modes and the refusal rule

On Linux and macOS the home and every directory Delo creates under it have mode 0700, and every protected file has mode 0600. Delo creates each of them with these modes through exclusive creation, so the process umask can only narrow them.

- **Protected files.** Every file under `secrets/`, `trust/`, `status/` and `catalogue/`, `run/<profile>/start-token`, `supervisor/roots.json` and the [C20](c20-operational-logs.md) log files. Upstream's `.credentials.yaml` and `.env` follow upstream's own check, which refuses a file that another user can read.
- **The refusal rule.** A component that reads a protected file first checks it with `lstat`. It refuses the file with `SECRET_FILE_MODE` when the path is a symbolic link or not a regular file, when its owner is not the process's user, or when any group or other permission bit (`0o077`) is set. The error names the path and the fix `chmod 600 <path>`.
- **Directories.** The home process refuses to start with `HOME_MODE` when the home, `secrets/` or `run/<profile>/` has a group or other bit set, is a symbolic link or belongs to another user. The error names the path and the fix `chmod 700 <path>`.
- **Windows.** Windows has no mode bits. The equivalent check reads the path's DACL: every allow entry must name the person's own SID, `SYSTEM` or `BUILTIN\Administrators`. A protected file or directory whose DACL allows any other SID is refused with the same codes, and the fix is the `icacls` command that removes inheritance and grants only those three.
- **Verification.** `delorun verify` checks the modes of the home, of each directory above and of each protected file, and prints the fix for each laxer path.

## Secrets

Delo's secrets are the home-auth keys, the relay and TLS keys, and the session secrets that C4 to C7 define. Each lives in one file under `secrets/<owner>/`, where the owning contract names the file and its format. Upstream's model keys and its browser session secret stay in upstream's `.credentials.yaml`, which also lies under the home.

- A secret never appears in a profile, `cordis.yml`, a patch file, a command's environment, a command line or a log.
- The home's confinement rules deny confined commands reads of `secrets/` and of upstream's credential files ([confinement rules](#confinement-rules)).
- Delo does not store these secrets in the OS key store. On Linux the Secret Service is reached over D-Bus, which stays reachable for confined commands, and on macOS a keychain item's access list trusts the runtime's `node` executable, which confined commands also run. A file in a directory that every dialect denies keeps them from confined commands wherever the dialect enforces the read rule.

## Sockets and the start token

The Docker supervisor ([C9](c09-runtime-supervisor.md)) and the update channel ([C19](c19-home-process.md)) are the two channels that refuse confined commands. Both listen under the home and both accept a request only when it carries the current start token.

- **Socket paths.** On Linux and macOS the update channel is the Unix socket `run/<profile>/update.sock` and the supervisor is `run/<profile>/supervisor.sock`. Both are pathname sockets; Delo never listens on an abstract-namespace socket. A socket is created after the start token is written and is set to mode 0600 after it binds.
- **Path length.** A socket path is at most 103 bytes. A longer path stops the start with `SOCKET_PATH_TOO_LONG`, which names the path and asks for a shorter `DELO_HOME`.
- **Windows.** The channels are the named pipes `\\.\pipe\delo-<homeId>-<profile>-update` and `\\.\pipe\delo-<homeId>-<profile>-supervisor`, where `<homeId>` is the first 16 lowercase hexadecimal digits of the SHA-256 digest of the resolved home path. Each pipe is created with a DACL that grants access only to the person's SID and rejects remote clients.
- **The start token.** Each home-process start writes a new token to `run/<profile>/start-token` before either channel listens: 32 bytes from the operating system's cryptographic random source, encoded as base64url without padding (43 characters) and followed by one newline. The file is replaced atomically with mode 0600 and removed when the home process stops cleanly.
- **Token lifetime.** A token is valid only while the home-process start that wrote it runs. A token file left by a crashed process is replaced at the next start, and no listener accepts its value.
- **Token handling.** The token exists only in the home process's memory, in the supervisor's memory and in the token file. It never appears in a command line, an environment variable, a URL, a response or a log. `delorun` client commands read the file when they send a request.

## The home lock

One home process per profile holds `run/<profile>/home.lock` for its lifetime ([C19](c19-home-process.md)). `delorun update` and `delorun recover` hold it while they change the store with no home process running.

- **Creation.** The lock is created by exclusive creation with mode 0600. It holds one JSON object: `{"v":1,"pid":<integer>,"startId":"<32 lowercase hexadecimal digits>","runtime":"<version>","startedAt":"<RFC 3339 UTC time>"}`. `startId` is random and identifies one start in [C19](c19-home-process.md)'s protocol and in [C20](c20-operational-logs.md)'s records; it is not a secret.
- **Stale lock.** A contender replaces the lock only when the recorded process no longer exists (`ESRCH`).
- **Unresponsive holder.** When the recorded process exists but its update channel does not answer `status` within 2 seconds, the contender stops with `HOME_UNRESPONSIVE` and names the process id. It never takes the lock over.
- **Scope.** The lock is per profile. The desktop app's upstream lock `profiles/desktop/lock` is a different file, which Delo never takes, writes or waits for.

## Profiles

- **The CLI profile** is `default`, at `profiles/default/`, in upstream's profile layout (`package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `node_modules/`). `DELO_PROFILE` selects another CLI profile name under upstream's profile-name rules. Each CLI profile has its own `run/<profile>/` directory, lock, token and channels.
- **The desktop profile** is upstream's `desktop` profile at `profiles/desktop/`, which only the desktop app manages. `delorun` refuses the name `desktop` for its own runs and for `delorun plugin`, as upstream's CLI refuses it.
- **Shared data.** Sessions, workspaces, attachments, credentials and the home patch stay at upstream's places under the home, so the CLI and the desktop app share them as upstream's surfaces do.

## The runtime store

The runtime store holds the installed runtime closures and names the active one. Each command-line start runs exactly one runtime, the one `current` names.

```text
runtimes/
  store.json              {"layout":1}
  current                 the active version and one newline
  previous                the version kept for rollback and one newline; absent before the first switch
  store.lock              taken by install, switch and removal
  <version>/              one complete, verified runtime closure
  delorun-<version>.manifest.json            the verified release manifest, beside its installation
  delorun-<version>-<platform>.files.json    the verified runtime file list
  delorun-<version>.manifest.log.json        the release-log bundle
```

- **Version names.** A directory name is a Delo release version: SemVer 2.0 without build metadata, matching `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`, at most 64 characters.
- **Pointer files.** `current` and `previous` hold UTF-8 text: exactly one version and one newline, at most 65 bytes. A pointer is replaced by writing a sibling `<pointer>.tmp-<16 hex>` through exclusive creation with mode 0600, flushing it to disk, renaming it over the pointer and, on Linux and macOS, flushing the `runtimes/` directory. A symbolic link is never used, because creating one needs a privilege on Windows and a running `node.exe` locks its directory.
- **Windows rename.** When the rename reports `EPERM`, `EBUSY` or `EACCES`, it is retried with backoff for at most 2,000 ms in total. A rename that still fails stops with `POINTER_REPLACE_FAILED` and leaves the old pointer unchanged.
- **Reading a pointer.** A reader reads the whole file. A missing, empty, oversized or malformed pointer, or one that names a version with no installed directory, is `NO_ACTIVE_RUNTIME`; the launcher then offers reinstall or rollback and never picks a directory on its own.
- **Switch order.** A switch writes `previous` with the old version first and `current` with the new version second, so a process killed between the two writes leaves `current` naming the old, whole version.
- **Who switches `current`.** Only four events switch it: the first install when no `current` exists; an update through [C19](c19-home-process.md)'s handshake; a rollback the person requests through [C19](c19-home-process.md) or `delorun recover`; and [C19](c19-home-process.md)'s automatic rollback after a failed health check. A launcher never switches `current` on its own, whether it is newer or older than the active runtime.
- **Installing.** An install takes `store.lock`, waiting at most 30 seconds before it stops with `STORE_BUSY`. It downloads into `~/.delo/staging/<16 hex>/`, which lies outside `runtimes/` on the same filesystem, and runs the client verification of [C2](c02-release-manifest.md): the root and timestamp walk, the manifest's signature and freshness, the release-log bundle and online check ([C18](c18-release-log.md)), and the archive's and file list's digests. It extracts with path checks (no absolute path, no `..` segment, no link, no device file and no entry outside the file list), checks every file against the file list, then renames the staging directory to `runtimes/<version>/` and places the manifest, file list and bundle beside it. Nothing appears under `runtimes/` before every check passes, and a failed install removes its staging directory and changes nothing else.
- **Installed files.** After the rename, directories under `<version>/` have mode 0555 and files 0444, or 0555 for executables; on Windows they carry the read-only attribute. The launcher's hash check at every start ([C2](c02-release-manifest.md)) is the integrity control; the modes stop accidental writes only.
- **Retention.** After a switch commits, the store keeps the versions that `current` and `previous` name, with their release files, and removes every other `<version>/` with its release files, and every directory under `staging/` that no install holds. A removal that fails, such as a Windows directory still in use, is retried at the next start. At most two versions and one staging directory exist at once.
- **Rollback scope.** A runtime rollback changes no file outside `runtimes/`. Restoring the profile from its history is [C3](c03-update-report.md)'s step.

## Launcher and store compatibility

A launcher runs the active runtime only when it understands both the store and the runtime's launch interface.

- `store.json` carries the store layout number, which is 1. The layout number changes only when an entry of the store moves or changes meaning.
- Each runtime's signed manifest ([C2](c02-release-manifest.md)) carries its launch protocol number, which is 1. The launch protocol fixes the runtime's entry file, the arguments the launcher passes and the environment variables it sets (`DSH_HOME`, `DELO_HOME`, `DELO_PROFILE`).
- The launcher runs `current` when it supports the store's layout number and the runtime's launch protocol number. Otherwise it stops with `RUNTIME_INCOMPATIBLE`, names both numbers and offers the update flow when the runtime is the older side, or a launcher update when the launcher is the older side. It changes neither `current` nor any other file of the store.

## The npm launcher and the install script

- **No runtime in the package.** The npm package `delorun` is the launcher only. It has no runtime dependencies and carries no runtime closure.
- **Download.** To install a version, the launcher downloads the release files that [C2](c02-release-manifest.md) names, over HTTPS only: the root and timestamp from `releases.delorun.com`, and the manifest, its bundle, the file list and the per-platform archive (`.tar.gz`, or `.zip` on Windows) from the GitHub Releases of Delo's public repository. It follows redirects only to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, and refuses any other host with `DOWNLOAD_REFUSED`. The release-log check reaches the hosts that [C18](c18-release-log.md) names.
- **Download limits.** An archive is at most 1,073,741,824 bytes (1 GiB) and a manifest at most 4,194,304 bytes (4 MiB). A connection that does not open within 30 seconds, or that delivers no byte for 60 seconds, fails the download.
- **Verification before install.** The launcher verifies the archive against the signed manifest ([C2](c02-release-manifest.md)) and the manifest's entry in the release log ([C18](c18-release-log.md)) before any file appears under `runtimes/<version>/`, as [the runtime store](#the-runtime-store) states.
- **Without network.** The launcher runs the installed `current` after its offline hash check. An install always needs the network and the log inclusion proof.
- **Trust anchor.** `npx delorun` runs the launcher that npm serves before any Delo check can run, so that launcher is trusted through the build attestation npm publishes for it, which ties the package to the public repository's release workflow ([C2](c02-release-manifest.md)). The install script is trusted through its published hash.
- **The launcher copy.** The install script writes the launcher to `bin/delorun` (with `bin/delorun.cmd` on Windows) and adds `bin/` to the person's command path. `delorun start --at-login` copies the running launcher into `bin/` before it installs the login item ([C19](c19-home-process.md)), so a login item never depends on npm.

## Confinement rules

Upstream's sandbox dialects confine file writes only. Delo's sandbox profiles add the rules below for every command that runs under `read-only` or `workspace-write`. A command that runs under `danger-full-access`, whether set by the person or approved as an escalation, runs unconfined, and no rule in this section applies to it.

| Rule | Confined commands cannot |
| --- | --- |
| `home-write` | create, change or delete anything under the home |
| `home-read` | read anything under the home except the read exemptions |
| `token-read` | read the start token |
| `home-connect` | connect to a socket or pipe of the home's channels |
| `docker-connect` | connect to the Docker socket at its real path |

- **Read exemptions.** Confined commands may read and execute `runtimes/`, `skills/` and `dsh-runtimes/`. The PTC worker and other confined processes run the runtime's own `node` from `runtimes/`, commands run the person's skill scripts from `skills/`, and the desktop app's workspace dependencies run from `dsh-runtimes/`. No secret is written under an exemption; a component that keeps a secret uses `secrets/`.
- **Writable roots.** The home is never inside a writable root. `workspace-write` is refused with `HOME_IN_WRITABLE_ROOT` when the workspace root or an additional writable root, after resolving symbolic links, equals the home, lies inside it or contains it. A workspace whose root contains the home, such as `~`, still runs `read-only` commands.
- **The Docker socket.** The socket lies outside the home. Delo resolves its path from the active Docker context: `/var/run/docker.sock` for a rootful engine, `$XDG_RUNTIME_DIR/docker.sock` for a rootless one, or the path Docker Desktop's context names. The rule covers both the context's path and its resolved real path. A context whose endpoint is TCP or SSH uses the network, which no dialect confines, so `docker-connect` is not enforced for it.
- **Other sockets.** Other `AF_UNIX` sockets, such as the ssh-agent socket, D-Bus and the display server, and the network stay reachable for confined commands.
- **Probes.** At each start the home process runs one confined probe command per rule against fixtures in `run/<profile>/probe/`, against a socket it opens there and against the Docker socket path, and records the result. `delorun verify` reports each rule through the `confinement-rule` check of [C15](c15-verification-checks.md), as `enforced` only when the dialect expresses it and its probe was refused at this start. The other states are `not-enforced` (the dialect cannot express the rule, the endpoint is a network endpoint, or the platform has no proving test), `unconfined` (no sandbox runs, or the mode is `danger-full-access`) and `unknown` (the probe did not run or failed for another reason). Each confinement rule state maps to a verification check result: `enforced` is `pass`, `not-enforced` is `not-enforced`, `unconfined` is `fail` and `unknown` is `unknown`.
- **Labelling Docker mode.** When `docker-connect` is not `enforced`, `delorun verify` reports it and setup's Docker mode option carries this statement: on this system, commands in native workspaces can connect to Docker, which can start containers with this computer's files mounted.
- **Landlock with a rootful engine.** When the dialect is Landlock and the active context's endpoint is a rootful engine's socket, `delorun verify` reports `docker-connect` as `not-enforced` with the reason `dialect-cannot-express` and names the socket's path. Setup ([C11](c11-setup-answers.md)) names the same path, states that confined commands can connect to it and that this is equivalent to root on this machine, and offers setting up Docker's rootless engine and switching the active context to it.
- **The escalation prompt.** The approval prompt for a `danger-full-access` escalation, whether a command requests it or the person sets the mode, states before the person approves: "Full access lets this command read Delo's home, including its keys and tokens, and reach the Docker supervisor and the update channel." The prompt is shown to the person and is not model-visible.

## Limits

| Limit | Value |
| --- | --- |
| Mode of the home and of Delo's directories | 0700 |
| Mode of protected files | 0600 |
| Socket path length | at most 103 bytes |
| Start token | 32 random bytes, 43 base64url characters |
| `homeId` in Windows pipe names | 16 hexadecimal digits |
| `status` answer before a lock counts as unresponsive | 2 seconds |
| Runtime version name | at most 64 characters |
| Pointer file | at most 65 bytes |
| Wait for `store.lock` | 30 seconds |
| Windows pointer rename retries | at most 2,000 ms in total |
| Installed runtime versions | at most 2, plus 1 staging directory |
| Archive download | at most 1 GiB |
| Manifest download | at most 4 MiB |
| Download connection | 30 seconds to open, 60 seconds without a byte |
| Store layout number | 1 |
| Launch protocol number | 1 |

## Errors

| Code | Meaning |
| --- | --- |
| `HOME_INVALID` | The resolved home is not absolute, or it is the filesystem root or the OS home directory |
| `HOME_IS_DSH_HOME` | The resolved home is upstream's `~/.dsh` or lies inside it |
| `HOME_MODE` | The home, `secrets/` or `run/<profile>/` is laxer than 0700, a symbolic link or another user's |
| `SECRET_FILE_MODE` | A protected file is laxer than 0600, a symbolic link, not a regular file or another user's |
| `SOCKET_PATH_TOO_LONG` | A channel's socket path exceeds 103 bytes |
| `HOME_IN_WRITABLE_ROOT` | A writable root equals, lies inside or contains the home |
| `HOME_RUNNING` | A live home process for the profile holds the lock |
| `HOME_UNRESPONSIVE` | The lock's process exists but its update channel did not answer within 2 seconds |
| `STORE_BUSY` | `store.lock` was not free within 30 seconds |
| `NO_ACTIVE_RUNTIME` | `current` is missing, malformed or names a version that is not installed |
| `POINTER_REPLACE_FAILED` | A pointer rename failed after its retries; the old pointer is unchanged |
| `RUNTIME_INCOMPATIBLE` | The launcher does not support the store's layout number or the runtime's launch protocol number |
| `INSTALL_VERIFY_FAILED` | A digest, signature, freshness, log-inclusion, path or file-hash check failed during an install |
| `DOWNLOAD_REFUSED` | A download redirected to a host outside the list, exceeded a size limit or timed out |

## Consumers

- `delo/apps/cli`: the `delorun` command and the CLI profile, through `delo/packages/home`.
- `delo/packages/home`: home resolution, the home tree and its modes, reading and writing protected files under the refusal rule, and the home lock.
- `delo/packages/integrity`: the `delorun verify` checks of modes and of each confinement rule.
- Upstream's `packages/sandbox/sandbox-local` and `packages/sandbox/sandbox`: the per-dialect profiles and the writable-root refusal.
- `delo/apps/install` and `delo/apps/npm-launcher`: the download, verification and the launcher copy.
- `delo/packages/runtime-store`: the store, the pointer files, install, switch and retention.
- `delo/packages/home-process`: holding the lock through `delo/packages/home`, the start token, the update channel's socket and the probes ([C19](c19-home-process.md)).
- `delo/packages/supervisor`: the supervisor's socket and its token check ([C9](c09-runtime-supervisor.md)).
- `delo/packages/home-auth`: the secret files under `secrets/home-auth/`, read and written through `delo/packages/home`.

## Compatibility

- The tree changes only by adding entries. Moving an entry, renaming it or changing its meaning raises the store layout number or is a breaking change with an upgrade guide under `delo/docs/upgrade-guide/`, and the runtime that makes the change reads both forms.
- `DELO_HOME`, `DELO_PROFILE`, the CLI profile name and the channel paths are external interfaces; changing one is a breaking change with an upgrade guide.
- Upstream's entries keep upstream's layout and compatibility rules, including its Session format.
- The launch protocol number rises only with a change to the entry file, the arguments or the environment that the launcher passes. A launcher supports every launch protocol number of the runtimes it can install.
- The types package follows Delo's version and changes in the same pull request as this page.

## Security

### Requirements

1. The home has mode 0700 and its protected files 0600. A component refuses a protected file that is laxer, a symbolic link or another user's, and the home process refuses to start on a laxer home, `secrets/` or `run/<profile>/`. `delorun verify` checks every one of them and prints the `chmod` fix, or on Windows the `icacls` fix.
2. Delo's secrets live in files under `secrets/`, a directory every dialect denies reads of where it enforces `home-read`. Upstream's credential files lie under the home and fall under the same rule. No secret is written to a read exemption, a profile, a patch file, a command's environment or command line, or a log.
3. Confined commands cannot write anything under the home on any dialect, and cannot read anything under it except the read exemptions wherever the dialect enforces `home-read`.
4. Confined commands cannot connect to the home's channels or to the Docker socket at its real path wherever the dialect enforces `home-connect` and `docker-connect`. bwrap mounts an empty tmpfs over the home and binds `/dev/null` over the Docker socket's real path, never over its parent directory, because `/run/user/<uid>/` also holds the ssh-agent socket. Seatbelt denies `file-read*` on the home and denies `network-outbound` to the `remote unix-socket` path literal of each channel socket and of both Docker socket paths. Landlock cannot deny a connect to a pathname socket, so `home-connect` and `docker-connect` are reported as `not-enforced` there.
5. Under Landlock the read denial on the home keeps the start token unreadable, so a confined command can connect to either channel but its request fails authentication, and `delorun verify` reports that state.
6. Both channels accept a request only with the token of the current home-process start; a missing token, a wrong token and a previous start's token are refused alike. The token is 256 bits from the OS random source, is never logged or passed in a command line or environment, and is compared in constant time.
7. The protection rests on confining the agent's commands. A process of the person's user that runs outside the sandbox can read the token and can already run `delorun` and `docker` itself, and this contract claims no protection against it. No root-owned helper exists.
8. Commands under `danger-full-access` run unconfined; none of the rules above applies to them, and `delorun verify` reports `unconfined` for a workspace in that mode. The approval prompt for that mode states that full access reaches Delo's home, its tokens, the Docker supervisor and the update channel.
9. The home is never inside a writable root, and `workspace-write` with a root that equals, lies inside or contains the home is refused.
10. A launcher never switches `current` on its own. An install verifies the archive, the manifest's signature and freshness, its log inclusion and every file hash before any file appears under `runtimes/<version>/`, and a pointer is replaced only by an atomic rename.
11. Delo never reads or writes upstream's `~/.dsh`.
12. On a Landlock-only system with a rootful Docker socket, `delorun verify` reports the socket as not enforced, and setup names it and offers the rootless engine.

### Denial tests

Each test runs on every CI platform where its dialect exists, against local fixtures only.

| Test | Proves |
| --- | --- |
| `home-read-denied` | On each dialect that enforces `home-read`, a confined command in a workspace at `~` fails to read a fixture home-auth key under `secrets/` and the start token, and reads a file under `runtimes/` |
| `home-write-denied` | On every dialect, a confined command cannot create, change or delete a file under the home |
| `home-socket-connect-denied` | On bwrap and Seatbelt, a confined command's connect to a socket under the home fails, and its connect to a fixture ssh-agent socket outside the home succeeds |
| `docker-socket-connect-denied` | On bwrap and Seatbelt, a confined command's connect to the Docker socket at its real rootful path and at a rootless path fails, and an ssh-agent socket in the same directory as the rootless Docker socket stays reachable |
| `landlock-token-unreadable` | Under Landlock, a confined command connects to both channels, fails to read the start token, receives `UNAUTHENTICATED` from both, and `delorun verify` reports `home-connect` as `not-enforced` and `token-read` as `enforced` |
| `not-enforced-reported` | On a fixture dialect that cannot express `docker-connect`, `delorun verify` reports the rule as `not-enforced` and setup's Docker mode option carries the label |
| `secret-mode-refused` | In a fixture home whose device-key file has mode 0640, the reading component refuses the file with `SECRET_FILE_MODE`, and `delorun verify` fails with the fix `chmod 600 <path>` |
| `home-mode-refused` | With the home at mode 0755, the home process refuses to start with `HOME_MODE`, and `delorun verify` prints the fix `chmod 700 <path>` |
| `writable-root-refused` | `workspace-write` with the workspace root `~`, and with a root inside the home, is refused with `HOME_IN_WRITABLE_ROOT` and no command runs |
| `launcher-leaves-current` | A newer launcher and an older launcher each leave `current` and `previous` byte-identical |
| `pointer-switch-interrupted` | Killing the switching process before, between and after the two pointer writes leaves `current` naming a whole, installed version |
| `install-verify-first` | A bad signature, a bad file hash, a missing log entry and an archive entry with `..` each leave nothing under `runtimes/<version>/` and no staging directory |
| `dsh-home-untouched` | After a first run with an inherited `DSH_HOME`, a fixture `~/.dsh` is byte-identical and the runtime ran with `DSH_HOME` set to the Delo home |
| `windows-dacl-refused` | On Windows, a protected file whose DACL allows `Everyone` is refused with `SECRET_FILE_MODE` and `delorun verify` prints the `icacls` fix |
| `windows-pipe-connect-denied` | On Windows under windows-acl, a confined command cannot open either channel's pipe for writing or Docker Desktop's engine pipe |
| `windows-home-read-label` | On Windows under windows-acl, with the no-read-up label on the home, a confined command fails to read a fixture secret and the start token and reads a file under `runtimes/`; `delorun verify` reports `home-read` as `enforced` only on a machine where this denial holds |
| `escalation-prompt-names-home` | The approval prompt rendered for a fixture `danger-full-access` escalation contains the statement that full access reaches Delo's home, its keys and tokens, the Docker supervisor and the update channel; a declined prompt leaves the command confined, and its read of the start token fails |
| `landlock-rootful-docker-reported` | On a Landlock fixture with a rootful Docker socket, `delorun verify` reports `docker-connect` as `not-enforced` with the socket's path, and setup's Docker step names that path and offers the rootless engine |

### What this does not prove

- **Landlock and sockets.** Landlock cannot deny a connect to a pathname socket. On a Landlock-only system a confined command reaches a rootful Docker socket, which is equivalent to root; `delorun verify` reports it, and no Delo mechanism closes it there. The home's channels stay closed only because the start token is unreadable.
- **Landlock and the home's ancestors.** Landlock grants reads by directory tree, so the profile grants every entry beside the way from `/` to the home rather than those directories themselves: a confined command cannot list `/`, the OS home or any other directory on that way, and an entry created in one of them after the command starts is unreadable to it. The entries are listed when the command is wrapped, so an entry removed before the launcher applies the ruleset makes the launcher refuse the run; the command does not run, unconfined or otherwise.
- **Windows reads.** windows-acl does not confine reads. The no-read-up label on the home is reported `enforced` only where `windows-home-read-label` passes; where it does not hold, `home-read` and `token-read` are not enforced on Windows, and the channels rest on the named-pipe write denial that `windows-pipe-connect-denied` proves.
- **Windows channels.** On Windows the channels are named pipes, outside the home's filesystem tree; only their DACL and the token protect them.
- **Docker over the network.** A Docker context whose endpoint is TCP or SSH is reachable by any command with network access on every dialect.
- **Full access.** Commands under `danger-full-access` can read every secret under the home and the start token, and can reach both channels; the escalation prompt states this, and no rule applies.
- **The person's own processes.** A process of the person's user outside the sandbox can read and change everything under the home; the modes protect against other users, not against it.

## Enforcement per platform and dialect

`delorun verify` reports each rule as this table states. A rule marked enforced is reported `enforced` only when its start probe was refused on that machine; otherwise the report says why.

| Rule | bwrap (Linux) | Landlock (Linux) | Seatbelt (macOS) | windows-acl (Windows) | No sandbox or `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| `home-write` | enforced: the home is not bound writable | enforced: no write grant under the home | enforced: `deny file-write*` outside writable roots | enforced: the Low-integrity token cannot write outside labelled roots | unconfined |
| `home-read` | enforced: empty tmpfs over the home, exemptions bound read-only | enforced: a layered ruleset that grants reads outside the home and to the exemptions | enforced: `deny file-read*` on the home, exemptions allowed | not-enforced: the dialect does not confine reads; a no-read-up integrity label on the home is the mechanism, reported enforced only where its denial test passes | unconfined |
| `token-read` | enforced, as `home-read` | enforced, as `home-read` | enforced, as `home-read` | not-enforced, as `home-read` | unconfined |
| `home-connect` | enforced: the sockets are hidden under the tmpfs | not-enforced: Landlock has no right for connecting to a pathname socket; the token check refuses the request | enforced: `remote unix-socket` path literals | enforced where `windows-pipe-connect-denied` passes: the write-restricted Low-integrity token cannot open the pipes for writing | unconfined |
| `docker-connect` | enforced: `/dev/null` bound over the real socket path | not-enforced | enforced: path literals for the context path and the real path | enforced where `windows-pipe-connect-denied` passes, for Docker Desktop's engine pipe | unconfined |
| Docker over TCP or SSH | not-enforced | not-enforced | not-enforced | not-enforced | unconfined |
| Other `AF_UNIX` sockets and the network | reachable | reachable | reachable | reachable | reachable |

- **Linux without bwrap.** Where unprivileged user namespaces are unavailable, bwrap fails its probe and upstream's provider selects Landlock. Where neither works, upstream's provider refuses to run confined commands, and every rule reads `unconfined` for a workspace the person runs in `danger-full-access`.
- **Landlock grants.** The layered ruleset grants each sibling along the path from `/` to the home, so a file created during a confined command directly in one of the home's ancestor directories is unreadable to that command.
- **macOS paths.** Seatbelt matches resolved paths, so the profile names `/private/var/...` for `/var/...` and both the Docker Desktop context path and its real path.
- **WSL2.** Delo inside WSL2 is Linux, and the Linux columns apply. The Windows host's processes are outside the sandbox.
