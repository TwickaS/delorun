---
name: delo-dev-workflow
description: Use when setting up a Delo worktree, choosing which local checks to run before a commit or push, reading a failed check, deciding whether a check may be skipped, or waiting on a long check in the background.
---

# Delo development workflow

The root [`AGENTS.md`](../../../AGENTS.md) states the rules: branches, the green base, the check runner, the commit standard and the changelog. Upstream's [`dsh-pre-push-checks`](../dsh-pre-push-checks/SKILL.md) selects the evidence a change needs and [`dsh-pr-description`](../dsh-pr-description/SKILL.md) writes the pull request description; both apply in full. This skill adds Delo's procedure: the worktree, the check runner, skips and commits. The [tools README](../../../delo/apps/tools/README.md#local-checks) says what each check covers.

## Set up a worktree

1. `node delo/apps/tools/src/setup-worktree.ts` at the worktree's root, on the Node major `.nvmrc` pins (`nvm use`). It writes the git-ignored `lefthook-local.yml` (`extends: [delo/lefthook.yml]`), runs `pnpm install --frozen-lockfile` and `node scripts/install-lefthook.mjs`, and sets the ledger merge driver (`merge.delo-ledger.driver`) in the clone's shared configuration, so a repeat run changes nothing. Without the hooks file none of Delo's hooks run, and without the driver git merges `delo/upstream-patches.json` as plain text, which conflicts on parallel edits.
2. Confirm the hooks directory (`git rev-parse --git-path hooks`) holds `commit-msg`, `pre-commit` and `pre-push`.
3. The first `pnpm check` is cold: upstream's typecheck and, when no runtime build exists, `build:artifacts`, which the runner starts by itself.

## Choose what to run

Choose the evidence with `dsh-pre-push-checks`, then run it through Delo's check runner:

| Situation | Command |
| --- | --- |
| While working | `pnpm check`: the agent tier, which leaves out the replays, the web lane and the Docker lane |
| The selection and its reasons, without running it | `pnpm check -- --plan` |
| One package or file | `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts <path>…` |
| One check, such as a lane that failed | `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only <id>` |
| Before the lead fast-forwards the trunk | `pnpm check:merge`: the merge tier, with the merge-only checks; a lane's agent never needs it, and a push of the trunk runs it |
| Before asking for the base to be called green | `pnpm check:full`, or `DELO_FULL_GATE=1 git push` |

The `pre-commit` hook runs `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --pre-commit`; the `pre-push` hook runs the changed checks. The [tools README](../../../delo/apps/tools/README.md#local-checks) gives each check's budget and tier.

The test lanes, by what they need:

| Lane | Runs | Picked when |
| --- | --- | --- |
| `tests:fork` | Delo's unit specs (10 s per test) and client component specs (30 s) | its packages or their dependencies change |
| `tests:fork:integration` | Delo's `*.integration.spec.ts` specs, which start processes or write real file trees, after `tests:fork`, 60 s per test on at most 4 workers | its packages or their dependencies change |
| `tests:snapshots` | upstream's recorded-session replay | upstream-owned code changes |
| `tests:upstream-changed` | the specs of changed upstream packages and their direct dependents | an upstream package changes |

A new spec goes in its package's `tests/` directory. Name it `*.integration.spec.ts` when it runs git, Node or `tsx` children, a real profile, a release build or many durable writes to a real file tree; `gates:spec-lanes` refuses a unit spec that starts a process, and every `spawnSync` or `execFileSync` in a spec needs a `timeout`. `--only tests:fork` runs both phases.

A spec that fixes "now" fixes every time it compares against, file modification times included (`utimesSync`), or injects the clock into the code under test; a fixed date beside a time the clock or the file system supplies starts failing on the day the real clock passes it. `--only tests:moved-clock` runs the unit specs with the clock moved forward and names such a test; run it after adding dated fixtures.

## Read a failure

- `node_modules/.cache/delo-checks/report.json` holds each check's status, whether a cached pass served it, duration and peak memory; `node_modules/.cache/delo-checks/logs/<check>.log` holds its full output.
- Rerun the failed check alone with `--only <id>` before changing code. A failure that disappears when the check runs alone is contention: other suites were running beside it. Do not run test suites beside the gate.
- A timing assertion bounds a measurement by the timestamps of the system it measures, not by when the test's own command returned; a loaded host delays the command.

## Skip a check

`DELO_PUSH_SKIP=<check or group>,… git push` leaves checks out of the pre-push gate. Use it only for a check whose failure has an entry in [`delo/docs/reference/harness-feedback.md`](../../../delo/docs/reference/harness-feedback.md) with its reason and the work that will fix it, and name the skipped check in the pull request. Never skip a hook with `--no-verify`.

## Commit

1. A change people can perceive adds one fragment per feature under [`delo/changelog/unreleased/`](../../../delo/changelog/README.md); a later change to the same feature edits its fragment instead of adding another, and `assemble.ts --list-unreleased` shows where a change belongs.
2. `git commit -s` with a Conventional Commits subject; a change nobody can perceive ends with `Changelog: none (<reason>)`.
3. The `commit-msg` hook checks the message against the commit standard; the pre-push gate checks what changed since the remote branch's tip. Merging by fast-forward after the branch push does not rerun the gate, because the tree pass record covers the same commit ([tools README](../../../delo/apps/tools/README.md#local-checks)).
4. Open the pull request with `dsh-pr-description`.

## Tools

- `gh` defaults to the upstream remote in this repository: pass `--repo` with the Delo repository on every call.
- Upstream's plugin-manager specs run through `pnpm exec vitest`; a bare `vitest` finds a global pnpm and fails the spec that needs the workspace's pnpm.
- Heavy runs of `run-checks.ts` wait their turn in a first-come queue (a second run prints the holder's pid and its position); a run of a few small checks, such as `--only gates:docs`, takes no turn, and the lead's trunk push sets `DELO_GATE_PRIORITY=trunk` to go ahead of waiting runs.
- To wait on a long command in the background, wait on its process id (`while kill -0 <pid>; do sleep 5; done`). A `pgrep -f '<pattern>'` loop matches its own command line, which contains the pattern, and never ends.
