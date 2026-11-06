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
