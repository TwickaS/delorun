---
description: "The @delo/profile-safety library: contract C3's carry check that refuses an update which would lose what a person added to their profile, the extended profile history, undo and restore with their approval list, eject, safe mode and delorun recover."
---

# @delo/profile-safety

English | [中文](README.zh.md)

## Summary

This package keeps a person's profile theirs across an update. Contract [C3](../../docs/contracts/c03-update-report.md) requires that no update disables, removes or changes a plugin, bundle or row the report did not name, and that undo and restore list what they bring back before anything is written; this package is where that is decided and carried out. Before an update changes a file, the carry check compares the profile the person left with the profile the target release would leave, and refuses — with a typed reason, before anything changes — when the target would drop a row, a local plugin or a setting the person added, reorder or rewrite the bundle list they chose, or put back a plugin they ejected. The history it writes is upstream's profile history extended with the Delo axis's exemption file, Delo's own record, a copy of the home patch and the update report, so a version brings back the whole profile. With the admission `delorun` gives it, no version holds a value for a plugin's secret field ([C1](../../docs/contracts/c01-home-layout.md#secrets)). Eject takes a plugin out while keeping every row and setting the person wrote for it; safe mode starts the home without third-party plugins and edits no profile file; `delorun recover` is the command that reports where a profile stands after an update and carries out the way back. Of these, the snapshot an update takes, safe mode and `delorun recover` are reached by a shipped command. No shipped command calls the carry check (`planCarry`, `assertCarriable`) or `ejectPlugin`, so `delorun update` does not run the carry check and nothing ejects a plugin; `delorun recover restore` applies a version at once and prints what it changed afterwards, without asking first.

## Contents

