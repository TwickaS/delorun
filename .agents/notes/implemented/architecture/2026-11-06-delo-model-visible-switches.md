# Agent Note: Each model-visible Delo addition has its own switch, off in the parity composition

Status: implemented

English | [中文](2026-11-06-delo-model-visible-switches.zh.md)

## Problem

Delo adds tools, tool descriptions and prompt text that a model can see, such as the `preset_inspect` tool and the doctor tool. Each addition changes the requests a model receives, so a recorded upstream scenario stops matching once an addition is on. A person also cannot see which additions shape the model's behaviour unless each one can be found and turned off.

## Decision

Each tool, tool description and prompt text that Delo adds and that a model can see has its own configuration switch. The switches are independent: turning one off does not change another. In the parity composition, every such switch is off, so upstream's recorded scenarios produce the same model requests they produce in stock DSH.

## Verification

The recorded upstream scenarios replay under `pnpm run test:snapshot`. In the parity composition, a Delo addition that is not switched off changes a recorded request and fails the replay. Each switch is a configuration field, so a reviewer can find the switch for each addition in the configuration.

## Related

A model-visible addition follows the same logging rule as upstream's model-visible text. The [reconstructable requests decision](../architecture/2026-07-05-reconstructable-requests.md) requires that every request can be rebuilt from the session log, and a Delo addition is covered by that rule.

Tool guidance follows the ownership rule of the [prompt variables decision](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md). Each Delo tool owns its description, and each Delo package owns its prompt section.

The [parity decision](../testing/2026-11-06-delo-stock-parity.md) describes the parity composition and the replay that uses these switches.

## Alternatives considered

**Always on.** An addition that cannot be switched off appears in every request, so the replay cannot match stock, and a person cannot remove an addition they do not want.

**One global switch.** A single switch turns every addition on or off together, so a person cannot keep one addition and remove another.

## Consequences

Each model-visible addition is a configuration field, and the parity composition sets every one of them off, so the replay checks each addition.

A new model-visible addition arrives with its switch, and the parity composition turns that switch off before the addition is listed as a difference.
