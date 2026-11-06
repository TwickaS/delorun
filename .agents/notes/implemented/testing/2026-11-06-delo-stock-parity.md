# Agent Note: A fresh install follows stock DSH, checked by a parity replay

Status: implemented

English | [中文](2026-11-06-delo-stock-parity.zh.md)

## Problem

A person who moves between stock DSH and Delo, or who runs a plugin, skill or recorded workflow written for DSH, needs the same behaviour unless Delo states a difference. Delo changes some defaults and adds model-visible behaviour, so a difference can arise without anyone noticing. Best-effort compatibility gives no list of the differences that exist, and no way to show that the stock workflow still runs.

## Decision

A fresh Delo install follows the stock DSH workflow: the same start, the same sessions, and the same plugins and profiles. Upstream's four modes, Standard, PTC, Minimal and Creator, are offered in every new chat.

Each default that Delo changes is listed in the [parity checklist](../../../../delo/docs/reference/glossary.md), with the evidence for the change. The checklist lists every stock feature at the upstream tag, with its evidence and each deliberate difference.

The parity composition is Delo's runtime with the studio composition bundle and Delo's model-visible changes switched off. The parity replay runs upstream's recorded-session scenarios through the parity composition, and the output must match the expected output of each scenario. Those scenarios are the ones that `pnpm run test:snapshot` replays through the shipped profiles.

## Verification

`pnpm run test:snapshot` is the keyless recorded-session replay of upstream's scenarios through the shipped profiles. The parity replay applies the same scenarios to the parity composition, and an output that differs from the expected output fails the replay. Each default that Delo changes has a row in the parity checklist with its evidence.

## Related

The [default product isolation decision](../process/2026-09-12-default-product-experimental-isolation.md) and the [optional bundles decision](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md) keep experimental capabilities out of the default product. The parity composition applies the same kind of boundary to Delo's additions.

The [PTC mode decision](../feature/2026-06-15-ptc.md) keeps `native` as the default value of the tool runtime's `mode` setting. Delo's preselection of PTC in onboarding is a Delo default that the parity checklist lists, and it does not change that setting.

The [Creator mode decision](../architecture/2026-09-16-creator-persistent-plugin-management.md) describes one of the four modes that stay in every new chat.

## Alternatives considered

**Best-effort compatibility.** Without a replay, each difference is found when a person meets it, and no list of differences exists to check against.

**Delo-only defaults.** Changing defaults without a stock replay breaks plugins, skills and recorded workflows written for DSH, and it removes the evidence that a fresh install still follows the stock workflow.

## Consequences

Every stock default that Delo changes appears in one list, and each new difference needs a row in that list.

The replay runs against each upstream release, so an upstream change that alters a recorded scenario appears as a replay difference and not as a silent change.

A Delo addition that reaches a model request must be switched off in the parity composition, or the replay fails. This constrains how each new model-visible addition is introduced.