- [Use this package](#use-this-package)
- [The carry check](#the-carry-check)
- [What a profile holds](#what-a-profile-holds)
- [The extended history](#the-extended-history)
- [Secret fields](#secret-fields)
- [Undo, restore and rollback](#undo-restore-and-rollback)
- [Eject](#eject)
- [Safe mode](#safe-mode)
- [delorun recover](#delorun-recover)
- [Errors](#errors)
- [Not covered](#not-covered)
- [Development](#development)

## Use this package

```text
import { assertCarriable, planCarry, readInventory } from '@delo/profile-safety'

const before = readInventory({ profileDir, homeDir })
const plan = planCarry(before, targetInventory, { report })
assertCarriable(plan, profileDir)
```

`readInventory` reads one profile's manifest, its own patch layer and the home's, and Delo's record. The target's inventory is the same shape, read from the profile as the target release would leave it, so the check compares two values and writes nothing. `report` is the update report of contract C3 when one was built: an item that names a change makes it one the person sees and confirms. `planCarry` returns every difference and every refusal; `assertCarriable` throws a `ProfileSafetyError` carrying the first refusal's code, every subject and the remedies the person is offered.

## The carry check

A difference the update report names is a change the person can see and confirm. A difference it does not name is never applied, and a difference that loses something the person added is refused outright. The refusals are:

| Code | What it refuses |
| --- | --- |
| `ROW_NOT_CARRIED` | A row the person's patch layer adds would leave the profile, or a row they disabled would load again, and no report item names it. |
| `CONFIGURATION_NOT_CARRIED` | A setting the person wrote for a row would be dropped or changed, and no report item names its row. |
| `LOCAL_PLUGIN_NOT_CARRIED` | A plugin installed from this machine (`file:`, `link:`, `portal:`, `workspace:` or a path) would leave the profile or move to another spec. |
| `BUNDLE_LIST_NOT_CARRIED` | The bundle list would be reordered, or gain a bundle, which no report reason can express; or lose one no report item names. |
| `EJECTED_PLUGIN_REINSTATED` | A plugin the person ejected would come back. |
| `UNNAMED_CHANGE` | The target would write a row, a setting or a plugin into the person's profile that no report item names. |

The check runs before the snapshot and before the switch, so a refusal leaves the profile as it was. The report's own items are what makes a change visible: a plugin the update disables is an item the person confirms, and the row that loads it stays in the profile, inert until the plugin is updated or enabled again.

## What a profile holds

`readInventory` reads the person's side of a profile:

- the bundle list, in the order it is applied;
- the rows the profile's `cordis.patch.yml` and the home's add, each with its id, its plugin name and whether the person's own patch disabled it;
- the settings the person wrote for a row some bundle declares, as the fields they set and their values;
- the plugins installed from this machine, with their spec and whether the bundle list also selects them;
- the ejections of Delo's record.

A profile whose manifest or patch layer cannot be read is refused with `PROFILE_UNREADABLE` naming the file, because a check over a profile it cannot read would mean nothing.

## The extended history

Upstream's profile history tracks the five files plugin management writes. Delo's history, `PROFILE_SAFETY_FILES`, holds those and four more: `delo-compatibility.json` for contract C17's Delo axis, `delo-safety.json` for Delo's own record of ejections and plugins a restore kept disabled, `home-cordis.patch.yml` as the profile's copy of the home patch, and `delo-update-report.json` for the report the update was shown. `recordSnapshot` writes the version an update takes before it changes anything, and contract C3's snapshot is exactly that version. Nothing outside the profile and the home patch is touched.

## Secret fields

Contract [C1](../../docs/contracts/c01-home-layout.md#secrets) keeps every secret out of patch files, and the history saves the patch files in git. A plugin marks a config field that holds a credential with the schema role `secret`; the value belongs in upstream's `.credentials.yaml`, and the plugin names it in a `credential-ref` field such as `apiKeyEnv`. `secretValuesInPatch` reads a patch layer's rows, the rows an `insert` list or a group adds included, against the Config schemas of the loaded plugins, by the row's id or, for an inserted row without one, by its plugin name, and returns each place that holds a value for a secret field: the file, the row and the field's path, with the reference fields beside it, and never the value. Empty and null values are unset, and a `!!js` expression counts as a value unless it only reads one environment variable (`process.env.NAME` or `env.NAME`); text that is not YAML is not checked. `findSecretValues` adds what moving a value needs, which `delorun` uses at start. `secretFieldAdmission` turns the check into an admission for upstream's `ProfileHistory`: given as `admit` to `openHistory` or `recordSnapshot`, it refuses a version whose profile patch or home patch copy holds such a value, and `recordSnapshot` then fails with `SNAPSHOT_FAILED` naming each place and puts the profile's copy of the home patch back as it was, so no later version of another history picks it up. `delorun` gives the same admission to the plugin manager's history and uses `secretFieldsSet` to refuse a configuration edit before it is saved ([secret fields](../../apps/cli/src/secret-fields.ts)).

## Undo, restore and rollback

`planRestore` compares the profile with a history version and returns the plan the approval prompt lists, in contract C3's shape: the plugins that are added, removed or moved to another version, the pnpm `allowBuilds` decisions that change, and the exemptions added to or removed from either axis file. A local `file:` spec appears where a version would, because it is what the profile declares. The plan also names the files it writes, the bundle list's membership changes, and whether the lockfile changes, so the dependency set is installed again only when it must. Nothing is written until `applyRestore`, and it writes only the files the plan listed.

A plugin version the current revocation list revokes comes back turned off, with its reason: a revoked bundle leaves the bundle list, and a revoked plugin's rows are disabled in the profile patch while the plugin itself stays installed. A row without an id is refused with `RESTORE_REFUSED`, because the restore would have no way to disable exactly that row. `rollbackToSnapshot` is the same restore toward the snapshot an update took, and it refuses with `RECOVER_REFUSED` when the history holds no version.

## Versions for people

`versions.ts` names and browses the history for the studio's Setup versions page and adds no store. `listProfileVersions` lists up to 50 versions newest first, each with its origin (`update` for an update's snapshot, `saved` for a version the person saved, `switch` for the version saved before a switch, `other` for any other edit) and `current` on the newest version whose files equal the profile now, ignoring the update report and the home patch copy; `unsaved` is true when none does. `saveProfileVersion` records the profile as `Saved by you` with an optional name (one line, at most 60 characters) under the profile's writer lock and reports whether the version is new. `switchToVersion` runs the restore of `delorun recover restore` with `saveFirst` set: the current setup is saved as `Before switching to <name or summary>` and the version is planned and applied in the same locked step, and a refused save leaves the profile as it was. Diffs are `planRestore`'s plan.

## Eject

`ejectPlugin` removes a package from the profile's bundle list and dependencies and records the ejection in `delo-safety.json`, with the person's reason and the time. Every row and setting the person wrote for it stays, so the configuration is there if they install it again, and a later update cannot put the plugin back — the carry check refuses that with `EJECTED_PLUGIN_REINSTATED`. Delo's own bundle cannot be ejected, because contract C11's privacy defaults hold only while it loads.

## Safe mode

Safe mode starts the home without third-party bundles and without the person's rows for them. `delorun start` runs it: the home process keeps the profile upstream's loader returned, drops its third-party layers and passes one overlay patch that disables the person's rows for them, so the only file written is the marker, `run/<profile>/safe-mode.json` under the home, outside the profile. A start in safe mode therefore leaves every file of the profile as it was — the rows, the local plugins, the settings, the bundle order and the ejections — and ending safe mode needs no repair. A marker that cannot be read is refused with `SAFE_MODE_UNREADABLE`, so a damaged home is never silently treated as a normal one.

## delorun recover

`delo/apps/cli/src/recover.ts` runs `recover` for `delorun recover`. With no action, or `status`, it reports the profile's last update (committed, rolled back, not committed while its record says `applying`, or the state it ended in with its reason), its snapshot, its recent versions, its ejections, the plugins a restore kept disabled and whether safe mode is on. `rollback` goes back from a recorded update through `@delo/update`'s rollback function, which restores the snapshot an update took through `rollbackToSnapshot`; `rollback --profile-only` with no recorded update restores the latest version. `restore <version>` brings back a named version, `safe-mode` starts without third-party plugins, and `exit-safe-mode` ends it. `--json` prints the same report as one JSON value.

## Errors

Every failure is a `ProfileSafetyError` with a `code`, the `path` it concerns, the `detail` the person reads, the `remedies` offered in contract C3's words and the `subjects` the refusal is about. The codes are closed: `PROFILE_UNREADABLE` for a profile file that cannot be read, the carry codes of the table above, `SNAPSHOT_FAILED` for a history version that could not be written, `RESTORE_REFUSED` and `EJECT_REFUSED` for a version or a package that cannot be handled as asked, `SAFE_MODE_UNREADABLE` for a marker Delo did not write, and `RECOVER_REFUSED` for an action the history cannot serve.

## Not covered

- The update itself: the pre-update report, the staging, the switch, the health check and the runtime store's rollback belong to the update and runtime-store work packages. This package decides whether a profile survives them and brings a profile back afterwards.
- The home lock. Contract C1 has `delorun recover` hold the profile's home lock while it changes the store; the CLI command that runs the runtime switch owns that, and this package's restore touches the profile and the home patch only.
- Client surfaces. The studio's Setup versions page ([`@delo/bundle-local`](../bundle-local/README.md)) lists, saves and switches versions through `listProfileVersions`, `saveProfileVersion` and `switchToVersion`; the studio has no update screen and no safe-mode switch.
- Secret fields of plugins that are not loaded. Only a loaded plugin's schema marks its secret fields, so a row of a disabled or missing plugin is not checked until it loads.
- Plugin audits. A restore lists the plugin versions it brings back, as contract C13 requires of an install; Delo itself runs no plugin audit.

## Development

The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/profile-safety`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delo/packages/profile-safety/tsconfig.json`. The history specs write real git histories in temporary directories; the rest use temporary profile directories and write nothing outside them.
