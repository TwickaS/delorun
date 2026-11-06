# Agent Note: Seam-first rule for Delo's behaviour

Status: implemented

English | [中文](2026-11-06-delo-seam-first.zh.md)

## Problem

Delo changes what a person's copy of DSH does: the studio, safe updates, workspace permissions, reach from other devices and more. If each change edits the upstream code where it sits, every upstream release has to merge those edits, the line between upstream behaviour and Delo behaviour disappears, and a reviewer cannot tell from the tree which code Delo owns. DSH already exposes plugins, client slots, registries, theme layers and configuration fields as documented extension points, and most Delo behaviour can be expressed on them.

## Decision

Delo's behaviour lives under `delo/` and attaches to upstream's documented extension points: plugins, client slots, registries, theme layers and configuration fields, including the Service Definitions of capability seams. The [seam-first rule](../../../../delo/docs/reference/glossary.md) is the name that Delo's glossary gives this decision.

When a needed change has no extension point, the change adds one to the upstream tree as a hook, a Service Definition or a configuration field, and the behaviour stays under `delo/`. Editing upstream behaviour in place is allowed only when no extension point can carry the change. Such an edit is recorded in the [divergence ledger](../../../../delo/upstream-patches.json) with its reason and class, as the [hard fork decision](../process/2026-11-06-delo-hard-fork-on-upstream-tag.md) requires.

This note uses "extension point" for hooks, slots, registries, theme layers and configuration fields. It reserves "seam" for upstream's capability seam, the complete capability made of a Service Definition, its Service Providers and its Consumers. The root guide states the rule as "a missing seam is added upstream as a seam (hook, Service Definition, configuration field)", which applies the word more widely than this note does.

## Verification

Each upstream file outside `delo/` that Delo changes appears in the ledger with a reason and a class, so a reviewer can compare every edit with this rule. Each upstream merge records a verdict for every changed file that applies cleanly, and that review finds an edit that an extension point could have carried.

## Related

The [capability seams decision](../architecture/2026-06-13-capability-seams.md) defines "seam" as the three roles together and reserves the word for that complete capability. This note follows that reservation. The [web capability seam](../architecture/2026-06-24-web-capability-seam.md) and the [approval seam](../feature/2026-07-06-approval-seam.md) are examples of capability seams that Delo behaviour can attach to.

## Alternatives considered

**Patching upstream freely.** Edits wherever a change is needed make every upstream release a merge of each such edit. The boundary between upstream and Delo is lost, because one file's history mixes both.

**Forking packages.** A copy of an upstream package under a new name receives no upstream fixes, and it drifts from the contracts that stock plugins and profiles name in configuration.

## Consequences

Most Delo changes arrive as plugins under `delo/`, and the upstream tree changes only where a needed extension point is missing.

A change that needs an extension point the upstream tree lacks takes two steps: the extension point is added first, and then the behaviour attaches to it.

The divergence ledger lists every remaining in-place edit, so the cost of each upstream merge is visible in one file.
