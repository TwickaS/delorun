---
description: "The @delo/changes library: the approved copies of plugins linked from folders, the change log, pending changes computed from a folder with their diff and risk summary, the protection setting, work sessions with live reload, and the start step that loads approved content."
---

# @delo/changes

## Summary

A person's harness is the signed release plus the changes they approved at their computer. This package keeps the approved copy of every plugin the profile links from a folder, computes what a folder changed against that copy, and makes the profile load the approved copy, never the folder. The contract is [C21](../../docs/contracts/c21-changes.md).

## Contents

- [Use this package](#use-this-package)
- [Where the files are](#where-the-files-are)
- [How the profile loads approved content](#how-the-profile-loads-approved-content)
- [Pending changes and the risk summary](#pending-changes-and-the-risk-summary)
- [Records and who writes them](#records-and-who-writes-them)
- [What a person does with a change](#what-a-person-does-with-a-change)
- [Work sessions](#work-sessions)
- [Not covered](#not-covered)
- [Development](#development)

## Use this package

```text
import { enforceApprovedContent, pluginChange, startNotice } from '@delo/changes'

const changes = await enforceApprovedContent({ home, profile, profileDir })
output(startNotice(changes))
```

`delorun start` and `delorun headless` call `enforceApprovedContent` through `delo/apps/cli/src/changes/start.ts` in their pre-start step `changes`, before upstream prepares the profile. `checkChangesInvariants` returns the invariants that do not hold; the composition's approved plugin content step refuses the start when it returns any. `changesStatus` gives what `delorun verify` and `delorun doctor` report and writes nothing; `writeBootRecord` and `readBootRecord` keep `run/<profile>/changes-boot.json`, which plugins under Changes loaded at the last start.

## Where the files are

Everything is under `changes/` in the Delo home, which confined commands can neither read nor write (contract C1). `store/objects/` holds file contents by SHA-256 and `store/versions/` the file list of each content version, named by the SHA-256 of its entries. `profiles/<profile>/active/<plugin>/` is the directory the profile's `link:` dependency names; `active.json` says what each holds, `log.json` is the change log and `work-session.json` the work session. `protection.json` holds the protection setting. The profile's `package.json` records each approved plugin's folder and version under `delo.changes`, so every profile history version holds it.

## How the profile loads approved content

pnpm resets the `node_modules` link of a `link:` dependency on every operation, so the start moves the recorded dependency itself: `package.json`, the lockfile's importer entry and the link name the active directory. Under Block the active directory holds the approved version, or nothing for a plugin with none, so upstream skips it; under Warn and Off, and in a work session, it holds the folder's content. Files that differ from what the directory should hold are replaced in place, so upstream's hot reload replaces exactly the changed modules.

The first start under Changes approves every linked plugin as it is and says so once. A plugin linked later waits for review. Links into the runtime store and to the directory the running installation carries for that package are the harness, not plugins, and are left alone: a source checkout runs the whole harness from the checkout. A plugin's links to sibling workspace packages are included in its content; a sibling's own dependencies, and installed packages, load from where they are installed.

## Pending changes and the risk summary

`pluginChange` stores the folder's content as a version and compares it with the approved one: the files added, changed and removed, a unified diff bounded at 256 KiB with files larger than 1 MiB and binary files named only, and a risk summary. The change id is derived from the plugin, its folder and both versions, so applying an id applies exactly the content that was shown. `reviewChange(input, checks)` runs the six built-in checks; it is the one place a later extension point adds registered checks. The summary is a help to the reader and not a protection: a plugin's code can do anything Delo can.

## Records and who writes them

Every record is a 0600 file whose reader refuses an unknown field, value or mode with `RECORD_UNREADABLE`. `setProtection` accepts only a proof from `attestTerminal`, which requires standard input and output to be terminals; `openWorkSession` and `closeWorkSession` accept a terminal proof or a studio proof from `attestStudio`, which requires the loopback address, the studio's credential and no remote session. A proof is refused unless one of these functions issued it. `noteLoaded` and `noteFailed` record what the Host loaded or failed to load in the open work session and need no proof. `writeWorkFailure` and `readWorkFailure` keep `run/<profile>/changes-work.json`, the last failed reload in a work session.

## What a person does with a change

`src/actions.ts` holds the operations `delorun changes` calls now and the studio's Changes section later. `listChanges` computes what each plugin's folder holds against its approved content, hides a change discarded for that content, and returns the other logged changes newest first, the plugins whose folder is gone, the protection setting and any work session; `showChange` returns one change or its log entry. `applyChange`, `discardChange`, `undoChange`, `turnOff`, `turnOn` and `changeProtection` take an `AtComputer` proof and refuse one the attest functions did not issue before they read anything. `applyChange` approves exactly the version the id names and refuses with `CHANGED_SINCE_REVIEW` when the folder holds anything else; `turnOff` and `turnOn` edit only `dsh.profile.bundles` and refuse Delo's own bundle.

`src/install-actions.ts` (also the entry `@delo/changes/install`) holds the agent's plugin requests ([C21](../../docs/contracts/c21-changes.md#the-agent-and-plugins)). `recordPluginRequest`, which `@delo/plugin-changes` calls when the agent's `plugin_manager` would install, update or remove a plugin, writes one pending `plugin-install`, `plugin-update` or `plugin-remove` entry with `subject.spec` and nothing else. `applyInstallChange` takes an `AtComputer` proof, runs the injected upstream plugin operation (`add <spec>` or `remove <name>`) under the profile write lock, records one history version and reloads the Host; a spec that names a folder is linked to the plugin's active directory, empty until the person applies the folder's content, which it records as a pending folder install. `listChanges` returns the waiting requests as `requests`; `applyChange` refuses them and `undoChange` refuses an applied one.

Each runs under upstream's profile write lock and records one profile history version naming the change id; discarding and the protection setting record none. An action that changes what the Host runs then calls the injected `ReloadHost`, which `delorun changes` implements with the update channel's `changes.reload` and which answers `undefined` when Delo is not running. When the reload fails, the action goes back: the approved record, the active directory and `active.json`, or the bundle list, return to what they held, a second history version records it, the change is pending again with `lastFailure`, and the Host is reloaded once more.

## Work sessions

`startWork(ctx, plugin, proof, { reload })` opens a work session on an approved plugin and loads its folder's content at once; `finishWork(ctx, plugin, proof, { reload })` makes the folder's content the approved version, or the content that last loaded when the folder's newest content failed to load or the folder is gone, as one applied `plugin-edit` change and one history version `Work on <plugin>: <from> → <to>`. Both refuse a proof the attest functions did not issue. While the session lasts, `loadWorkSession(ctx, reload)` loads the folder's content when it is new to the session: it copies it into the active directory and reloads the Host, and when the reload fails it puts the content that last loaded back, reloads again, notes the failure and writes `changes-work.json`, leaving the session open. `workSessionFact(home, profile)` gives the open session and its last failed reload for the studio's badge.

The plugin keeps loading from its active directory, so the home process watches the folder itself (`delo/apps/cli/src/changes/work-watch.ts`) instead of setting upstream's `hmr.root`, which would watch files that are not loaded. When Delo stops, `finishWorkWithoutPerson(ctx)` ends the session the same way without loading anything; it needs no proof, so it is exported only from `@delo/changes/stop`, which only the CLI's start module imports.

## Not covered

- Plugin code runs with the harness's full authority; nothing here confines it.
- A changed file of the harness itself is refused by the runtime store's start check in every protection setting.

## Development

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/changes` runs the specs; `node_modules/.bin/tsc --noEmit -p delo/packages/changes/tsconfig.json` typechecks.
