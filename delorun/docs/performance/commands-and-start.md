---
description: "How long Delorun's everyday commands, a start and a stop take, and the other suites' scenarios: the first measured record and where the time goes."
---

# Commands and start

English

## Summary

These suites time what a person waits for outside an update: the everyday commands, starting and stopping Delorun, the first install, recovery, export and the trash, plugins, a chat turn without a model, and the studio in a browser. Every command runs through the launcher, as a person's `delorun` does. With the fast start check, most commands answer in 1 to 2.5 seconds; the waits that remain long are the first install (about 52 s to the studio), the first start of a home (21 s), `delorun stop` (15 s), `recover status` (15 s), `verify --offline` (17 s) and installing a plugin (14 s to its row running).

## Contents

- [What each suite measures](#what-each-suite-measures)
- [Record of 2026-11-11](#record-of-2026-11-11)
- [Where the time goes](#where-the-time-goes)
- [Record of 2026-11-10](#record-of-2026-11-10)

## What each suite measures

- `cli`: a bare Node start, the launcher alone (`--help`, which starts no runtime), `--version` run by the runtime's own Node, and each command to its first output and to exit: `--version`, `status` stopped and running, `doctor`, `verify --offline`, `trash list` stopped and running, `recover status`, `plugin --profile default list` and `logs`. `update --check` is measured by the [update suite](update-timings.md), because a home process started by `delorun start` reads the published release hosts, and online `verify` needs the release log.
- `start`: the first `delorun start` of a copied home and a later one, each to the command reporting Delorun running and to the studio's web server answering its index; `delorun stop`, `delorun stop --now` and a restart. A bare `delorun` is not measured, because it opens the default browser, which on WSL is the person's own Windows browser.
- `install`: the launcher's first run with no runtime (resolve, signature, log check, download and unpack, store and first start), `delorun setup --yes`, and the first start to the studio. Interactive setup needs a terminal; `setup --yes` takes the same defaults.
- `recovery`: `recover status`, entering safe mode, the start in safe mode, leaving it, and `recover restore` of the oldest profile history version.
- `data`: `delorun export` of a chat and of a workspace holding every chat, `delorun import` of it, moving a chat to the trash and restoring it through the studio's own routes, moving every chat there, and listing the full trash in the studio and with `delorun trash list`, in a small and a large home.
- `plugins`: installing a synthetic plugin from a local tarball with Delorun running, turning it off, on and reloading it through the profile patch, and the first start with 0, 5 and 20 installed plugins that each load one row.
- `turn`: a chat turn and its tool calls against a loopback model stub that speaks the model provider's wire, from sending to the first token and to the turn's end, and per tool call, in Delorun's composition and with Delorun's switch rows off.
- `studio`: the studio in headless Chromium: boot to interactive, the sidebar with few and many chats, opening a short and a long chat, switching between them, Settings and the onboarding steps, in the studio look and the stock look.

## Record of 2026-11-11

Three repetitions of each scenario, 2026-11-11 between 03:48 and 05:50 UTC, on the trunk before the first preview with this branch's benchmark code: 22 CPUs (Intel Core Ultra 9 185H), 21.5 GiB, WSL2 kernel 6.6, Node 24.22.0, ext4 without clones, a machine shared with other lanes (load average 4 to 16, storage pressure at most 16%). Medians, with the range of the samples:

| Item | Median | Range |
| --- | --- | --- |
| `node -e ""` | 26 ms | 25 ms to 37 ms |
| Launcher `--help` | 81 ms | 74 ms to 122 ms |
| `delorun --version` by the runtime's own Node | 437 ms | 401 ms to 774 ms |
| `delorun --version` | 1.9 s | 1.1 s to 9.2 s |
| `delorun status`, stopped / running | 1.8 s / 1.1 s | 1.0 s to 14.9 s |
| `delorun doctor` | 2.7 s | 1.1 s to 2.9 s |
| `delorun verify --offline` | 17.1 s | 9.5 s to 19.3 s |
| `delorun trash list`, stopped / running | 1.6 s / 1.1 s | 1.0 s to 1.9 s |
| `delorun recover status` (cli suite / recovery suite) | 1.5 s / 15.1 s | 1.1 s to 15.4 s |
| `delorun plugin --profile default list` | 2.1 s | 1.6 s to 2.4 s |
| `delorun logs` | 1.4 s | 1.1 s to 1.5 s |
| `delorun open --print` | 1.5 s | 1.0 s to 1.9 s |
| First `delorun start` of a home, to running and to the studio answering | 21.3 s | 17.7 s to 34.8 s |
| Later `delorun start` | 5.4 s | 4.2 s to 9.3 s |
| `delorun stop` | 15.4 s | 13.5 s to 19.7 s |
| `delorun stop --now` | 2.2 s | 1.6 s to 3.4 s |
| Restart (`stop`, then `start`) | 8.3 s | 6.7 s to 10.4 s |
| First run of the launcher: install, to the runtime's `--version` | 41.8 s | 40.9 s to 54.6 s |
| of which download and unpack | 33.5 s | 29.3 s to 40.3 s |
| `delorun setup --yes` | 2.4 s | 1.4 s to 2.9 s |
| First `delorun start` after setup, to the studio answering | 5.6 s | 3.8 s to 7.5 s |
| Install, setup and first start together | 52.1 s | 46.1 s to 62.7 s |
| `delorun recover safe-mode`, then `start` in safe mode, then `exit-safe-mode` | 12.9 s, 6.1 s, 2.1 s | 1.7 s to 15.8 s |
| `delorun export` of one chat, 20-chat / 400-chat home | 8.8 s / 13.5 s | 8.6 s to 16.6 s |
| Moving one chat to the trash / restoring it, in the studio | 47 ms / 17 ms | 16 ms to 69 ms |
| Moving 400 chats to the trash, one request each / listing them | 12.1 s / 0.3 s | 0.3 s to 12.4 s |
| `delorun trash list` of 400 items | 1.8 s | 1.8 s to 2.2 s |
| `delorun plugin add` of a local tarball with Delorun running / to its row started | 12.0 s / 14.2 s | 10.3 s to 16.0 s |
| Turning a plugin off, on, reloading it through the profile patch | 2.1 s each | 2.1 s to 2.2 s |
| First start with 0, 5 and 20 installed plugins | 13.3 s, 17.5 s, 14.0 s | 10.1 s to 22.7 s |
| Chat turn, first token / end, first turn of a session (loopback model stub) | 232 ms / 250 ms | 218 ms to 255 ms |
| Chat turn, first token / end, later turns | 69 ms / 72 ms | 62 ms to 80 ms |
| One tool call, read / write, in a turn of 20 calls | 47 ms / 69 ms | 34 ms to 125 ms |

Not measured in this record: the export and import of a workspace (the set-up home's workspace registry has no entry to gather the chats into), restoring a profile history version (the history of a home `setup --yes` set up lists none), the chat turn in the stock composition (`delorun start` with Delorun's switch rows off exits 1 before Delorun runs), and the studio in a browser (its first item waits for the preview notice dialog, which the page did not show; the suite needs a pass in a browser before it records numbers). The start cost per plugin does not separate from noise at 0, 5 and 20 plugins on this machine.

## Where the time goes

- **The launcher's start check is no longer the cost of a command.** `--version` takes 1.9 s through the launcher against 0.4 s from the runtime's own Node; most commands answer in 1 to 2.5 s.
- **First install, 42 s.** Downloading the 193 MB archive over loopback takes under a second; writing its 35,287 files and the store's install take the rest.
- **The first start of a home, 21 s, against 5.4 s for a later one.** The first boot of a copied home pays work a later start does not; the record does not split it further.
- **`delorun stop`, 15 s, against 2.2 s for `stop --now`.** Not the Host's shutdown: the home process goes from the stop request to its `stopped` record in 0.15 to 0.25 s, and `delorun stop` run by the runtime's own Node takes 0.8 to 1.1 s. The suite measures `stop` right after the first start of a home it copied with `cp -al`, which moves every runtime file's change time; the first start's identity record then vouches for no file, so the launcher's check before `stop` hashes all of them again ([start check design](../design/start-check.md#measurements)), and `stop --now` comes later, once a record vouches. An installed home does not meet this, because an install waits out the 2 s before it records. The suite's numbers include this until its homes let the change times settle before the first start; an update's `stop-host` held a full hash of its own, now a start check ([update timings](update-timings.md#start-checks-and-parallel-unpacking)).
- **`recover status` in the recovery suite, `verify --offline` and `recover safe-mode`, 13 to 17 s.** Each takes as long as a full read of a runtime's files; `recover status` takes 1.5 s in the cli suite's home, where Delorun has run before, and 15 s as the first command in a freshly copied one, where every file is hashed, as for `stop` above.
- **Export, 9 to 14 s for one chat, more in the larger home.** The export takes every profile's home lock and scans the chat history for secrets before it writes; the record does not split the time between them.

## Record of 2026-11-10

Before the fast start check, `cli` and `start`, three repetitions each, 2026-11-10 at 13:34 UTC on a loaded machine: every command took 8 to 28 s through the launcher (`--version` 9.9 s, `verify --offline` 28.0 s), a later `delorun start` 10.0 s and a restart 29.6 s, because the launcher read and hashed all of the runtime's 35,287 files before each start.
