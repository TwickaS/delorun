# Agent Note: Each model-visible Delo addition has its own switch, off in the parity composition

Status: proposed

English | [中文](2026-11-06-delo-model-visible-switches.zh.md)

## Problem

Delo adds tools, tool descriptions and prompt text that a model can see, such as the `preset_inspect` tool. Each addition changes the requests a model receives, so a recorded upstream scenario stops matching once an addition is on. A person also cannot see which additions shape the model's behaviour unless each one can be found and turned off.

## Proposal

Each tool, tool description and prompt text that Delo adds and that a model can see would have its own configuration switch. The switches would be independent: turning one off would not change another. In the parity composition, every such switch would be off, so upstream's recorded scenarios would produce the same model requests they produce in stock DSH.

## Related

A model-visible addition follows the same logging rule as upstream's model-visible text. The [reconstructable requests decision](../../implemented/architecture/2026-07-05-reconstructable-requests.md) requires that every request can be rebuilt from the session log, and a Delo addition would be covered by that rule.

Tool guidance follows the ownership rule of the [prompt variables decision](../../implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md). Each Delo tool would own its description, and each Delo package would own its prompt section.

The [stock parity proposal](../testing/2026-11-06-delo-stock-parity.md) describes the parity composition and the replay that would use these switches.

## Alternatives considered

**Always on.** An addition that cannot be switched off appears in every request, so the replay cannot match stock, and a person cannot remove an addition they do not want.

**One global switch.** A single switch turns every addition on or off together, so a person cannot keep one addition and remove another.

## Acceptance criteria

- Each model-visible Delo addition has a configuration field that turns it off.
- With every Delo addition off, the recorded upstream scenarios replay with no difference in model requests in the parity composition.
- A test that turns each addition on alone shows that no other addition changes.

## Risks

Each addition adds a configuration field, which lengthens the configuration surface that a person reads.

A scenario that does not reach an addition cannot show that addition's difference, so the replay covers only the additions that the recorded scenarios exercise.

A person who wants some additions and not others has to set several fields, because the proposal rejects a single global switch.
