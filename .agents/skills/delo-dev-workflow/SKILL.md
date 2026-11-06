---
name: delo-dev-workflow
description: Use when setting up a Delo worktree, choosing which local checks to run before a commit or push, reading a failed check, deciding whether a check may be skipped, or waiting on a long check in the background.
---

# Delo development workflow

The check-runner commands below arrive with Delo's tooling; until then, the `pnpm run` commands in the root [`AGENTS.md`](../../../AGENTS.md) apply.

The root [`AGENTS.md`](../../../AGENTS.md) states the rules: branches, the green base, the check runner, the commit standard and the changelog. Upstream's [`dsh-pre-push-checks`](../dsh-pre-push-checks/SKILL.md) selects the evidence a change needs and [`dsh-pr-description`](../dsh-pr-description/SKILL.md) writes the pull request description; both apply in full. This skill adds Delo's procedure: the worktree, the check runner, skips and commits. The [tools README](../../../delo/apps/tools/README.md#local-checks) says what each check covers.

## Set up a worktree

1. `pnpm install` at the worktree's root.
2. Write the one-line `lefthook-local.yml` at the root: `extends: [delo/lefthook.yml]`. Git ignores it.
3. `node scripts/install-lefthook.mjs`, then confirm the hooks directory (`git rev-parse --git-path hooks`) holds `commit-msg`, `pre-commit` and `pre-push`. Without the file, none of Delo's hooks run.
4. The first gate run is cold: upstream's typecheck and, when no runtime build exists, `build:artifacts` in the official profile, which the runner starts by itself.

## Choose what to run

Choose the evidence with `dsh-pre-push-checks`, then run it through Delo's check runner:

| Situation | Command |
| --- | --- |
| While working | `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --changed` |
| One package or file | `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts <path>…` |
| One check, such as a lane that failed | `node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only <id>` |
| Upstream's whole unit suite | add `--upstream` |
| Before asking for the base to be called green | the full gate: no argument, or `DELO_FULL_GATE=1 git push` |

The test lanes, by what they need:

| Lane | Runs | Picked when |
| --- | --- | --- |
| `tests:fork` | Delo's specs against sources | its packages or their dependencies change |
| `tests:built` | `*.built.spec.ts` on the host against the distribution packages built in place | a package with such specs, or one it depends on, changes |
| `tests:docker` | `*.docker.spec.ts` against images built from the tree | container code or what it depends on changes |
| `tests:snapshots` | upstream's recorded-session replay | upstream-owned code changes |
| `tests:upstream-changed` | the specs of changed upstream packages and their direct dependents | an upstream package changes |

A new spec goes in the cheapest lane that still tests its claim: sources first, built packages on the host next, containers only when the claim is about a container boundary.

## Read a failure

- `node_modules/.cache/delo-checks/report.json` holds each check's status, duration and peak memory; `node_modules/.cache/delo-checks/logs/<check>.log` holds its full output.
- A failed run keeps its temporary directory, whose path the first line of the run prints.
- Rerun the failed check alone with `--only <id>` before changing code. A failure that disappears when the check runs alone is contention: other suites were running beside it. Do not run test suites beside the gate.
- A timing assertion bounds a measurement by the timestamps of the system it measures, not by when the test's own command returned; a loaded host delays the command.

## Skip a check

`DELO_PUSH_SKIP=<check or group>,… git push` leaves checks out of the pre-push gate. Use it only for a check whose failure has an entry in [`delo/docs/reference/harness-feedback.md`](../../../delo/docs/reference/harness-feedback.md) with its reason and the work that will fix it, and name the skipped check in the pull request. Never skip a hook with `--no-verify`.

## Commit

1. A change people can perceive adds a fragment under [`delo/changelog/unreleased/`](../../../delo/changelog/unreleased/README.md).
2. `git commit -s` with a Conventional Commits subject; a change nobody can perceive ends with `Changelog: none (<reason>)`.
3. The `commit-msg` hook checks the message; the pre-push gate checks the range.
4. Open the pull request with `dsh-pr-description`.

## Tools

- `gh` defaults to the upstream remote in this repository: pass `--repo` with the Delo repository on every call.
- Upstream's plugin-manager specs run through `pnpm exec vitest`; a bare `vitest` finds a global pnpm and fails the spec that needs the workspace's pnpm.
- To wait on a long command in the background, wait on its process id (`while kill -0 <pid>; do sleep 5; done`). A `pgrep -f '<pattern>'` loop matches its own command line, which contains the pattern, and never ends.
