---
description: "Delo's operational logs package, for maintainers of a surface that writes a C20 log: the logger, redaction, captured output, the Cordis logger exporter, rotation and retention, the readers behind delorun logs, and the cross-surface denial suite."
---

# @delo/logs

English | [中文](README.zh.md)

## Summary

This package implements [contract C20](../../docs/contracts/c20-operational-logs.md): every Delo process that keeps an operational log writes it through this package, so redaction, the record format, rotation and retention hold the same way on every surface. It also holds the readers and the clear and age-check effects that `delorun logs` and purge use, and the cross-surface denial suite that runs C20's denial tests over every surface in the tree. The contract's values and types come from [`@delo/contract-operational-logs`](../contract-operational-logs/README.md); the mode codes come from [C1](../../docs/contracts/c01-home-layout.md).

## Contents

- [Writing a surface's log](#writing-a-surfaces-log)
- [Records and keys](#records-and-keys)
- [Redaction](#redaction)
- [Captured output](#captured-output)
- [Rotation and retention](#rotation-and-retention)
- [Reading](#reading)
- [The denial suite](#the-denial-suite)
- [Tests](#tests)

## Writing a surface's log

A surface owner does these steps as its process starts:

1. Resolve the surface's location with `resolveSurface({ kind, home, profile })`. The relay's location is its container path and ignores the home.
2. Create one `Redactor` for the process and register every secret value the process holds or reads as it loads it, with `register(value, kind)`, keeping the returned disposer for a value that is dropped.
3. Open the log with `SurfaceLog.open({ location, redactor, pid, level, startId, onFailure, now })`. Opening creates the directory at 0700 and the active file at 0600 by exclusive creation, and checks an existing directory or file with `@delo/home`'s `checkPrivateDirectorySync` and `checkProtectedFileSync`, the one implementation of C1's refusal rule: a symbolic link, another user's path or one with a group or other permission bit throws `HomeLayoutError` with `HOME_MODE` or `SECRET_FILE_MODE` and its `chmod` fix, so a surface fails at its start instead of running without its log.
4. Run `startAgeChecks({ home, now, onReport })`, which prunes every local surface at once and every 3,600 seconds. `delorun` prunes once at each invocation's start through `pruneLocalSurfaces`. No shipped process calls `startAgeChecks`, so while the home process runs, records past their retention stay until the next `delorun` invocation prunes them.
5. Write Delo's own records through `log.logger(name)`, attach the Cordis application with `attachCordisLogs(ctx, log)` from `@delo/logs/cordis`, and capture upstream code's output with `LineCapture`, `captureStream` or `interceptStdio`.

`SurfaceLog.write` never throws: a record that cannot be written is dropped and its `LogsError` or `HomeLayoutError` goes to `onFailure`, and the next record opens the file again. A surface that keeps upstream's console exporter and also captures its own standard output writes each Cordis message twice, so it keeps only one of the two.

## Records and keys

Each record is one JSON line of C20's fields, at most 16,384 bytes. A longer record is cut after redaction, from the end of `err.stack`, then `msg`, then `err.message`, and `truncated` counts the bytes removed, including bytes a capture dropped. Records from the Cordis exporter and from `log.logger(name)` carry `source: "delo"`; captured lines carry `source: "captured"` and `stdout` or `stderr` as their logger.

A record names its keys with `keys`, or takes them from the log's key sources (`log.useKeys(source)`). `attachCordisLogs` adds a source that reads upstream's agent registry: while an agent drives a chat, `ctx.agents.currentInitiator()` names it, and the record carries that session's id and, while a turn is open, the number of its latest `turn/start`. This covers Cordis messages and output the process writes to its own streams during the turn. No shipped process calls `attachCordisLogs`, so the CLI home's records carry no session or turn keys. No session-log event changes, so upstream's session format and the parity replay stay as they are.

## Redaction

`Redactor.text` applies C20's steps 1 and 3: each registered value of at least 8 characters, with its base64, base64url, hexadecimal, URL-encoded and JSON-escaped forms, matched without case, including the part of a base64 encoding that stays the same at each byte alignment inside a longer encoding; then the listed forms, from header values and URL credentials to owner code runs in either case and in groups and `NAME=value` pairs, and a key body of two or more 64-character base64 lines whose `BEGIN` line the text does not hold. `Redactor.fields` applies step 2 to structured values before they are serialised, and `Redactor.error` step 4. A registered value becomes `[redacted:<kind>]`, a listed form `[redacted:<pattern>]`, and a secret-named field `[redacted]`. Redaction catches only registered values and listed forms; C20 states what it cannot catch.

## Captured output

`LineCapture` splits a stream into one record per line, holding a partial line across writes up to 65,536 bytes. A longer line is redacted as a whole at that size and the rest of it, up to the newline, is dropped and counted. The lines of a PEM private key block are each replaced with `[redacted:private-key]`, because each line is a record of its own. `captureStream` captures a child's stream, and `interceptStdio` this process's own streams, where a line written during a turn carries that turn's keys.

## Rotation and retention

The writer rotates before a write would take the active file past 10 MiB: `.3` to `.4`, `.2` to `.3`, `.1` to `.2`, the active file to `.1`, deleting the old `.4` and anything beyond it. A writer whose active file another process rotated, pruned, emptied or removed continues in the file now at its path. `pruneSurface` and `pruneLocalSurfaces` delete each file whose oldest record is older than 14 days, rotating an expired active file away first, and `pruneStartupReports` deletes upstream's `startup-*.log` reports past the same window by their own last write, since a report carries no records to date it. `clearSurface`, `clearStartupReports` and `clearLocalLogs` are the clear effect of `delorun logs --clear` and purge's offer: rotated files and upstream's `startup-*.log` reports are deleted and active files are emptied in place. These functions act only on a surface's own `<name>.log` and `<name>.log.<n>` files and on the startup reports, refuse a symbolic link, and never touch `sessions/`.

## Reading

`readLines` returns a surface's last matching lines across its files, reading from the newest file back. `followLines` delivers each line written after it starts, across rotations; a file emptied in place is followed from its start once a check finds it shorter than the part already read. Both check each file with C1's refusal rule first. `parseRecord` checks a line's required fields and keeps unknown fields.

## The denial suite

[`tests/denial/`](tests/denial/denial.spec.ts) runs C20's denial tests over the reference surface, this package writing `home-default` and capturing a child process's output, and over every surface whose package is in the tree and depends on `@delo/logs`. [`tests/denial/surfaces.ts`](tests/denial/surfaces.ts) lists C20's surfaces with their owning packages. A surface whose package is absent or does not depend on `@delo/logs` is listed as a skipped test with its reason; a surface whose package depends on `@delo/logs` must add its `SurfaceDriver` there, or the suite fails.

| C20 test | Spec | Runs over |
| --- | --- | --- |
| `log-canary-every-surface` | `denial.spec.ts` | each surface in the suite, rotated files included |
| `log-canary-split` | `denial.spec.ts` | each surface in the suite |
| `log-canary-patterns` | `denial.spec.ts` | each surface in the suite |
| `log-rotation` | `denial.spec.ts` | size: each surface in the suite; age: the age check every surface runs |
| `log-modes` | `denial.spec.ts` | each surface in the suite |
| `log-session-keys` | [`session-keys.spec.ts`](tests/denial/session-keys.spec.ts) | the Cordis exporter on upstream's production agent loop |
| `log-purge-clear` | `denial.spec.ts` | the clear effect over each surface in the suite; purge itself is skipped until C8's purge is in the tree |
| `log-desktop-host-file` | skipped | waits for the desktop Host's log file |
| `log-confined-write-denied` | skipped | waits for Delo's sandbox profiles for C1's `home-write` rule |

## Tests

From the repository root, `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/logs` runs the specs, and `--reporter=verbose` lists each skipped surface with its reason. The specs that start an agent load upstream's built packages, so they need `pnpm run build:artifacts` first.
