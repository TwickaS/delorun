# Agent Note: Delorun's checks run in tiers, and the full uncached run is the correctness evidence

Status: proposed

English | [中文](2026-11-06-delorun-check-tiers.zh.md)

## Problem

Upstream's local checks take minutes, and developers skip a check that is slow, so the local signal becomes weak. A cache that skips work whose inputs did not change makes local runs fast, but a cache is correct only when its keys name every input that a check reads. A green cached run therefore cannot be the only evidence that a change is correct.

## Proposal

Delorun's checks would run in four tiers.

- Pre-commit would check only the staged files, within 5 seconds.
- `pnpm check` would run the checks that the change reaches. Delorun's check runner would provide this command, with a local pass cache keyed on each check's declared inputs.
- `pnpm check:full`, the green-base gate and CI would run every check uncached, and CI would run them in shards.
- `--plan` would show which checks would run, why each one runs, and what each costs.

Each check would have a time budget. A slowdown beyond the budget would fail the check, as a failing test does.

## Related

The [local gate speed-ups decision](../../implemented/process/2026-10-12-local-gate-speedups.md) keeps each check's output unchanged while it shortens the local run. The tiers would choose which checks run locally and would use those commands.

The stock pre-commit hook in [lefthook.yml](../../../../lefthook.yml) also runs repository-wide verifiers. This proposal would set the Delorun pre-commit tier to staged files only, so Delorun's hook composition would differ from the stock one.

The [build artifacts and build check decision](../../implemented/process/2026-10-11-build-artifacts-check-split.md) separates the commands that the aggregate checks run, and the check runner would use those commands.

## Alternatives considered

**Always run everything.** A full run takes long enough that people skip it, and a skipped check gives no signal, so the local run stops being evidence.

**Rely on CI only.** A failure found only after a push costs a round trip, and the pre-commit tier exists to catch what the staged files show without a full run.

**Cache everything and drop the uncached run.** A cache is only as complete as its declared inputs, and a cache with a missing input passes a changed check. The uncached run finds such a gap, so it remains the evidence.

## Acceptance criteria

- On a clean tree, `pnpm check:full` runs every check uncached, and CI reports one result for each shard.
- `pnpm check --plan` on a sample change lists each check with its reason and cost, and runs none of them.
- On the reference host, a pre-commit run on a change that stages one file finishes within the 5-second budget.
- A test in which a check reads an undeclared input shows that the cached pass can differ from the uncached run, and that the uncached run fails.
- A check whose run exceeds its budget fails its own test.

## Risks

The cache can miss an undeclared input, and the uncached run is the only proof that the keys are complete, so the full run stays a cost in CI.

The 5-second pre-commit budget may exclude checks that people expect at commit time.

Time budgets depend on hardware, so a budget can fail on a slow machine without any change to the code.
