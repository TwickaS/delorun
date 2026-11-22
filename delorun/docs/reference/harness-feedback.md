# Harness feedback: pain points

English | [中文](harness-feedback.zh.md)

A running board of friction met while working in this harness and this repository, so the same cost is not paid twice. Add an entry the first time something costs time; a workaround that is already known belongs in the same entry. Entries that become work name their pull request.

**How to add one.** Take the next free number, keep the entry to the lines below, and put the date first. Say what happened, what it cost, and what to do instead. A fix that lands upstream closes with the upstream pull request; one that is Delorun's closes with the Delorun pull request.

**Status:** `open`, `worked around`, `fixed` (with the reference).

## Entries

### 2026-11-06 · #1 WebKit's system libraries are missing on this host

**What happened.** This host lacks the system libraries that WebKit needs: `playwright install-deps --dry-run webkit` reports 73 missing packages. Eleven web e2e specs under `apps/web/tests` launch WebKit inline, so the changed web lane (`tests:web-changed`) cannot run their WebKit legs on this host.

**What it cost.** The lane runs Chromium only and leaves those eleven spec files out whole, since no switch runs their Chromium legs alone. Their Chromium legs then run only in CI's web snapshot gate, so a local change to one of them is not run before push.

**What to do instead.** Owner action: run `sudo npx playwright install-deps webkit` on this host, then remove the WebKit exclusion from `delorun/apps/tools/src/checks/web.ts`. The owner has deferred the host fix.

**Status:** `worked around`: the lane runs Chromium only until the host fix lands.

### 2026-11-07 · #2 The plugin-manager e2e's team dialog times out on this host

**What happened.** `apps/web/tests/plugin-manager.e2e.ts` times out in its team-dialog step, at the `waitFor` for the 智能体团队 dialog's empty-state text (30 s `locator.waitFor`), before the step's check that "Team 暂不可用" is absent. The failure reproduces with every working-tree change stashed, on the same tree, so no in-flight change causes it; the e2e runs app-boot's built `lib/`.

**What it cost.** `tests:web-changed` selects the spec whenever a changed package reaches app-boot (as the loader `refuseCode` change does), turning a lane that would otherwise decline into one that fails.

**What to do instead.** Diagnose the team dialog's availability state on this host before relying on that spec; until then, a push whose changed set reaches this spec may use `DELORUN_PUSH_SKIP=tests:web-changed` with this entry as the reason, naming the skip in the pull request.

**Status:** `open`.

### 2026-11-09 · #3 A fresh worktree's suites fail on the missing native system addon

**What happened.** After `git worktree add` and `node delorun/apps/tools/src/setup-worktree.ts`, there is no `native/system/packages/linux-x64/bin/glibc/system.node`: the addon is git-ignored and the setup builds nothing native. `tests:snapshots`, `tests:fork` and `parity-replay` then fail most of their tests with `dsh: Cannot find module '…/native/system/packages/linux-x64/bin/glibc/system.node'`: 168 of the 186 tests of `snapshots/session/headless.snapshot.ts` alone, most of them with that line. `tests:upstream-changed` fails the same way on a spec that loads it (`packages/session/session-persistence-jsonl/tests/lease.spec.ts`: 17 of 19).

**What it cost.** A fresh worktree could not run the lanes its change reaches until the addon was built by hand. The failure names a module path, not the missing step, so it reads as a broken tree rather than a missing prerequisite, and the only record of the step was the prerequisites line of the parity baseline. `tests:snapshots` alone reports 200+ failures, which hides every real one.

**What to do instead.** `pnpm run build:native-system` builds the host's addon in about a second. The lanes that load it now declare `generate:native` in their needs ([`plan.ts`](../../apps/tools/src/checks/plan.ts)), so `pnpm check` builds it before the first lane that loads it, with no manual step, and a tree that loses the addon is rebuilt on the next run because the check declares no inputs.

**Status:** `fixed`: every lane that loads the addon carries the build as a need, and [`checks-native-system.spec.ts`](../../apps/tools/tests/checks-native-system.spec.ts) asserts it.

### 2026-11-10 · #4 parity-switches flags a non-model-visible edit inside an upstream plugin's `apply`

**What happened.** `parity-switches` counts a changed line of a ledgered upstream file as a model-visible contribution when it lies anywhere in a top-level statement that holds a registration call. The `lane/sandbox-escapes` security fix binds each Session's git runner to its sandbox with one changed line inside `packages/deliverables/workspace-changes/src/index.ts`'s `apply`, which also holds upstream's unchanged `ctx.on('tools/pre-execute')` listener, so the check reports that one line although nothing the model sees changes and `parity-replay` shows no difference. No restructuring avoids it: any edit inside `apply` lands in the same statement.

**What it cost.** The check fails on a security fix that has no C16 switch to register, because the fix must hold in the parity composition too.

**What to do instead.** Review the hunk, then record it with `node_modules/.bin/tsx delorun/apps/tools/src/ledger-record.ts --non-model-visible-hunk <path>:<line> --reason "<one line>"`, which adds its digest to the file's security entry under `nonModelVisibleHunks` and exits 3 for the lead's verdict; `parity-switches` then passes that exact hunk and fails again when it changes ([tools README](../../apps/tools/README.md)). A skip of `parity-switches` or of `tests:fork` needs the lead's authorisation for that push and is never available for the trunk.

**Status:** `fixed`: security entries record reviewed non-model-visible hunks, and the check reads them.

## Where to go next

The [parity baseline](parity-with-deepseek-harness/parity-baseline.md) records the host state that several entries depend on. The [reference index](README.md) lists the other developer pages.
