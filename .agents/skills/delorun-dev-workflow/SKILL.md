---
name: delorun-dev-workflow
description: Use when setting up a Delorun worktree, choosing which local checks to run before a commit or push, reading a failed check, deciding whether a check may be skipped, or waiting on a long check in the background.
---

# Delorun development workflow

The root [`AGENTS.md`](../../../AGENTS.md) states the rules: branches, the green base, the check runner, the commit standard and the changelog. Upstream's [`dsh-pre-push-checks`](../dsh-pre-push-checks/SKILL.md) selects the evidence a change needs and [`dsh-pr-description`](../dsh-pr-description/SKILL.md) writes the pull request description; both apply in full. This skill adds Delorun's procedure: the worktree, the check runner, skips and commits. The [tools README](../../../delorun/apps/tools/README.md#local-checks) says what each check covers.

## Set up a worktree

1. `node delorun/apps/tools/src/setup-worktree.ts` at the worktree's root, on the Node major `.nvmrc` pins (`nvm use`). It writes the git-ignored `lefthook-local.yml` (`extends: [delorun/lefthook.yml]`), runs `pnpm install --frozen-lockfile`, the documentation site's own install (`pnpm --dir docs install --frozen-lockfile` in `delorun/apps`) and `node scripts/install-lefthook.mjs`, and sets the ledger merge driver (`merge.delorun-ledger.driver`) in the clone's shared configuration, so a repeat run changes nothing. It keeps an existing `lefthook-local.yml` and refuses one that does not extend `delorun/lefthook.yml`. Without the hooks file none of Delorun's hooks run, so the installed `pre-push` hook refuses every push until the file extends `delorun/lefthook.yml`; run the setup in each new worktree before its first push. Without the driver git merges `delorun/upstream-patches.json` as plain text, which conflicts on parallel edits.
2. Confirm the hooks directory (`git rev-parse --git-path hooks`) holds `commit-msg`, `pre-commit` and `pre-push`.
3. The first `pnpm check` is cold: upstream's typecheck and, when no runtime build exists, `build:artifacts`, which the runner starts by itself.

## Choose what to run

Choose the evidence with `dsh-pre-push-checks`, then run it through Delorun's check runner:

| Situation | Command |
| --- | --- |
| Before a commit or push, in seconds | `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --preflight`: the commit standard, the changelog fragment, whitespace (`delorun/apps/tools/src/checks/gates/whitespace.ts --base origin/main --fix` repairs it), secrets and identifiers, the JSDoc rules, and the changed packages' typecheck |
| While working | `pnpm check`: the agent tier, which leaves out the replays, the web lane and the Docker lane |
| The selection and its reasons, without running it | `pnpm check -- --plan` |
| One package or file | `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts <path>…` |
| Coverage of the files you changed, every file listed | `node_modules/.bin/tsx delorun/apps/tools/src/coverage.ts <package directory or spec>…` (each run writes its own report directory) |
| One check, such as a lane that failed | `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only <id>` |
| Before the lead fast-forwards the trunk | `pnpm check:merge`: the merge tier, with the merge-only checks; a lane's agent never needs it, and a push of the trunk runs it |
| Before asking for the base to be called green | `pnpm check:full`, or `DELORUN_FULL_GATE=1 git push` |

The `pre-commit` hook runs `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --pre-commit`; the `pre-push` hook of a lane branch runs the lane tier (the pre-flight plus the changed packages' own specs), `DELORUN_TIER=agent git push` the agent tier, and a push of the trunk the merge tier. The [tools README](../../../delorun/apps/tools/README.md#local-checks) gives each check's budget and tier.

The test lanes, by what they need:

| Lane | Runs | Picked when |
| --- | --- | --- |
| `tests:fork` | Delorun's unit specs (10 s per test) and client component specs (30 s) | its packages or their dependencies change |
| `tests:fork:integration` | Delorun's `*.integration.spec.ts` specs, which start processes or write real file trees, after `tests:fork`, 60 s per test on at most 4 workers | its packages or their dependencies change |
| `tests:snapshots` | upstream's recorded-session replay | upstream-owned code changes |
| `tests:upstream-changed` | the specs of changed upstream packages and their direct dependents | an upstream package changes |

Run a Delorun spec directly with `pnpm exec vitest run --config delorun/vitest.config.ts <spec>`; the root vitest config does not include Delorun's specs. Integration specs and session readers load built `lib/`, so a stale `lib/` fails them: `--only build:delorun` rebuilds it, and a spec never builds a package itself.

A new spec goes in its package's `tests/` directory. Name it `*.integration.spec.ts` when it runs git, Node or `tsx` children, a real profile, a release build or many durable writes to a real file tree; `gates:spec-lanes` refuses a unit spec that starts a process, and every `spawnSync` or `execFileSync` in a spec needs a `timeout`. `--only tests:fork` runs both phases.

A spec that fixes "now" fixes every time it compares against, file modification times included (`utimesSync`), or injects the clock into the code under test; a fixed date beside a time the clock or the file system supplies starts failing on the day the real clock passes it. `--only tests:moved-clock` runs the unit specs with the clock moved forward and names such a test; run it after adding dated fixtures.

## Read a failure

- `node_modules/.cache/delorun-checks/report.json` holds each check's status, whether a cached pass served it, duration and peak memory; `node_modules/.cache/delorun-checks/logs/<check>.log` holds its full output.
- Rerun the failed check alone with `--only <id>` before changing code. A failure that disappears when the check runs alone is contention: other suites were running beside it. Do not run test suites beside the gate.
- A timing assertion bounds a measurement by the timestamps of the system it measures, not by when the test's own command returned; a loaded host delays the command.

## Skip a check

`DELORUN_PUSH_SKIP=<check or group>,… git push` leaves checks out of the pre-push gate. Use it only for a check whose failure has an entry in [`delorun/docs/reference/harness-feedback.md`](../../../delorun/docs/reference/harness-feedback.md) with its reason and the work that will fix it, and name the skipped check in the pull request. Never skip a hook with `--no-verify`.

## Commit

1. A change people can perceive adds one fragment per feature under [`delorun/changelog/unreleased/`](../../../delorun/changelog/README.md); a later change to the same feature edits its fragment instead of adding another, and `assemble.ts --list-unreleased` shows where a change belongs. A fragment's section is one of Security, Added, Changed, Fixed, Removed or From upstream. A feature a person cannot reach yet goes in `delorun/changelog/pending/` with a `waits:` line naming what must be wired first. A release summary is one plain line of at most 200 characters.
2. `git commit -s` with a Conventional Commits subject; a change nobody can perceive ends with `Changelog: none (<reason>)`.
3. The `commit-msg` hook checks the message against the commit standard; the pre-push gate checks what changed since the remote branch's tip. Merging by fast-forward after the branch push does not rerun the gate, because the tree pass record covers the same commit ([tools README](../../../delorun/apps/tools/README.md#local-checks)).
4. Open the pull request with `dsh-pr-description`.

## Tools

- `gh` can default to the upstream remote in a clone that has one: pass `--repo` with the Delorun repository on every call.
- Upstream's plugin-manager specs run through `pnpm exec vitest`; a bare `vitest` finds a global pnpm and fails the spec that needs the workspace's pnpm.
- Heavy runs of `run-checks.ts` share the machine's CPU slots, memory and disk-heavy places, first come, first served, except that a small later request may start beside the blocked head of the queue when it cannot delay the head (`checks/slots.ts`); a waiting run prints why it waits, its position and how long it has waited, and `run-checks.ts --queue` shows who holds slots. A run of a few small checks takes none, and the lead's trunk push sets `DELORUN_GATE_PRIORITY=trunk` to go ahead of waiting runs.
- Run your own heavy commands (a build, `tsc`, a focused `vitest` run) inside the same budget: `node_modules/.bin/tsx delorun/apps/tools/src/with-slots.ts --slots 4 -- <command>`, with `--disk` for an install, a build or the fork suite; a test runner takes `--maxWorkers=$DELORUN_SLOTS`. Never start one beside the budget.
- To wait on a long command in the background, wait on its process id (`while kill -0 <pid>; do sleep 5; done`). A `pgrep -f '<pattern>'` loop matches its own command line, which contains the pattern, and never ends.
