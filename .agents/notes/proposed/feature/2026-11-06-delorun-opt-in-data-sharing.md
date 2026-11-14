# Agent Note: Anything leaving the machine is opt-in, and Delorun has no telemetry of its own

Status: proposed

English | [中文](2026-11-06-delorun-opt-in-data-sharing.zh.md)

## Problem

Stock DSH sends data to DeepSeek by default in two ways: its session-log upload is on by default, and its desktop application has product analytics. A person who installs Delorun must not find that data has left the machine because of a default they did not choose. Delorun does not add a collection of its own.

## Proposal

Delorun would have no telemetry of its own. Upstream's desktop analytics and DeepSeek session-log upload would remain available and would be off unless the person turns them on. Any telemetry that Delorun adds would be opt-in, with its exact payload shown.

Anything that leaves the machine would be opt-in, and Delorun would explain what an option sends before the option takes effect. A request from Delorun to a Delorun host that is on by default would need a lead's approval and an entry in the network test's allowlist, as the root guide requires for new default-on requests.

In the parity composition, the session-log upload would keep the stock value, because the recorded scenarios exercise the shipped default and the stock value keeps them matching the expected output. A fresh install would give the person the default off.

## Related

The [session-log upload default decision](../../implemented/architecture/2026-09-14-session-log-upload-default.md) makes the upload on by default in every process. This proposal would depart from it for Delorun, whose fresh-install default would be off. The upstream decision would stay in force for stock DSH.

The [bounded upload decision](../../implemented/architecture/2026-09-24-bounded-session-log-upload.md) limits the size of each upload once the upload is enabled. Delorun would keep those bounds.

The [explicit-feedback decision](../../implemented/architecture/2026-09-05-nonofficial-feedback-otel.md) sends feedback only after the person creates a feedback event. This proposal would not change that rule.

## Alternatives considered

**Upstream's defaults.** Keeping the upload and analytics on would send data from every fresh Delorun install without a choice, which the stock-first rule of the project forbids.

**Removing the features.** Removing the upload and analytics would make every upstream merge conflict with deleted code, and it would remove an option that a person may choose.

## Acceptance criteria

- In a fresh Delorun install every upload and analytics setting is off, which a test in Delorun's composition asserts.
- Turning on each option shows its exact payload before the option takes effect.
- The parity replay passes with the stock upload value in the parity composition.

## Risks

Fresh Delorun installs would stop sending session logs to DeepSeek, so recorded data would come only from people who opt in, and people who move from DSH would see a different default for a behaviour they knew.

Each option needs an explanation before it applies, which adds interface text that must be translated into every upstream UI language.

Stock and Delorun would differ in two defaults, and the parity checklist would list both, so the checklist grows with each default that this proposal changes.
