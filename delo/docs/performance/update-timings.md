---
description: "How long delorun update, update --check and a rollback take, step by step: the update suite's scenarios, how each step is timed, and the first measured record with the defects that stopped it."
---

# Update timings

English

## Summary

The `update` suite times a real `delorun update` from one local release to the next, step by step, and the ways back: `delorun update --check`, a rollback with no data copy to restore and a rollback that restores one. The first record, below, stops at the health check: on the trunk measured, every update fails its health check and rolls back, so no update commits. It already shows where the time goes before the switch: the runtime start check, which reads and hashes every file of a runtime, runs several times per update and dominates.

## Contents

- [Scenarios](#scenarios)
- [How the steps are timed](#how-the-steps-are-timed)
- [Running the suite](#running-the-suite)
- [Record of 2026-11-10](#record-of-2026-11-10)
- [The slowest steps](#the-slowest-steps)

## Scenarios

| Scenario | What dominates |
| --- | --- |
| `same-format` | Same data format, so no copy; small chat set; cold store; then a rollback with no copy to restore |
| `changed-format` | Changed data format, so the copy is taken; small chat set; then a rollback that restores the copy |
| `changed-format-large` | The same with the large chat set (`--chats-large`), so the copy dominates |
| `many-plugins` | Same format with `--plugins` installed plugin packages, so the report reads each |
| `warm-store` | `update --check` first, so the update finds the target already in the store |

A file-system clone needs roots on a file system that clones (`--root-base`); the result records whether the roots' file system clones, and the suite lists the clone scenario as skipped where it does not.

## How the steps are timed

The home process runs `delorun start --foreground`'s own function from the installed runtime's own modules, with one start dependency replaced: its update support reads the run's loopback channel and stand-in log, which the published runtime names as constants, under the download rule a launcher built for a loopback channel uses. The support is otherwise the CLI's own (`homeUpdateSupport` over the runtime store, the CLI's report sources, profile history and data copies). A wrapper around the support's store, channel, downloader, report sources, profile history and copies writes one timing record at the start and end of each call and changes no argument or result. The successor an update starts is the target runtime's own `delorun start`.

Three sources give the step boundaries: those timing records, the home log's `update phase` records and the successor's record `the Host booted on the new runtime; checking its health`, which the home process writes for this purpose, and the times the command's own lines reach the harness. `pnpm run benchmark:delo -- --list` names every item; the ones that matter most are `cli-start` (launcher start check, runtime start, request), `running-check`, `download`, `unpack`, `store-install`, `report`, `stop-host`, `data-copy`, `switch`, `target-boot`, `health-check` and `total` (command start to commit).

## Running the suite

`pnpm run benchmark:delo -- --suite update` after `--prepare`; `--scenario same-format` runs one scenario. Each repetition installs a runtime of about 770 MB in 35,287 files and, with a copy, writes the chat data again, so run the large scenarios only on a quiet disk.

## Record of 2026-11-10

One repetition of `same-format`, 2026-11-10 at 13:56 UTC, on a machine shared with about a dozen other lanes: 22 CPUs (Intel Core Ultra 9 185H), 21.5 GiB, WSL2 kernel 6.6, Node 24.22.0, ext4 without clones, load average 7 to 21, storage pressure from 0.2% to 76% at its highest sample. The closure measured was the trunk's commit with the three build-time fixes and the report fix listed under [defects](#defects-met-on-the-way); the health check then failed, so the update rolled back. Times are from one sample and are not a median.

| Step | Time |
| --- | --- |
| Start check of the running runtime before the channel opens | 7.9 s |
| Channel timestamp, root chain, manifest, signature and log check | 0.1 s |
| Download of the 193 MB archive over loopback | 0.7 s |
| File list, archive check and unpacking into staging | 22.0 s |
| The store checking the staged files and moving them in | 15.7 s |
| Building the report | 68.6 s |
| Profile snapshot | 0.1 s |
| Stopping the Host and switching the pointers | 0.2 s |
| Target home process start and Host boot | 2.1 s |
| Target health check, to its failure | 7.7 s |
| Automatic rollback after the failure | 7.5 s |

### Defects met on the way

- The trunk's release recipe cannot build a runtime closure. `pnpm --filter ./delo/packages/* run build` stops on `ERR_PNPM_TASK_CYCLE` (the cycle through `@delo/release`, `@delo/runtime-closure` and `@delo/cli`); the transpile step refuses `@delo/release`'s tooling sources, which import `@delo/tools/src/*.ts` by name; and wildcard `exports` such as `./sign/*` keep their `.ts` targets, so the installed runtime cannot load `@delo/release/sign/verify`. The benchmark's measurement closure carries local fixes for all three; none is in this branch.
- The report's reader of the target's bundle tables expects `PROFILE_TEMPLATES` values to be bundle lists, and upstream's are `{ bundles }` objects, so every `update.prepare` throws a `ZodError`.
- An unexpected failure of `update.prepare` closes the update channel without a final line, and `delorun update` then reads the last progress line as the answer and crashes with `TypeError: Cannot read properties of undefined (reading 'to')`. A download refused or a channel that cannot be reached does the same.
- The health check's H2 requests the studio's index without the start link's cookie, which the web server answers with 401, so every update fails H2 and rolls back.

## The slowest steps

1. **Building the report, 68.6 s.** The report's readers `running`, `target` and `data` each run the store's start check on the runtimes they read, at the same time; the start check reads and hashes every one of a runtime's 35,287 files (about 770 MB), so the report hashes the two runtimes several times over.
2. **Unpacking and installing the target, 37.7 s.** Unpacking writes 35,287 files; the store then checks every staged file against the signed file list before it moves the runtime in, reading all of them again.
3. **The start check before and after.** The running runtime's check before the channel opens (7.9 s), the target's H1 check (7.7 s) and the launcher's own check before `delorun update` starts at all (about 10 s, see [commands and start](commands-and-start.md)) each hash a whole runtime again.
