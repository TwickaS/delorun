---
description: "Contract C1: the ~/.delo home tree, its modes and refusal rule, where secrets and sockets live, the per-start token, the CLI profile, the runtime store with its current and previous pointers, the npm launcher's download and verification, and what each sandbox dialect enforces."
---

# C1 Home layout and runtime store

English | [中文](c01-home-layout.zh.md)

## Summary

This contract fixes where Delo keeps a person's home on disk and how the `delorun` command finds and switches the runtime it runs. It defines the `~/.delo` tree and the owner of each entry, the modes of the home and its protected files with the rule that a component refuses a laxer file, the place of secrets and of the two sockets that refuse confined commands, the token each home-process start writes, the CLI profile beside the desktop app's own profile, the runtime store with its `current` and `previous` pointer files, the override variables and the npm launcher's download and verification. It states which confinement rules each operating system and sandbox dialect enforces. The types package [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.md) carries the names, codes and limits as constants.

## Status

The home, its modes on Linux and macOS, the update channel, the lock, the runtime store, the npm launcher and the confinement rules of the CLI profile on bwrap, Landlock and Seatbelt are built; the checks that report the rules, Windows and the Docker supervisor's channel are not.

- **Built and reached:** home resolution and its refusals; the home's directories and protected files with their modes and the refusal rule on Linux and macOS; the update channel's socket and the start token; the home lock; the runtime store with install, switch and the start check; the npm launcher's download and verification; and, in the CLI profile, the `home-write`, `home-read` and `token-read` rules on bwrap, Landlock and Seatbelt, the `home-connect` and `docker-connect` rules on bwrap and Seatbelt, and the refusal of a writable root that holds the home; the `wsl-interop` rule under WSL on bwrap, with Landlock refusing confined commands there; and the `vsock` rule on bwrap wherever the kernel offers virtual-machine sockets.
- **Built, reached by nothing:** the Docker supervisor's socket, which `delorun start` adds to the denied sockets but which no process creates, because no command launches the supervisor ([C9](c09-runtime-supervisor.md)).
- **Not built:** Delo's rules under `delorun plugin`, which runs upstream's pnpm operation with none of them; the probes at each start and the `confinement-rule` and `home-modes` checks, which `delorun verify` reports as not run; setup's Docker labels; the full-access prompt's statement of what full access reaches; the denial of Docker Desktop's control-socket directories under WSL and on Linux; on Windows the DACL check, the named pipes and any read confinement; the install scripts, the launcher copy under `bin/` and login items; and the npm build attestation. These rules are in the [native confinement design](../design/native-confinement.md) and the [release workflow design](../design/release-workflow.md).

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

## Contents

