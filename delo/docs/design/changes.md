---
description: "Design of changes to a person's harness: the signed release plus the changes they approved, the Changes surface, work sessions for live reload, the one protection setting, what verify and doctor report, updates that re-apply approved edits, and recovery when a change breaks something."
---

# Changes to your harness

English

## Summary

A person has full control over their own harness, through plugins, which are preferred, or by editing the harness itself. Delo's rule is that nothing changes what the harness runs unless the person approved the change at their computer: their harness is the signed release plus the changes they approved. One place, Changes, reviews every change with its diff and a risk summary, and applies, discards or undoes it. A change the person approved is expected, so a person who edits their harness keeps full protection. When a change breaks the start or the studio, Delo leaves that change out, says so, and offers to apply it again or undo it.

## Contents

- [What stock does today](#what-stock-does-today)
- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [When a change breaks something](#when-a-change-breaks-something)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What stock does today

Delo runs upstream's plugin loading unchanged, so this is also what Delo does today.

- A plugin installed from a local folder is linked into the profile's dependencies and loads from that folder. A plugin from a registry loads from the profile's `node_modules`.
- Upstream has hot reload (`@deepseek-ai/dsh-hmr`), on in the base bundle whenever a profile is loaded. A change to the profile's bundle list or patch file, and every plugin-manager operation, recomposes the profile and replaces each loaded plugin whose files below the profile directory changed on disk, the targets of linked packages included. Watching a source folder is off unless the profile patch sets `hmr.root`. A replacement that fails to load leaves the plugin stopped and reported as failed; it is not rolled back.
- The agent can write a plugin with the ordinary file tools and install it with `plugin_manager`'s `install_bundle` on its folder. Each `plugin_manager` write action needs `danger-full-access` or the person's approval for that call. Later edits to the folder load at the next recomposition without another approval.
- Hot reload compares a file's inode, size and modification time only to decide whether to reload it. Nothing compares what changed, and Delo's instruction consent covers instruction files, skills and presets, not a plugin's source.
- The plugin manager keeps a history of the profile's files, in which each change is a version that `undo` and `restore` return to.

## What exists today

- `delorun recover safe-mode` marks the next start to boot the profile without its third-party bundles and the person's rows for them, without writing any profile file; `delorun recover exit-safe-mode` ends it. `delorun recover` (or `recover status`) also reports the profile's state, `recover rollback` rolls back the last recorded update, and `recover restore <version>` restores a profile history version.
- Changes for plugins linked from folders, `delorun changes`, work sessions, the protection setting, the agent's consent and pending plugin requests, and Changes in `delorun verify` and `delorun doctor` are built; [C21](../contracts/c21-changes.md) states them.

## The rules

1. **One surface, Changes.** Built for plugins as `delorun changes` ([C21, Commands](../contracts/c21-changes.md#commands)); the studio section and harness files are not built yet.
2. **Approved content runs, not the folder.** Built ([C21, Loading approved content](../contracts/c21-changes.md#loading-approved-content)).
3. **Work sessions give live reload.** Built at the terminal ([C21, Work sessions](../contracts/c21-changes.md#work-sessions)); Delo's own watcher copies the folder into the plugin's active directory instead of upstream's source watching, because the folder's files are not the loaded ones. The studio's button and badge are not built yet.
4. **The approval.** Built ([C21, The risk summary](../contracts/c21-changes.md#the-risk-summary)).
5. **The agent and plugins.** Built ([C21, The agent and plugins](../contracts/c21-changes.md#the-agent-and-plugins)).
6. **One protection setting.** Built ([C21, The protection setting](../contracts/c21-changes.md#the-protection-setting)); Warn and Off cover plugin content, and a changed harness file is refused in every setting: a harness edit arrives only through a reviewed harness change, not built yet.
7. **A blocked plugin.** When a plugin's files no longer match the approved version, the plugin is not loaded, the rest of the harness keeps working, and the person is offered two actions: put the approved version back, or review the current files as a change and approve them.
8. **Editing the harness itself.** `delorun changes edit-harness` makes the person's own writable copy of the installed release, which Delo then starts from. Each saved edit is a pending change against the signed file, applied like any other. The signed original is never edited, and discarding every harness change returns to it.
9. **What `verify` and `doctor` report.** Built ([C21, What verify and doctor report](../contracts/c21-changes.md#what-verify-and-doctor-report)); doctor's `release-log` line says how long the release-log check has stayed unchecked.
10. **Updates re-apply approved edits.** The update report lists each approved harness change and whether it applies to the new release. Applying is a three-way merge per file; a conflicted file takes the new release's content, and the person's version is kept beside it as `<file>.mine` and named in the report. Approved plugin versions carry over unchanged. The update's health check and rollback cover the result ([update and rollback](update-and-rollback.md)).
11. **Words.** The person sees changes, review, apply, discard, undo and working on. The code and the contract keep the technical terms.

## When a change breaks something

12. **A bad start leaves the last change out.** When a start fails, or fails the update health check, and the newest entry in Changes is a plugin or harness change, Delo tries once more without that entry. The entry is marked "left out at start" with the failure, and the terminal and the studio name it and offer Apply again and Undo. The retry writes no profile file: the change is left out by the same overlay safe mode uses. A second failure stops with the full safe-mode command. Nothing is deleted.
13. **A recovery screen that needs no plugin.** The studio's page carries a small built-in screen, part of the boot page and of no plugin, that shows when the studio fails to render and at a fixed loopback address: what failed, the recent changes, and the actions Turn off, Undo and Safe mode. Its routes are the Host's own, owner-only and loopback-only; a remote session gets "This needs you at your computer".
14. **A failed reload goes back.** Built ([C21, Commands](../contracts/c21-changes.md#commands) and [Work sessions](../contracts/c21-changes.md#work-sessions)).
15. **Safe mode in two sizes.** `delorun recover safe-mode` starts without every third-party plugin; `delorun changes off <plugin>` and `on <plugin>`, and the recovery screen, start without one. Both are entries in Changes, so they are visible and undone the same way.
16. **`doctor` names the cause.** For a failed start or a failed render, `delorun doctor` names the plugin whose code failed and the change that introduced it.

## What this does not protect against

- **Plugin code has the harness's authority.** An approved plugin can do anything the harness can, and the risk summary is computed from the change's files, not from what the code does at run time.
- **A work session runs unreviewed code.** During a work session, every edit loads live without review. The extra ask before the agent's first write and the badge are the protections; nothing prompts a review of what the agent wrote before the session ends and its result becomes the approved version.
- **Protection Off and Warn.** Under Off nothing is checked at start, and under Warn an unapproved change runs.
- **A process of the same user.** A program running as the person outside the sandbox can change the approved store and the setting itself, as the [threat model](../security/threat-model.md#other-local-processes-under-the-same-user) states for the whole home.

## Denial tests

- `a changed harness file is refused under Block`
- `a changed plugin does not load under Block`
- `no route, tool or remote session can apply a change, start or end a work session, or change the protection setting`
- `the agent's first write to an approved plugin asks`
- `a plugin outside a work session never loads from its folder`
- `a work session's badge is shown while it lasts`
- `verify never prints passed with unapproved content`
- `a conflicted file never silently keeps either side`
- `a start that fails on a new plugin starts without it and names it`
- `the retry writes nothing to the profile`
- `the recovery screen renders with every plugin's client code failing`
- `a remote session cannot use the recovery actions`
- `a failed reload leaves the previous version running`

## What is built so far

Rules 1 to 6, 9 and 14 for plugins, and `delorun changes off` and `on` of rule 15, are built ([C21](../contracts/c21-changes.md)); F16 is enforced and F15 stays designed until harness changes, the bad-start retry, the recovery screen and the studio section are built ([fundamentals](../security/fundamentals.md)). Whole-profile safe mode and the profile rollback and restore of `delorun recover` are built.
