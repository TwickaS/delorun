---
description: "The hold behind Delo's plugin_changes_pending switch and the check before every reload of a running profile, for maintainers changing what happens when the agent asks plugin_manager to change plugins or when a running Host recomposes its profile."
kind: "package-bundle"
---

# @delo/plugin-changes

## Summary

`@delo/plugin-changes` keeps the agent from changing which plugins the harness runs. With its C16 switch `plugin_changes_pending` on, a `plugin_manager` call whose action is `install_bundle` or `remove_bundle` does not run: a `tools/pre-execute` listener records it in the profile's change log as a pending change ([C21](../../docs/contracts/c21-changes.md#the-agent-and-plugins)) and denies the call with a result the model reads, `Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.` The tool never reaches its own full-access approval for these actions, and the person applies or discards the change at their computer with `delorun changes`. The agent's other `plugin_manager` actions that change what runs (`set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo`, `restore`) are denied with `PLUGIN_CHANGE_AT_COMPUTER` and record nothing. Whatever the switch says, the plugin provides upstream hot reload's `profileReconcileCheck`, which checks every recomposition of the profile before anything stops ([C21](../../docs/contracts/c21-changes.md#reloads-and-restores)). With the switch off, the default and the parity value, the plugin registers no listener or guard and the tool runs and asks as upstream's does.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **What is held.** `install_bundle` records a `plugin-install`, or a `plugin-update` when the spec is a registry version of a plugin the profile already has; the tool offers no update action, so this is how the agent asks for one. `remove_bundle` records a `plugin-remove`. Every other action and tool goes on to the next listener.
- **What is recorded.** `recordPluginRequest` of `@delo/changes/install` writes one pending entry with `subject.spec` and, when the spec names it, `subject.plugin`, under the profile write lock, into the profile the Host runs (`ctx.profileContext`). It writes no manifest, lockfile, `node_modules` or approval. A request that still waits keeps its id; a repeat of a decided request is a new change.
- **What the model reads.** A recorded request is denied with error code `PLUGIN_CHANGE_PENDING` and the change's id; an update says `Nothing was installed or updated.` and a removal `Nothing was removed.` A call with no target, a spec pnpm would not accept, a removal of a name that is no dependency, a Host without a profile, or a log that cannot be written is denied with `PLUGIN_CHANGE_UNRECORDED` and the reason, and records nothing. The denial is the tool call's logged result, so no session event is added.
- **What the person makes.** `set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo` and `restore` do not run: the model reads that the person makes that change at their computer, in the studio or with `delorun plugin`, with error code `PLUGIN_CHANGE_AT_COMPUTER`, and nothing is recorded.
- **The guard.** A `pre-execute` listener that allowed such a call without calling `next()` would skip the plugin's listener. The plugin's tool guard, which runs after every listener and cannot be overruled, denies every such call its listener did not handle.
- **The check before a reload.** `profileReconcileCheck.check(profile)` runs `prepareReload` of `@delo/changes` for the profile the Host runs: a `link:` dependency that names a folder is moved to the plugin's active directory where the profile write lock allows, and a link or active directory that differs from what Changes keeps refuses the recomposition with `LOAD_REFUSED`, so nothing stops and nothing loads. A link counts as the harness's own when it is into the runtime store or names the directory the Host already loads that package from (`loadedLinks`).
- **No decisions.** The plugin imports no function that applies, discards or undoes a change, opens or ends a work session, or changes the protection setting; `delo/packages/changes/tests/reach.spec.ts` holds it to that.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Delo's C16 switch `plugin_changes_pending`. `@delo/bundle-local` mounts the plugin with `enabled: true` in its `delo-plugin-changes` row; the parity overlay restates that row disabled. |

## Known limitations

- A profile whose configuration leaves the `delo-plugin-changes` row out reloads without the check until its next start.

## Tests

[`tests/plugin-changes.spec.ts`](tests/plugin-changes.spec.ts) runs upstream's `plugin_manager` tool through the real tool pipeline: an install, an update and a removal each record a pending change, leave the profile's files byte for byte as they were and never reach the approval; a call that cannot be recorded is denied; a listener that allows the call first is overruled by the guard; other actions keep upstream's approval; the actions the person makes are denied; and with the switch off, install and remove ask the tool's approval as upstream does. [`tests/reload-check.spec.ts`](tests/reload-check.spec.ts) boots a real profile with the plugin manager and hot reload: a tampered active directory, a restore naming a folder and another process's `link:<folder>` install load nothing, and under Block upstream evaluates nothing of a plugin with no approved content. [`tests/unrecorded.spec.ts`](tests/unrecorded.spec.ts) covers a failure that is not an `Error`; [`tests/loaded-links.spec.ts`](tests/loaded-links.spec.ts) the harness-link rule.