- [Status](#status)
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

- **Resolution.** `delorun` resolves the home from `DELO_HOME` when it is set and not blank, otherwise from the OS home directory joined with `.delo` (`~/.delo`, on Windows `%USERPROFILE%\.delo`). A leading `~` is expanded as upstream's `expandHomePath` expands it, and the result is normalised to an absolute path. Every symbolic link in the home's parent path is resolved, as far as that path exists, and the home's own name is kept, so the resolved home names the same directories that the files under it report. A home that is itself a symbolic link is refused with `HOME_MODE`. The refusals below compare paths with every symbolic link resolved, the home's own included.
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
  profiles/headless/                   the profile delorun headless boots: upstream's headless template with @delo/bundle-headless linked
  sessions/, attachments/, cache/, storages/, spill/, dsh-runtimes/, ...   upstream data
  logs/                                upstream startup reports and the operational logs of C20
  runtimes/                      0700  Delo: the runtime store
  staging/                       0700  Delo: runtime installs in progress
  trust/                         0700  Delo: the verified release root, timestamp and log checkpoint (C2, C18), and the installations' identity records
  status/                        0700  Delo: each installation's update status record (C3)
  catalogue/                     0700  Delo: the verified catalogue index and revocation list (C13)
  secrets/                       0700  Delo: secret files, 0600 each
  run/<profile>/                 0700  Delo: home lock, start token, sockets, update record, update check, setup progress, start overlays
  data-copies/                   0700  Delo: the session-data copy an update took, and a restore's journal (C3)
  data-set-aside/                0700  Delo: chat data a rollback set aside (C3)
  trash/                         0700  Delo: trashed chats and workspaces until retention ends or a restore (C8)
  archive/                       0700  Delo: workspace archive imports, staged and published (C8)
  supervisor/                    0700  Delo: the Docker supervisor's roots file (C9)
  bin/                           0700  Delo: the launcher copy used by the install script and login items
  alerts/                        0700  Delo: signed certificate-alert files (C5)
  trash/                         0700  Delo: deleted chats and workspaces until a purge, and the retention record (C8)
  archive/                       0700  Delo: imports in progress and imported workspaces (C8)
```

The operational logs that [C20](c20-operational-logs.md) defines live in per-surface directories under upstream's `logs/`, beside upstream's `startup-*.log` reports. The home tree creates `status/`, `catalogue/`, `supervisor/`, `bin/` and `alerts/` empty, and nothing writes into them: the features that own them are not built or not reached ([status](#status)).

The types package's `DELO_HOME_ENTRIES` lists every Delo entry above, and its `home-entries` spec fails when Delo's code builds a top-level entry under the home that neither that list nor upstream's entries name.

- **`trust/`.** `root.json` is the newest root that verified, `timestamp.json` the newest timestamp that verified, whose `version` is the highest one stored ([C2](c02-release-manifest.md)), `checkpoint.json` the latest log checkpoint that verified ([C18](c18-release-log.md)), and `release-log.json` the release-log check state of each installed release, `verified` or `unchecked` with the reason, which an install writes once the runtime store has installed the release and the start check updates ([C18](c18-release-log.md#check-states)). Each is replaced atomically and never with an older version; the CLI launcher and the desktop updater share them. `roots/<n>.root.json` holds one file per root version an install walked, oldest first, which is the proof a start holds a stored root newer than every root the launcher ships to ([C2](c02-release-manifest.md#key-rotation)). `channel.json` records where the home's releases come from, `{"v":1}` with the `channelOrigin` and `logOrigin` the installing launcher was built with, each absent for the production value; a launcher writes it once the store has installed a release from it, and `delorun update` fetches from those origins and anchors on the stored roots, which must chain, each signed by the one before it. No environment variable, setting or runtime command of Delo moves the channel: Delo changes it only when the person runs a launcher built for another channel, in a terminal. The file lies under `trust/`, which the sandbox keeps confined commands from writing; an unconfined process of the same user, a Host plugin included, can write it as it can every file of the home, so the record decides only where releases are fetched from, and a release installs only when it verifies under the stored roots. `runtime-files/delorun-<version>-<platform>.json`, at mode 0600, is the identity record of an installed runtime that C2's start check reads; the runtime store writes it under `store.lock` and retention removes it with its version, and it lies outside every read exemption of confined commands.
- **`status/`.** `cli-home.json` and `desktop-host.json` are the status records of [C3](c03-update-report.md); each installation writes only its own record and reads the other.
- **`run/<profile>/`.** Besides the lock, the token and the sockets, it holds `setup-progress.json`, the record that lets an interrupted setup resume ([C11](c11-setup-answers.md)), and the overlays a start passes to upstream's profile runner: `sandbox.patch.yml`, the confinement rules of [this contract](#confinement-rules), and `safe-mode.patch.yml` while safe mode is on. A start rewrites the overlays; they are not the person's configuration.
- **`run/<profile>/update.json`.** The update record of [C19](c19-home-process.md#interrupted-updates) and [C3](c03-update-report.md#rollback): the two versions, whether the chat data differs, whether a copy was taken and `targetStarted`, written at mode 0600 and synced before the target's process is spawned. It stays with phase `committed` after an update commits, so a later rollback reads it, and goes when a rollback completes.
- **`run/<profile>/update-check.json`.** The update check's record ([C3](c03-update-report.md#update-check)): when the profile's last check ran, the newest release it verified and why the last check failed, written atomically at mode 0600 and removed by a start whose profile switches the check off.
- **`run/<profile>/update.previous.json`.** The committed record of the previous update while a newer update runs: it goes back to `update.json` when the newer update ends before switching or is rolled back, and is removed when the newer update commits.
- **`run/data-users/<pid>`.** One file per process that uses the shared stores, `sessions/`, `storages/` and the rest beside them, and `runtimes/current`, at mode 0600, holding `{"mode":"shared"|"exclusive","command":"<name>"}` with the holder's `processStart` and `pidNamespace` ([the home lock](#the-home-lock)) where the platform reports them. Every home process registers as `shared` with `"command":"start","profile":"<profile>"` from before it takes its home lock until it exits, `delorun headless` and `delorun plugin` register as `shared`, `delorun trash`, `export` and `import` as `exclusive` while they also hold the home lock of every profile, and `delorun recover rollback` with no home process running, unless `--profile-only`, as `exclusive` with `"command":"recover"` while it holds its profile's home lock. An exclusive user refuses while any other live process is listed, a shared user refuses while an exclusive one is, and a home process refuses to start while an exclusive one is or an update or a rollback of another profile is between its snapshot and its end. An update's prepare, session-data copy, restore and runtime switch, and a rollback, refuse while any other live process is listed, another profile's home process included, and name it; an update checks before it writes its update record and again after, right before its Host stops for the switch, so a process listed in between is found. The process's own file never counts. A file whose process has exited, or whose recorded start identity differs from the live process's, is not live and is removed; a file that records another pid namespace is live and kept; a file that cannot be read counts as an exclusive use. `data-users` is never a profile's run directory: it is a [reserved profile name](#profiles).
- **`data-copies/`.** `<version>/` holds the session-data copy the update to that version took: real copies of `sessions/` and `storages/` beside `copy.json`. An older copy is removed when a newer update commits, and a copy of an update that ended before switching is removed with it. `restore.json` is the journal of a restore in progress, completed before any Host starts. An update's data-safety step writes the copy and a rollback the journal, both through `delo/packages/update`.
- **`data-set-aside/`.** `<version>-<time>/` holds the `sessions/` and `storages/` a rollback replaced with a copy. Nothing removes it but the person, through `delorun recover discard`. The rollback of `delo/packages/update` writes it.
- **`trash/`.** `items/<item>/` holds one trashed item: its `item.json` and the chats moved out of `sessions/`, until the home process's retention pass or `delorun trash purge` purges it or a restore moves it back; `retention.json` records the last retention pass. The studio's trash plugin and `delorun trash` write it ([C8](c08-archive-and-trash.md#trash-and-purge)).
- **`archive/`.** `staging/` holds an import in progress and `imported/<workspace>/` each workspace `delorun import` published; no row of the shipped composition reads it ([C8](c08-archive-and-trash.md)).
- **`catalogue/`.** `index.json` and `revocations.json` are the newest catalogue index and revocation list that verified, and `state.json` holds each one's `sequence` and fetch time ([C13](c13-catalogue-revocation.md)).

## Modes and the refusal rule

On Linux and macOS the home and every directory Delo creates under it have mode 0700, and every protected file has mode 0600. Delo creates each of them with these modes through exclusive creation, so the process umask can only narrow them.

- **Protected files.** Every file under `secrets/`, `trust/`, `status/` and `catalogue/`, `run/<profile>/start-token`, `supervisor/roots.json` and the [C20](c20-operational-logs.md) log files. Upstream's `.credentials.yaml` and `.env` follow upstream's own check, which refuses a file that another user can read.
- **The refusal rule.** A component that reads a protected file first checks it with `lstat`. It refuses the file with `SECRET_FILE_MODE` when the path is a symbolic link or not a regular file, when its owner is not the process's user, or when any group or other permission bit (`0o077`) is set. The error names the path and the fix `chmod 600 <path>`.
- **Directories.** The home process refuses to start with `HOME_MODE` when the home, `secrets/` or `run/<profile>/` has a group or other bit set, is a symbolic link or belongs to another user. The error names the path and the fix `chmod 700 <path>`.
- **Windows.** Windows has no mode bits, and the checks above are skipped there; no check reads a path's DACL. The DACL check is in the [native confinement design](../design/native-confinement.md#windows).
- **Checks.** `delorun doctor` checks the modes of the home, `secrets/` and `run/<profile>/`. `delorun verify` reports its `home-modes` check as not run ([native confinement design](../design/native-confinement.md#checks-at-each-start)).

## Secrets

Delo's secrets are the home-auth keys, the relay and TLS keys, and the session secrets that C4 to C7 define. Each lives in one file under `secrets/<owner>/`, where the owning contract names the file and its format. Upstream's model keys and its browser session secret stay in upstream's `.credentials.yaml`, which also lies under the home.

- A secret never appears in a profile, `cordis.yml`, a patch file, a command's environment, a command line or a log.
- In the CLI profile, the home's confinement rules deny confined commands reads of `secrets/` and of upstream's credential files wherever the dialect enforces `home-read` ([confinement rules](#confinement-rules)).
- Delo does not store these secrets in the OS key store. On Linux the Secret Service is reached over D-Bus, which stays reachable for confined commands, and on macOS a keychain item's access list trusts the runtime's `node` executable, which confined commands also run. A file in a directory that every dialect denies keeps them from confined commands wherever the dialect enforces the read rule.

## Sockets and the start token

The update channel ([C19](c19-home-process.md)) and the Docker supervisor ([C9](c09-runtime-supervisor.md)) are the two channels that refuse confined commands. Both listen under the home and accept a request only when it carries the current start token. No command launches the supervisor, so only the update channel listens.

- **Socket paths.** On Linux and macOS the update channel is the Unix socket `run/<profile>/update.sock` and the supervisor is `run/<profile>/supervisor.sock`. Both are pathname sockets; Delo never listens on an abstract-namespace socket. A socket is created after the start token is written and is set to mode 0600 after it binds.
- **Path length.** A socket path is at most 103 bytes. A longer path stops the start with `SOCKET_PATH_TOO_LONG`, which names the path and asks for a shorter `DELO_HOME`.
- **Windows.** The update channel is a filesystem socket path on every platform; no named pipe and no pipe DACL exists. The named pipes are in the [native confinement design](../design/native-confinement.md#windows).
- **The start token.** Each home-process start writes a new token to `run/<profile>/start-token` before either channel listens: 32 bytes from the operating system's cryptographic random source, encoded as base64url without padding (43 characters) and followed by one newline. The file is replaced atomically with mode 0600 and removed when the home process stops cleanly.
- **Token lifetime.** A token is valid only while the home-process start that wrote it runs. A token file left by a crashed process is replaced at the next start, and no listener accepts its value.
- **Token handling.** The token exists only in the home process's memory, in the supervisor's memory and in the token file. It never appears in a command line, an environment variable, a URL, a response or a log. `delorun` client commands read the file when they send a request.

## The home lock

One home process per profile holds `run/<profile>/home.lock` for its lifetime ([C19](c19-home-process.md)). `delorun update` and `delorun recover` hold it while they change the store with no home process running.

- **Creation.** The lock is created by exclusive creation with mode 0600. It holds one JSON object: `{"v":1,"pid":<integer>,"startId":"<32 lowercase hexadecimal digits>","runtime":"<version>","startedAt":"<RFC 3339 UTC time>"}`, with `"processStart":"<start identity>"` and `"pidNamespace":"pid:[<inode>]"` where the platform reports them. `startId` is random and identifies one start in [C19](c19-home-process.md)'s protocol and in [C20](c20-operational-logs.md)'s records; it is not a secret.
- **Start identity.** A holder's start identity tells its process from a later one with the same process id. On Linux it is `linux:<boot id>:<start time>`, the boot id from `/proc/sys/kernel/random/boot_id` and field 22 of `/proc/<pid>/stat`; on macOS it is `darwin:<milliseconds since the epoch>`, the start time `ps -o lstart=` reports. Windows has none, and a record without one, as Delo wrote before it existed, is judged by its process id alone: a process that reuses that id reads as the holder.
- **Pid namespace.** On Linux a record names the pid namespace its `pid` is numbered in, the writer's own, as `/proc/self/ns/pid` links to it: `pid:[<inode>]`. A holder in another pid namespace, such as a container or a sandbox that shares the home, records a process id that names nothing in the reader's, so a reader whose own namespace differs from the record's, or cannot be read, does not judge the holder and treats it as alive. A record without `pidNamespace`, as Delo wrote before it existed, as other platforms write, and as Linux writes when `/proc/self/ns/pid` cannot be read, is judged by its process id and start identity alone. A `pidNamespace` that is present but not of that form makes the record malformed.
- **Stale lock.** A contender replaces the lock only when the record names no pid namespace or the contender's own, and the recorded process no longer exists (`ESRCH`) or the record carries a start identity and the live process with that id has another.
- **Unresponsive holder.** When the recorded process exists, with the recorded start identity where there is one, or the record names another pid namespace, but its update channel does not answer `status` within 2 seconds, the contender stops with `HOME_UNRESPONSIVE` and names the process id. It never takes the lock over.
- **Scope.** The lock is per profile. The desktop app's upstream lock `profiles/desktop/lock` is a different file, which Delo never takes, writes or waits for.

## Profiles

- **The CLI profile** is `default`, at `profiles/default/`, in upstream's profile layout (`package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `node_modules/`). Beside upstream's files, `delo-migrations.json` holds `{"v":1,"done":[<id>…]}`, the one-time profile changes a fresh start completed, such as adding the studio bundle to a profile an earlier release set up, at mode 0600. A fresh start runs each change not listed under the home lock before its Host boots, and an update's successor runs none. A record that does not read runs no change: the start warns on its output and in its log, naming the file and that removing it lets the next start apply the changes, and boots the profile unchanged. A profile with no record takes over `run/<profile>/migrations.json`, where an earlier release kept it, once. The profile history does not track the record, so a restore leaves it as it stands. `DELO_PROFILE` or `--profile` selects another CLI profile, whose name is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or a digit (`PROFILE_NAME_PATTERN`); the launcher and `delorun` refuse any other name with the same rule. Each CLI profile has its own `run/<profile>/` directory, lock, token and channels.
- **Reserved names.** No CLI profile takes a name that something else in the same home uses under `profiles/` or `run/`, or that a `delorun` command boots as its own profile (`RESERVED_PROFILE_NAMES`): `desktop`, the desktop app's profile; `headless`, the profile `delorun headless` boots, which Delo composes with the sandbox overlay and `@delo/bundle-headless`; `data-users`, because `run/data-users/` holds the home-wide exclusion's records, which a profile's run directory there would escape; `node_modules`, upstream's package layer `profiles/node_modules/`, which upstream refuses as a profile; and the Windows device names `con`, `prn`, `aux`, `nul`, `com1` to `com9` and `lpt1` to `lpt9`, which no folder can take on Windows. A reserved name is refused in any letter case. Upstream's template names that nothing boots in a Delo home, such as `web` and `tui`, stay usable. The launcher and every `delorun` command that takes `--profile` or `DELO_PROFILE` refuse a reserved name with the usage exit code before they read or change the profile or its run directory, naming the name and why (`profileNameProblem`), and setup's profile question asks again. `delorun plugin` and `delorun logs`, whose own parsers read `--profile` again, check every `--profile` value the command line carries, as `--profile <name>` or `--profile=<name>`, and refuse values that differ; a home holding a CLI profile under a reserved name is refused the same way until the person moves it to another name.
- **The headless profile** is `headless`, at `profiles/headless/`, in upstream's profile layout. The first `delorun headless` run creates it from upstream's `headless` template and links `@delo/bundle-headless` into it as the one-time change `headless-bundle`, which `profiles/headless/delo-migrations.json` records like a CLI profile's changes; every `delorun headless` run applies the changes the record does not list, under upstream's profile file lock and without a home lock, and a record that does not read runs none. The same run brings the bundle to a profile an earlier release created. A profile whose loader does not load the bundle stops `delorun headless` before boot, naming the bundle; removing `profiles/headless/delo-migrations.json` lets the next run link it again, and removing the `profiles/headless/` folder lets Delo create the profile again. The rows the bundle adds are held to [C19](c19-home-process.md#host-invariants)'s Host invariants.
- **The desktop profile** is upstream's `desktop` profile at `profiles/desktop/`, which only the desktop app manages. `delorun` refuses the name `desktop` for its own runs and for `delorun plugin`, as upstream's CLI refuses it.
- **`delorun plugin`** is upstream's `dsh plugin`, run against the home: under upstream's profile file lock it runs pnpm in a CLI profile's directory, changing its `package.json`, lockfile and `node_modules/`, and records the bundle list. It boots no Host, so the [confinement rules](#confinement-rules), the start overlays and C19's Host invariants do not apply: pnpm runs unconfined with the command's environment, runs a dependency's install scripts only when the profile's `pnpm-workspace.yaml` allows its build, and runs whatever a pnpm command such as `exec` or `dlx` names. It imports no plugin code. It registers in `run/data-users/` as a shared user while it runs.
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
- **`store.lock`.** The lock holds `{"v":1,"pid":<integer>,"id":"<32 lowercase hexadecimal digits>"}` at mode 0600, with the holder's `processStart` and `pidNamespace` as the home lock records them, and is created and replaced as the home lock is ([the home lock](#the-home-lock)): a lock in the reader's pid namespace, or without one, whose holder has exited or whose recorded start identity differs from the live process's is stale.
- **Installing.** An install takes `store.lock`, waiting at most 30 seconds before it stops with `STORE_BUSY`. It downloads into `~/.delo/staging/<16 hex>/`, which lies outside `runtimes/` on the same filesystem, and runs the client verification of [C2](c02-release-manifest.md): the root and timestamp walk, the manifest's signature and freshness, the release-log bundle and online check ([C18](c18-release-log.md)), and the archive's and file list's digests. It extracts with path checks (no absolute path, no `..` segment, no link, no device file and no entry outside the file list), checks every file against the file list, then renames the staging directory to `runtimes/<version>/` and places the manifest, file list and bundle beside it. Nothing appears under `runtimes/` before every check passes, and a failed install removes its staging directory and changes nothing else.
- **Installed files.** After the rename, directories under `<version>/` have mode 0555 and files 0444, or 0555 for executables; on Windows they carry the read-only attribute. The launcher's start check ([C2](c02-release-manifest.md#client-verification)), which hashes every file or compares the identities recorded after the last hash, is the integrity control; the modes stop accidental writes only.
- **Retention.** After a switch commits, the store keeps the versions that `current` and `previous` name, with their release files and identity records, and removes every other `<version>/` with its release files and identity record, and every directory under `staging/` that no install holds. A removal that fails, such as a Windows directory still in use, is retried at the next start. At most two versions and one staging directory exist at once.
- **Rollback scope.** A runtime rollback changes no file outside `runtimes/` and its identity records under `trust/runtime-files/`. Restoring the profile from its history, and the chat data from a copy the person took, are [C3](c03-update-report.md#rollback)'s steps, and every rollback goes through C3's table.

## Launcher and store compatibility

A launcher runs the active runtime only when it understands both the store and the runtime's launch interface.

- `store.json` carries the store layout number, which is 1. The layout number changes only when an entry of the store moves or changes meaning.
- Each runtime's signed manifest ([C2](c02-release-manifest.md)) carries its launch protocol number, which is 1. The launch protocol fixes the runtime's entry file, the arguments the launcher passes and the environment variables it sets (`DSH_HOME`, `DELO_HOME`, `DELO_PROFILE`, and `DELO_LAUNCHER_ROOTS`, the directory of the release roots the launcher ships, which `delorun verify`, every update, every rollback and the health check's start check anchor the stored root on. A runtime started without it installs, updates and rolls back to nothing, refusing with `ROOT_NOT_ANCHORED`, and its `delorun verify` holds the stored root to its own signatures only and says so; and `DELO_LAUNCHER_VERSION`, the launcher package's own version, which `delorun setup` pins its install of the `delorun` command to and `delorun verify` compares with the release's signed `npm` entries. The launcher drops every inherited `DELO_LAUNCHER_*` variable, so the runtime sees only the values it sets. A runtime started without the version offers no install of the command, and the variable is optional within launch protocol 1, so a launcher that sets none still starts every runtime of that protocol).
- The launcher runs `current` when it supports the store's layout number and the runtime's launch protocol number. Otherwise it stops with `RUNTIME_INCOMPATIBLE`, names both numbers and offers the update flow when the runtime is the older side, or a launcher update when the launcher is the older side. It changes neither `current` nor any other file of the store.

## The npm launcher and the install script

- **No runtime in the package.** The npm package `delorun` is the launcher only. It has no runtime dependencies and carries no runtime closure.
- **Download.** To install a version, the launcher downloads the release files that [C2](c02-release-manifest.md) names, over HTTPS only: the root and timestamp from `releases.delorun.com`, and the manifest, its bundle, the file list and the per-platform archive (`.tar.gz`, or `.zip` on Windows) from the GitHub Releases of Delo's public repository. It follows redirects only to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, and refuses any other host with `DOWNLOAD_REFUSED`. The release-log check reaches the host of the root metadata's `log.origin`, as [C18](c18-release-log.md) states. The channel's origin is a build constant of the launcher, and so is the log's origin in a build for a local log (a production build reads the log its trusted root names): the build passes them to the bundler, which writes them into the code, and no setting, argument or environment variable moves them afterwards. A build that names neither is the production launcher, with the hosts above. A build for a local channel may name an `https:` origin, or an `http:` origin on the computer's own loopback address, serving `timestamp.json`, `root/<n>.root.json` and `releases/download/v<version>/<file>` below it; the downloader then allows that origin's host and no other.
- **Download limits.** An archive is at most 1,073,741,824 bytes (1 GiB) and a manifest at most 4,194,304 bytes (4 MiB). A connection that does not open within 30 seconds, or that delivers no byte for 60 seconds, fails the download.
- **Verification before install.** The launcher verifies the archive against the signed manifest ([C2](c02-release-manifest.md)) and the manifest's entry in the release log ([C18](c18-release-log.md)) before any file appears under `runtimes/<version>/`, as [the runtime store](#the-runtime-store) states.
- **Without network.** The launcher runs the installed `current` after its offline start check. An install always needs the network and the log inclusion proof.
- **A `current` that fails its check.** When `current` fails the start check and `previous` passes it under the same anchored root, a bare `delorun`, `delorun start` or `delorun recover rollback`, each with only `--profile` options and nothing after `--`, makes the launcher print one line saying so and start `previous` with `delorun recover rollback`, the profile passed in `DELO_PROFILE`; that command applies [C3](c03-update-report.md#rollback)'s rollback table and refuses with `NO_UPDATE_RECORD` when no update to `current` is recorded. Every other command is refused: the launcher starts no release and changes nothing, names the release that failed its start check with the check's reason, names `delorun recover rollback` as the command that starts `previous` to roll back to it, and exits 1. Without such a `previous`, and whenever a release was named with `--release`, the start's refusal stands. The launcher switches no pointer itself.
- **Trust anchor.** `npx delorun` runs the launcher that npm serves before any Delo check can run. No workflow publishes the package, so no build attestation ties it to the public repository; publication with an attestation, and install scripts trusted through a published hash, are in the [release workflow design](../design/release-workflow.md).
- **The launcher copy.** No install script exists and `delorun start` installs no login item, so nothing writes `bin/`.

## Confinement rules

Upstream's sandbox dialects confine file writes only. In the CLI profile, which `delorun setup` creates and `delorun` or `delorun start` boots, Delo's settings on upstream's sandbox provider add the rules below for every command that runs under `read-only` or `workspace-write`. `delorun headless` boots under the same overlay; `delorun plugin` boots no Host, and none of these rules applies to its commands. A command that runs under `danger-full-access`, whether set by the person or approved as an escalation, runs unconfined, and no rule in this section applies to it.

| Rule | Confined commands cannot |
| --- | --- |
| `home-write` | create, change or delete anything under the home |
| `home-read` | read anything under the home except the read exemptions |
| `token-read` | read the start token |
| `home-connect` | connect to a socket or pipe of the home's channels |
| `docker-connect` | connect to the Docker socket at its real path |
| `wsl-interop` | start a Windows program through WSL's interop, by path, by bare name or as a copy |
| `vsock` | create a virtual-machine (`AF_VSOCK`) socket, the transport between a virtual machine such as WSL and its host, or an io_uring instance, whose requests create sockets without the `socket` call |

- **Read exemptions.** Confined commands may read and execute `runtimes/`, `skills/` and `dsh-runtimes/`. The PTC worker and other confined processes run the runtime's own `node` from `runtimes/`, commands run the person's skill scripts from `skills/`, and the desktop app's workspace dependencies run from `dsh-runtimes/`. No secret is written under an exemption; a component that keeps a secret uses `secrets/`. The model-facing file and search tools may also read the calling chat's own directory under `spill/`, where tool output too long for that chat is saved for the model to read, and no other chat's; confined commands may not read `spill/`, and no runner grants it.
- **Writable roots.** The home is never inside a writable root. `workspace-write` is refused with `HOME_IN_WRITABLE_ROOT` when the workspace root or an additional writable root, after resolving symbolic links, equals the home, lies inside it or contains it. A workspace whose root contains the home, such as `~`, still runs `read-only` commands.
- **The Docker socket.** The socket lies outside the home. `delorun start` resolves its path from the active Docker context: `/var/run/docker.sock` for a rootful engine, `$XDG_RUNTIME_DIR/docker.sock` for a rootless one, or the path Docker Desktop's context names. The rule covers the context's path, its resolved real path, every other mount on Linux that reaches the same socket found when a command is wrapped (such as Docker Desktop's `/mnt/wsl/docker-desktop-bind-mounts/<distro>/docker.sock` under WSL), and on macOS Docker Desktop's sockets `docker.raw.sock` and `docker.sock` under `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/docker.sock` when they exist at the start. Docker Desktop's other control sockets, such as those under `/mnt/wsl/docker-desktop/shared-sockets/` and `~/.docker/desktop/`, are not denied; denying their directories is in the [native confinement design](../design/native-confinement.md#docker-desktops-control-sockets). A context whose endpoint is TCP or SSH uses the network, which no dialect confines, so `docker-connect` is not enforced for it.
- **Other sockets.** Other `AF_UNIX` sockets, such as the ssh-agent socket, D-Bus and the display server, and the network stay reachable for confined commands.
- **Reporting.** No probe runs at start, and `delorun verify` reports the `confinement-rule` check of [C15](c15-verification-checks.md) as not run, so nothing reports which rules hold on a machine. The sandbox provider computes whether it found every other mount of the home and of each denied socket (alias coverage), and nothing reads that result. The probes, the check and setup's Docker labels are in the [native confinement design](../design/native-confinement.md#checks-at-each-start).
- **The escalation prompt.** The approval prompt for a `danger-full-access` escalation is upstream's, which names the requested mode and the operation and does not say that full access reaches Delo's home, its keys and tokens or the update channel. The statement is in the [native confinement design](../design/native-confinement.md#full-access).

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
- `delorun verify` and `delorun doctor` (`delo/apps/cli`): `doctor` checks the home's directory modes; the `verify` checks of modes and of each confinement rule are not built.
- Upstream's `packages/sandbox/sandbox-local` and `packages/sandbox/sandbox`: the per-dialect profiles and the writable-root refusal.
- `delo/apps/install` and `delo/apps/npm-launcher`: the download, verification and the launcher copy.
- `delo/packages/runtime-store`: the store, the pointer files, install, switch and retention.
- `delo/packages/home-process`: holding the lock through `delo/packages/home`, the start token and the update channel's socket ([C19](c19-home-process.md)).
- `delo/packages/supervisor`: the supervisor's socket and its token check ([C9](c09-runtime-supervisor.md)); no command launches it.
- `delo/packages/home-auth`: the secret files under `secrets/home-auth/`, read and written through `delo/packages/home`; every CLI profile loads it. `delorun export` writes the home key there.

## Compatibility

- The tree changes only by adding entries. Moving an entry, renaming it or changing its meaning raises the store layout number or is a breaking change with an upgrade guide under `delo/docs/upgrade-guide/`, and the runtime that makes the change reads both forms.
- `DELO_HOME`, `DELO_PROFILE`, the CLI profile name and the channel paths are external interfaces; changing one is a breaking change with an upgrade guide.
- Upstream's entries keep upstream's layout and compatibility rules, including its Session format.
- The launch protocol number rises only with a change to the entry file, the arguments or the environment that the launcher passes. A launcher supports every launch protocol number of the runtimes it can install.
- The types package follows Delo's version and changes in the same pull request as this page.

## Security

### Requirements

1. The home has mode 0700 and its protected files 0600. A component refuses a protected file that is laxer, a symbolic link or another user's, and the home process refuses to start on a laxer home, `secrets/` or `run/<profile>/`. `delorun verify` checks every one of them and prints the `chmod` fix, or on Windows the `icacls` fix. Not built: the `verify` check and every Windows check.
2. Delo's secrets live in files under `secrets/`, a directory every dialect denies reads of where it enforces `home-read` in the CLI profile. Upstream's credential files lie under the home and fall under the same rule. No secret is written to a read exemption, a profile, a patch file, a command's environment or command line, or a log.
3. Confined commands cannot write anything under the home on any dialect, and cannot read anything under it except the read exemptions wherever the dialect enforces `home-read`.
4. Confined commands cannot connect to the home's channels or to the Docker socket at its real path wherever the dialect enforces `home-connect` and `docker-connect`. bwrap mounts an empty tmpfs over the home and binds `/dev/null` over the Docker socket's real path, never over its parent directory, because `/run/user/<uid>/` also holds the ssh-agent socket. Seatbelt denies `file-read*` on the home and denies `network-outbound` to the `remote unix-socket` path literal of each channel socket and of both Docker socket paths. Landlock cannot deny a connect to a pathname socket, so `home-connect` and `docker-connect` are reported as `not-enforced` there.
5. Under Landlock the read denial on the home keeps the start token unreadable, so a confined command can connect to either channel but its request fails authentication, and `delorun verify` reports that state. Not built: the report.
6. Both channels accept a request only with the token of the current home-process start; a missing token, a wrong token and a previous start's token are refused alike. The token is 256 bits from the OS random source, is never logged or passed in a command line or environment, and is compared in constant time.
7. The protection rests on confining the agent's commands. A process of the person's user that runs outside the sandbox can read the token and can already run `delorun` and `docker` itself, and this contract claims no protection against it. No root-owned helper exists.
8. Commands under `danger-full-access` run unconfined; none of the rules above applies to them, and `delorun verify` reports `unconfined` for a workspace in that mode. The approval prompt for that mode states that full access reaches Delo's home, its tokens, the Docker supervisor and the update channel. Not built: the report and the prompt's statement.
9. The home is never inside a writable root, and `workspace-write` with a root that equals, lies inside or contains the home is refused.
10. A launcher never switches `current` on its own. An install verifies the archive, the manifest's signature and freshness, its log inclusion and every file hash before any file appears under `runtimes/<version>/`, and a pointer is replaced only by an atomic rename.
11. Delo never reads or writes upstream's `~/.dsh`.
12. On a Landlock-only system with a rootful Docker socket, `delorun verify` reports the socket as not enforced, and setup names it and offers the rootless engine. Not built.
13. Every command that boots a Host applies rules 2 to 4 and 9. Not built: `delorun plugin` boots no Host and applies none of them.
14. Under WSL, the kernel's `WSLInterop` binfmt handler starts any executable with a Windows header, wherever it lies, by sending a request to a socket in `/run/WSL`, which it finds whether or not `WSL_INTEROP` is set; the Windows process runs outside every Linux namespace, mount rule and protected home, with the person's Windows account. `delorun start` names `/run/WSL` as an escape socket directory on every machine, and the provider checks at each wrap whether it exists. Where it does, bwrap mounts an empty read-only tmpfs over it, so the program fails to start whichever way the command reaches the handler through those sockets: by its `/mnt/<drive>` path, by bare name through `PATH`, as a copy, through `/init` called directly, or with `WSL_INTEROP` naming a socket. A confined command sees `binfmt_misc` only read-only and without the handler's registration. A dialect that cannot deny socket connects, Landlock on Linux, refuses every confined command with `SANDBOX_UNSUPPORTED_POLICY` while the directory exists. WSL's kernel offers virtual-machine sockets to Windows, which rule 15 refuses. A workspace on a Windows drive stays readable and writable as its policy says. Not built under `delorun plugin`, as rule 13 states.
15. Wherever the kernel offers virtual-machine sockets, as `/proc/net/protocols` lists `AF_VSOCK` at a wrap, or an escape socket directory exists, or the list cannot be read, bwrap starts every confined command under a seccomp filter. It refuses `socket(AF_VSOCK, …)` with `EAFNOSUPPORT` and `io_uring_setup` with `ENOSYS` on x86-64 (x32 numbers included), i386, AArch64 and 32-bit Arm, and refuses every call of an architecture it does not name with `ENOSYS`. A kernel that loads vsock only on a first call has no hypervisor transport loaded, and such a socket reaches only the local loopback transport. The filter applies on any virtual machine with vsock, not only under WSL, and there: a program that requires io_uring fails; a 32-bit program that creates sockets through `socketcall`, as 32-bit glibc older than 2.23 does, cannot create any socket, because the filter cannot read that call's family; and on a host whose architecture the filter does not name, such as RISC-V, every confined command fails with a bwrap diagnostic. bwrap reads the filter from descriptor 9, so the wrap starts it from `/bin/sh`; a caller's descriptors 3 to 7 reach the command and its descriptors 8 and 9 do not, a missing `printf` or a closed standard input fails with a `bwrap:` diagnostic before the command starts, and the shell stays bwrap's parent, so a command whose bwrap is killed by a signal reports exit status 128 plus the signal's number. Landlock applies no seccomp filter; under WSL it refuses every command by rule 14, and on other virtual machines it leaves vsock and io_uring open. Not built under `delorun plugin`, as rule 13 states.

### Denial tests

Each test runs on every CI platform where its dialect exists, against local fixtures only.

| Test | Proves |
| --- | --- |
| `home-read-denied` | On each dialect that enforces `home-read`, a confined command in a workspace at `~` fails to read a fixture home-auth key under `secrets/` and the start token, and reads a file under `runtimes/` |
| `home-write-denied` | On every dialect, a confined command cannot create, change or delete a file under the home |
| `home-socket-connect-denied` | On bwrap and Seatbelt, a confined command's connect to a socket under the home fails, and its connect to a fixture ssh-agent socket outside the home succeeds |
| `docker-socket-connect-denied` | On bwrap and Seatbelt, a confined command's connect to the Docker socket at its real rootful path and at a rootless path fails, and an ssh-agent socket in the same directory as the rootless Docker socket stays reachable |
| `secret-mode-refused` | In a fixture home whose device-key file has mode 0640, the reading component refuses the file with `SECRET_FILE_MODE` and names the fix `chmod 600 <path>` |
| `home-mode-refused` | With the home at mode 0755, the home process refuses to start with `HOME_MODE` and names the fix `chmod 700 <path>` |
| `writable-root-refused` | `workspace-write` with the workspace root `~`, and with a root inside the home, is refused with `HOME_IN_WRITABLE_ROOT` and no command runs |
| `launcher-leaves-current` | A newer launcher and an older launcher each leave `current` and `previous` byte-identical |
| `pointer-switch-interrupted` | Killing the switching process before, between and after the two pointer writes leaves `current` naming a whole, installed version |
| `install-verify-first` | A bad signature, a bad file hash, a missing log entry and an archive entry with `..` each leave nothing under `runtimes/<version>/` and no staging directory |
| `reserved-profile-refused` | The launcher, `delorun --profile <name>` and `DELO_PROFILE=<name>` refuse `desktop`, `headless`, `data-users` and `node_modules`, naming the name and why; a fixture home holding a CLI profile named `data-users` is refused at start with the profile byte-identical and no run directory created; ordinary names, `web` and `tui` among them, are accepted |
| `dsh-home-untouched` | After a first run with an inherited `DSH_HOME`, a fixture `~/.dsh` is byte-identical and the runtime ran with `DSH_HOME` set to the Delo home |
| `wsl-interop-denied` | Under WSL with interop enabled, on bwrap, a confined command fails to start `whoami.exe` by its `/mnt/c` path, by bare name, as a copy in its workspace, through `/init` and with `WSL_INTEROP` naming each interop socket; it cannot connect to any interop socket, sees `/run/WSL` empty, sees no writable `binfmt_misc` mount and neither `register` nor `WSLInterop` in it; and it reads and writes a workspace on a Windows drive. Off WSL, each case skips by name with its reason |
| `wsl-vsock-denied` | Under WSL with interop enabled, on bwrap, a confined command cannot create a vsock socket, which the same command creates unconfined, and `io_uring_setup` fails with `ENOSYS`; IPv4 and Unix sockets are still created. On x86-64 the same holds through the 32-bit `int 0x80` entry (`socket`, `socketcall(SYS_SOCKET)`, `io_uring_setup`) and the x32 `socket`, each of which creates what it asks for unconfined. Off WSL, on another architecture or without a 32-bit entry, each case skips by name with its reason |
| `wsl-interop-landlock-refused` | Under WSL with interop enabled, the provider configured as `delorun start` configures it refuses a wrap on the Landlock rung with `SANDBOX_UNSUPPORTED_POLICY` naming `/run/WSL` |

### What this does not prove

- **Landlock and sockets.** Landlock cannot deny a connect to a pathname socket. On a Landlock-only system a confined command reaches a rootful Docker socket, which is equivalent to root, and nothing reports it; no Delo mechanism closes it there. The update channel stays closed only because the start token is unreadable.
- **Sockets recreated after a command starts.** bwrap binds `/dev/null` over a denied socket's path when the command is wrapped; a socket that is removed and created again at that path afterwards, such as after a Docker engine restart, is a new file that the bind does not cover, so a command that started before is not denied it. A component that keeps confined commands running for long, such as a terminal or a background job, rewraps or stops them when a denied socket is recreated; that component's contract carries this requirement.
- **Filesystems that hide their aliases.** Aliases are found by matching a path's device in `stat` against the mount table. btrfs and bcachefs subvolumes and overlayfs layers report devices the table does not tie to their other mounts, so on those filesystems aliases may go unfound; the provider reports alias coverage as `unknown` there, and no rule that depends on it reads `enforced`. A filesystem that exposes the home elsewhere under another device, such as a FUSE mirror, is not detected on any filesystem.
- **Bind mounts of replaced files.** A bind mount of a file under the home stays attached to that file after it is deleted or replaced, such as a key rotated by an atomic rename. The mount table then marks its root deleted, alias detection skips it, and its mount point still reaches the old contents; no profile covers it.
- **The write tools' check-then-write window.** The in-process write fence checks a path and then writes by path, so a confined command running at the same time can swap a directory on that path for a link in between; [descriptor-based writes](https://github.com/Delo-Run/delo/issues/71) would close it.
- **Mounts and links added later.** The profiles cover the other mounts of the home's filesystem and of each denied socket that exist when a command is wrapped. A mount added while it runs, and a hard link made outside the sandbox to a file under the home, are not covered.
- **Landlock and the home's ancestors.** Landlock grants reads by directory tree, so the profile grants every entry beside the way from `/` to the home rather than those directories themselves: a confined command cannot list `/`, the OS home or any other directory on that way, and an entry created in one of them after the command starts is unreadable to it. The entries are listed when the command is wrapped, so an entry removed before the launcher applies the ruleset makes the launcher refuse the run; the command does not run, unconfined or otherwise.
- **Windows.** windows-acl confines writes only. A confined command on Windows can read everything under the home, Delo's secrets, upstream's credential files and the start token included, so the token does not keep it from the update channel, and the home's modes are not checked there.
- **Commands outside the CLI profile.** `delorun headless` boots under the same sandbox overlay as the CLI profile, so its confined commands get the rules above, and its profile loads `@delo/bundle-headless`: the fetch guard, the instruction write, MCP and schedule consents, the full-access consent and the turn gate apply, protected from plugin management, a guard that asks a person refuses because the profile composes no approval answerer, and full access is refused for a working directory without a grant, which the person records at the home's computer in the studio or with `delorun workspace full-access`; under `delorun plugin`, which boots no Host and applies no overlay, a command that a plugin operation runs can read the whole home, the start token included, and connect to the update channel's socket.
- **WSL below the interop sockets.** Under bwrap the `vsock` filter refuses vsock sockets and io_uring. Abstract Unix sockets stay reachable on every dialect: a connect names its address in memory, which a seccomp filter cannot read, and the only kernel rule that scopes them, Landlock's abstract-socket scope from Linux 6.12, is not available on the 6.6 kernel WSL ships and is not a rule bwrap applies. WSL itself listens on none: its interop sockets are pathname sockets under `/run/WSL`, and the abstract names a WSL install lists belong to the connected ends of systemd's bus connections, which accept no connection. A program the person runs that listens on an abstract socket is reachable from confined commands. Hiding them all would take a network namespace (`--unshare-net`), which also removes network access. WSLg's display and audio sockets (`/tmp/.X11-unix`, `/mnt/wslg`) and the inherited `WSL_INTEROP` and `WSLENV` variables stay visible; the variables name only the hidden socket and the shared variable names.
- **The desktop app as a user of the chat data.** The desktop app shares `sessions/` and the stores beside it, but no file under the home shows whether it runs: `profiles/desktop/lock` is held only while the app prepares its profile, and its single-instance lock is the platform's, outside the home. So the home-wide exclusion of `run/data-users/` does not count it, and an update's copy, restore or rollback, `delorun trash`, `export` and `import` can run while the desktop app writes the same stores. This is an accepted gap for the first release, in which the desktop app is not shipped.
- **Docker over the network.** A Docker context whose endpoint is TCP or SSH is reachable by any command with network access on every dialect.
- **Full access.** Commands under `danger-full-access` can read every secret under the home and the start token, and can reach the update channel; no rule applies, and upstream's escalation prompt does not say so.
- **Which bundle declares a protected row.** The start's check that the sandbox row and each Delo row come from the bundle that declares them ([C19](c19-home-process.md#host-invariants)) recognises that bundle by its package name, `@deepseek-ai/dsh-base` or a name in the `@delo/` scope, not by the package directory it resolved to. A package of that name that the profile resolves from somewhere other than the running release passes the check.
- **The person's own processes.** A process of the person's user outside the sandbox can read and change everything under the home; the modes protect against other users, not against it.

## Enforcement per platform and dialect

This table states what each dialect enforces for a command of the CLI profile. Nothing reports it per machine: `delorun verify` reports the `confinement-rule` check as not run.

| Rule | bwrap (Linux) | Landlock (Linux) | Seatbelt (macOS) | windows-acl (Windows) | No sandbox or `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| `home-write` | enforced: the home is not bound writable | enforced: no write grant under the home | enforced: `deny file-write*` outside writable roots | enforced: the Low-integrity token cannot write outside labelled roots | unconfined |
| `home-read` | enforced: empty tmpfs over the home, exemptions bound read-only | enforced: a layered ruleset that grants reads outside the home and to the exemptions | enforced: `deny file-read*` on the home, exemptions allowed | not-enforced: the dialect does not confine reads | unconfined |
| `token-read` | enforced, as `home-read` | enforced, as `home-read` | enforced, as `home-read` | not-enforced, as `home-read` | unconfined |
| `home-connect` | enforced: the sockets are hidden under the tmpfs | not-enforced: Landlock has no right for connecting to a pathname socket; the token check refuses the request | enforced: `remote unix-socket` path literals | not-enforced: the dialect adds no socket or pipe rule, and the start token is readable | unconfined |
| `docker-connect` | enforced: `/dev/null` bound over the real socket path | not-enforced | enforced: path literals for the context path and the real path | not-enforced | unconfined |
| `wsl-interop` | enforced under WSL: an empty read-only tmpfs over `/run/WSL` | refused under WSL: every confined command fails with `SANDBOX_UNSUPPORTED_POLICY`, because Landlock has no right for connecting to a pathname socket | not applicable | not applicable | unconfined |
| `vsock` | enforced wherever the kernel offers vsock: a seccomp filter refuses `socket(AF_VSOCK, …)` and `io_uring_setup` | refused under WSL, as `wsl-interop`; not-enforced on other virtual machines | not applicable | not applicable | unconfined |
| Docker over TCP or SSH | not-enforced | not-enforced | not-enforced | not-enforced | unconfined |
| Other `AF_UNIX` sockets and the network | reachable | reachable | reachable | reachable | reachable |

- **Linux without bwrap.** Where unprivileged user namespaces are unavailable, bwrap fails its probe and upstream's provider selects Landlock. Where neither works, upstream's provider refuses to run confined commands, and every rule reads `unconfined` for a workspace the person runs in `danger-full-access`.
- **Landlock grants.** The layered ruleset grants each sibling along the path from `/` to the home, so a file created during a confined command directly in one of the home's ancestor directories is unreadable to that command.
- **macOS paths.** Seatbelt matches resolved paths, so the profile names `/private/var/...` for `/var/...` and both the Docker Desktop context path and its real path.
- **WSL2.** Delo inside WSL2 is Linux, and the Linux columns apply. The Windows host's processes are outside the sandbox; `wsl-interop` and `vsock` keep confined commands from starting them and from reaching Windows over the virtual-machine transport.
