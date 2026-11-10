---
description: "Contract C21: Changes. A person's harness is the signed release plus the changes they approved at their computer: the approved-content store under the home, the change kinds and states, how a start loads approved content for plugins linked from folders, the protection setting, work sessions with live reload, the risk summary, and who may change each from where."
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
- [Work sessions](#work-sessions)
- [The risk summary](#the-risk-summary)
- [The agent and plugins](#the-agent-and-plugins)
- [Who may do what from where](#who-may-do-what-from-where)
- [Commands](#commands)
- [What verify and doctor report](#what-verify-and-doctor-report)
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
| `profiles/<profile>/work-session.json` | The work session while one lasts ([Work sessions](#work-sessions)) |
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

## Work sessions

A work session loads one approved plugin's folder live while the person works on it. Its record is `{"schema":"delo.changes-work-session/1","plugin","source","from","startedAt","startedFrom":"terminal"|"studio","lastLoaded"?,"lastFailed"?}`: `from` is the approved content when it started, `lastLoaded` the folder content that last loaded, and `lastFailed` folder content whose reload failed after that. One session at a time per profile; opening is an exclusive create.

- **What loads.** The plugin still loads from its active directory. Each load stores the folder's content, makes the active directory hold it with `active.json` kind `work-session`, replacing only the files that differ, and asks the running Host to reload as `changes.reload` does. A success records `lastLoaded` and removes `run/<profile>/changes-work.json`.
- **Live reload.** The home process watches `work-session.json` and, while a session is open, the plugin's folder recursively without `.git`, and loads each change once events have been quiet for 300 milliseconds. Delo watches the folder itself instead of setting upstream's `hmr.root`, because the Host loads the plugin from its active directory, so a source watch of the folder would watch files that are not loaded. Folder content that is already active, or equals `lastFailed`, is not loaded again.
- **Opening.** `startWork` needs a plugin the profile loads from its active directory with approved content and whose folder exists (`NOT_LINKED` otherwise), opens the record (`WORK_SESSION_OPEN` when one is open) and loads the folder's content at once. When Delo is not running for the profile, it closes the session again, puts the active directory and `active.json` back, and refuses with `NOT_ALLOWED`.
- **A failed reload goes back.** The active directory holds `lastLoaded` again, or `from` when nothing loaded yet, the Host reloads once more, the record notes `lastFailed`, and `run/<profile>/changes-work.json` is written: `{"schema":"delo.changes-work/1","plugin","at","error"}`, a protected file that `delorun doctor` and the studio read and nothing decides from. The session stays open.
- **Ending.** `finishWork` first loads folder content the Host has not loaded, then the folder's content becomes the approved version, or `lastLoaded` (`from` when nothing loaded) when the folder's content equals `lastFailed` or the folder is gone, and the result says which. When the approved content changed, one profile history version `Work on <plugin>: <first 7 digits of from> → <first 7 digits of the new version>` records it, and the log gains one applied `plugin-edit` change from `from` to the new version with that summary, created at `startedAt`. `active.json` records the content as `approved`, the record is removed, and `changes-work.json` is removed unless the newest content failed to load.
- **Delo stopping.** The Host's `close` stops the watcher and then ends the open session the same way without loading anything, decided where the session was started (`finishWorkWithoutPerson`, the separate entry `@delo/changes/stop`). A start of the home process that finds a session open, which a home process that did not stop left, ends it first and says so; `delorun headless` leaves it alone.

## The risk summary

Six built-in checks read the new and changed lines of a change and its `package.json` on both sides: registers or replaces a consent, guard or the sandbox policy; adds a tool the model can call; runs commands; opens network connections; reads under the Delo home; adds or changes a dependency or a build or install script. Any finding asks a second confirmation before applying. The summary is heuristics, a help to the reader and not a protection: plugin code has the harness's full authority. `reviewChange(input, checks)` is the one function a later extension point extends with registered checks.

## The agent and plugins

Two behaviours in Delo's composition decide what the agent may do to the plugins the harness runs. Each sits behind its own [C16](c16-parity-composition.md) switch, on in the composition a person runs and off in the parity composition, where the agent's writes and `plugin_manager` calls run as upstream runs them.

- **Writes to an approved plugin's folder ask once per chat** (switch `approved_plugin_write_consent`, `@delo/plugin-instruction-consent`'s `approvedPluginWrites`). Before the agent's first write in a chat to the `source` folder of a plugin the profile approved, or to its active directory, the person is asked: "The agent is changing what your harness runs: <plugin>. The change will wait for your review in Changes.", with the diff the tool carries. The folders are read from the profile the Host runs at every write; a target counts as inside one when its path resolved lexically is, or its real path is, so a symbolic link, a dangling link or a `..` spelling into the folder asks too. After the person allows it, later writes to that plugin's folders in the same chat pass until the Host restarts; another chat asks again. A refused, cancelled or unanswerable ask leaves the file unchanged, and the model reads the typed refusal `FS_CONSENT_DENIED`, such as `the user refused the write to "<path>", which changes the plugin <plugin>; it stays unchanged, so stop and explain instead of working around it`. A profile record that cannot be read refuses the write. The writes the person allows are pending changes like anyone's and load only when the person applies them, or live during a work session.
- **The agent's plugin installs, updates and removals wait for the person** (switch `plugin_changes_pending`, `@delo/plugin-changes`). A `plugin_manager` call whose action is `install_bundle` or `remove_bundle` does not run and never reaches the tool's full-access approval: it is recorded in the change log as a pending `plugin-install`, `plugin-update` (an install of a registry version of a plugin the profile has; the tool has no update action) or `plugin-remove` with `subject.spec` and, when the spec names it, `subject.plugin`, and the model reads `Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.` (for an update `Nothing was installed or updated.`, for a removal `Nothing was removed.`), with the error code `PLUGIN_CHANGE_PENDING`. A call that names no target, a spec pnpm would not accept, a removal of a name that is no dependency, or a log that cannot be written is denied with `PLUGIN_CHANGE_UNRECORDED` and records nothing. Repeating a request that still waits returns its id; a repeat of a decided one is a new change. A tool guard denies any such call the plugin's listener did not record, so a `tools/pre-execute` listener that allows the call without calling `next()` cannot run it.

Applying such a change at a terminal runs upstream's profile plugin operation, the one `delorun plugin` runs, under the profile write lock: `add <spec>` for an install or update, `remove <name>` for a removal, which also removes the plugin's approval. A spec that names a folder is never linked to the folder: the plugin is linked to its active directory, which holds nothing, and the folder's content is recorded as a pending `plugin-install` from that folder, applied like any other, so nothing the agent asked for loads before the person reviewed its content. A failed operation leaves the change pending with `lastFailure`; a successful one records one history version `Applied <id>: …` and reloads a running Host, whose failure leaves the change applied for the next start.

The model reads only the tool results above, each logged as the tool call's result like any other, so neither behaviour adds a session event; the asks are logged as upstream's `approval/asked` and `approval/decided`.

## Who may do what from where

| Action | Allowed from |
| --- | --- |
| Change the protection setting | `delorun changes protection` at a terminal only |
| Apply, discard or undo a change; turn one plugin off or on | `delorun changes` at a terminal; the actions also accept a loopback-studio proof for the studio's later Changes section |
| Open or close a work session | `delorun changes work` and `done` at a terminal, or the loopback studio with its credential and no remote session; Delo stopping closes one without a person |
| Read changes | The person's own commands and the loopback studio |

A proof of presence is issued only by `attestTerminal` (standard input and output are terminals) or `attestStudio` (loopback, the studio's credential, no remote session), and a writer refuses any value those functions did not issue.

## Commands

`delorun changes` is the terminal's way to the actions of `@delo/changes` (`listChanges`, `showChange`, `applyChange`, `discardChange`, `undoChange`, `turnOff`, `turnOn`, `changeProtection`, `startWork`, `finishWork`).

| Subcommand | What it does |
| --- | --- |
| `list` (the default) `[--json]` | The changes waiting for review, computed from each folder now, and the agent's plugin requests waiting for review (`requests`, marked `asked in a chat`), then every other logged change newest first, each plugin whose folder is gone, the protection setting and any work session |
| `show <id> [--diff] [--json]` | One change: the plugin, its folder, its files with dependency files grouped, the risk summary's lines and, with `--diff`, the bounded diff, saying when it was cut short |
| `apply <id>` | The plugin's approved content becomes the version the id names; `CHANGED_SINCE_REVIEW` when its folder holds anything else. For an agent's plugin request, upstream's plugin operation runs for its spec ([The agent and plugins](#the-agent-and-plugins)); `OPERATION_FAILED` when it fails |
| `discard <id>` | The change becomes `discarded`: it never loads and is not listed while the folder holds that content; the folder is never written |
| `undo <id>` | An applied plugin change: the approved content goes back to the change's `from`, or the plugin has none after undoing its install, and its active directory holds that until the next start, which under `warn` and `off` loads the folder's content again; a `plugin-off` turns the plugin on and a `plugin-on` turns it off; `NOT_ALLOWED` when a later change of the plugin was applied, and for the other kinds |
| `off <plugin>`, `on <plugin>` | The package name leaves, or is appended to, `dsh.profile.bundles` in the profile's `package.json`, as upstream's plugin manager writes it; `NOT_ALLOWED` for `@delo/bundle-local` and for a plugin the profile does not have in that state |
| `protection [block\|warn\|off]` | Prints the setting, or changes it; a weaker level is logged as an applied `guard-weakening` change with `subject.setting` `protection` |
| `work <plugin>` | Opens a work session and prints `Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>.`; when the folder's content fails to load at once it also reports the failure and exits 1 with the session open |
| `done <plugin>` | Ends the work session and says what became the approved version |

- **Presence and confirmation.** Every subcommand that changes something first needs standard input and output to be terminals and otherwise refuses with "This needs you at your computer: run it in a terminal." before it reads or writes anything. It then asks a yes-or-no question; anything but `y` or `yes` changes nothing. `apply` first prints the change's summary and risk lines, and when a check found something asks a second question naming the kinds. A weaker protection level first says "Changed plugins will run without your review." and what the level means.
- **One history version.** Each action runs under upstream's profile write lock and records one profile history version (`kind: person`) whose subject names the change id: `Applied <id>: …`, `Undid <id>: …`, `Turned off <plugin> (<id>)`. Discarding and the protection setting change no profile file and record none.
- **Reloading a running Home.** When the profile's home process answers, the action runs under the profile write lock and then sends [C19](c19-home-process.md)'s `changes.reload`, which carries nothing: the Host recomposes the profile through upstream's hot reload. The reload fails when hot reload is off, a plugin fails to load or start, or the change needs a restart. When no home process answers, the command holds the profile's home lock for the action, so no start runs meanwhile, and the next start loads the change.
- **A failed reload goes back.** The approved record, the plugin's active directory and `active.json`, or the bundle list, return to what they held before the action; a second history version `Went back: <id> failed to load` records it; the entry returns to `pending`, or for an undo stays `applied`, with `lastFailure` `{at, failure}`; the Host is reloaded once more; and the command reports the failure and exits 1. A plugin turned off or on that failed to load is listed with its failure and applied again by its id.
- **A plugin in a work session.** `apply` and `undo` of a plugin with an open work session are refused with `NOT_ALLOWED`.

## What verify and doctor report

`delorun verify` prints a Changes block after the release's check lines: the plugins the person approved, each with its folder and marked when the first start under Changes approved it, then everything present that they did not approve: each plugin whose folder differs from its approved content, each plugin whose active content is of kind `unapproved` (under `warn` or `off`), and each invariant that does not hold. A run from outside the runtime store says it is a source checkout or a development build with no signed release to compare its files with. While anything is not approved, the summary line ends with how many changes the person has not approved are present and how many parts of their changes are not as Changes keeps them, so it never reads as a plain pass; the run exits 1 while unapproved content runs or an invariant does not hold. `--json` carries the same report under `changes`.

`delorun doctor` prints `changes` lines: the protection setting, an open work session, the last failed reload in a work session from `run/<profile>/changes-work.json` as `warn`, and for each plugin under Changes whether it loaded at the last start, whether its active content is the approved one, the `engines.dsh` and `engines.delo` its active `package.json` declares, and what the built-in consent, guard and sandbox check finds in its active content. When the last start failed or a plugin did not load, a line names the plugin and its newest applied change with `delorun changes undo <id>`; a failure that names no plugin under Changes names the newest applied change of any plugin. A pending change, unapproved content and a plugin that did not load are `warn`; an invariant that does not hold is `fail`.

Neither command writes. A folder is read without the scan cache, so a pending change carries its id only when the store already holds the folder's content, and otherwise points to `delorun changes list`. A record that cannot be read is reported as an invariant that does not hold.

After each start the home process writes `run/<profile>/changes-boot.json` ([C1](c01-home-layout.md)), a protected file `{"schema":"delo.changes-boot/1","at":<ISO time>,"plugins":[{"plugin","rows":[{"id","state"}],"loaded","error"?}],"failure"?}`: for each plugin under Changes (approved, or waiting for review as an install), the Loader rows whose module is the package or a path inside it, and whether it has an enabled row and every enabled row became active; `failure` is set when the profile did not boot. A failure to write it is logged and the start goes on; no start reads it.

## Consumers

`delo/apps/cli` (`delorun start`, `delorun headless`, `delorun changes`); later `delorun verify`, `delorun doctor` and the studio's Changes section.

## Compatibility

A profile from before Changes is migrated at its first start without changing what it runs. Every record carries a schema tag; a reader refuses an unknown tag, field or value with `RECORD_UNREADABLE`, and a start then stops rather than guess.

## Security

### Requirements

1. Outside a work session, a plugin linked from a folder never loads from the folder under `block`: the profile's dependency, lockfile entry and link name its active directory, which holds the approved version.
2. A plugin with no approved content loads nothing under `block`.
3. A confined command cannot write `changes/`: it is under the protected home and not a read exemption ([C1](c01-home-layout.md#security)).
4. Only a terminal proof changes the protection setting; only a terminal or loopback-studio proof opens or closes a work session, apart from Delo stopping, which ends one through `@delo/changes/stop`, an entry no module but the CLI's start module imports.
5. The store's objects and versions are checked against their names on every read.
6. Every action that changes what the profile runs refuses a proof the attest functions did not issue before it reads or writes anything, `delorun changes` gets its proof only at a terminal, and no module of Delo or upstream other than `delorun changes` and `@delo/changes` imports an action or an attest function.
7. In a work session, a reload that fails leaves the content that last loaded, or the approved content, running, and the session open.
8. With `plugin_changes_pending` on, an agent's `plugin_manager` install, update or removal changes no profile file and never reaches the tool's approval; with `approved_plugin_write_consent` on, the agent's first write in a chat to an approved plugin's folders asks, however the path is spelt.

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
| `every state-changing changes action refuses without a terminal` | Requirement 6 (`delo/apps/cli/tests/changes-command.spec.ts`) |
| `the changes actions refuse a proof the attest functions did not issue` | Requirement 6 (`delo/packages/changes/tests/actions.integration.spec.ts`) |
| `protection cannot be lowered from the studio` | Requirement 4 (`actions.integration.spec.ts`) |
| `a remote session and the model cannot start or end a work session` | Requirement 4 (`work.integration.spec.ts`; `reach.spec.ts` covers `startWork`, `finishWork` and `finishWorkWithoutPerson`) |
| `a failed reload in a work session leaves the previous version running` | Requirement 7 (`delo/apps/cli/tests/changes-work.spec.ts`) |
| `a work session's edits load live` | [Work sessions](#work-sessions) (`changes-work.spec.ts`) |
| `done makes the folder's state the approved version as one history entry` | [Work sessions](#work-sessions) (`work.integration.spec.ts`) |
| `Delo stopping ends the work session` | [Work sessions](#work-sessions) (`work.integration.spec.ts`, `changes-work.spec.ts`) |
| `a start after a crash finishes the open work session first` | [Work sessions](#work-sessions) (`changes-work.spec.ts`) |
| `no model tool or route reaches a changes action` | Requirement 6 (`reach.spec.ts`) |
| `changes.reload carries no arguments` | [C19](c19-home-process.md)'s closed schema for `changes.reload` (`delo/packages/home-process/tests/changes-reload.integration.spec.ts`) |
| `verify never prints a plain pass with unapproved content` | [What verify and doctor report](#what-verify-and-doctor-report) (`delo/apps/cli/tests/verify/changes.spec.ts`) |
| `doctor names the plugin and the change that introduced a failed load` | [What verify and doctor report](#what-verify-and-doctor-report) (`delo/apps/cli/tests/doctor/changes.spec.ts`) |
| `no tool can apply a change, start or end a work session, or change the protection setting` | Requirement 6 for `@delo/plugin-changes` and `@delo/plugin-instruction-consent`, with `applyInstallChange` guarded (`reach.spec.ts`) |
| `needs the person at their computer` | Requirement 6 for `applyInstallChange` (`install-actions.integration.spec.ts`) |
| `the agent's first write to an approved plugin's folder asks` | Requirement 8; a second write in the same chat does not ask and another chat asks again (`delo/packages/plugin-instruction-consent/tests/plugin-folders.spec.ts`) |
| `a symlinked or \`..\` spelling of the folder asks too, and so does the plugin's active directory` | Requirement 8 (`plugin-folders.spec.ts`) |
| `a refused ask leaves the file unwritten, and the next write asks again` | [The agent and plugins](#the-agent-and-plugins) (`plugin-folders.spec.ts`) |
| `with the switch at parity the write runs as upstream runs it` | `approved_plugin_write_consent` off asks nothing (`plugin-folders.spec.ts`) |
| `the model's plugin_manager install creates a pending change and installs nothing` | Requirement 8: the manifest, lockfile and `node_modules` are unchanged (`delo/packages/plugin-changes/tests/plugin-changes.spec.ts`) |
| `the model's plugin_manager remove creates a pending change and removes nothing` | Requirement 8 (`plugin-changes.spec.ts`) |
| `the model's plugin_manager update creates a pending change and updates nothing` | Requirement 8 (`plugin-changes.spec.ts`) |
| `a listener that allows the call without the plugin's listener is overruled by its guard` | Requirement 8 (`plugin-changes.spec.ts`) |
| `with the switch at parity the plugin_manager action asks stock's approval` | `plugin_changes_pending` off keeps upstream's flow (`plugin-changes.spec.ts`) |
| `links a folder to its active directory, which holds nothing, and leaves the folder's content waiting for review` | Requirement 1 for an applied agent request (`delo/packages/changes/tests/install-actions.integration.spec.ts`) |

### What this does not prove

- Plugin code, once approved, can do anything Delo can; the risk summary does not limit it.
- A source checkout runs the whole harness from the checkout; its own code, Delo's bundles included, is not checked.
- Installed dependencies outside a plugin's folder are not part of its approved content.
