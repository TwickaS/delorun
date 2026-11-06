---
description: "The @delo/home library: contract C1's home for every Delo component, from resolving ~/.delo and creating its tree at mode 0700 to reading and writing protected files at 0600 and the per-profile home lock."
---

# @delo/home

English | [中文](README.zh.md)

## Summary

This package is the one implementation of [contract C1](../../docs/contracts/c01-home-layout.md)'s home that every Delo component uses. It resolves the Delo home, creates the home and Delo's entries in it at mode 0700, refuses a directory or protected file that other users can reach, reads and writes protected files at mode 0600, and takes the per-profile home lock so that one home process runs per profile. Names, modes and error codes come from [`@delo/contract-home-layout`](../contract-home-layout/README.md). The `delorun` command ([`delo/apps/cli`](../../apps/cli/README.md)) is its first consumer.

## Contents

- [Use this package](#use-this-package)
- [Resolving the home](#resolving-the-home)
- [The tree and its modes](#the-tree-and-its-modes)
- [Protected files](#protected-files)
- [The home lock](#the-home-lock)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Use this package

```text
import { ensureHomeTree, readProtectedFile, resolveDeloHome, writeProtectedFile } from '@delo/home'
```

Every failure the contract defines is a `HomeLayoutError` with C1's `code`, the `path` it concerns and, where one exists, the shell command in `fix`; its message ends with that command.

## Resolving the home

`resolveDeloHome(env)` returns the home: `DELO_HOME` when it is set and not blank, otherwise `~/.delo` (`%USERPROFILE%\.delo` on Windows), with a leading `~` expanded to the OS home directory and the path normalised. It refuses a relative path, the filesystem root and the OS home directory with `HOME_INVALID`, and upstream's `~/.dsh`, a path inside it or a link to either with `HOME_IS_DSH_HOME`; links are resolved before comparing. It also returns an inherited `DSH_HOME` that names another directory, which the caller ignores and may report.

## The tree and its modes

`ensureHomeTree(home, profile)` creates the home, each of Delo's top-level entries (`runtimes/`, `staging/`, `trust/`, `status/`, `catalogue/`, `secrets/`, `run/`, `supervisor/`, `bin/`, `alerts/`) and `run/<profile>/` at mode 0700 through `mkdir` with that mode, so the umask can only narrow it. It then checks the home, `secrets/` and `run/<profile>/` with `checkPrivateDirectory`, which refuses a symbolic link, another user's directory or one with a group or other bit set with `HOME_MODE` and the fix `chmod 700 <path>`. An existing directory keeps its mode: nothing here changes a mode. Upstream's entries keep upstream's layout and modes, and this package creates none of them.

## Protected files

C1's protected files are every file under `secrets/`, `trust/`, `status/` and `catalogue/`, the start token, the supervisor's roots file and the operational log files.

- `writeProtectedFile(path, data)` writes a sibling temporary file created exclusively at mode 0600, flushes it, renames it over the path and, on Linux and macOS, flushes the directory. A failed write removes the temporary file and leaves the path unchanged.
- `readProtectedFile(path)` refuses, with `SECRET_FILE_MODE`, a path that is a symbolic link, not a regular file, another user's, or has a group or other bit set, with the fix `chmod 600 <path>` for a laxer mode. It examines the path before opening it, so a FIFO or device is never opened, and checks the opened file again, so a file swapped in between is refused.
- `checkProtectedFile(path)` runs the same check without reading the file.

## The home lock

`acquireHomeLock({ runDirectory, runtime, probe })` takes `run/<profile>/home.lock`, whose record is C1's JSON object (`v`, `pid`, `startId`, `runtime`, `startedAt`) at mode 0600, and returns a handle whose `release()` removes the lock when it still holds this holder's record; `release()` is synchronous so a process `exit` listener can call it.

- **Creation.** Every file the lock writes is written to a temporary file and hard-linked to its path, so it appears whole or not at all, and of any number of contenders exactly one link succeeds.
- **A live holder** is never taken over. The `probe` asks it for its status within C1's two seconds: an answer gives `HOME_RUNNING`, silence `HOME_UNRESPONSIVE`. Until the home process's update channel exists, the CLI passes a probe that counts a live holder as answering.
- **A stale lock**, whose process no longer exists, is removed by `removeStaleLock` under a takeover guard `home.lock.takeover-<startId>`, created the same way, so one contender at a time may remove that one record. Holding the guard, the contender removes the lock only when it still holds that `startId`. A `startId` is random and never reused, and only the guard holder may remove its record, so a contender never removes a lock other than the stale one it found, however late it runs. A guard left by a contender that died is removed the same way under a guard named after its own random id, and a contender waits up to 10 seconds while a live one finishes a removal.

## Not yet implemented

- The Windows DACL check of C1's Windows rule ([#48](https://github.com/Delo-Run/delo/issues/48)): on Windows the directory and protected-file checks look only at the file type.
- The start token, the channels' sockets and the confinement probes, which the home process adds.

## Development

The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delo/packages/home/tsconfig.json`. The lock specs race up to 16 processes from `tests/fixtures/lock-contender.ts` over free and dead holders' locks, round after round, and use temporary directories only.
