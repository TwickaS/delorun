# Agent Note: A fresh install follows stock DSH, checked by a parity replay

Status: proposed

English | [中文](2026-11-06-delorun-stock-parity.zh.md)

## Problem

A person who moves between stock DSH and Delorun, or who runs a plugin, skill or recorded workflow written for DSH, needs the same behaviour unless Delorun states a difference. Delorun changes some defaults and adds model-visible behaviour, so a difference can arise without anyone noticing. Best-effort compatibility gives no list of the differences that exist, and no way to show that the stock workflow still runs.

## Proposal

A fresh Delorun install would follow the stock DSH workflow: the same start, the same sessions, and the same plugins and profiles. Upstream's four modes, Standard, PTC, Minimal and Creator, would be offered in every new chat.

Each default that Delorun changes would be listed in the [parity checklist](../../../../delorun/docs/reference/glossary.md), with the evidence for the change. The checklist would list every stock feature at the upstream tag, with its evidence and each deliberate difference.

The parity composition would be Delorun's runtime with the studio composition bundle and Delorun's model-visible changes switched off. The parity replay would run upstream's recorded-session scenarios through the parity composition, and each output would have to match the expected output of its scenario. Those scenarios are the ones that `pnpm run test:snapshot` replays through the shipped profiles.

## Related

The [default product isolation decision](../../implemented/process/2026-09-12-default-product-experimental-isolation.md) and the [optional bundles decision](../../implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md) keep experimental capabilities out of the default product. The parity composition would apply the same kind of boundary to Delorun's additions.

The [PTC mode decision](../../implemented/feature/2026-06-15-ptc.md) keeps `native` as the default value of the tool runtime's `mode` setting. Delorun's preselection of PTC in onboarding is a Delorun default that the parity checklist would list, and it would not change that setting.

The [Creator mode decision](../../implemented/architecture/2026-09-16-creator-persistent-plugin-management.md) describes one of the four modes that would stay in every new chat.

## Alternatives considered

**Best-effort compatibility.** Without a replay, each difference is found when a person meets it, and no list of differences exists to check against.

**Delorun-only defaults.** Changing defaults without a stock replay breaks plugins, skills and recorded workflows written for DSH, and it removes the evidence that a fresh install still follows the stock workflow.

## Acceptance criteria

- `pnpm run test:snapshot` passes for every recorded scenario through the parity composition, with no difference from the expected output.
- The parity checklist has one row, with its evidence, for each default that Delorun changes, and a change that alters a default without a row fails.
- A new chat in a fresh Delorun install is offered each of the four modes.

## Risks

The replay turns every upstream scenario change into a difference that a person must review, so each upstream release costs review time in proportion to the scenarios it changes.

A check that compares the checklist with the defaults in code is needed for the one-row rule to hold. This proposal does not specify that check, so the checklist could fall behind the code.

A Delorun addition that reaches a model request must be switched off in the parity composition, or the replay fails. This constrains how each new model-visible addition is introduced, and a scenario that does not reach the addition can hide its difference.
