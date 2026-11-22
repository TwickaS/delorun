---
description: "The Delorun launcher npm serves as delorun: it verifies and installs the release its channel names through @delorun/install, refuses a runtime it cannot verify, and starts the installed runtime through its own Node executable (contract C1's launch protocol 1)."
---

# @delorun/npm-launcher

English | [中文](README.zh.md)

## Summary

This app is what `npx delorun` runs. It starts the runtime this computer has installed, and installs the release its channel names first when there is none to start. A start needs no network: contract C2's start check runs inside the runtime store. It hashes every file the store's identity record cannot vouch for, so a changed file it reads stops the start; the record carries no key, so a program running with the person's access can rewrite it to let any changed file, the runtime's Node and `delorun` itself included, pass ordinary starts, and the launcher therefore hashes every file before `delorun verify` runs. An install goes through [`@delorun/install`](../install/README.md), which verifies the release against its signed manifest and the release log, and leaves nothing under `~/.delorun/runtimes/` when either check refuses. The launcher never switches `current`: the store's install sets it, and only for a store that has no runtime at all.

## Contents

- [Commands](#commands)
- [The launch flow](#the-launch-flow)
- [What it prints](#what-it-prints)
- [The roots it ships](#the-roots-it-ships)
- [Building the package](#building-the-package)
- [Refusals](#refusals)
- [Exit codes](#exit-codes)
- [Development](#development)

<a id="commands"></a>

## Commands

| Command line | What it does |
| --- | --- |
| `delorun [--profile <name>]` | Starts the installed runtime with the arguments it was given; installs the channel's release first when the store holds no runtime |
| `--profile <name>` | The CLI profile, also passed to the runtime; the default is `default`, and `DELORUN_PROFILE` supplies it when the flag is absent. A profile name is 1 to 32 lowercase letters, digits, `-` or `_`, starting with a letter or a digit; anything else, and each name [contract C1](../../docs/contracts/c01-home-layout.md#profiles) reserves (`desktop`, `headless`, `data-users` and `node_modules`), is refused before the home is read |
| `--release <version>` | Read only before the runtime's command word, and after `repair`: in `delorun verify --release <version>` it is the runtime's own option. Installs this release instead of the channel's current one, when the store holds no runtime; a release the fresh timestamp does not name is refused, and with a runtime installed the launcher stops and names both versions rather than ignoring it |
| `--help`, `-h` | Prints the usage text; read only before the command word, and after `repair`, so `delorun start --help` is the runtime's own help |
| `--` | Ends the launcher's own options: every argument after it is passed to the runtime unchanged, so the runtime keeps its own `--release` and `--profile` |
| Every other argument | Passed to the runtime unchanged, because the runtime owns `delorun`'s commands |
| `DELORUN_RUNTIME_FULL_CHECK_DAYS` | The interval after which a start hashes every runtime file instead of comparing the identities recorded after the last hash: whole days from 0, which hashes at every start, to 30; 7 when unset. The interval runs from the time the identity record names, which a program running as the person can rewrite. `delorun verify` always gets 0. Any other value is refused with the usage text before the home is read |
| `DELORUN_REPAIR_MARK_GRACE_SECONDS` | The seconds a `run/repair.json` that does not parse still counts as a running repair, because the repair that writes it may be mid-write: whole seconds from 1 to 60; 5 when unset. Any other value is refused with the usage text before the home is read |

<a id="the-launch-flow"></a>

## The launch flow

`runLauncher` starts, and installs only when the store answers `NO_ACTIVE_RUNTIME`. A start reads `trust/root.json`, the root this home last verified, and hands it to the store, which runs contract C2's start check over `current` with the interval of its full hash, 0 for `delorun verify`, so every file is hashed before that command runs, and builds contract C1's launch protocol 1 command. The root is trusted only through the roots the launcher ships (see [The roots it ships](#the-roots-it-ships)); a start with no stored root is treated as a store without a runtime, because nothing on this home was verified yet. Before the runtime starts, the launcher runs contract C18's start check through `@delorun/release-verify`: the stored release-log bundle offline, then the online check against the log the root names, recording the state and the verified checkpoint under `trust/`. A check that could not complete prints the warning and starts; a verifiable failure prints the refusal, names `delorun verify` and a reinstall, and exits 1 without starting, except for `delorun verify` itself, which starts so the person can see every check. A missing stored bundle, which every install through the store keeps, is refused the same way, naming the bundle's path and offering `delorun recover rollback` or restoring the file; `delorun recover rollback` then starts `previous`, after its own start check and release-log check, as it does when `current` fails its start check. The runtime is started with `DELORUN_LAUNCHER_ROOTS` set to the launcher's `roots/` directory, `DELORUN_LAUNCHER_VERSION` set to the `version` of the launcher's own `package.json`, or without it when that does not read, and `DELORUN_START_CHECK` set to the record of the start check: when it began, whether it hashed every file, how many files it hashed, when the last full pass ran, and the launcher's version and directory, which `delorun verify` and the studio report without hashing again; an inherited `DELORUN_LAUNCHER_*` variable never reaches the runtime, which `delorun setup` pins its install of the `delorun` command to and `delorun verify` compares with the release's signed `npm` entries.

When `current` fails its start check, the launcher looks for the version the last update replaced, reading the home and writing nothing: the stored root must be anchored on the shipped roots, the store must name a `previous`, and `previous` must pass the same start check. With such a `previous`, what happens depends on the command. A bare `delorun`, `delorun start` and `delorun recover rollback`, each with only `--profile <name>` or `--profile=<name>` options around it and nothing after `--`, print one line, run the release-log start check for `previous`, and start it with `delorun recover rollback` instead of the person's arguments, the profile passed in `DELORUN_PROFILE` as launch protocol 1 passes it:

```text
Delorun did not start release 0.2.0: it failed its start check. Starting release 0.1.0, the version before the last update, to roll back to it: delorun recover rollback
```

That command applies contract C3's rollback table, so the pointers change only through it, and it refuses with `NO_UPDATE_RECORD` when no update to `current` is recorded; the launcher exits with its status. Every other command, `delorun verify`, `delorun stop`, `delorun status`, `delorun update`, `delorun recover status`, an unknown command, a start with any other option such as `--foreground`, and any command line with arguments after `--`, whose `--profile` the launcher does not read, included, is refused: the launcher starts no release, changes nothing in the home, prints which release failed its start check and why, names `delorun recover rollback` as the way to start `previous` and roll back to it, and exits 1, because running the rollback in its place would roll back the runtime and the chat data on a command that asked for neither:

```text
Delorun did not run delorun verify: release 0.2.0 failed its start check, so Delorun ran no release.
Why: RUNTIME_CHANGED: runtime 0.2.0 differs from its signed file list: app/entry.js (sha256)
What you can do:
  Start release 0.1.0, the version before the last update, to roll back to it: delorun recover rollback --profile default
```

Without a usable `previous`, and whenever a release was named with `--release`, the start's own refusal stands for every command.

A release named with `--release` is installed, and this launcher installs one only when the store holds no runtime: it never replaces the runtime a person already has and never switches `current`. A store that holds a runtime therefore refuses the named release, naming the version installed and offering the runtime's own update, rather than starting the installed runtime and dropping what was asked for.

An install resolves the release, asks the store to install it with the channel's `fill` as the download step, and then keeps the two versions the pointers name, removing the rest. A retention the store cannot finish is reported as a warning and retried on the next run; it never fails the launch.

The runtime runs in this process's stead: the launcher spawns it with the environment the store built over this process's own — minus the variables that load code or decide trust, whatever their case: `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_COMPILE_CACHE`, `NODE_V8_COVERAGE`, `NODE_ICU_DATA`, `OPENSSL_CONF`, `OPENSSL_MODULES`, `OPENSSL_ENGINES`, `GCONV_PATH`, `LOCPATH`, `LD_*` and `DYLD_*` (a denylist, not an allowlist, because the runtime runs the person's commands and tools, which need `PATH`, proxies, credentials, an SSH agent and toolchain variables that an allowlist would remove), so the shell that ran `npx delorun` cannot load code into the runtime's Node or its dynamic loader, and cannot decide what its HTTPS connections trust (`DROPPED_LAUNCH_ENV` and `inheritableEnvironment` in `@delorun/contract-home-layout`, which an update's successor and the studio's Check now apply too) — shares its standard streams, passes on the SIGTERM and SIGHUP it receives while the runtime runs (a Ctrl-C reaches the runtime through the terminal, so the launcher only waits; a SIGINT sent to the launcher's process alone is ignored, so a script that stops Delorun uses SIGTERM), and exits with the runtime's own status, or 128 plus the signal's number when a signal ended it.

<a id="what-it-prints"></a>

## What it prints

An install prints a checklist to standard error, so the output of the command that runs next stays on standard output unmixed. Each step is a line: a spinner while it runs, then a tick and how long it took, with the durations right-aligned in one column. The download and the extraction also show a bar under their line. On a terminal the block redraws in place:

```text
✔ Found release 0.1.0-preview.2.7 on the stable channel                    0.4s
✔ Signature checked (release root 1)                                       0.1s
✔ Release log checked                                                      0.6s
⠹ Downloading delorun-0.1.0-preview.2.7-linux-x64.tar.gz
  ██████████████░░░░░░░░░░   58%  126.4 / 218.0 MB  6.7 MB/s  ~14s left
```

The bar shortens, and then drops the time left, the speed and the amounts, on a narrow terminal. The speed and the time left are worked out over the last five seconds, and the time left reads `estimating…` until a second of data gives a speed. A download that delivers no byte for three seconds reads `waiting for data… 12s`, and the spinner keeps turning, so the screen is never silent. Setting `NO_COLOR` removes the colour.

The steps follow the order the checks run: the signature is checked before the archive is downloaded, because the signed manifest is what names the archive and its size. When the install ends and the command says what happens next, it prints one `Next:` line: `a few setup questions` for a bare `delorun` on a home without the CLI profile and for `delorun setup`, `opening the studio` for a bare `delorun` on a home that has it and for `delorun start`, and no line for any other command. When standard error is not a terminal, or `TERM` is `dumb`, the same steps print as plain lines, and the download prints one line for each tenth:

```text
✔ Found release 0.1.0-preview.2.7 on the stable channel  0.4s
✔ Signature checked (release root 1)  0.1s
✔ Release log checked  0.6s
Downloading delorun-0.1.0-preview.2.7-linux-x64.tar.gz…
  10%  21.8 / 218.0 MB  6.7 MB/s
  20%  43.6 / 218.0 MB  6.8 MB/s
…
✔ Downloaded 218.0 MB at 6.8 MB/s average  32s
✔ Download matches its signed hash  0.9s
Unpacking the runtime…
  10%  352 / 3,516 files
…
✔ Unpacked the runtime (3,516 files)  4.5s
✔ Installed release 0.1.0-preview.2.7  0.2s
✔ Starting Delorun  0.0s
Next: a few setup questions
```

When the release log or its witness cannot be reached, or its newest witnessed checkpoint is older than 24 hours, the step is marked `!` with the reason, and one warning follows in the words of contract C18:

```text
! Release log not checked (the release log did not answer: …)  0.6s
  Warning: Release 0.1.0-preview.2.7 has not been checked against the release log; Delorun checks it at the next connection.
```

The install then goes on with the release's signature, and the home records the release as `unchecked` in `trust/release-log.json` (see [`@delorun/install`](../install/README.md#the-release-log)). A log that answers and contradicts the release refuses instead, as [Refusals](#refusals) describes: the running step is marked `✖`, and the refusal's own text follows. A question the launcher asks, such as the one `delorun repair` asks, clears the checklist while it is asked. A start prints none of these lines. The checklist is `@delorun/install`'s `InstallRenderer`, which `src/progress.ts` re-exports, so `delorun update`, `delorun repair` and a plugin pack download draw the same lines from the same events. The renderer only displays: verification, its order, its refusals and their messages do not depend on it.

A Node older than the package's `engines` range (`>=24.9.0`) gets one line, with the version it found and where to get a newer one, and exit status 1, before anything else runs: the published `bin` (`src/entry.ts`) loads the launcher's main module only after the version check passes, so a Node that cannot read the main module's syntax still reads the refusal.

<a id="the-roots-it-ships"></a>

## The roots it ships

The launcher trusts a release only through the root files in its own package's `roots/` directory, `1.root.json`, `2.root.json` and on. The shipped roots must form a chain: each is signed by the root before it as well as by its own keys, which the launcher checks when it reads them and the build checks when it packs them. A newer root is reached by walking from the newest root the package ships, so a package whose roots skip a version refuses every install rather than trusting what the network offers. A package with no root at all refuses every install with `NO_TRUSTED_ROOT` and tells the person to use the install script on the release page instead. The rule is `@delorun/install`'s `readShippedRoots`, which the runtime this launcher starts applies to the same directory through `DELORUN_LAUNCHER_ROOTS`.

The same roots anchor a start. The root a home stored is read back and checked against them before the store runs its start check: at a version the launcher ships, the stored root must be that very root, keys and roles included, so a root an install did not verify cannot make an unrelated runtime look signed. A stored root older than the newest shipped root, one older than every shipped root included, is not the anchor: the start check runs under the newest shipped root, so a targets key that root revoked fails the start, and the stored file stays as it is until the next install or update stores the root it walks to. A stored root newer than every shipped root is trusted only with the chain an install walked to it under `trust/roots/`: every version from a shipped root to the stored one, each signed by the previous root's keys and by its own. A stored root that no shipped root leads to is refused, which is `RUNTIME_CHANGED`, so a root a restore or a sync placed under `trust/` anchors nothing. A launcher whose package later carries the newer root checks it exactly. The runtime anchors every update, rollback and health check on the same roots, through `DELORUN_LAUNCHER_ROOTS`, so a root a same-user process wrote over `trust/root.json` is refused there too.

<a id="refusals"></a>

## Refusals

`refusalFor` prints any failure on standard error in the refusal format `delorun` shares (`@delorun/home`'s `renderRefusal`): a line saying what Delorun did, a `Why:` line with the error's code and the release, host, file or detail it concerns, and the remedies under `What you can do:`. Each package describes its own errors (`@delorun/home`'s refused home, `@delorun/install`'s install failures, `@delorun/runtime-store`'s store refusals and `@delorun/release-verify`'s release-log failures); `LAUNCHER_DESCRIBERS` lists the ones the launcher composes. Any other failure prints `Delorun stopped: <message>`, with no stack and no remedy. Every refusal passes `@delorun/logs`'s redactor before it is printed (`renderLauncherRefusal`), so a key, token or credential path in a message prints as `[redacted:<kind>]`. The published `bin` installs `@delorun/home`'s last-resort handler before it loads the main module (`installLauncherLastResort`): a failure the launcher did not catch prints the same redacted refusal, with a last remedy saying the launcher keeps no log, and exits 1, never a Node stack. An install refusal offers the remedies its code carries:

- An unreachable release host asks the person to check the connection and run the same command again. An unreachable log is not a refusal: the install warns and goes on.
- A launcher with no trusted root points at `npx delorun@latest`, which ships the current roots.
- A trust file that does not read asks the person to move it aside; the launcher stores it again from the release it verifies.
- A stored root that is not one the launcher ships, or that no shipped root leads to, asks the person to install the release again, which re-verifies the root chain from the shipped roots and stores what it proves.
- A refused or unverifiable release asks the person to run the same command again when the release page names a newer release, and to report it if it repeats.
- A `--release` on a store that holds a runtime names the release asked for and the version installed, and offers the runtime's own update.
- A profile name that is not one, or a `--release` that is not a version, is a wrong command line: the launcher prints the usage text and exits 2, before reading or writing the home.

A store refusal offers the store's own remedies as commands the person can run, such as installing the release again or switching back to the version kept for rollback.

<a id="building-the-package"></a>

## Building the package

`src/build.ts` builds the package npm serves as `delorun` and packs it. The package holds the launcher bundled into plain JavaScript with its dependencies inlined (`dist/bin.js` and one chunk), the root files in `roots/`, `LICENSE` and a short `README.md`, with `bin` pointing at `dist/bin.js` and `engines.node` set to `>=24.9.0`; `npx` runs it on Node alone.

```sh
node_modules/.bin/tsx delorun/apps/npm-launcher/src/build.ts --root <root.json>... --out <dir> \
  [--channel-origin <origin>] [--log-origin <origin>] [--package-version <version>]
```

- Each `--root` is copied to `roots/<n>.root.json`, named by the root's own version, after it verifies with its own root signatures. The roots together must be consecutive versions; a build with no `--root` is refused, because the launcher it made would refuse every install with `NO_TRUSTED_ROOT`.
- `--channel-origin` and `--log-origin` become build constants that the bundler writes into the code; no setting, argument or environment variable moves them afterwards. Without them the build is the production launcher: the channel is `releases.delorun.com`, with GitHub Releases and `releases.delo.run` as mirrors under contract C1's host list, and the log is the one the trusted root names: the root's `log.origin` is the log's host, and the launcher reads `https://<host>/api/v2/checkpoint` and the tiles below `https://<host>/api/v2/`, which is Rekor v2's layout. An origin is `https:` with no path, or `http:` on this machine's loopback address, so a local channel and log can serve a build. A channel origin serves `timestamp.json`, `root/<n>.root.json` and `releases/download/v<version>/<file>`, the layout `apps/release/src/local-release.ts` writes; the downloader then allows that origin's host and no other.
- The package is staged at `<out>/package` and packed to `<out>/delorun-<version>.tgz` by `npm pack`. `--package-version` sets the version, and this package's own is the default.
- Before it packs, the build scans the whole output folder, the staged package and anything else in `<out>`, for the building user's home directory, the user name as a folder (`/<name>/` or `\<name>\`) and a unique build root `delorun-release-build-*`, and refuses with every offending file named, so no tarball is written. Nothing skips the scan (`@delorun/release-formats/gate/home-paths`, the gate the release build runs over its closures).

<a id="exit-codes"></a>

## Exit codes

| Code | When |
| --- | --- |
| 0 | The runtime ran and ended with status 0, or the usage text was printed |
| 1 | Delorun refused or failed and nothing ran (a host no release publishes a runtime for included), or the runtime ended with its own nonzero status; a signal that ended the runtime counts as 128 plus its number, such as 130 for Ctrl-C |
| 2 | The command line was wrong |

<a id="development"></a>

## Development

The tests in `tests/` drive `runLauncher` with a stand-in store, channel and spawn, so no network is contacted and nothing is installed on the machine running them; `tests/build.integration.spec.ts` builds and packs the launcher with a throwaway root. The end-to-end spec in [`@delorun/release`](../release/README.md#local-release) installs a local release through a packed launcher. Run them with the repository's Vitest configuration: `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/npm-launcher`.
