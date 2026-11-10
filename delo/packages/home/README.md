---
description: "The @delo/home library: contract C1's home for every Delo component, from resolving ~/.delo and creating its tree at mode 0700 to reading and writing protected files at 0600 and the per-profile home lock."
---

# @delo/home

English | [中文](README.zh.md)

## Summary

This package is the one implementation of [contract C1](../../docs/contracts/c01-home-layout.md)'s home that every Delo component uses. It resolves the Delo home, creates the home and Delo's entries in it at mode 0700, refuses a directory or protected file that other users can reach, reads and writes protected files at mode 0600, takes the per-profile home lock so that one home process runs per profile, and owns the per-start token and the listener of the two channels that check it, the update channel and the Docker supervisor's socket. Names, modes and error codes come from [`@delo/contract-home-layout`](../contract-home-layout/README.md). The `delorun` command ([`delo/apps/cli`](../../apps/cli/README.md)) is its first consumer.

## Contents

- [Use this package](#use-this-package)
- [Resolving the home](#resolving-the-home)
- [The tree and its modes](#the-tree-and-its-modes)
- [Protected files](#protected-files)
- [The home lock](#the-home-lock)
- [The start token](#the-start-token)
- [The token channels](#the-token-channels)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Use this package

```text
import { ensureHomeTree, readProtectedFile, resolveDeloHome, writeProtectedFile } from '@delo/home'
```

Every failure the contract defines is a `HomeLayoutError` with C1's `code`, the `path` it concerns, the `detail` and, where one exists, the shell command in `fix`; its message ends with that command. The package also owns the refusal format `delorun` and its npm launcher print every failure in: a `Refusal` holds what Delo did, why and what the person can do, `renderRefusal` prints it, and `describeFailure` reads an error through the first `RefusalDescriber` whose class it matches, or as `Delo stopped: <message>`. Each package exports the describer of its own errors next to them, such as `homeLayoutDescriber` here, so this package imports none of them. `renderRefusal` takes the program's redactor (`TextRedactor`, which `@delo/logs`'s `Redactor` satisfies; this package does not import it, because `@delo/logs` depends on it) and returns the whole text through it, so a lead, reason or remedy, the raw message of `Delo stopped:` included, never prints a secret the operational logs would redact. The last-resort report (`src/last-resort.ts`) covers a failure no command caught: `renderFatal` prints it as the program's refusal with a last remedy that says where the full detail is, recorded in the program's log or nowhere, and `claimFatalHandler` holds a process to one such handler. `installLastResort` is the handler of a program that boots no upstream profile, the npm launcher: on an uncaught exception or an unhandled rejection it prints `renderFatal`'s text, never a stack, and exits 1 even when standard error is gone. `delorun` reports through upstream's `installFailLoud` with the same rendering ([`delo/apps/cli`](../../apps/cli/README.md)).

## Resolving the home

`resolveDeloHome(env)` returns the home: `DELO_HOME` when it is set and not blank, otherwise `~/.delo` (`%USERPROFILE%\.delo` on Windows), with a leading `~` expanded to the OS home directory, the path normalised and every symbolic link in its parent path resolved, so the home names the same directories that the files under it report; a home that is itself a link stays a link, which `checkPrivateDirectory` refuses. It refuses a relative path, the filesystem root and the OS home directory with `HOME_INVALID`, and upstream's `~/.dsh`, a path inside it or a link to either with `HOME_IS_DSH_HOME`; links are resolved before comparing. It also returns an inherited `DSH_HOME` that names another directory in neither spelling, which the caller ignores and may report.

## The tree and its modes

`ensureHomeTree(home, profile)` creates the home, each of Delo's top-level entries (`runtimes/`, `staging/`, `trust/`, `status/`, `catalogue/`, `secrets/`, `run/`, `supervisor/`, `bin/`, `alerts/`) and `run/<profile>/` at mode 0700 through `mkdir` with that mode, so the umask can only narrow it. It then checks the home, `secrets/` and `run/<profile>/` with `checkPrivateDirectory`, which refuses a symbolic link, another user's directory or one with a group or other bit set with `HOME_MODE` and the fix `chmod 700 <path>`. `checkPrivateDirectorySync(path)` runs the same check synchronously, for a caller on a synchronous path such as the log writer of [`@delo/logs`](../logs/README.md). An existing directory keeps its mode: nothing here changes a mode. On Windows, which has no mode bits, neither check refuses anything ([not yet implemented](#not-yet-implemented)). Upstream's entries keep upstream's layout and modes, and this package creates none of them.

## Protected files

C1's protected files are every file under `secrets/`, `trust/`, `status/` and `catalogue/`, the start token, the supervisor's roots file and the operational log files.

- `writeProtectedFile(path, data)` writes a sibling temporary file created exclusively at mode 0600, flushes it, renames it over the path and, on Linux and macOS, flushes the directory. A failed write removes the temporary file and leaves the path unchanged.
- `readProtectedFile(path)` refuses, with `SECRET_FILE_MODE`, a path that is a symbolic link, not a regular file, another user's, or has a group or other bit set, with the fix `chmod 600 <path>` for a laxer mode. It examines the path before opening it, so a FIFO or device is never opened, and checks the opened file again, so a file swapped in between is refused.
- `checkProtectedFile(path)` runs the same check without reading the file, and `checkProtectedFileSync(path)` runs it synchronously and returns the `lstat` result it checked, so a caller that then opens the file can confirm it opened the same one.

## The home lock

`acquireHomeLock({ runDirectory, runtime, probe })` takes `run/<profile>/home.lock`, whose record is C1's JSON object (`v`, `pid`, `startId`, `runtime`, `startedAt`, and `processStart` and `pidNamespace` where the platform reports them) at mode 0600, and returns a handle whose `release()` removes the lock when it still holds this holder's record; `release()` is synchronous so a process `exit` listener can call it.

- **Creation.** Every file the lock writes is written to a temporary file and hard-linked to its path, so it appears whole or not at all, and of any number of contenders exactly one link succeeds.
- **The holder.** `holderAlive(holder)` decides whether a recorded holder still runs: its process exists, and when the record carries a start identity, the live process with that id has the same one, so a process id reused after a reboot does not keep a dead holder's lock. `readProcessStart(pid)` reads the identity: on Linux the boot id with field 22 of `/proc/<pid>/stat`, on macOS the start time of `ps -o lstart=` under `LC_ALL=C` and `TZ=UTC`. Windows and other platforms have none, so a record there carries the process id alone and a process that reuses that id reads as the holder, as does a record written before `processStart` existed. On Linux a record also carries `pidNamespace`, `pid:[<inode>]` from `readPidNamespace()`, the pid namespace the writer numbers `pid` in; a record whose namespace differs from the reader's, or that a reader whose own namespace cannot be read meets, reads as alive, so a holder in a container or sandbox that shares the home is never taken over. A record without one, as older Delo, other platforms, and Linux without a readable `/proc/self/ns/pid` write, is judged as before. `checkHolder(holder, table)` tells the cases apart, against `SYSTEM_PROCESS_TABLE` or a caller's `ProcessTable`: `confirmed` only when a live process has the recorded id and start identity in the recorded pid namespace, `exited`, `replaced` for another start identity, or `unconfirmed` with the reason, which includes every record on a platform without a start identity reader and every record without `processStart`; a caller that signals a holder, such as `delorun stop --now`, acts only on `confirmed`, and `holderAlive` is false exactly for `exited` and `replaced`. `parseHolder` refuses a malformed `processStart` or `pidNamespace`, and writers spread `holderIdentity(holder)` after their own fields. `currentHolder()` is this process's holder, read once.
- **The shared lock file.** `LockFile` is this lock's creation, reading, release, handover and takeover with the record and messages of one lock; `@delo/runtime-store`'s `store.lock` is the same `LockFile` with its own record.
- **A live holder** is never taken over. The `probe` asks it for its status within C1's two seconds: an answer gives `HOME_RUNNING`, silence `HOME_UNRESPONSIVE`. The home process passes `@delo/home-process`'s `updateChannelProbe`, which sends `status` over the update channel.
- **The start id** is the caller's, from `newStartId()`, so the home process logs under it from before it takes the lock.
- **Handover.** `handOver(successor)` replaces the record atomically with a successor home process's process id, start id and runtime while the file still holds this holder's record, after which this handle's `release()` does nothing; the successor takes the handle with `adoptHomeLock(runDirectory, startId)`, which refuses a record not naming its own process.
- **A stale lock**, whose holder is not alive, is removed by `removeStaleLock` under a takeover guard `home.lock.takeover-<startId>`, created the same way, so one contender at a time may remove that one record. Holding the guard, the contender removes the lock only when it still holds that `startId`. A `startId` is random and never reused, and only the guard holder may remove its record, so a contender never removes a lock other than the stale one it found, however late it runs. A guard left by a contender that died is removed the same way under a guard named after its own random id, and a contender waits up to 10 seconds while a live one finishes a removal.

## The start token

`writeNewStartToken(home, profile)` writes a new token to `run/<profile>/start-token` at each home-process start: 32 bytes from the operating system's random source as base64url and one newline, replaced atomically at mode 0600. `readStartTokenFile` reads it through the protected-file check for `delorun` client commands, and never quotes a malformed file. `StartTokenCheck` compares a request's `token` with the current start's through fixed-length digests in constant time, so a missing, wrong or previous start's token is refused alike. `removeStartTokenFile` removes the file at a clean stop only while it still holds this start's token, synchronously, so an `exit` listener can call it.

## The token channels

`listenTokenSocket` is the listener of both of C1's token channels; each channel passes its contract's limits, codes and closed schema.

- **Binding.** The pathname socket is bound under a temporary name in the run directory, set to mode 0600 and renamed into place, replacing an earlier start's socket; any other file at the path is refused, and a path over 103 bytes is refused with `SOCKET_PATH_TOO_LONG`. A start removes temporary sockets an earlier one left. `close()` and the synchronous `removeSocketSync()` remove the path only while it is still this listener's socket, by device and inode.
- **Requests.** Each connection carries one request line within the channel's size limit and deadline, and a connection beyond the channel's limit is answered at once. `authenticateLine` checks the line's `token` before anything else is read, so a caller without the token learns nothing about the schema; a refused authentication is logged without the presented value at most once per interval, with a count.
- **Responses.** A request may write progress lines before its final line; the connection closes after the final line, and a caller that has not closed its side by the first-byte deadline is cut off. A request whose caller disconnects runs on, and that connection no longer counts towards the limit. `answered` runs once the final line is written, so a request that ends the channel closes it only after its caller has the answer.

## Not yet implemented

- The Windows DACL check of C1's Windows rule ([#48](https://github.com/Delo-Run/delo/issues/48)): on Windows the directory check returns without checking anything, and the protected-file check looks only at the file type, so a home or a secret file that other users can read is not refused there.
- The Windows named pipes with C1's DACL: the token channels listen only on Unix sockets.

## Development

The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delo/packages/home/tsconfig.json`. The lock specs race up to 16 processes from `tests/fixtures/lock-contender.ts` over free and dead holders' locks, round after round, and use temporary directories only.
