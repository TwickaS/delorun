---
description: "The hold behind Delo's plugin_changes_pending switch, for maintainers changing what happens when the agent asks plugin_manager to install, update or remove a plugin."
kind: "package-bundle"
---

# @delo/plugin-changes

## Summary

`@delo/plugin-changes` keeps the agent from changing which plugins the harness runs. With its C16 switch `plugin_changes_pending` on, a `plugin_manager` call whose action is `install_bundle` or `remove_bundle` does not run: a `tools/pre-execute` listener records it in the profile's change log as a pending change ([C21](../../docs/contracts/c21-changes.md#the-agent-and-plugins)) and denies the call with a result the model reads, `Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.` The tool never reaches its own full-access approval for these actions, and the person applies or discards the change at their computer with `delorun changes`. With the switch off, the default and the parity value, the plugin registers nothing and the tool runs and asks as upstream's does.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **What is held.** `install_bundle` records a `plugin-install`, or a `plugin-update` when the spec is a registry version of a plugin the profile already has; the tool offers no update action, so this is how the agent asks for one. `remove_bundle` records a `plugin-remove`. Every other action and tool goes on to the next listener.
- **What is recorded.** `recordPluginRequest` of `@delo/changes/install` writes one pending entry with `subject.spec` and, when the spec names it, `subject.plugin`, under the profile write lock, into the profile the Host runs (`ctx.profileContext`). It writes no manifest, lockfile, `node_modules` or approval. A request that still waits keeps its id; a repeat of a decided request is a new change.
- **What the model reads.** A recorded request is denied with error code `PLUGIN_CHANGE_PENDING` and the change's id; an update says `Nothing was installed or updated.` and a removal `Nothing was removed.` A call with no target, a spec pnpm would not accept, a removal of a name that is no dependency, a Host without a profile, or a log that cannot be written is denied with `PLUGIN_CHANGE_UNRECORDED` and the reason, and records nothing. The denial is the tool call's logged result, so no session event is added.
- **The guard.** A `pre-execute` listener that allowed such a call without calling `next()` would skip the recording. The plugin's tool guard, which runs after every listener and cannot be overruled, denies every such call its listener did not record.
- **No decisions.** The plugin imports no function that applies, discards or undoes a change, opens or ends a work session, or changes the protection setting; `delo/packages/changes/tests/reach.spec.ts` holds it to that.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Delo's C16 switch `plugin_changes_pending`. `@delo/bundle-local` mounts the plugin with `enabled: true` in its `delo-plugin-changes` row; the parity overlay restates that row disabled. |

## Known limitations

- `undo` and `restore`, which `plugin_manager` offers with the `profile_history` switch, can bring back plugins an earlier profile version held; they keep the tool's full-access approval.
- `set_plugin` and `set_bundle` turn plugins the profile already has on and off; they keep the tool's full-access approval too.

## Tests

[`tests/plugin-changes.spec.ts`](tests/plugin-changes.spec.ts) runs upstream's `plugin_manager` tool through the real tool pipeline: an install, an update and a removal each record a pending change, leave the profile's files byte for byte as they were and never reach the approval; a call that cannot be recorded is denied; a listener that allows the call first is overruled by the guard; other actions keep upstream's approval; and with the switch off, install and remove ask the tool's approval as upstream does. [`tests/unrecorded.spec.ts`](tests/unrecorded.spec.ts) covers a failure that is not an `Error`.
