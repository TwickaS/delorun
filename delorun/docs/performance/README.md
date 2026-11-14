---
description: "Delorun's wait-time benchmarks: what each suite measures, how to run them, how to read a result and its budgets, and how a change adds a suite."
---

# Performance

English

## Summary

`pnpm run benchmark:delorun` measures the points where a person waits on Delorun, one suite per point, so a slow step can be found, and a regression caught before a release. Every suite runs the real product on local releases of the measured commit, in throwaway homes, with no request leaving the machine. A run writes a JSON result and prints a table; `--check-budgets` fails the run when a step's median is over its ceiling. The [harness](../../apps/benchmarks/README.md) owns the code.

## Contents

- [Suites](#suites)
- [Running the benchmarks](#running-the-benchmarks)
- [What a run does](#what-a-run-does)
- [Reading a result](#reading-a-result)
- [Budgets](#budgets)
- [Adding a suite](#adding-a-suite)

## Suites

| Suite | Measures | Page |
| --- | --- | --- |
| `update` | `delorun update` step by step, `update --check`, and rollbacks with and without a data copy to restore | [Update timings](update-timings.md) |
| `cli` | The commands a person expects to answer at once, to first output and to exit, beside the cost of starting a process | [Commands and start](commands-and-start.md) |
| `start` | `delorun start` cold and warm to the studio's first page, `delorun stop`, `stop --now`, a restart and a bare `delorun` | [Commands and start](commands-and-start.md) |
| `install` | The launcher's first run, setup and the first start to the studio | [Commands and start](commands-and-start.md) |
| `recovery` | `delorun recover status`, safe mode and restoring a profile history version | [Commands and start](commands-and-start.md) |
| `data` | `delorun export` and `import` of small and large homes, and moving chats to the trash, restoring them and listing a large trash | [Commands and start](commands-and-start.md) |
| `plugins` | Installing a plugin from a local package, turning it off, on and reloading it, and the start cost of 0, 5 and 20 installed plugins | [Commands and start](commands-and-start.md) |
| `turn` | A chat turn and its tool calls around a loopback model stub, in Delorun's composition and with Delorun's switch rows off | [Commands and start](commands-and-start.md) |
| `studio` | The studio in headless Chromium: boot, the sidebar, chats, Settings and onboarding, in the studio look and the stock look | [Commands and start](commands-and-start.md) |

`pnpm run benchmark:delorun -- --list` prints every suite, its scenarios and its measured items.

## Running the benchmarks

Run from the repository root on Linux, with unprivileged user namespaces available.

1. Build the workspace's artifacts, as for any closure build.
2. `pnpm run benchmark:delorun -- --prepare` builds the base runtime closure of the checked-out commit with the release recipe (`build-closure.ts --artifacts existing`) into `.cache/delorun-benchmarks/`. The worktree must be at the commit with no tracked change. `--closure-from <dir>` takes a closure built elsewhere instead.
3. `pnpm run benchmark:delorun` runs every suite; `--suite <id>` and `--scenario <id>` select, `--repeat <n>` sets the repetitions per scenario (3 by default), and `--chats-small`, `--chats-large` and `--plugins` size the synthetic data.
4. On a quiet machine, `--check-budgets` compares the medians with [`budgets.json`](../../apps/benchmarks/budgets.json). `--keep-roots` keeps every throwaway home after the run, so a failed repetition's home log can be read. `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only benchmark:delorun` runs the same check through the check runner, which runs it alone. No tier of the runner selects it: a full run takes most of an hour, and its timings mean nothing on a loaded machine.

## What a run does

- **Releases.** The base closure is re-stamped as release `0.1.0`, and as `0.1.1` and `0.2.0` for the update suite, with the release tooling's own steps; `0.2.0` carries a `data-formats.json` that differs in one of Delorun's records, so updating to it takes the session-data copy. Each release is signed with throwaway keys made for the run, logged to the release tooling's stand-in release log, and served from a loopback channel. The launcher is built for that channel and that log.
- **Homes.** Every home is a new directory under the system's temporary directory (or `--root-base`), whose `home/` is the `HOME` of every process the run starts. The harness refuses a root that is, contains, or lies inside the `.delorun` or `.dsh` of the person's real home. The launcher installs `0.1.0` and runs `delorun setup --yes`; the profile's studio listens on a port the system assigns. A template home is installed once and copied for each repetition; the copy's installed runtimes are hard links to the template's read-only files, so a repetition writes only what it installs itself.
- **Data.** Chats are upstream's synthetic Session corpus, whose per-chat lengths follow aggregate quantiles of a measured corpus and whose text is a fixed synthetic vocabulary; the same count writes the same bytes. Plugins are synthetic packages. Nothing personal is read or written.
- **Network.** The measured run re-runs itself in a new network namespace that holds only loopback, as the person's own user, so no request of the harness or of the product leaves the machine.
- **Timing.** Every command runs through the launcher, as a person runs `delorun`. Steps are read from the times the command's own lines arrived, from the home log's records, and, in the update suite, from a home-process driver that times the update support's calls without changing them ([update timings](update-timings.md#how-the-steps-are-timed)).

## Reading a result

The result is `.cache/delorun-benchmarks/results/<time>.json` (or `--out`), format `delorun.benchmark-result/1`: the commit, the machine's processor count and model, memory, kernel release, Node version, the roots' file system and whether it clones files, the load averages before and after, the storage pressure (`some avg10` of `/proc/pressure/io`) before, after and at its highest sample, and per suite and scenario every sample and the median, minimum, maximum and spread of each measured item, with failures and skipped items. It names no host, user or path outside the throwaway roots.

The table prints the same per scenario. Compare runs by their medians on machines with the same facts; the spread shows how much load moved the samples. A run on a loaded machine inflates every number, the process starts most.

## Budgets

[`budgets.json`](../../apps/benchmarks/budgets.json) holds a ceiling in milliseconds for measured items of each scenario. `--check-budgets` fails when a median is over its ceiling, when a budgeted item was not measured, when a scenario that ran has no ceilings, or when a repetition failed. It refuses to judge a run whose storage pressure went over 20% at any sample, and exits 3 instead of passing or failing: such a run measures a busy disk. The file's `measured` field says where its ceilings come from; the current ones were taken on a machine shared with other lanes and are provisional until a run on a quiet machine replaces them. Each ceiling is four times the median measured on the recorded machine and load, at least one second, rounded up to two significant digits; the four times absorb a loaded machine's noise, so the check catches a regression that multiplies a step's time, not a few percent. `--propose-budgets <file>` writes ceilings by that rule from a run; a change that makes a step slower on purpose records the new ceiling with the reason in its pull request.

## Adding a suite

A change that adds a point where a person waits adds its suite in the same change: a module under `delorun/apps/benchmarks/src/suites/<id>/` that exports a `Suite`, its entry in `src/suites/index.ts`, its first ceilings in `budgets.json`, and its row in the table above with a page or a section of one. A suite uses the harness's template homes, its channel and its timed processes, runs every command as a person runs it, and adds no product code beyond a timing observer or a log record, which its page names.
