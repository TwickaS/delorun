---
description: "How long Delo's everyday commands, a start and a stop take, and the other suites' scenarios: the first measured record and where the time goes."
---

# Commands and start

English

## Summary

The `cli` suite times the commands a person expects to answer at once and the `start` suite times starting and stopping Delo. Both run every command through the launcher, as a person's `delorun` does. In the first record every command takes about ten seconds or more, against well under one second for the same command run by the runtime's own Node: the launcher checks every file of the installed runtime before each start. The `install`, `recovery`, `data`, `plugins`, `turn` and `studio` suites have no record yet.

## Contents

- [What each suite measures](#what-each-suite-measures)
- [Record of 2026-11-10](#record-of-2026-11-10)
- [Where the time goes](#where-the-time-goes)

## What each suite measures

- `cli`: a bare Node start, the launcher alone (`--help`, which starts no runtime), `--version` run by the runtime's own Node, and each command to its first output and to exit: `--version`, `status` stopped and running, `doctor`, `verify --offline`, `trash list` stopped and running, `recover status`, `plugin --profile default list` and `logs`. `update --check` is measured by the [update suite](update-timings.md), because a home process started by `delorun start` reads the published release hosts, and online `verify` needs the release log.
- `start`: the first `delorun start` of a copied home and a later one, each to the command reporting Delo running and to the studio's web server answering its index; `delorun stop`, `delorun stop --now` and a restart. A bare `delorun` is not measured, because it opens the default browser, which on WSL is the person's own Windows browser.
- `install`: the launcher's first run with no runtime (resolve, signature, log check, download and unpack, store and first start), `delorun setup --yes`, and the first start to the studio. Interactive Quick setup needs a terminal; `setup --yes` takes the same defaults.
- `recovery`: `recover status`, entering safe mode, the start in safe mode, leaving it, and `recover restore` of the oldest profile history version.
- `data`: `delorun export` of a chat and of a workspace holding every chat, `delorun import` of it, moving a chat to the trash and restoring it through the studio's own routes, moving every chat there, and listing the full trash in the studio and with `delorun trash list`, in a small and a large home.
- `plugins`: installing a synthetic plugin from a local tarball with Delo running, turning it off, on and reloading it through the profile patch, and the first start with 0, 5 and 20 installed plugins that each load one row.
- `turn`: a chat turn and its tool calls against a loopback model stub that speaks the model provider's wire, from sending to the first token and to the turn's end, and per tool call, in Delorun's composition and with Delo's switch rows off.
- `studio`: the studio in headless Chromium: boot to interactive, the sidebar with few and many chats, opening a short and a long chat, switching between them, Settings and the onboarding steps, in the studio look and the stock look.

## Record of 2026-11-10

`cli` and `start`, three repetitions each, 2026-11-10 at 13:34 UTC, on a machine shared with about a dozen other lanes: 22 CPUs (Intel Core Ultra 9 185H), 21.5 GiB, WSL2 kernel 6.6, Node 24.22.0, ext4 without clones, load average 19 to 27, storage pressure 5% before, 3% after and 58% at its highest sample. The closure measured was the trunk's commit with the build-time fixes the [update page](update-timings.md#defects-met-on-the-way) lists. Medians, with the range of the three samples:

| Item | Median | Range |
| --- | --- | --- |
| `node -e ""` | 29 ms | 28 ms to 69 ms |
| Launcher `--help` | 89 ms | 72 ms to 156 ms |
| `delorun --version` by the runtime's own Node | 385 ms | 366 ms to 859 ms |
| `delorun --version` | 9.9 s | 7.9 s to 14.3 s |
| `delorun status`, stopped | 16.8 s | 7.5 s to 17.2 s |
| `delorun status`, running | 16.2 s | 15.1 s to 22.3 s |
| `delorun doctor` | 17.1 s | 7.9 s to 20.7 s |
| `delorun verify --offline` | 28.0 s | 20.2 s to 37.1 s |
| `delorun trash list` | 11.5 s | 11.0 s to 14.0 s |
| `delorun recover status` | 11.8 s | 8.8 s to 13.7 s |
| `delorun plugin --profile default list` | 14.2 s | 7.9 s to 20.2 s |
| `delorun logs` | 10.4 s | 8.6 s to 24.1 s |
| First `delorun start`, to running | 18.3 s | 12.3 s to 22.6 s |
| Later `delorun start`, to running | 10.0 s | 9.1 s to 12.6 s |
| `delorun stop` | 8.8 s | 8.0 s to 11.9 s |
| `delorun stop --now` | 8.6 s | 7.9 s to 15.3 s |
| Restart (`stop`, then `start`) | 29.6 s | 17.5 s to 36.0 s |

The studio's web server answered its index within 0.1 s of each start reporting Delo running.

## Where the time goes

- **The launcher's start check, about 9 s of every command.** Before it starts the runtime, the launcher checks every file of the installed runtime against its signed file list, reading and hashing all 35,287 files (about 770 MB). `--version` takes 9.9 s through the launcher and 0.4 s from the runtime's own Node; the launcher alone takes 0.1 s.
- **`verify --offline`, 28 s.** It checks the runtime's files once more after the launcher's check.
- **`start` and `stop`.** A later start is the launcher's check plus about 1 s of boot; the first start of a home adds about 8 s of first boot. `stop` is mostly the launcher's check. A restart pays the check twice.
