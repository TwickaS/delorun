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
- `delorun doctor` checks Docker, the DeepSeek API key's format, the home and the studio's port. For the CLI profile's plugins it reports each installed package's source and whether it is enabled, version ranges the running release does not meet, packages hidden by a shipped package of the same name, enabled bundles that are not installed, safe mode, and the plugin rows that did not activate at the last start, from the home process's log. It reports nothing about approved content or the change that introduced a failure.
- There is no Changes surface, no store of approved content, no work session, no protection setting, and no per-plugin safe mode. `delorun verify` checks the installed release's files and its signature, and reports its other checks, the plugin check among them, as not run.

## The rules

1. **One surface, Changes.** Every change to what the harness runs is one item: a plugin's files, a plugin install or update, a file of the harness itself, and a setting that weakens a guard. Each item shows the changed files, a diff and a risk summary, and is applied, discarded or undone. Changes is a section of the loopback studio and the command `delorun changes [list | show <id> | apply <id> | discard <id> | undo <id> | work <plugin> | done <plugin>]`. Applied changes are versions in the profile history upstream already keeps, so undo and restore use one history.
2. **Approved content runs, not the folder.** For a plugin linked from a folder, Delo keeps the approved version in the home and loads that. Edits in the folder appear in Changes as pending and change nothing that runs. Applying one replaces the approved version and reloads the plugin through upstream's hot reload.
3. **Work sessions give live reload.** `delorun changes work <plugin>`, or the studio's button at the computer, starts a work session: Delo loads that plugin from its folder and turns upstream's source watching on for it, so edits load live, and a badge names the plugin while the session lasts. The session ends with `delorun changes done <plugin>`, the studio's button, or when Delo stops. At its end the folder's state becomes the approved version and the whole diff is recorded as one history version. A remote session and the model cannot start, extend or end a work session.
4. **The approval.** The risk summary is computed from the change: whether it registers or replaces a consent, a guard or the sandbox policy; adds a tool the model can call; runs commands; reaches the network; reads the Delo home; or adds a build script or a dependency. A change with any of these needs a second confirmation. The summary helps the reader and is not a security boundary: plugin code runs with the harness's full authority. No approval is offered to a remote session or to the model.
5. **The agent and plugins.** Before the agent's first write to an approved plugin's folder in a chat, a consent names the plugin and says the agent is changing what the harness runs. Its writes then appear in Changes like any other; during a work session they load live. The agent cannot apply a change, start a work session or change the protection setting.
6. **One protection setting.** One setting says what happens to a change the person did not approve: **Block**, the default, refuses the start for a changed harness file and does not load a changed plugin, with the plugin and the reason named; **Warn** runs it and shows it at every start and in the studio; **Off** checks nothing at start, for source checkouts and development. `delorun changes protection <block|warn|off>` at a terminal on the home's computer is the only way to lower it; a remote session and a model's tool cannot. A download is verified before it is installed in every setting.
7. **A blocked plugin.** When a plugin's files no longer match the approved version, the plugin is not loaded, the rest of the harness keeps working, and the person is offered two actions: put the approved version back, or review the current files as a change and approve them.
8. **Editing the harness itself.** `delorun changes edit-harness` makes the person's own writable copy of the installed release, which Delo then starts from. Each saved edit is a pending change against the signed file, applied like any other. The signed original is never edited, and discarding every harness change returns to it.
9. **What `verify` and `doctor` report.** `delorun verify` prints the signed release and its checks, then "N changes you approved" with their names, then anything not approved; it never prints a plain `passed` while unapproved content is present. `delorun doctor` reports, for each plugin, whether it loaded, whether its content is the approved version, its declared version requirements, and what it registers that changes a consent or a guard; and for the harness, the protection setting, any work session in progress and how long the release-log check has gone without running.
10. **Updates re-apply approved edits.** The update report lists each approved harness change and whether it applies to the new release. Applying is a three-way merge per file; a conflicted file takes the new release's content, and the person's version is kept beside it as `<file>.mine` and named in the report. Approved plugin versions carry over unchanged. The update's health check and rollback cover the result ([update and rollback](update-and-rollback.md)).
11. **Words.** The person sees changes, review, apply, discard, undo and working on. The code and the contract keep the technical terms.

## When a change breaks something

12. **A bad start leaves the last change out.** When a start fails, or fails the update health check, and the newest entry in Changes is a plugin or harness change, Delo tries once more without that entry. The entry is marked "left out at start" with the failure, and the terminal and the studio name it and offer Apply again and Undo. The retry writes no profile file: the change is left out by the same overlay safe mode uses. A second failure stops with the full safe-mode command. Nothing is deleted.
13. **A recovery screen that needs no plugin.** The studio's page carries a small built-in screen, part of the boot page and of no plugin, that shows when the studio fails to render and at a fixed loopback address: what failed, the recent changes, and the actions Turn off, Undo and Safe mode. Its routes are the Host's own, owner-only and loopback-only; a remote session gets "This needs you at your computer".
14. **A failed reload goes back.** When replacing a plugin fails, Delo reloads the last version that loaded, from the approved store or, in a work session, the last content that loaded, and shows the error in the studio and the terminal. A work session stays open and keeps watching for the next edit.
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

Whole-profile safe mode and the profile rollback and restore of `delorun recover` are built. None of the rules above is built; fundamentals F15 and F16 record the rule and the protection setting as designed ([fundamentals](../security/fundamentals.md)).
