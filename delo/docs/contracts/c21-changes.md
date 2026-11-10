---
description: "Contract C21: Changes. A person's harness is the signed release plus the changes they approved at their computer: the approved-content store under the home, the change kinds and states, how a start loads approved content for plugins linked from folders, the protection setting, the work-session record, the risk summary, and who may change each from where."
---

# C21 Changes

## Summary

Nothing changes what a person's harness runs unless they approved it at their computer. A plugin the profile links from a folder loads from a copy of the content the person approved, kept under the Delo home; edits in the folder are pending changes until the person applies them. The library is [`@delo/changes`](../../packages/changes/README.md); `delorun start` and `delorun headless` apply it in their pre-start step `changes`, before upstream prepares the profile, and hold the prepared profile to its invariants in the composition's approved plugin content step.

## Contents

- [The home's changes directory](#the-homes-changes-directory)
- [Change kinds and states](#change-kinds-and-states)
- [Loading approved content](#loading-approved-content)
- [The first start under Changes](#the-first-start-under-changes)
- [The protection setting](#the-protection-setting)
- [The work-session record](#the-work-session-record)
- [The risk summary](#the-risk-summary)
- [Who may do what from where](#who-may-do-what-from-where)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## The home's changes directory

`changes/` is a Delo entry of the home ([C1](c01-home-layout.md#the-home-tree)) at mode 0700; every file in it is a protected file at 0600.

| Path under `changes/` | Holds |
| --- | --- |
| `protection.json` | `{"schema":"delo.changes-protection/1","level":"block"\|"warn"\|"off","setAt":<ISO time>}`; absent means `block` |
| `store/objects/<sha256>` | One file's bytes, named by their SHA-256, never rewritten |
| `store/versions/<sha256>.json` | One content version: `{"schema":"delo.changes-version/1","entries":[…]}`, entries sorted by path; its name is the SHA-256 of its canonical entries |
| `profiles/<profile>/active/<plugin>/` | The directory the profile's `link:` dependency on the plugin names; `@scope/name` is written `@scope+name` |
| `profiles/<profile>/active.json` | What each active directory holds: a version and `approved`, `work-session` or `unapproved` |
| `profiles/<profile>/log.json` | The change log: `{"schema":"delo.changes-log/1","migratedAt"?,"entries":[…]}` |
| `profiles/<profile>/work-session.json` | The work session while one lasts |
| `profiles/<profile>/scan-cache.json` | File digests by inode, size and times; an optimisation never trusted for a decision |

A version entry is a file (`path`, `digest`, `size`, `executable`) or a link (`path`, `target`, `outside`). The profile's `package.json` records each approved plugin under `delo.changes` as `{"schema":"delo.changes-approved/1","plugins":{"<name>":{"source","version","approvedAt","approvedAtUpgrade"?}}}`, so every profile history version holds the approved version and upstream's undo and restore bring it back.

## Change kinds and states

| Kind | What changes |
| --- | --- |
| `plugin-edit` | A linked plugin's folder differs from its approved content |
| `plugin-install`, `plugin-update`, `plugin-remove` | A plugin is added, moved to another version or taken out |
| `plugin-off`, `plugin-on` | One plugin is turned off or on again |
| `harness-edit` | A file of the harness itself differs from the signed release's |
| `guard-weakening` | A setting weakens a consent, a guard or the protection setting |

A change is `pending`, `applied`, `discarded`, `left-out-at-start` or `undone`. Its id is `c` and ten hexadecimal digits of the SHA-256 of its kind, subject and both versions, so an id names exactly the content that was shown. Each applied change is one version of the profile's history.

## Loading approved content

Before upstream prepares the profile, the start takes upstream's profile write lock (`package.json`'s file lock) and, for every `link:` dependency:

1. A link into the runtime store, or to the directory the running installation carries for that package name, is the harness and is left alone.
2. Any other link is moved to the plugin's active directory in `package.json`, the lockfile's importer entry and `node_modules/<name>`, because pnpm resets the link to the recorded dependency on every operation.
3. The active directory is made to hold: in a work session for the plugin, the folder's content; under `block`, the approved version, or nothing for a plugin with none, which upstream then skips; under `warn` and `off`, the folder's content. A file that differs is replaced in place, so hot reload replaces only changed modules.

A plugin's content is every file under its folder except `.git`, with links to sibling workspace packages outside the folder included as content; installed packages under `node_modules` outside the folder stay links with their absolute target and are not part of the approved content.

## The first start under Changes

The first start whose log has no `migratedAt` approves every linked plugin as it is: each is stored, recorded with `approvedAtUpgrade`, logged as an applied `plugin-install` decided at `upgrade`, and named once at the terminal. One profile history version records the move. A plugin linked after that start is a pending `plugin-install` and loads nothing under `block` until applied.

## The protection setting

`block` is the default. Under `warn` unapproved plugin content runs and every start names it; under `off` it runs without notice. A changed harness file is refused by the runtime store's start check in every setting; a home process started from the store checks its runtime at a fresh start as the launcher does.

## The work-session record

`{"schema":"delo.changes-work-session/1","plugin","source","from","startedAt","startedFrom":"terminal"|"studio","lastLoaded"?}`. One session at a time per profile; opening is an exclusive create.

## The risk summary

Six built-in checks read the new and changed lines of a change and its `package.json` on both sides: registers or replaces a consent, guard or the sandbox policy; adds a tool the model can call; runs commands; opens network connections; reads under the Delo home; adds or changes a dependency or a build or install script. Any finding asks a second confirmation before applying. The summary is heuristics, a help to the reader and not a protection: plugin code has the harness's full authority. `reviewChange(input, checks)` is the one function a later extension point extends with registered checks.

## Who may do what from where

| Action | Allowed from |
| --- | --- |
| Change the protection setting | `delorun changes protection` at a terminal only |
| Open or close a work session | A terminal, or the loopback studio with its credential and no remote session |
| Read changes | The person's own commands and the loopback studio |

A proof of presence is issued only by `attestTerminal` (standard input and output are terminals) or `attestStudio` (loopback, the studio's credential, no remote session), and a writer refuses any value those functions did not issue.

## Consumers

`delo/apps/cli` (`delorun start`, `delorun headless`); later `delorun changes`, `delorun verify`, `delorun doctor` and the studio's Changes section.

## Compatibility

A profile from before Changes is migrated at its first start without changing what it runs. Every record carries a schema tag; a reader refuses an unknown tag, field or value with `RECORD_UNREADABLE`, and a start then stops rather than guess.

## Security

### Requirements

1. Outside a work session, a plugin linked from a folder never loads from the folder under `block`: the profile's dependency, lockfile entry and link name its active directory, which holds the approved version.
2. A plugin with no approved content loads nothing under `block`.
3. A confined command cannot write `changes/`: it is under the protected home and not a read exemption ([C1](c01-home-layout.md#security)).
4. Only a terminal proof changes the protection setting; only a terminal or loopback-studio proof opens or closes a work session.
5. The store's objects and versions are checked against their names on every read.

### Denial tests

| Test | Proves |
| --- | --- |
| `a plugin outside a work session never loads from its folder` | Requirement 1 (`delo/packages/changes/tests/enforce.integration.spec.ts`) |
| `a changed plugin does not load under Block` | Requirement 1 |
| `a new linked plugin without approved content loads nothing under Block` | Requirement 2 |
| `puts a tampered active directory back to the approved version` | Requirement 1 |
| `refuses a studio proof`, `refuses an object that only looks like a terminal proof`, `refuses when standard input or output is not a terminal` | Requirement 4 (`records.spec.ts`) |
| `refuses an object whose bytes do not have its digest`, `refuses a version file whose content is not the version its name says` | Requirement 5 (`store.integration.spec.ts`) |
| `refuses a fresh start from the store whose runtime files differ, before the profile is touched` | The harness start check (`delo/apps/cli/tests/changes-start.spec.ts`) |

### What this does not prove

- Plugin code, once approved, can do anything Delo can; the risk summary does not limit it.
- A source checkout runs the whole harness from the checkout; its own code, Delo's bundles included, is not checked.
- Installed dependencies outside a plugin's folder are not part of its approved content.
