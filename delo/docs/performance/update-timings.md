---
description: "How long delorun update, update --check and a rollback take, step by step: the update suite's scenarios, how each step is timed, and the first measured record with the defects that stopped it."
---

# Update timings

English

## Summary

The `update` suite times a real `delorun update` from one local release to the next, step by step, and the ways back: `delorun update --check`, a rollback with no data copy to restore and a rollback that restores one. On the trunk with the update repair and the fast launcher start check, an update commits in about 90 seconds and a rollback takes about 50. Unpacking the new runtime, stopping the running Host, the start check of the running runtime before the channel opens, the time before the store's prepare begins and the target's health check take most of it; downloading, verifying the release, the report, the copy and the switch take about two seconds together.

## Contents

- [Scenarios](#scenarios)
- [How the steps are timed](#how-the-steps-are-timed)
- [Running the suite](#running-the-suite)
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

Three sources give the step boundaries: those timing records, the home log's `update phase` records and the successor's record `the Host booted on the new runtime; checking its health`, which the home process writes for this purpose, and the times the command's own lines reach the harness. `pnpm run benchmark:delo -- --list` names every item; the ones that matter most are `cli-start` (launcher start check, runtime start, request), `running-check`, `download`, `unpack`, `store-install`, `report`, `stop-host`, `data-copy`, `switch`, `target-boot`, `health-check` and `total` (command start to commit).

## Running the suite

`pnpm run benchmark:delo -- --suite update` after `--prepare`; `--scenario same-format` runs one scenario. Each repetition installs a runtime of about 770 MB in 35,287 files and, with a copy, writes the chat data again, so run the large scenarios only on a quiet disk.

## Record of 2026-11-11

Three repetitions of each scenario (two of `changed-format-large`, whose third failed as described below), 2026-11-11 between 03:48 and 04:35 UTC, on the trunk's commit 5fb7c934ed with this branch's benchmark code: 22 CPUs (Intel Core Ultra 9 185H), 21.5 GiB, WSL2 kernel 6.6, Node 24.22.0, ext4 without clones, a machine shared with other lanes (load average 9 to 16, storage pressure at most 16%). The closure is the trunk's recipe output with no local change. Medians in seconds; the small chat set is 20 chats, the large one 400 (125 MiB):

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

- One of three `changed-format-large` repetitions failed its health check on criterion `H3-only-named-disabled` and rolled back automatically; the other two committed. A rerun with `--keep-roots` keeps the home log that names the row.
- Synthetic plugins that declare no `engines.dsh` make the report name each one as unpredictable, and `update --yes` then refuses to confirm, as it should; the fixture now declares ranges.
- Before the update repair, the trunk could not build a closure, and every update failed at the report or the health check; [the record of 2026-11-10](#record-of-2026-11-10) keeps the details.

## Record of 2026-11-10

On the trunk before the update repair, one repetition of `same-format` on a closure built with local fixes stopped at the health check: the report took 68.6 s, unpacking 22.0 s, the store's install 15.7 s, and the running runtime's start check 7.9 s, against 0.1 s for the channel's checks and 0.7 s for the download. The defects met then, all fixed on the trunk since: the recipe could not build a closure (a pnpm task cycle, `@delo/release` sources importing TypeScript by name, wildcard exports left pointing at `.ts`); the report's reader of the target's bundle tables rejected upstream's `PROFILE_TEMPLATES`; an unexpected prepare failure left `delorun update` crashing with a `TypeError`; and H2 asked the studio's index without a session and failed every update on its 401.

## The slowest steps

1. **Unpacking the target, about 30 s.** `download-unpack` is nearly all unpacking: the 186 to 193 MB archive downloads over loopback in under a second, then 35,287 files (about 770 MB) are written into staging.
2. **Stopping the running Host, 10 to 16 s.** The update waits for the Host to shut down before it copies the data and switches; `delorun stop` takes as long (see [commands and start](commands-and-start.md)), so the cost is the Host's shutdown, not the update's.
3. **The checks of whole runtimes, 10 to 14 s each.** `running-check` is the store's start check of the running runtime before the channel opens, and the target's `health-check` runs H1 over the target's files; each takes as long as a full read of a runtime's files, while the launcher's own start check now takes under a second. The 10 to 12 s before the store's prepare begins (`cli-start`; 1.3 s when an earlier `--check` already ran) is work the first request does before the prepare, which the timing records do not split further.
