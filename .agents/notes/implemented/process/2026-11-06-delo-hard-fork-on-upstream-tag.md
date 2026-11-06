# Agent Note: Delo is a hard fork rooted on an upstream release tag

Status: implemented

English | [中文](2026-11-06-delo-hard-fork-on-upstream-tag.zh.md)

## Problem

Delo runs DeepSeek Harness (DSH) and receives each upstream release without losing the record of what Delo changed. A copy of upstream with Delo's changes kept as a patch set makes every release a manual reconstruction, and the patch set cannot be read from the repository history. A squashed import of each release erases the common ancestry that git needs to merge the upstream releases. A vendored copy has the same problem as a squashed import, because it replaces the upstream commits with a tree that git does not connect to them.

## Decision

Delo's repository contains upstream's public history, rooted at the upstream release tag `dsh-v0.2.2-rc.1`. Each upstream release enters Delo as a git merge.

Delo's own code and documentation live under `delo/`. The divergence ledger, `delo/upstream-patches.json`, records the upstream repository, tag and commit. It lists every changed or added file outside `delo/` with its reason and its class: `delo-feature` when the file serves a Delo feature, `generic-fix` when upstream could take the fix, or `security` when the file moves an approval, a refusal or an escalation and carries a lead verdict. Delo's Agent Notes under `.agents/notes/` are added files outside `delo/`, so they have entries too. The paths the ledger lists as fork-owned, `delo/` and `.agents/skills/delo-*/`, carry no entries.

When an upstream change absorbs a Delo edit, the entry is retired and the record credits the upstream change. Each upstream merge updates the ledger, reruns the parity replay and the plugin corpus, and records a verdict for each changed file that applies cleanly, grouped by feature. Ledger growth per release stays within the divergence budget, which a rehearsal merge onto upstream's newest tag measures. Exceeding the budget, or a conflict in a `security` file, needs a maintainer decision.

## Verification

The ledger schema, `delo/upstream-patches.schema.json`, fixes the record's shape: the upstream commit is a 40-character hexadecimal string, and each entry has a path, one class from the closed set and a reason. The rehearsal merge measures the ledger growth and the conflicts that each release produces.

## Related

No active upstream Agent Note decides how a fork tracks upstream releases. The procedure in [vendor/README.md](../../../../vendor/README.md) governs pinned copies of vendored packages, not the harness.

## Alternatives considered

**A soft fork with patches.** A copy of upstream with a patch set keeps Delo's changes apart, but each release requires the patch set to be rebuilt by hand, and the set cannot be checked against upstream's history. Delo would learn which upstream changes it had absorbed by comparing diffs, not from merge results.

**A squashed import per release.** Each import is one commit with no ancestry to the previous upstream release. Each subsequent import conflicts in every file Delo changed, and git cannot relate the new release's changes to the earlier ones.

**Vendoring the harness.** A vendored copy places the harness in a directory with a manifest, as [vendor/README.md](../../../../vendor/README.md) does for the pinned Cordis packages. Vendoring the whole harness leaves the tree without git ancestry to upstream, so it has the same merge problem as a squashed import, and it hides which files Delo changed.

## Consequences

Each upstream release is a git merge, and Delo's history contains upstream's public commits.

Every Delo edit outside `delo/` appears in one file with its reason and class, so a reviewer can check the fork boundary from the ledger.

The costs are merge conflicts in files Delo changed, a lead verdict for each conflicted `security` file, and a ledger that grows with each Delo edit within the divergence budget.
