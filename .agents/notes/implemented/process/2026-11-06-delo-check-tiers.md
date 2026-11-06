# Agent Note: Delo's checks run in tiers, and the full uncached run is the correctness evidence

Status: implemented

English | [中文](2026-11-06-delo-check-tiers.zh.md)

## Problem

Upstream's local checks take minutes, and developers skip a check that is slow, so the local signal becomes weak. A cache that skips work whose inputs did not change makes local runs fast, but a cache is correct only when its keys name every input that a check reads. A green cached run therefore cannot be the only evidence that a change is correct.

## Decision

Delo's checks run in four tiers.

- Pre-commit checks only the staged files, within 5 seconds.
- `pnpm check` runs the checks that the change reaches. Delo's check runner provides this command, with a local pass cache keyed on each check's declared inputs.
- `pnpm check:full`, the green-base gate and CI run every check uncached. CI runs them in shards.
- `--plan` shows which checks would run, why each one runs, and what each costs.

Each check has a time budget. A slowdown beyond the budget fails the check, as a failing test does.

## Verification

The uncached run, `pnpm check:full`, is the evidence of correctness, so a cached pass of `pnpm check` does not replace it. Each check's declared inputs are the keys of its cache entry, and an input that a check reads without declaring it is a defect that the uncached run exposes. The runner enforces each time budget.

## Related

The [local gate speed-ups decision](../process/2026-10-12-local-gate-speedups.md) keeps each check's output unchanged while it shortens the local run. Delo's tiers choose which checks run locally and use those commands.

The stock pre-commit hook in [lefthook.yml](../../../../lefthook.yml) also runs repository-wide verifiers. This decision sets the pre-commit tier for Delo to staged files only, so Delo's hook composition differs from the stock one.

The [build artifacts and build check decision](../process/2026-10-11-build-artifacts-check-split.md) separates the commands that the aggregate checks run, and Delo's check runner uses those commands.

## Alternatives considered

**Always run everything.** A full run takes long enough that people skip it, and a skipped check gives no signal, so the local run stops being evidence.

**Rely on CI only.** A failure found only after a push costs a round trip, and the pre-commit tier exists to catch what the staged files show without a full run.

**Cache everything and drop the uncached run.** A cache is only as complete as its declared inputs, and a cache with a missing input passes a changed check. The uncached run finds such a gap, so it remains the evidence.

## Consequences

Local feedback is fast for the common case, and the full uncached run remains the evidence that the cache keys are complete.

A cached pass can differ from an uncached run when a check reads an input that it does not declare, so such a gap is a defect that the uncached run must expose.

A check that exceeds its time budget fails, and it passes again only when its cost comes down, so the budget constrains the check.
