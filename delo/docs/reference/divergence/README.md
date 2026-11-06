---
description: "Delo's divergence index: the ledger of every upstream file Delo edits, its classes, how the checks measure it, the divergence budget that limits its growth per release, and where divergence records live."
---

# Divergence index

English | [中文](README.zh.md)

Delo changes some files of upstream DeepSeek Harness. The divergence ledger records each of those files with its reason and class, so the difference from upstream stays measured and reviewable. This page defines the ledger, how to read and measure it, and the divergence budget that limits how far it may grow in one release.

## Contents

- [The ledger](#the-ledger)
- [Classes](#classes)
- [Reading the ledger](#reading-the-ledger)
- [Measuring the ledger](#measuring-the-ledger)
- [Divergence budget](#divergence-budget)
- [Divergence records](#divergence-records)

## The ledger

The ledger is [`delo/upstream-patches.json`](../../../upstream-patches.json), described by its [schema](../../../upstream-patches.schema.json). It lists every file outside Delo's own trees that differs from the upstream commit it pins, with the reason for the change and the change's class. Delo's own trees are `delo/`, the `.agents/skills/delo-*/` skills and the `.agents/notes/**/*-delo-*` notes. Those files are Delo's, not upstream edits, so the ledger does not list them.

Each upstream file that Delo edits, adds or deletes is one entry, whatever its number of hunks. When upstream absorbs a change, its entry moves to `retired`, which names the upstream commit that absorbed it and the hunks it had. The retired entry stays in the ledger and is credited in the [divergence budget](#divergence-budget).

## Classes

| Class | Meaning |
| --- | --- |
| `delo-feature` | The change serves a Delo feature. |
| `generic-fix` | The change fixes something upstream could take. Each generic fix has its own commit. |
| `security` | The change moves an approval, a refusal or an escalation. It carries a lead's verdict and a denial test that fails before the change and passes after it. |

## Reading the ledger

- `upstream.repository`, `upstream.ref` and `upstream.commit` pin the upstream commit that every entry is measured against. The pin changes when an upstream release is merged.
- `forkOwned` lists the paths and globs that Delo owns outright.
- `patches` lists each upstream file with its class and a reason that states what the change does and why.
- `retired` lists entries that upstream absorbed, with the absorbing commit and the hunks each one had.

## Measuring the ledger

`pnpm --filter @delo/tools check` runs the ledger checks and exits 1 on any violation. The checks run against the pinned commit and the working tree. The full list of what they refuse is in the [tools README](../../../apps/tools/README.md).

`node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts --count` runs the same checks and prints the divergence: the number of listed entries and their hunks. A hunk is one `@@` header of `git diff --unified=0` against the pinned commit, and an untracked file counts as one hunk. Retired entries are listed separately and are not part of the count.

## Divergence budget

The budget limits how far the ledger may grow in one release, and it names the checks that enforce that limit.

- **Count.** A release's count is the ledger's non-generated entries and hunks, per class. A retired entry is credited against the count: growth is measured net of the entries and hunks that retired entries record.
- **Growth cap.** Growth per release is capped at the larger of 20 entries or 10 % of the first release's baseline entries. Growth in hunks is capped at the larger of 150 hunks or 10 % of the first release's baseline hunks.
- **Breach.** A breach of either cap needs a maintainer decision, recorded in the release notes.
- **Rehearsal merge.** Delo's budget requires that the rehearsal merge onto upstream's newest tag fail when conflicted hunks exceed 15 % of the ledger's hunks at that tag. It also fails when any `security`-class file conflicts without a recorded maintainer decision.
- **Baseline.** The first release's baseline is recorded when that release is cut.
- **Current count.** `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts --count` prints the ledger's entries and hunks against the base tag; the first release's baseline is recorded in that release's notes.

## Divergence records

A substantial change to one upstream area gets its own divergence record, a page in this directory that explains how to merge the next upstream release for that area. The change that creates the divergence adds the page. No records exist yet.

Upstream merges follow the [fork boundary](../../../../AGENTS.md#the-fork-boundary) rules in the root guide.
