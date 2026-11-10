---
description: "The @delo/changes library: the approved copies of plugins linked from folders, the change log, pending changes computed from a folder with their diff and risk summary, the protection setting, the work-session record, and the start step that loads approved content."
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
- [Not covered](#not-covered)
- [Development](#development)

## Use this package

```text
import { enforceApprovedContent, pluginChange, startNotice } from '@delo/changes'

const changes = await enforceApprovedContent({ home, profile, profileDir })
output(startNotice(changes))
```

`delorun start` and `delorun headless` call `enforceApprovedContent` through `delo/apps/cli/src/changes/start.ts` in their pre-start step `changes`, before upstream prepares the profile. `checkChangesInvariants` returns the invariants that do not hold; the composition's approved plugin content step refuses the start when it returns any.

## Where the files are

Everything is under `changes/` in the Delo home, which confined commands can neither read nor write (contract C1). `store/objects/` holds file contents by SHA-256 and `store/versions/` the file list of each content version, named by the SHA-256 of its entries. `profiles/<profile>/active/<plugin>/` is the directory the profile's `link:` dependency names; `active.json` says what each holds, `log.json` is the change log and `work-session.json` the work session. `protection.json` holds the protection setting. The profile's `package.json` records each approved plugin's folder and version under `delo.changes`, so every profile history version holds it.

## How the profile loads approved content

pnpm resets the `node_modules` link of a `link:` dependency on every operation, so the start moves the recorded dependency itself: `package.json`, the lockfile's importer entry and the link name the active directory. Under Block the active directory holds the approved version, or nothing for a plugin with none, so upstream skips it; under Warn and Off, and in a work session, it holds the folder's content. Files that differ from what the directory should hold are replaced in place, so upstream's hot reload replaces exactly the changed modules.

The first start under Changes approves every linked plugin as it is and says so once. A plugin linked later waits for review. Links into the runtime store and to the directory the running installation carries for that package are the harness, not plugins, and are left alone: a source checkout runs the whole harness from the checkout. A plugin's links to sibling workspace packages are included in its content; a sibling's own dependencies, and installed packages, load from where they are installed.

## Pending changes and the risk summary

`pluginChange` stores the folder's content as a version and compares it with the approved one: the files added, changed and removed, a unified diff bounded at 256 KiB with files larger than 1 MiB and binary files named only, and a risk summary. The change id is derived from the plugin, its folder and both versions, so applying an id applies exactly the content that was shown. `reviewChange(input, checks)` runs the six built-in checks; it is the one place a later extension point adds registered checks. The summary is a help to the reader and not a protection: a plugin's code can do anything Delo can.

## Records and who writes them

Every record is a 0600 file whose reader refuses an unknown field, value or mode with `RECORD_UNREADABLE`. `setProtection` accepts only a proof from `attestTerminal`, which requires standard input and output to be terminals; `openWorkSession` and `closeWorkSession` accept a terminal proof or a studio proof from `attestStudio`, which requires the loopback address, the studio's credential and no remote session. A proof is refused unless one of these functions issued it.

## Not covered

- Plugin code runs with the harness's full authority; nothing here confines it.
- A changed file of the harness itself is refused by the runtime store's start check in every protection setting.

## Development

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/changes` runs the specs; `node_modules/.bin/tsc --noEmit -p delo/packages/changes/tsconfig.json` typechecks.
