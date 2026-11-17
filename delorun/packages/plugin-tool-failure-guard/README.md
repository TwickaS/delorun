---
description: "The guard that stops a turn which keeps hitting failing tool calls, for maintainers changing when it stops, what the model reads first, or how the stop is shown."
---

# @delorun/plugin-tool-failure-guard

English | [中文](README.zh.md)

## Summary

`@delorun/plugin-tool-failure-guard` stops a turn that keeps hitting failing tool calls, so a model that cannot reach a tool, such as a browser whose Chromium build is missing, does not spend the person's tokens trying one workaround after another. After 3 failed calls in a row the model reads one reminder to stop and tell the person what failed. After 6 failed calls in a row, or 8 failures among the last 12 calls, the turn stops before its next model request, and the chat shows one notice saying why and how to carry on. The person carries on by sending a message, which starts a fresh count. `@delorun/bundle-local` and `@delorun/bundle-headless` mount the plugin on and protect its row from the `plugin_manager` tool; the Config default stays the parity value, off, and the parity composition keeps the row disabled. This is Delorun's C16 switch `tool_failure_guard`.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **What counts.** Every tool call an agent makes is counted for that agent, after the other `tools/post-execute` listeners have run, so a call a policy listener blocked counts as the failure the model reads. A call the person refused or cancelled at an approval (`APPROVAL_REJECTED`, `APPROVAL_CANCELLED`) and a cancelled call (`ABORTED`, `ABORTED_BEFORE_DISPATCH`) do not count and do not end a run of failures. A call with no agent, and a call to a tool `exclude` names, is ignored. Subagents keep their own counts.
- **Reminder.** When a run of failures reaches `reminderAfter`, the call's result carries one extra context for the next request, a `notice` sourced `tool-failure-guard`, which the session logs as a plugin message. Its text names the failure count and the stop that follows; see [`reminderText`](src/index.ts).
- **Stop.** When a run reaches `consecutiveFailures`, or the window of the latest `windowSize` counted calls holds `windowFailures` failures, the guard waits for the step's remaining tool results, then cancels the turn at the next `agent/pre-step`, before the next model request. The turn's `turn/end` records `{ kind: 'aborted', reason: { kind: 'hook', reason: 'delorun/tool-failure-guard' } }` ([`TOOL_FAILURE_GUARD_STOP_REASON`](src/tally.ts)); no other event is added, and nothing about the stop reaches the model. The cancel keeps the inbox, so a message the person queued runs as the next turn.
- **Carrying on.** A step that admits a message from the person discards the agent's count, so the person's next message, or a message sent while the turn runs, starts afresh.
- **Notice.** The studio half registers a Conversation Definition that matches the recorded `turn/end`, and one Chat row for it ([`StopNotice`](src/client/StopNotice.tsx)), in English and Chinese. It reads only the log, so the notice shows again when the chat is reopened, under the stock look too.
- **Headless line.** With `stderrNotice` on, a stop also writes [`STDERR_NOTICE`](src/index.ts) to the process's standard error, and `delorun headless` then exits 1 as for any turn that did not complete.
- **Switch off.** With `enabled: false`, the default and the parity value, the plugin validates its limits and registers nothing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The C16 switch `tool_failure_guard`; `@delorun/bundle-local` sets it on. |
| `consecutiveFailures` | `6` | Failed calls in a row that stop the turn; at least 2. |
| `windowSize` | `12` | How many of the latest counted calls the window holds; at least 2. |
| `windowFailures` | `8` | Failed calls within the window that stop the turn; at least 2 and at most `windowSize`. |
| `reminderAfter` | `3` | Failed calls in a row after which the model reads one reminder; below `consecutiveFailures`, `0` for none. |
| `exclude` | `[]` | Tool-name patterns, `*` matching any run of characters, whose calls are ignored. |
| `stderrNotice` | `false` | Also write one line to standard error when the guard stops a turn; `@delorun/bundle-headless` sets it on, because `delorun headless` prints only the final text. |

A limit outside its range fails the row at load with `ToolFailureGuardConfigError`, whether the switch is on or off.

## Known limitations

- **Counts are in memory.** A Host restart, or a chat reloaded from disk, starts every count afresh; the stop itself is recorded.
- **Successful wandering is not caught.** A turn whose calls succeed while it gets nowhere runs on; the guard counts failures only, and upstream's `repeat-tool-reminder` covers exact repeats.

## Tests

- [`tests/guard.spec.ts`](tests/guard.spec.ts) drives a real agent loop against a scripted model: both stop rules, the reminder, refusals, policy denials, excluded tools, the switch, carrying on and the Config checks.
- [`tests/stop-notice.client.spec.tsx`](tests/stop-notice.client.spec.tsx) covers which turn endings get the notice, the row's copy and the registrations.
