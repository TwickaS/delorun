# Delorun benchmarks

English

`@delorun/benchmarks` measures the points where a person waits on Delorun, a private package in `delorun/apps/benchmarks`. One harness gives every suite throwaway homes, local signed releases of the measured commit, synthetic data, the result format, the table and the budget check; each suite measures one touch point. What each suite measures, how to run it and the numbers recorded so far are on the [performance pages](../../docs/performance/README.md).

## Modules

- `src/run.ts` is `pnpm run benchmark:delorun`: it parses the command line, builds the base runtime closure with `--prepare`, re-runs itself inside a loopback-only network namespace, runs the selected suites, writes the JSON result, prints the table and checks the budgets.
- `src/harness/` holds the harness: throwaway roots that refuse the real home (`roots.ts`), the isolated network (`isolation.ts`), child processes with timed output lines (`processes.ts`), the machine's facts (`machine.ts`), samples, results and the scrubbing of paths and names (`result.ts`, `stats.ts`), the budgets (`budgets.ts`), the table (`table.ts`), the command line (`options.ts`) and the suite interface (`suite.ts`).
- `src/fixtures/` holds the shared fixtures: the base closure and the release closures derived from it (`closure.ts`), the run's local channel, stand-in release log and launcher (`channel.ts`), installed homes and the commands run in them (`home.ts`), template homes and the installed release (`releases.ts`), and synthetic chats and plugins (`data.ts`).
- `src/suites/` holds one directory per suite and `index.ts`, the list of suites.
- `budgets.json` holds the ceilings `--check-budgets` enforces.
- `tests/` holds the specs of the harness and of each suite's pure helpers. Running a suite needs an installed runtime closure, so the suites' process-driving code runs only in a measured run.

## Adding a suite

Add `src/suites/<id>/index.ts` exporting a `Suite`, add it to `src/suites/index.ts`, run it, record its first ceilings in `budgets.json` with `--propose-budgets`, and add its page under `delorun/docs/performance/`.
