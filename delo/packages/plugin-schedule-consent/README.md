---
description: "The consent behind Delo's scheduled-task switch, for maintainers changing how a scheduled-task approval names the effect it creates and how each due delivery is reviewed against the permission preset it was approved under."
kind: "package-bundle"
---

# @delo/plugin-schedule-consent

English | [中文](README.zh.md)

## Summary

`@delo/plugin-schedule-consent` provides the `scheduleConsent` service, the Service Provider of the Schedule consent seam ([`packages/schedule`](../../../packages/schedule)): [`tool-schedule`](../../../packages/schedule/tool-schedule) joins the service's naming into every `schedule_create` and `schedule_edit` approval ask, and the Schedule delivery runtime asks the service about each due delivery before it wakes its Session. The naming states the recurrence the call arms or keeps, the chat the deliveries reach and that chat's permission preset. The review delivers only while the target chat still runs the permission preset the task was approved under; every other reading refuses with a stated reason, the runtime pauses the refused task so no later occurrence retries it, and the refusal surfaces as the typed `schedule/consent-refused` error. The seam is optional: upstream's Schedule reads `ctx.get('scheduleConsent')` opportunistically, so with the plugin absent — or with `enabled` off, the schema's default — approvals and deliveries are exactly upstream's.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Naming.** `nameEffect` turns one approved call's [`ScheduleEffect`](../../../packages/schedule/schedule/src/types.ts) into one sentence: what the recurrence is, the chat the deliveries reach — the calling chat, or a new chat the first delivery opens — and the permission preset that chat runs under. The text joins the approval's reason, so the ask states what would start running; an effect without a recurrence names nothing.
- **Delivery review.** `reviewDelivery` compares the preset the task captured at creation with the preset the target chat runs under now, both read by the runtime and handed to the service. The same preset delivers. A chat that moved since the approval — wider included, narrower too — refuses with `the target chat moved from the "<creation>" permission preset to "<current>" after the task was approved`, because the approval named the preset the deliveries run under and no other reading was approved.
- **Unnamed and unreadable presets.** A task created while no preset service was composed stores no preset; once its chat runs a named preset, the delivery refuses with `the target chat runs the "<current>" permission preset, which the task's approval did not name`. When the preset cannot be read any more, the delivery refuses with `the target chat's permission preset cannot be read to compare with the "<creation>" preset the task was approved under`, so a delivery never runs unverified.
- **Pausing and groups.** The runtime pauses a refused task before it delivers, so no later occurrence retries it, and screens a due group member by member, so one refused member pauses alone while the remaining members keep one message. The reason reaches the model through the typed `schedule/consent-refused` error and the log.
- **No reads of its own.** The service holds no state and injects nothing: it compares the two presets it is handed and names the effect it is handed. Mounting or disposing it mid-session changes only the later approvals and deliveries.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Mounts the consent service. Delo's `scheduled_task_consent` switch is this field: a composition that mounts the plugin with `enabled: true` gets the naming and the review, and any other composition keeps upstream's behaviour. |

## Known limitations

- The review compares preset names, not scopes: a preset renamed without changing what it allows refuses until the task is approved again, and two names with the same scope in different deployments are unrelated.
- The service ranks no presets, so a move to a narrower preset refuses too; whenever the approved preset is not provably the one the delivery would run under, the review refuses.
- The plugin does not edit stored tasks; lifting a refusal is the person's later edit or re-creation of the task, and the consent reviews each delivery again with the presets of that moment.

## Tests

[`tests/consent.spec.ts`](tests/consent.spec.ts) covers the preset matrix without a composition: the same preset delivers, a chat that moved to a wider preset refuses with its reason, the narrower, unnamed and unreadable readings refuse with theirs, a task and a chat without presets deliver, the naming states the recurrence, the chat and the preset for an existing and a new chat, and the configuration schema defaults `enabled` to false.
