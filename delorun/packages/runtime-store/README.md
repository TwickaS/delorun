---
description: "The @delorun/runtime-store library: contract C1's runtime store under ~/.delorun/runtimes, with the current and previous pointers switched by atomic rename, store.lock, installs from a staging directory, retention, rollback and contract C2's start check of every installed file."
---

# @delorun/runtime-store

English | [中文](README.zh.md)

## Summary

This package is the one implementation of [contract C1](../../docs/contracts/c01-home-layout.md#the-runtime-store)'s runtime store. It installs a verified runtime closure under `~/.delorun/runtimes/<version>/`, switches the `current` and `previous` pointer files by atomic rename so that a process killed mid-switch leaves one whole version current, keeps the previous version for rollback and removes the rest. Before every launch of the CLI runtime it runs [contract C2](../../docs/contracts/c02-release-manifest.md#client-verification)'s start check, which verifies the stored manifest and file list with the trusted root and every installed file's length and SHA-256, in every verification mode. Signatures are verified with [`@delorun/release`](../../apps/release/README.md)'s C2 verifier.

## Contents

- [Use this package](#use-this-package)
- [Pointers and switching](#pointers-and-switching)
- [Rollback](#rollback)
- [Installing](#installing)
- [Retention](#retention)
- [The start check](#the-start-check)
- [Launching](#launching)
- [Errors](#errors)
- [Crash safety](#crash-safety)
- [Not covered](#not-covered)
- [Development](#development)

## Use this package

```text
import { RuntimeStore, SUPPORTED } from '@delorun/runtime-store'

const store = new RuntimeStore({ home, platform: 'linux-x64', logger })
const plan = await store.prepareLaunch({ launcher: SUPPORTED, root: anchoredRoot, mode: 'warn', profile: 'default', args })
```

`home` is the resolved Delorun home from [`@delorun/home`](../home/README.md), `anchoredRoot` the root `trust/root.json` holds once it is anchored on the launcher's shipped roots ([the start check](#the-start-check)), `platform` the runtime platform of this machine (C2's `process.platform` and `process.arch` joined by a hyphen) and `logger` a [`@delorun/logs`](../logs/README.md) logger for retention's failures. Every failure is a `RuntimeStoreError` with a `code`, the `path` it concerns, the `detail` and the `remedies` the launcher offers.

## Pointers and switching

`pointers()` reads `current` and `previous` whole. A `current` that is missing, empty, above 65 bytes, not exactly one version and a newline, a symbolic link or a version without an installed directory is `NO_ACTIVE_RUNTIME`; a `previous` like that reads as absent.

- **Writing a pointer.** The new value goes to `<pointer>.tmp-<16 hex>`, created exclusively at mode 0600 and flushed, which is renamed over the pointer; on Linux and macOS `runtimes/` is then flushed. On Windows a rename that reports `EPERM`, `EBUSY` or `EACCES` is retried for at most 2,000 ms, and then fails with `POINTER_REPLACE_FAILED`, leaving the old pointer.
- **`switchTo(from, to)`** takes `store.lock`, requires `current` to name `from` (`POINTER_CHANGED` otherwise) and `to` to be installed (`NOT_INSTALLED`), then writes `previous` with `from` and `current` with `to`. It removes nothing.
- **`restore(before)`** writes both pointers back to the values read before an update, `previous` first and removed when it was absent.
- **`store.lock`** holds `{"v":1,"pid":…,"id":…}` at mode 0600, with the holder's `processStart` and `pidNamespace` where the platform reports them, and is `@delorun/home`'s `LockFile`: created whole by a hard link, a record without them read too. A live holder is waited for 30 seconds before `STORE_BUSY`; a lock whose holder is not alive by `@delorun/home`'s `holderAlive` (its process has exited, or another process now has its process id; a holder in another pid namespace is alive) is removed under a takeover guard named after its random id.

## Rollback

The store has no rollback of its own: every way back reads the update record and applies [contract C3](../../docs/contracts/c03-update-report.md#rollback)'s rollback table through `@delorun/update`'s one rollback function, which switches the pointers through `switchTo` or `restore` as its caller's path does. A pointer write, a rollback's included, changes no file outside `runtimes/`. The `NO_PREVIOUS` code stays for the launcher's refusal table and no store operation raises it.

## Installing

`install({ version, root, fill })` takes `store.lock` for the whole install and creates `staging/<16 hex>/` at mode 0700. `fill` downloads the release, runs C2's client verification steps 1 to 5 and extracts the archive into that directory, then returns the manifest, file list and release-log bundle, and may report each file's identity after it wrote the file from bytes that matched the list (`staged`). The store then:

1. verifies the manifest's and file list's targets signatures with `root`, and that they describe `version` and this platform;
2. sets the installed modes (files 0444, or 0555 for executables, directories 0555), leaving a file that already has its mode untouched;
3. checks every staged entry against the file list: the regular files are exactly the listed ones with their lengths and SHA-256, and no other kind of entry exists. Where change times are trusted, a file the fill reported against the same file list, whose identity `lstat` still shows, is not read again; the store first waits until the newest reported change time is 2 s old, so the record it writes vouches for every file;
4. writes the three release files beside the installation and, on a first install, `store.json`;
5. moves an installed copy of the same version out, renames the staging directory to `runtimes/<version>/`, sets it to 0555 and, where change times are trusted, writes its identity record;
6. on a first install, when `current` is absent or malformed, writes `current`.

Any failure fails with `INSTALL_VERIFY_FAILED` or the underlying error, removes the staging directory and leaves every pointer and installation as it was. A store whose `store.json` names a layout other than 1 is refused with `RUNTIME_INCOMPATIBLE`.

## Retention

`retain()` runs after a switch commits and at each start. Under `store.lock` it keeps the versions `current` and `previous` name with their release files and identity records, and removes every other installation (moved out of `runtimes/` first, so it stops reading as installed at once) with its release files and identity record, every directory under `staging/` and the temporary files of interrupted writes. Other entries are left alone. A removal that fails is logged at `warn` and retried by the next run. When `current` cannot be read, nothing is removed.

## The start check

`checkRuntime(version, root)` is the full check: it verifies the stored manifest and file list with the root, then hashes every file of the installation against the list, whatever the identity record says: a missing, changed, extra or non-regular entry fails it with `RUNTIME_CHANGED`, naming up to ten entries with their kind. The remedies are `reinstall`, and `rollback` when `previous` names another installed version. A root that revokes the targets key the runtime was signed with fails it as a bad signature does. A pass rewrites the identity record under `store.lock`, without waiting for it, only when the record is missing, unbound or names another identity, so a check of an intact runtime writes nothing. `delorun verify` and a rollback's report use it. `startCheckRuntime(version, root, fullCheckDays)` runs the start check `prepareLaunch` runs on any installed version, with the same record, interval and failures; an update uses it on the running version before it opens the channel, on an installed target in its prepare, in `HomeRuntimeStore.checkLaunch` before a successor starts, and in the health check's H1. `shareChecks(work)` runs work in which the checks of a version and an install of it share one file check, which `HomeRuntimeStore` uses for an update's prepare and a rollback's report: a start check shares any earlier check of the version, a full check only a full check or an install.

The start check that `prepareLaunch` runs reads the installation's identity record, `trust/runtime-files/delorun-<version>-<platform>.json` at mode 0600 (`identity.ts`). Where the installation lies on a file system whose change times only the local kernel sets (Linux on ext2 to ext4, XFS, Btrfs, F2FS or tmpfs), the record is bound to this version, platform, file list, manifest, installation directory and file system, and its last full pass is newer than `fullCheckDays` days, the start lists the installation and hashes only the files whose identity differs from the record, whose device is not the installation's, or whose change time is within 2 s of the record's capture time. Otherwise it runs the full check. A start that hashed a file and passed rewrites the record under `store.lock` without waiting; one that failed leaves it. The [start check design](../../docs/design/start-check.md) states what the identity comparison does and does not detect.

`resolveFullCheckDays(text)` resolves the interval from the launcher's `DELORUN_RUNTIME_FULL_CHECK_DAYS`: whole days from 0 to 30, 7 when unset, and an error for anything else.

The store never reads `trust/root.json` itself: every root it verifies with is its caller's, anchored on the release roots the launcher ships. The launcher anchors the root for its start; the home process's `HomeRuntimeStore` takes a `TrustedRootSource` (`root` in its options) that the CLI anchors on the roots the launcher names in `DELORUN_LAUNCHER_ROOTS`, and that refuses with `ROOT_NOT_ANCHORED` when the process was not started by the launcher, so no update installs and no rollback starts under a root a same-user process could have replaced. The clock is not read: an expired root does not stop a start.

## Launching

`prepareLaunch({ launcher, root, mode, fullCheckDays, profile, args })` writes nothing but the identity record. It reads `store.json`'s layout number, `current`, its verified manifest's launch protocol number and the start check, and returns launch protocol 1's command:

- the runtime's Node executable, `node/bin/node`, or `node/node.exe` on Windows;
- the arguments `app/node_modules/@delorun/cli/src/bin.js` followed by `args`;
- the variables `DSH_HOME` and `DELORUN_HOME` set to the home and `DELORUN_PROFILE` to the profile.

A layout or protocol the launcher does not support fails with `RUNTIME_INCOMPATIBLE`, naming both numbers, with the remedy `update` when the runtime is the older side and `launcher-update` otherwise. A launcher never switches `current`, whether it is newer or older than the active runtime. The check runs in the `warn`, `enforce` and `off` modes alike, and each refusal names the mode. `launchCommand(version, profile, args)` builds the same command without checking, for a caller that ran `checkRuntime` itself.

## Errors

| Code | Meaning |
| --- | --- |
| `STORE_BUSY` | `store.lock` was not free within 30 seconds (C1) |
| `NO_ACTIVE_RUNTIME` | `current` or `store.json` is missing or malformed, or `current` names a version that is not installed (C1) |
| `POINTER_REPLACE_FAILED` | A pointer rename failed after its retries; the old pointer is unchanged (C1) |
| `RUNTIME_INCOMPATIBLE` | The launcher does not support the store's layout or the runtime's launch protocol, or the runtime lacks the protocol's files (C1) |
| `INSTALL_VERIFY_FAILED` | A signature or file check failed during an install (C1) |
| `NO_PREVIOUS` | A rollback was requested and no installed `previous` exists (C19) |
| `RUNTIME_CHANGED` | The start check failed; C2 requires the stop and names no code |
| `POINTER_CHANGED` | A switch's `from` is not the version `current` names |
| `NOT_INSTALLED` | A pointer write names a version that is not installed |
| `ROOT_NOT_ANCHORED` | A `TrustedRootSource` could not anchor `trust/root.json` on the launcher's shipped roots: the process was not started by the launcher, its roots do not read, or none leads to the stored root |
| `TARGET_LOWER` | An update's prepare named a target, or the channel resolved a release, lower than the version `current` names; nothing was installed, and `delorun recover rollback` is the only way back |

## Crash safety

`tests/crash.integration.spec.ts` ends a switching process with `SIGKILL` before each of the ten durable steps of a switch (creating, writing, flushing and renaming each pointer's temporary file, and flushing `runtimes/`) and after it. Before `current`'s rename, `current` names the old version; after it, the new one; in every case the version it names passes the start check, and the next switch and retention succeed over the dead process's `store.lock`. The same spec kills a process that switches in a loop at random moments, twelve times, with the same result.

## Not covered

- Power loss: the flushes of the temporary file and of `runtimes/` are what keep a pointer after it, and no spec cuts power.
- Reinstalling an installed version moves the old copy out before renaming the new one in; a process killed between the two renames leaves that version uninstalled, and the launcher offers reinstall.
- Windows: the pointer-rename retry is specified by C1 and covered with a stand-in rename; modes become the read-only attribute, and the specs run on Linux and macOS.

## Development

The specs run with `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/runtime-store`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delorun/packages/runtime-store/tsconfig.json`. The specs sign fixture releases with Ed25519 keys generated in the test, and use temporary directories only.
