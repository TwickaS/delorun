# Harness feedback: pain points

English | [中文](harness-feedback.zh.md)

A running board of friction met while working in this harness and this repository, so the same cost is not paid twice. Add an entry the first time something costs time; a workaround that is already known belongs in the same entry. Entries that become work name their pull request.

**How to add one.** Take the next free number, keep the entry to the lines below, and put the date first. Say what happened, what it cost, and what to do instead. A fix that lands upstream closes with the upstream pull request; one that is Delo's closes with the Delo pull request.

**Status:** `open`, `worked around`, `fixed` (with the reference).

## Entries

### 2026-11-06 · #1 WebKit's system libraries are missing on this host

**What happened.** This host lacks the system libraries that WebKit needs: `playwright install-deps --dry-run webkit` reports 73 missing packages. Eleven web e2e specs under `apps/web/tests` launch WebKit inline, so the changed web lane (`tests:web-changed`) cannot run their WebKit legs on this host.

**What it cost.** The lane runs Chromium only and leaves those eleven spec files out whole, since no switch runs their Chromium legs alone. Their Chromium legs then run only in CI's web snapshot gate, so a local change to one of them is not run before push.

**What to do instead.** Owner action: run `sudo npx playwright install-deps webkit` on this host, then remove the WebKit exclusion from `delo/apps/tools/src/checks/web.ts`. The owner has deferred the host fix.

**Status:** `worked around`: the lane runs Chromium only until the host fix lands.

### 2026-11-07 · #2 The plugin-manager e2e's team dialog times out on this host

**What happened.** `apps/web/tests/plugin-manager.e2e.ts:1215` times out waiting for the 智能体团队 dialog's "Team 暂不可用" text (30 s `locator.waitFor`). The failure reproduces with every working-tree change stashed, on the same tree, so no in-flight change causes it; the e2e runs app-boot's built `lib/`.

**What it cost.** `tests:web-changed` selects the spec whenever a changed package reaches app-boot (as the loader `refuseCode` change does), turning a lane that would otherwise decline into one that fails.

**What to do instead.** Diagnose the team dialog's availability state on this host before relying on that spec; until then, a push whose changed set reaches this spec may use `DELO_PUSH_SKIP=tests:web-changed` with this entry as the reason, naming the skip in the pull request.

**Status:** `open`.
