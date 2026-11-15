---
description: "How long delorun update, update --check and a rollback take, step by step: the update suite's scenarios, how each step is timed, and the first measured record with the defects that stopped it."
---

# Update timings

English | [中文](update-timings.zh.md)

## Summary

The `update` suite times a real `delorun update` from one local release to the next, step by step, and the ways back: `delorun update --check`, a rollback with no data copy to restore and a rollback that restores one. Since an update runs the launcher's start check instead of hashing whole runtimes, and unpacks several files at once, a 400-chat update commits in about 46 seconds on a loaded machine, against about 92 before. Unpacking the new runtime and the time before the store's prepare begins take most of what remains; the checks, stopping the Host, downloading, verifying the release, the report, the copy and the switch take about seven seconds together.

## Contents

- [Scenarios](#scenarios)
- [How the steps are timed](#how-the-steps-are-timed)
- [Running the suite](#running-the-suite)
- [Start checks and parallel unpacking](#start-checks-and-parallel-unpacking)
- [Record of 2026-11-11](#record-of-2026-11-11)
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

Three sources give the step boundaries: those timing records, the home log's `update phase` records and the successor's record `the Host booted on the new runtime; checking its health`, which the home process writes for this purpose, and the times the command's own lines reach the harness. `pnpm run benchmark:delorun -- --list` names every item; the ones that matter most are `cli-start` (launcher start check, runtime start, request), `running-check`, `download`, `unpack`, `store-install`, `report`, `stop-host`, `data-copy`, `switch`, `target-boot`, `health-check` and `total` (command start to commit).

## Running the suite

`pnpm run benchmark:delorun -- --suite update` after `--prepare`; `--scenario same-format` runs one scenario. Each repetition installs a runtime of about 770 MB in 35,287 files and, with a copy, writes the chat data again, so run the large scenarios only on a quiet disk.

## Start checks and parallel unpacking

Three repetitions of `changed-format-large` before and after the update ran the launcher's start check on the runtimes it reads and starts, and unpacking wrote up to 16 files at once ([start check design](../design/start-check.md#decisions)), on 2026-11-11 between 05:35 and 06:40 UTC on the machine and Node of the record below, shared with other lanes. Before: load average 10 to 20, storage pressure at most 8.5%. After: load average 20 to 31, storage pressure at most 11.8%. Medians in seconds, measured on a loaded machine; they show the size of the change, not what a quiet machine takes:

| Item | Before | After |
| --- | --- | --- |
| `total`, command start to commit | 91.8 | 46.4 |
| `running-check` | 14.3 | 0.8 |
| `download-unpack` | 27.1 | 19.0 |
| `stop-host`, which held the full hash of the target before the switch | 13.9 | 1.0 |
| `health-check`, H1's full hash of the target before | 13.2 | 1.3 |
| `rollback` | 83.0 | 51.7 |

`stop-host` was not the Host's shutdown: the home process stops its Host in 0.15 to 0.25 s, and the step held the full hash of the target the update ran before the switch. Unpacking alone (`extractArchive` of the real 32,449-file closure, `delorun/apps/install/tests/timing/extract-timing.ts`, interleaved runs at load average 6 to 12) took 15.3 to 18.4 s before and 8.6 to 10.1 s after; reading and hashing the archive takes 4 to 5 s of it. All six repetitions committed.

## Record of 2026-11-11

Three repetitions of each scenario (two of `changed-format-large`, whose third failed as described below), 2026-11-11 between 03:48 and 04:35 UTC, on the trunk before the first preview with this branch's benchmark code: 22 CPUs (Intel Core Ultra 9 185H), 21.5 GiB, WSL2 kernel 6.6, Node 24.22.0, ext4 without clones, a machine shared with other lanes (load average 9 to 16, storage pressure at most 16%). The closure is the trunk's recipe output with no local change. Medians in seconds; the small chat set is 20 chats, the large one 400 (125 MiB):

| Item | `same-format` | `changed-format` | `changed-format-large` | `many-plugins` (20) | `warm-store` |
| --- | --- | --- | --- | --- | --- |
| `total`, command start to commit | 87.0 | 97.8 | 80.1 | 95.1 | 48.6 |
| `cli-start`, to the store's prepare | 11.6 | 12.4 | 9.9 | 12.1 | 1.3 |
| `running-check` | 10.9 | 14.1 | 13.3 | 13.5 | 11.8 |
| `channel-verify` | 0.2 | 0.2 | 0.2 | 0.1 | 0.1 |
| `download-unpack` | 33.5 | 25.9 | 27.4 | 27.4 | in store |
| `store-install` | 3.7 | 3.0 | 3.6 | 4.8 | in store |
| `report` | 0.9 | 1.0 | 1.0 | 1.3 | 0.8 |
| `snapshot` and `drain` | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 |
| `stop-host` | 9.7 | 14.5 | 10.7 | 16.4 | 11.8 |
| `data-copy` | none | 0.2 | 1.7 | none | none |
| `switch` | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `target-boot` | 2.0 | 3.0 | 2.1 | 3.0 | 2.4 |
| `health-check` | 9.3 | 13.3 | 9.8 | 13.7 | 9.5 |
| `rollback` | 47.1 | 50.0 | 60.2 | not run | not run |
| `rollback-switch` | 17.6 | 17.2 | 22.3 | not run | not run |
| `rollback-target` | 11.8 | 10.7 | 14.9 | not run | not run |

`delorun update --check` took 57.5 s (cold store, which it fills); the update that followed found the target installed, and its `total` is the `warm-store` column. The spread is wide: the slowest of three samples was up to 1.6 times the median, as other lanes used the machine.

### What failed or surprised

- One of three `changed-format-large` repetitions failed its health check on criterion `H3-only-named-disabled` and rolled back automatically; the other two committed. Docker Desktop started at 04:10 UTC, during that scenario: the successor's start denied the Docker socket's real path, which the running Host's start had not, and H3 read the sandbox row's changed settings as a change the report did not name. H3 now compares the sandbox row's protection on its own and leaves out the sockets a start finds on the computer ([C3](../contracts/c03-update-report.md#health-check)); four reruns committed.
- Synthetic plugins that declare no `engines.dsh` make the report name each one as unpredictable, and `update --yes` then refuses to confirm, as it should; the fixture now declares ranges.
- Before the update repair, the trunk could not build a closure, and every update failed at the report or the health check; [the record of 2026-11-10](#record-of-2026-11-10) keeps the details.

## Record of 2026-11-10

On the trunk before the update repair, one repetition of `same-format` on a closure built with local fixes stopped at the health check: the report took 68.6 s, unpacking 22.0 s, the store's install 15.7 s, and the running runtime's start check 7.9 s, against 0.1 s for the channel's checks and 0.7 s for the download. The defects met then, all fixed on the trunk since: the recipe could not build a closure (a pnpm task cycle, `@delorun/release` sources importing TypeScript by name, wildcard exports left pointing at `.ts`); the report's reader of the target's bundle tables rejected upstream's `PROFILE_TEMPLATES`; an unexpected prepare failure left `delorun update` crashing with a `TypeError`; and H2 asked the studio's index without a session and failed every update on its 401.

## The slowest steps

1. **Unpacking the target, about 19 s on a loaded machine.** `download-unpack` is nearly all unpacking: the 186 to 193 MB archive downloads over loopback in under a second, reading and hashing it takes 4 to 5 s, and writing 35,287 files (about 770 MB) into staging, 16 at a time, the rest.
2. **Before the store's prepare begins, 12 to 15 s.** `cli-start` (1.3 s when an earlier `--check` already ran) is work the first request does before the prepare, which the timing records do not split further.
3. **The checks, under a second each.** `running-check`, the check before the switch and H1 are the launcher's start check; a runtime is hashed in full there only when a start would hash it, and on `delorun verify` and a rollback's report.
