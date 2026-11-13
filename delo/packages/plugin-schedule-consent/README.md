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

- **Naming.** `nameEffect` turns one approved call's [`ScheduleEffect`](../../../packages/schedule/schedule/src/types.ts) into one sentence: the task's title, the start of the instruction it sends, the recurrence, the chat the deliveries reach — by its title when it has one, or a new chat the first delivery opens and the directory it opens in — and the permission preset that chat runs under. The runtime hands every text fact over bounded in length and without control characters, and an edit names what the task will be after it, so an edit of the instruction alone states the new instruction. The text joins the approval's reason, so the ask states what would start running; an effect without a recurrence names nothing.
- **Baseline.** The preset the approved ask named becomes the task's delivery baseline, even when the chat moves before the person answers, so a delivery is measured against what the person saw.
- **Delivery review.** `reviewDelivery` compares the preset the task captured at creation with the preset the target chat runs under now, both read by the runtime and handed to the service. The same preset delivers. A chat that moved since the approval — wider included, narrower too — refuses with `the target chat moved from the "<creation>" permission preset to "<current>" after the task was approved`, because the approval named the preset the deliveries run under and no other reading was approved.
- **Unnamed and unreadable presets.** A task created while no preset service was composed stores no preset; once its chat runs a named preset, the delivery refuses with `the target chat runs the "<current>" permission preset, which the task's approval did not name`. When the preset cannot be read any more, the delivery refuses with `the target chat's permission preset cannot be read to compare with the "<creation>" preset the task was approved under`, so a delivery never runs unverified.
- **Pausing and groups.** The runtime pauses a refused task before it delivers, so no later occurrence retries it, and screens a due group member by member, so one refused member pauses alone while the remaining members keep one message. Every occurrence of a recurring task is reviewed. The reason reaches the model through the typed `schedule/consent-refused` error and the log.
- **Chats a delivery opens.** `presetFor` names the preset a new chat starts with: its Workspace's, read from `permissionDefaults.defaultPreset(cwd)` when `@delo/plugin-permission-defaults` is mounted, which seeds that preset into every new chat. The approval names that preset, the task stores it as its baseline, and a delivery that opens the chat is reviewed under it before the chat exists, so a refused delivery creates no chat. Without that service or a directory the deployment default stands in. After the chat is opened and its Workspace joined, the runtime reads the preset again and reviews once more when it differs from the one reviewed, for every kind of target; a chat refused at that point keeps its reservation, so re-approving the task reuses it.
- **Queued reminders.** A reminder an earlier delivery left queued — after a Host restart, say — is reviewed again before recovery wakes it. A refusal, or a task the consent already refused, withdraws the reminder from the inbox, so no turn reads it, and pauses the task.
- **Failing closed.** The runtime delivers only on the declared `allow` verdict; an unrecognised verdict or a refusal without a reason refuses with a fixed reason. A review that throws delivers nothing and leaves the task armed for the next drive; a manual run reports it as the typed `schedule/consent-failed` error.
- **One read of its own.** The service holds no state and injects nothing: it compares the two presets it is handed, names the effect it is handed, and reads the optional `permissionDefaults` service for a new chat's Workspace preset. Mounting or disposing it mid-session changes only the later approvals and deliveries.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Mounts the consent service. Delo's `scheduled_task_consent` switch is this field: a composition that mounts the plugin with `enabled: true` gets the naming and the review, and any other composition keeps upstream's behaviour. |

## Known limitations

- The review compares preset names, not scopes: a preset renamed without changing what it allows refuses until the task is approved again, and two names with the same scope in different deployments are unrelated.
- The service ranks no presets, so a move to a narrower preset refuses too; whenever the approved preset is not provably the one the delivery would run under, the review refuses.
- The plugin does not edit stored tasks; lifting a refusal is the person's later edit or re-creation of the task, and the consent reviews each delivery again with the presets of that moment.
- A task created for a chat that is not running stores no baseline, because its preset cannot be read without restoring the chat, so its first delivery refuses until the person approves an edit while the chat runs.
- A new chat whose creation names no directory opens in the Host's own directory, which the service does not know; it is reviewed under the deployment default and then again under the preset it got.
- The main chat's own guard asks before every schedule management call and decides alone, so those asks state the guard's text rather than this naming, and an edit approved there does not re-approve a refused task.

## Tests

[`tests/consent.spec.ts`](tests/consent.spec.ts) covers the preset matrix without a composition: the same preset delivers, a chat that moved to a wider preset refuses with its reason, the narrower, unnamed and unreadable readings refuse with theirs, a task and a chat without presets deliver, the naming states the title, the instruction, the recurrence, the chat by title or the new chat's directory, and the preset, the Workspace preset is read for a chat opened in a directory, the mounted service provides all three and a disabled mount provides nothing, and the configuration schema defaults `enabled` to false. The runtime's side of the seam is covered in the upstream schedule packages' `consent.spec.ts` files.

## When the service fails

If the consent's service fails to start while `enabled` is on, the row stays active and mounts a service that refuses every scheduled delivery. The refusal names the row `delo-schedule-consent` and the failure, and says to restart Delorun, read the logs or start in safe mode; the refused tasks are paused and need resuming. With `enabled` off nothing is mounted.
