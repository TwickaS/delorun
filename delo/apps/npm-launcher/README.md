---
description: "The Delo launcher npm serves as delorun: it verifies and installs the release its channel names through @delo/install, refuses a runtime it cannot verify, and starts the installed runtime through its own Node executable (contract C1's launch protocol 1)."
---

# @delo/npm-launcher

English | [中文](README.zh.md)

## Summary

This app is what `npx delorun` runs. It starts the runtime this computer has installed, and installs the release its channel names first when there is none to start. A start needs no network: contract C2's start check runs inside the runtime store, so a runtime that no longer matches its signed file list does not start. An install goes through [`@delo/install`](../install/README.md), which verifies the release against its signed manifest and the release log, and leaves nothing under `~/.delo/runtimes/` when either check refuses. The launcher never switches `current`: the store's install sets it, and only for a store that has no runtime at all.

## Contents

- [Commands](#commands)
- [The launch flow](#the-launch-flow)
- [The roots it ships](#the-roots-it-ships)
- [Refusals](#refusals)
- [Exit codes](#exit-codes)
- [Development](#development)

<a id="commands"></a>

## Commands

| Command line | What it does |
| --- | --- |
| `delorun [--profile <name>]` | Starts the installed runtime with the arguments it was given; installs the channel's release first when the store holds no runtime |
| `--profile <name>` | The CLI profile, also passed to the runtime; the default is `default`, and `DELO_PROFILE` supplies it when the flag is absent. A profile name is 1 to 32 lowercase letters, digits, `-` or `_`, starting with a letter or a digit; anything else, `desktop` included, is refused before the home is read |
| `--release <version>` | Installs this release instead of the channel's current one, when the store holds no runtime; a release the fresh timestamp does not name is refused, and with a runtime installed the launcher stops and names both versions rather than ignoring it |
| `--help`, `-h` | Prints the usage text |
| `--` | Ends the launcher's own options: every argument after it is passed to the runtime unchanged, so the runtime keeps its own `--release` and `--profile` |
| Every other argument | Passed to the runtime unchanged, because the runtime owns `delorun`'s commands |

<a id="the-launch-flow"></a>

## The launch flow

`runLauncher` starts, and installs only when the store answers `NO_ACTIVE_RUNTIME`. A start reads `trust/root.json`, the root this home last verified, and hands it to the store, which runs contract C2's start check over `current` and builds contract C1's launch protocol 1 command. The root is trusted only through the roots the launcher ships (see [The roots it ships](#the-roots-it-ships)); a start with no stored root is treated as a store without a runtime, because nothing on this home was verified yet.

A release named with `--release` is installed, and this launcher installs one only when the store holds no runtime: it never replaces the runtime a person already has and never switches `current`. A store that holds a runtime therefore refuses the named release, naming the version installed and offering the runtime's own update, rather than starting the installed runtime and dropping what was asked for.

An install resolves the release, asks the store to install it with the channel's `fill` as the download step, and then keeps the two versions the pointers name, removing the rest. A retention the store cannot finish is reported as a warning and retried on the next run; it never fails the launch.

The runtime runs in this process's stead: the launcher spawns it with the environment the store built over this process's own — minus `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `LD_*` and `DYLD_*`, so the shell that ran `npx delorun` cannot load code into the runtime's Node or its dynamic loader, and cannot decide what its HTTPS connections trust — shares its standard streams, and exits with the runtime's own status.

<a id="the-roots-it-ships"></a>

## The roots it ships

The launcher trusts a release only through the root files in its own package's `roots/` directory, `1.root.json`, `2.root.json` and on. A newer root is reached by walking from the newest root the package ships, so a package whose roots skip a version refuses every install rather than trusting what the network offers. A package with no root at all refuses every install with `NO_TRUSTED_ROOT` and tells the person to use the install script on the release page instead.

The same roots anchor a start. The root a home stored is read back and checked against them before the store runs its start check: at a version the launcher ships, the stored root must be that very root, keys and roles included, and a stored root older than the oldest shipped one is refused, so a root an install did not verify cannot make an unrelated runtime look signed. A stored root newer than every shipped root is trusted only with the chain an install walked to it under `trust/roots/`: every version from a shipped root to the stored one, each signed by the previous root's keys and by its own. A stored root that no shipped root leads to is refused, which is `RUNTIME_CHANGED`, so a root a restore or a sync placed under `trust/` anchors nothing. A launcher whose package later carries the newer root checks it exactly.

<a id="refusals"></a>

## Refusals

`refusalFor` turns any failure into one sentence on standard error: what Delo did, why, and what the person can do about it. An install refusal names the release, host or file it concerned and offers the remedies its code carries:

- An unreachable host or an unchecked log asks the person to check the connection and run the same command again.
- A launcher with no trusted root points at the install script on the release page.
- A trust file that does not read asks the person to move it aside; the launcher stores it again from the release it verifies.
- A stored root that is not one the launcher ships, or that no shipped root leads to, asks the person to install the release again, which re-verifies the root chain from the shipped roots and stores what it proves.
- A refused or unverifiable release asks the person to run the same command again when the release page names a newer release, and to report it if it repeats.
- A `--release` on a store that holds a runtime names the release asked for and the version installed, and offers the runtime's own update.
- A profile name that is not one, or a `--release` that is not a version, is a wrong command line: the launcher prints the usage text and exits 2, before reading or writing the home.

A store refusal offers the store's own remedies as commands the person can run, such as installing the release again or switching back to the version kept for rollback.

<a id="exit-codes"></a>

## Exit codes

| Code | When |
| --- | --- |
| 0 | The runtime ran and ended with status 0, or the usage text was printed |
| 1 | Delo refused or failed and nothing ran, or the runtime ended with its own nonzero status |
| 2 | The command line was wrong |

<a id="development"></a>

## Development

The tests in `tests/` drive `runLauncher` with a stand-in store, channel and spawn, so no network is contacted and nothing is installed on the machine running them. Run them with the repository's Vitest configuration: `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/npm-launcher`.
