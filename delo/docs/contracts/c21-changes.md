---
description: "Contract C21: Changes. A person's harness is the signed release plus the changes they approved at their computer: the approved-content store under the home, the change kinds and states, how a start loads approved content for plugins linked from folders, the protection setting, work sessions with live reload, the start that leaves out a change it failed with, the risk summary, and who may change each from where."
---

# C21 Changes

## Summary

Nothing changes what a person's harness runs unless they approved it at their computer. A plugin the profile links from a folder loads from a copy of the content the person approved, kept under the Delo home; edits in the folder are pending changes until the person applies them. The library is [`@delo/changes`](../../packages/changes/README.md); `delorun start` and `delorun headless` apply it in their pre-start step `changes`, before upstream prepares the profile, and hold the prepared profile to its invariants in the composition's approved plugin content step.

## Contents

- [The home's changes directory](#the-homes-changes-directory)
- [Change kinds and states](#change-kinds-and-states)
- [Loading approved content](#loading-approved-content)
- [Reloads and restores](#reloads-and-restores)
- [Collecting the store](#collecting-the-store)
- [The first start under Changes](#the-first-start-under-changes)
- [The protection setting](#the-protection-setting)
- [Work sessions](#work-sessions)
- [When a start fails](#when-a-start-fails)
- [The risk summary](#the-risk-summary)
- [The agent and plugins](#the-agent-and-plugins)
- [Who may do what from where](#who-may-do-what-from-where)
- [Routes and the recovery screen](#routes-and-the-recovery-screen)
- [The studio's Changes section](#the-studios-changes-section)
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
| `store.lock` | The store's lock, holding its holder's process id: storing a folder and collection hold it ([Collecting the store](#collecting-the-store)) |
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
3. The active directory is made to hold: in a work session for the plugin, the folder's content; while a change a failed start left out stays out, the content from before it, or nothing ([When a start fails](#when-a-start-fails)); under `block`, the approved version, or nothing for a plugin with none, which upstream then skips; under `warn` and `off`, the folder's content. A file that differs is replaced in place, so hot reload replaces only changed modules.
4. The start checks that every link names its plugin's active directory, that `node_modules/<name>` resolves there when it exists, and that each active directory holds what `active.json` records, the approved version under `block` outside a work session and a change left out; otherwise it refuses with `LOAD_REFUSED` and the profile does not boot.

A plugin's content is every file under its folder except `.git` and names holding a backslash, with the targets of its links included by hash: a link that stays inside the folder, judged both as written and by where it resolves on disk, stays a relative link; a link to a sibling workspace package or to an installed package outside the folder, such as one in pnpm's `.pnpm` store, is copied under the link's path. An installed package included this way brings the dependencies its `package.json` lists (`dependencies`, `optionalDependencies`, `peerDependencies`) that are installed beside it, as pnpm installs them, under `<its path>/node_modules/<name>`, so the copy resolves them as Node resolves the original. A link that does not resolve is left out.

One content version holds at most 50,000 files, links and directories and 512 MiB (`CONTENT_ENTRY_LIMIT`, `CONTENT_BYTE_LIMIT`), its included packages counted. A folder that passes a limit, changes while it is read, or cannot be read never stops a start:

- Under `block` the plugin keeps its approved content, or loads nothing without one, and the start names the plugin and the reason (for a limit, `CONTENT_TOO_LARGE`): a plugin over the limits is refused until it is smaller.
- Under `warn` and `off` a folder over the limits only with its installed packages is stored with those packages kept as links to where they are installed, and every `warn` start says so, adding when one of them is below the person's home folder, where a confined command can write; a folder over the limits itself, or one that cannot be read, keeps its approved content as under `block`.
- A link a start moves whose folder cannot be read waits for review as a pending `plugin-install` whose `to` is the empty version, and the next start reads the folder again; the first start under Changes approves no such plugin.
- Approved content the store no longer holds, such as a version a restored history version names after collection removed it, loads nothing, and the start names the plugin.

## Reloads and restores

Every recomposition of the running profile is checked before anything stops: upstream's hot reload awaits the optional `profileReconcileCheck` service in `reconcileProfile`, and `@delo/plugin-changes` provides it whatever its switch says. That covers `changes.reload`, a work session's reload, the person's plugin changes in the studio (Plugin Manager's install, removal, `set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo` and `restore`), and the profile's own file watch after `delorun plugin` or any edit of `package.json`. The check, `prepareReload`:

1. moves every `link:` dependency that names a folder, as a restore or undo writes back `link:<folder>` and `delorun plugin add link:<folder>` writes, to the plugin's active directory as a start does, logging a pending `plugin-install` unless the folder is the approved one; it approves nothing and records no history version;
2. makes the active directory of a plugin it moved hold what a start would load, and never rewrites any other;
3. checks the links and active directories as step 4 of [Loading approved content](#loading-approved-content) does, and refuses the recomposition with `LOAD_REFUSED` when one is not what Changes keeps, such as an active directory written between starts. Everything keeps running.

The profile write lock decides whether it may write. When the Host's own process holds the lock, Plugin Manager is changing the profile and reloads inside its lock, so the check writes without taking it. When no process holds it, the check takes it, waiting at most two seconds (`RELOAD_LOCK_WAIT_MS`). When another process holds it, as `delorun changes` does while it waits for the reload's answer and a `pnpm` run does, the check writes nothing and only verifies, so a link to a folder refuses the recomposition until the holder is done.

`delorun plugin` runs the same check in its own process after upstream's operation, whether that succeeded or not, unless the profile's first start under Changes has not run: `delorun plugin add link:<folder>` leaves the plugin linked to its empty active directory and prints `<plugin> is not loaded until you review it: delorun changes show <id>`. The command exits 1 when upstream's operation failed or the check refused.

With `plugin_changes_pending` on, the model's `plugin_manager` calls that would change what runs other than installs and removals do not run ([The agent and plugins](#the-agent-and-plugins)).

## Collecting the store

At the end of each start, under the profile write lock and after the check, `collectStore` removes every version file and object that no profile under Changes references: each profile's approved record, its change-log entries in state `pending`, `applied` or `left-out-at-start` (`from` and `to`), its `active.json` and its work session (`from`, `lastLoaded`, `lastFailed`). A version file written within the last hour (`COLLECT_GRACE_MS`) is kept, so a change computed for review but not yet decided keeps its content. Collection takes the store's lock without waiting and does nothing while another process stores a folder, removes nothing when any of those records cannot be read, stops after two seconds (`COLLECT_TIME_LIMIT_MS`) and leaves the rest for the next start; a failure to remove a file leaves it and the start goes on. Versions referenced only by `discarded` or `undone` entries, or by an older profile history version, are removed, so restoring such a history version loads nothing for that plugin until the person applies a change again.

## The first start under Changes

The first start under Changes of a profile whose log has no `migratedAt` approves every linked plugin as it is, when the profile is one the home held at the first start under Changes of any profile: that start writes `changes/migration.json`, `{"schema":"delo.changes-migration/1","at","profiles":[…]}`, naming every profile in `profiles/` then, by an exclusive create. Each plugin is stored, recorded with `approvedAtUpgrade` and logged as an applied `plugin-install` decided at `upgrade`; one profile history version records the move. A profile created after that record is new: its linked plugins are pending `plugin-install` changes, like a plugin linked after the first start, and load nothing under `block` until applied.

Each start names the plugins approved at upgrade until a terminal showed them: the entry gains `shownAt` only when the start's output reached a terminal (`delorun start` runs the home process with its output in the log only) or `delorun changes list` printed them at one. Until then `delorun status` and `delorun changes list` name them too.

## The protection setting

`block` is the default. Under `warn` unapproved plugin content runs and every start names it; under `off` it runs without notice. A changed harness file is refused by the runtime store's start check in every setting; a home process started from the store checks its runtime at a fresh start as the launcher does.

## Work sessions

A work session loads one approved plugin's folder live while the person works on it, for at most 480 minutes. Its record is `{"schema":"delo.changes-work-session/1","plugin","source","from","startedAt","startedFrom":"terminal"|"studio","endsAt","lastLoaded"?,"lastFailed"?}`: `from` is the approved content when it started, `endsAt` when it ends without the person, `lastLoaded` the folder content that last loaded, and `lastFailed` folder content whose reload failed after that. One session at a time per profile; opening is an exclusive create.

- **What loads.** The plugin still loads from its active directory. Each load stores the folder's content, makes the active directory hold it with `active.json` kind `work-session`, replacing only the files that differ, and asks the running Host to reload as `changes.reload` does. A success records `lastLoaded` and removes `run/<profile>/changes-work.json`.
- **Live reload.** The home process watches `work-session.json` and, while a session is open, the plugin's folder recursively without `.git`, and loads each change once events have been quiet for 300 milliseconds. Delo watches the folder itself instead of setting upstream's `hmr.root`, because the Host loads the plugin from its active directory, so a source watch of the folder would watch files that are not loaded. Folder content that is already active, or equals `lastFailed`, is not loaded again, and nothing loads once `endsAt` has passed.
- **Opening.** `startWork` takes the session's length, whole minutes from 1 to `WORK_SESSION_MAX_MINUTES` (480), and refuses any other with `NOT_ALLOWED` before it reads anything; it needs a plugin the profile loads from its active directory with approved content and whose folder exists (`NOT_LINKED` otherwise), opens the record with `endsAt` that many minutes after `startedAt` (`WORK_SESSION_OPEN` when one is open) and loads the folder's content at once. When Delo is not running for the profile, it closes the session again, puts the active directory and `active.json` back, and refuses with `NOT_ALLOWED`.
- **The length.** `delorun changes work <plugin> --for <minutes>` sets it, 120 minutes when `--for` is absent; a value that is not whole minutes from 1 to 480 is a usage error. The length is an option of the command rather than a configuration field, because the CLI's home process runs the session and no validated configuration of the CLI's own settings exists for a profile.
- **A failed reload goes back.** The active directory holds `lastLoaded` again, or `from` when nothing loaded yet, the Host reloads once more, the record notes `lastFailed`, and `run/<profile>/changes-work.json` is written: `{"schema":"delo.changes-work/1","plugin","at","error"}`, a protected file that `delorun doctor` and the studio read and nothing decides from. The session stays open.
- **Ending at the person's word.** `reviewWork` stores the folder's content and returns it with its difference from `from`; `delorun changes done` prints its first 7 digits, its files, the risk summary and the bounded diff, every line through the terminal escaper, asks, and asks a second time naming the kinds when a check found something. `finishWork` then approves exactly the content it was given: when the folder holds anything else, the folder gone included, it refuses with `CHANGED_SINCE_REVIEW`, approves nothing and leaves the session open. When the active directory does not hold that content yet and Delo runs, it loads first, and a load that goes back approves nothing and leaves the session open. A folder that is gone keeps `from`. When the approved content changed, one profile history version `Work on <plugin>: <first 7 digits of from> → <first 7 digits of the new version>` records it, and the log gains one applied `plugin-edit` change from `from` to the new version with that summary, created at `startedAt`. `active.json` records the content as `approved`, and the record and `changes-work.json` are removed.
- **Ending without the person.** The Host's `close` stops the watcher and ends the open session; a start of the home process that finds a session open, which a home process that did not stop left, ends it first and says so, and `delorun headless` leaves it alone; the watcher ends a session at `endsAt` and logs that it ended at its time limit. Each goes through `finishWorkWithoutPerson`, the separate entry `@delo/changes/stop`, and approves nothing: the approved content stays `from`, the active directory holds it again with `active.json` kind `approved` (at `endsAt` the running Host reloads), the record and `changes-work.json` are removed, nothing is logged and no history version is recorded, and the folder's content is the ordinary pending `plugin-edit` against `from`. The folder is not read, so an unreadable folder never keeps a session open.
- **Where it shows.** `delorun status` prints `work session: <plugin> since <startedAt>, ends at <endsAt>`, `delorun changes list` prints `Working on <plugin> since <startedAt>, until <endsAt> at the latest: edits in its folder load live.`, and `workSessionFact` gives the same for the studio.

## When a start fails

A start that fails right after a change starts again without that change, and the profile's files are not rewritten for it ([`left-out.ts`](../../packages/changes/src/left-out.ts), [`retry.ts`](../../apps/cli/src/changes/retry.ts)).

| Step | What happens |
| --- | --- |
| Which starts | A fresh start of the home process: never an update's or a rollback's successor, never the second start itself, and not `delorun headless` |
| What counts as failing | Upstream's profile runner throws; the booted Host is refused (a row of a Delo bundle did not activate, or an invariant of the composition does not hold); or an enabled row of the plugin of the change it may leave out did not activate |
| Which change | The newest decision that changed what runs (`applied`, `undone` or `left-out-at-start`, by `decidedAt`, then by its place in the log), when it applied a `plugin-edit`, `plugin-install`, `plugin-update` or `plugin-on` the person made, not an approval at upgrade, to a plugin linked to its active directory whose active directory holds approved content, for a change of content the change's `to`, which is also the approved version. Otherwise the start fails as before, so a run of failures leaves out one change at most |
| Leaving it out | `leaveOutNewestChange` writes only the change log, under the profile write lock: the entry becomes `left-out-at-start` with `decidedAt`, `decidedFrom: "start"` and `leftOut {at, failure}`, the error's message without a stack, at most 2 KiB of UTF-8. It needs no proof of presence; only `apps/cli/src/changes/retry.ts` names it outside the package |
| The second start | A new `delorun start --foreground` process with `DELO_CHANGES_RETRY=1`: in the terminal, the first process prints the words and runs it with the same terminal, passing on `SIGTERM` and `SIGHUP`, and exits with its code; `delorun start` in the background marks its child `DELO_CHANGES_STARTER=detached`, which exits with code 4 instead, and starts it once more. Both markers are removed from the home process's environment. The second start never leaves a change out |
| What every later start loads | Its pre-start step `changes` makes the plugin's active directory hold the change's `from` with `active.json` kind `left-out`, or nothing (no `version`) for an install or a plugin turned on, in every protection setting, until the person applies the change again or undoes it, or the approved version is no longer the change's `to`. A work session on the plugin loads its folder as before |
| What the person reads | "Delo did not start with your latest change to `<plugin>` (`<id>`): `<failure>`." / "It starts without it now; your files are unchanged." / "To try it again: delorun changes apply `<id>`. To undo it: delorun changes undo `<id>`.", the failure on one line and cut at 200 characters, at the failed start and at every later start; a second failure prints "Delo did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start." |
| Applying it again | `apply <id>` makes the active directory hold the approved content again, which is the change's `to`, and the entry `applied`; a failed reload keeps it left out with `lastFailure` |
| Undoing it | `undo <id>` undoes it as an applied change: the approved version goes back to `from`, or none for an install; a `plugin-on` turns the plugin off |

Under `block` the invariants accept `left-out` content holding a version only when a change left out of the plugin that stays out holds that version; `left-out` content holding nothing loads nothing and is always accepted. `delorun changes list` names each change that stays out in its own group, `delorun doctor` names the plugin, the change and the failure with both commands, and `leftOutFacts` gives the same for the studio.

## The risk summary

Seven built-in checks read the new and changed lines of a change and its `package.json` on both sides: registers or replaces a consent, guard or the sandbox policy; adds a tool the model can call; runs commands; opens network connections; reads under the Delo home; adds or changes a dependency or a build or install script; has content the diff does not show (`not-shown`). `not-shown` names each added or changed file whose lines the diff leaves out: a binary file whose name ends in an extension Node loads (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.json`, `.node`, `.wasm`), a text file above 1 MiB, a text file past where the diff reached 256 KiB, and, once per package, the files below a `node_modules` directory inside the folder. Any finding asks a second confirmation before applying, and the second question lists each `not-shown` file. The summary is heuristics, a help to the reader and not a protection: plugin code has the harness's full authority. `reviewChange(input, checks)` is the one function a later extension point extends with registered checks.

## The agent and plugins

Two behaviours in Delo's composition decide what the agent may do to the plugins the harness runs. Each sits behind its own [C16](c16-parity-composition.md) switch, on in the composition a person runs and off in the parity composition, where the agent's writes and `plugin_manager` calls run as upstream runs them.

- **Writes to an approved plugin's folder ask once per chat** (switch `approved_plugin_write_consent`, `@delo/plugin-instruction-consent`'s `approvedPluginWrites`). Before the agent's first write in a chat to the `source` folder of a plugin the profile approved, the person is asked: "The agent is changing what your harness runs: <plugin>. The change will wait for your review in Changes.", with the diff the tool carries. The folders are read from the profile the Host runs at every write. A write is compared on the path the file backend writes, the target's `targetKey`, which upstream's local backends set to the real path (the file's own, or for a file that does not exist yet its deepest existing ancestor's with the rest appended); the folder's real path is computed the same way. The target counts as inside the folder when that path or its lexical path lies at or below the folder, ignoring case when a probe of the folder's own path in another case finds the same directory on its volume, or when an existing ancestor of the target is the folder's directory (the same device and inode), so a symbolic link, a `..` after a link and a case variant into the folder ask too. A write through a dangling link asks nothing: the backend keys it by the link's own path and refuses it as no regular file. After the person allows it, later writes to that plugin's folder in the same chat pass until the Host restarts; another chat asks again. A refused, cancelled or unanswerable ask leaves the file unchanged, and the model reads the typed refusal `FS_CONSENT_DENIED`, such as `the user refused the write to "<path>", which changes the plugin <plugin>; it stays unchanged, so stop and explain instead of working around it`. A profile record that cannot be read refuses the write. A file tool's write into the profile's active directories (`changes/profiles/<profile>/active/`) is refused without asking, approved plugin or not, because only Changes writes there and such a write would never become the person's plugin; the model reads `FS_CONSENT_DENIED` with `the write to "<path>" was not run: it is inside the directory Changes loads the harness's plugins from, which only Changes writes, …; change the plugin's own folder instead`. The writes the person allows are pending changes like anyone's and load only when the person applies them, or live during a work session.
- **Shell writes are not asked.** Only the file tools' writes are reviewed. A shell command or a PTC script the sandbox lets write a plugin's folder changes it without asking; that change is still a pending change: under `block` it does not load until the person applies it, under `warn` and `off` it loads at the next start as any folder content does, and during a work session for that plugin it loads live, because the person opened the work session.
- **The agent's plugin installs, updates and removals wait for the person** (switch `plugin_changes_pending`, `@delo/plugin-changes`). A `plugin_manager` call whose action is `install_bundle` or `remove_bundle` does not run and never reaches the tool's full-access approval: it is recorded in the change log as a pending `plugin-install`, `plugin-update` (an install of a registry version of a plugin the profile has; the tool has no update action) or `plugin-remove` with `subject.spec` and, when the spec names it, `subject.plugin`, and the model reads `Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.` (for an update `Nothing was installed or updated.`, for a removal `Nothing was removed.`), with the error code `PLUGIN_CHANGE_PENDING`. A call that names no target, a spec pnpm would not accept, a removal of a name that is no dependency, or a log that cannot be written is denied with `PLUGIN_CHANGE_UNRECORDED` and records nothing. Repeating a request that still waits returns its id; a repeat of a decided one is a new change. A call whose action is `set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo` or `restore` does not run either and records nothing: the model reads that the person makes that change at their computer, in the studio or with `delorun plugin`, with the error code `PLUGIN_CHANGE_AT_COMPUTER`. A tool guard denies any such call the plugin's listener did not handle, so a `tools/pre-execute` listener that allows the call without calling `next()` cannot run it.

Applying such a change at a terminal runs upstream's profile plugin operation `runProfilePnpm` under the profile write lock, as the plugin manager's `installBundle` runs it, with the checks `installBundle` runs: `add <spec>` for an install or update, `remove <name>` for a removal, which also removes the plugin's approval. A spec that names a folder is never linked to the folder: the plugin is linked to its active directory, which holds nothing, and the folder's content is recorded as a pending `plugin-install` from that folder, applied like any other, so nothing the agent asked for loads before the person reviewed its content.

| `installBundle` step | Applying the agent's request at a terminal |
| --- | --- |
| pnpm runs with no terminal and a scrubbed environment (`execution: 'service'`), with no option that allows a build script | The same: `execution: 'service'` and no build option, so the profile's `pnpm-workspace.yaml` `allowBuilds` entries alone decide which scripts run and pnpm cannot ask |
| Builds are approved only when the person passes the pending names (`approvedBuilds`) | Nothing approves a build; the person decides by editing `allowBuilds` |
| A failed run records the build scripts pnpm reports blocked as `set this to true or false` (`recordPendingBuilds`) and returns them | The same function records them, and the change's `lastFailure` names each with where to decide it |
| A failed run puts `package.json` and `pnpm-lock.yaml` back; downloaded files stay | The same files go back after any failed or refused operation |
| `runProfilePnpm` refuses a version incompatible with this Delo or DSH before or after pnpm runs | The same function, and the failure names the version; for a folder spec, whose link holds nothing yet, the folder's `package.json` is checked with upstream's `evaluatePluginCompatibility` and the profile's exemptions before pnpm runs |
| An install that changes more than one dependency (`ambiguous-install`), or a package without `dsh.bundle.patch` (`not-bundle`), is refused | The same refusals, after which the files go back; a folder spec's package must declare `dsh.bundle.patch` |
| The optional `pluginAudit` service audits the bundle when the profile mounts one | Not run: the service lives in the Host, and no Delo composition mounts one ([C13](c13-catalogue-revocation.md)) |
| Registries asked in the plan order (`registryPlan`), a GitHub connection check and a Git transport choice | pnpm's own configured registry and transport only; these steps decide where a package is fetched from, not whether it runs |

A failed or refused operation leaves the change pending with `lastFailure`; a successful one records one history version `Applied <id>: …` and reloads a running Host, whose failure leaves the change applied for the next start.

The model reads only the tool results above, each logged as the tool call's result like any other, so neither behaviour adds a session event; the asks are logged as upstream's `approval/asked` and `approval/decided`.

## Who may do what from where

| Action | Allowed from |
| --- | --- |
| Change the protection setting | `delorun changes protection` at a terminal only; no studio route changes it |
| Apply, discard or undo a change; turn one plugin off or on | `delorun changes` at a terminal, or the studio at the computer ([Routes and the recovery screen](#routes-and-the-recovery-screen)) |
| Open or close a work session | `delorun changes work` and `done` at a terminal, or the studio's `work` and `done` routes at the computer; Delo stopping, a start after a crash and the session's end time close one without a person, approving nothing |
| Start safe mode | `delorun recover safe-mode`, or the recovery screen at the computer |
| Read changes | The person's own commands, and any session the studio admits, a remote one included |
| Leave a change out | A fresh start whose boot failed ([When a start fails](#when-a-start-fails)), with no proof of presence; it writes only the change log |

A proof of presence is issued only by `attestTerminal` (standard input and output are terminals) and `attestStudio` (a studio request at the computer, which only the studio's Changes routes call), and a writer refuses any value they did not issue. The protection setting's writer also refuses a studio proof.

The terminal check does not tell a person from a model: a model's terminal tool gives its commands a real pseudo-terminal. Two rules together keep a model in a confined workspace from lowering protection or approving a change: the terminal check, and the sandbox's home-write rule, under which a confined command can write nothing under the Delo home, `changes/` included, and a workspace that contains the home is refused ([C1](c01-home-layout.md#security)). A workspace with full access runs commands with the person's own authority: a model working there can lower the protection setting and approve changes, as the person can. Fundamental [F16](../security/fundamentals.md) therefore stays designed: as worded it also covers full-access workspaces, which nothing here prevents.

## Routes and the recovery screen

`@delo/plugin-changes` registers the studio's Changes routes with the web server once the web server and Connection are present, whatever its switch says, and names their prefix to the boot page through the index global `dshRecoveryRoutes`.

| Route | Who | What it does |
| --- | --- | --- |
| `GET /delo/changes/state` | Any session the studio admits, a remote one included | What failed at the last start (`changes-boot.json`), the changes left out at a start with the failure each start recorded (`leftOut`), the changes and the agent's requests waiting for review, the 20 newest decided changes with whether each can be undone, the protection setting, safe mode, the work session, a sentence per record that cannot be read, and `atComputer` |
| `GET /delo/changes/show?id=<id>`, `?work=<plugin>` | The same | One change: its plugin, folder, files, risk summary and bounded diff, or its log entry; or the open work session's folder version against the content it started from |
| `POST /delo/changes/apply`, `discard`, `undo` | The studio at the computer | `{ "id", "confirmedRisk"? }`: as `delorun changes`; `apply` answers `409 CONFIRM_RISK` with the kinds and each file the diff does not show until `confirmedRisk` is `true`, and refuses an agent's plugin request with `409 APPLY_AT_TERMINAL` and `delorun changes apply <id>` |
| `POST /delo/changes/off`, `on` | The same | `{ "plugin" }`: turns the plugin off or on |
| `POST /delo/changes/work`, `done` | The same | `work` takes `{ "plugin", "minutes"? }`, 120 minutes by default; `done` takes `{ "plugin", "version", "confirmedRisk"? }`, the version `show?work=` showed, refuses another with `409 CHANGED_SINCE_REVIEW` and asks the second confirmation as `apply` does |
| `POST /delo/changes/safe-mode` | The same | `{}`: profile safety's safe mode with the `installationBundles` of the plugin's row, Delo's profile bundle list; without one, `503 SAFE_MODE_UNAVAILABLE` names `delorun recover safe-mode` |

No route changes the protection setting. Every request is first admitted by Connection, the Host/Origin fence and then the studio's signed cookie or the `authenticator` provider: a request without the credential is answered `401 NOT_SIGNED_IN` or `403 FORBIDDEN` and nothing else runs. A `POST` then needs the person at the computer, decided before the body is read: the request arrived on the loopback listener (no reach stamp) under a `Host` that names a loopback authority, carried the credential, and no reach dispatcher admitted it. No session factor exists yet; because no reach listener accepts a loopback `Host`, such a request did not come through a remote session, and a later change to reach replaces this with the session factor. Any other request is answered `403 LOOPBACK_REQUIRED` with "This needs you at your computer.". A browser request another site sent, by `Sec-Fetch-Site` or by an `Origin` that is not the request's own loopback origin, is answered `403 CROSS_SITE`, also before the body is read. The body is then one JSON object of at most 16 KiB with only the fields above, and the route attests the request with `attestStudio`. An action that changes what the Host runs reloads it in the Host's own process with `reloadProfile` and the Host's hot reload. Answers are JSON with `cache-control: no-store`, with person-facing fields only: no path under the home and no content version except the one `done` approves; file names, diffs and failures are JSON strings. A refusal of Changes keeps its code, with 404 for `UNKNOWN_CHANGE`, 403 for `NOT_AT_COMPUTER`, 500 for an unreadable record and 409 otherwise.

The recovery screen is part of upstream's boot page and needs no client plugin. On a page whose index names `dshRecoveryRoutes`, it shows below the failure report when a client entry fails to load or activate or the boot throws before the studio mounts, when the studio has not mounted 30 seconds after the boot began, and at `/recovery`, which upstream's frontend-static server renders as the index behind the same fence and where the boot page loads no client plugin. It reads `state` and shows what failed, the plugins of the last start with Turn off, the recent changes with Undo where one can be undone, and Start in safe mode; each action asks the browser's confirmation and posts to its route. A remote session reads the screen and is told "This needs you at your computer." when `atComputer` is false and when an action is answered `403 LOOPBACK_REQUIRED`. Its words are English or Chinese by the browser's language, it builds its elements with DOM text only, so it runs under the reach listener's Content Security Policy and Trusted Types, and it is a labelled region with a heading that takes focus, an alert for refusals and a polite status for results.

## The studio's Changes section

The browser half of `@delo/plugin-changes` (`@delo/plugin-changes/client`) registers the `settings.section` `delo-changes`, a `shell.overlay` toast and the `sidebar.footer.action` `delo-changes.work-badge`; the `delo-plugin-changes` row loads it, so the parity composition, which disables that row, shows none of them. It reads and acts only through the routes above, with the paths and fields of [`src/wire.ts`](../../packages/plugin-changes/src/wire.ts), and reads `state` when it loads, after each action and every 15 seconds while the page is visible.

- **What it shows.** The work session, the changes left out at a start with the failure the start recorded, the changes waiting for review with their folder, file count and risk kinds, the agent's plugin requests with `delorun changes apply <id>`, the recent changes with Undo where one can be undone, each record that cannot be read, safe mode, a failed last start, and the protection setting with `delorun changes protection block|warn|off` and no control.
- **Review and Apply.** Review reads `show?id=` and shows the folder, the files with their status, the risk kinds with the places each check found, the fixed sentence "This summary is a help to read the change, not a protection: a plugin's code can do anything Delo can.", each file the diff does not show, the paths the scan could not include, and the bounded diff with the files it left out, all as text. Apply posts `{ id }`; when the route answers `409 CONFIRM_RISK`, a second dialog names each kind and each file the diff does not show from that answer and repeats the sentence, and only its Apply anyway posts `confirmedRisk: true`. Discard posts from the review.
- **Undo, Apply again, Start working.** Each asks a confirmation first. Apply again posts `apply` for a change left out at a start, and Undo posts `undo`; Start working posts `work` with the route's default length for a plugin of the last start.
- **Done.** Done reads `show?work=<plugin>`, shows the folder's version by its first 7 digits with its difference from the content the session started from, and posts `done` with exactly that version; a flagged version asks the second confirmation as Apply does. A folder that is gone offers no approval.
- **Not at the computer.** When `state` says `atComputer: false`, or an action is answered `403 LOOPBACK_REQUIRED`, the section shows "This needs you at your computer." and disables every action; Review still reads.
- **The badge.** While `state` names a work session whose `endsAt` has not passed, the badge names the plugin at the sidebar's foot, a dot with the same words as its tooltip in the narrow rail; it is gone once `state` names none.
- **Outcomes.** Each action's outcome is a toast that outlives the Settings dialog: applied, discarded, undone, Delo not running, a reload that went back with its failure, a folder changed since review, a refusal with its sentence, and no answer. Every copy is in English and Chinese dictionaries.

## Commands

`delorun changes` is the terminal's way to the actions of `@delo/changes` (`listChanges`, `showChange`, `applyChange`, `discardChange`, `undoChange`, `turnOff`, `turnOn`, `changeProtection`, `startWork`, `finishWork`).

| Subcommand | What it does |
| --- | --- |
| `list` (the default) `[--json]` | The changes waiting for review, computed from each folder now, and the agent's plugin requests waiting for review (`requests`, marked `asked in a chat`), then the changes a failed start left out that stay out (`leftOut`), then every other logged change newest first, each plugin whose folder is gone, the protection setting and any work session |
| `show <id> [--diff] [--json]` | One change: the plugin, its folder, its files with dependency files grouped, the risk summary's lines and, with `--diff`, the bounded diff, saying when it was cut short |
| `apply <id>` | The plugin's approved content becomes the version the id names; `CHANGED_SINCE_REVIEW` when its folder holds anything else. For an agent's plugin request, upstream's plugin operation runs for its spec ([The agent and plugins](#the-agent-and-plugins)); `OPERATION_FAILED` when it fails. A change left out at start loads again ([When a start fails](#when-a-start-fails)) |
| `discard <id>` | The change becomes `discarded`: it never loads and is not listed while the folder holds that content; the folder is never written |
| `undo <id>` | An applied plugin change, or one left out at start: the approved content goes back to the change's `from`, or the plugin has none after undoing its install, and its active directory holds that until the next start, which under `warn` and `off` loads the folder's content again; a `plugin-off` turns the plugin on and a `plugin-on` turns it off; `NOT_ALLOWED` when a later change of the plugin was applied, and for the other kinds |
| `off <plugin>`, `on <plugin>` | The package name leaves, or is appended to, `dsh.profile.bundles` in the profile's `package.json`, as upstream's plugin manager writes it; `NOT_ALLOWED` for `@delo/bundle-local` and for a plugin the profile does not have in that state |
| `protection [block\|warn\|off]` | Prints the setting, or changes it; a weaker level is logged as an applied `guard-weakening` change with `subject.setting` `protection` |
| `work <plugin> [--for <minutes>]` | Opens a work session lasting `--for` minutes (120 by default, at most 480) and prints `Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>, at the latest until <endsAt>.`; when the folder's content fails to load at once it also reports the failure and exits 1 with the session open |
| `done <plugin>` | Prints the folder's version, its files, the risk summary and the bounded diff against the approved content, asks (twice when a check found something), and approves exactly that version; `CHANGED_SINCE_REVIEW` when the folder changed meanwhile, and exits 1 with the session open when the version fails to load |

- **Presence and confirmation.** Every subcommand that changes something first needs standard input and output to be terminals and otherwise refuses with "This needs you at your computer: run it in a terminal." before it reads or writes anything. It then asks a yes-or-no question; anything but `y` or `yes` changes nothing. `apply` first prints the change's summary and risk lines and the bounded diff, a page at a time at a terminal (Enter for the next page, `a` for the rest), and when the checks flagged the change asks a second question naming the kinds and each file whose content the diff does not show. A weaker protection level first says "Changed plugins will run without your review." and what the level means.
- **One history version.** Each action runs under upstream's profile write lock and records one profile history version (`kind: person`) whose subject names the change id: `Applied <id>: …`, `Undid <id>: …`, `Turned off <plugin> (<id>)`. Discarding and the protection setting change no profile file and record none.
- **Reloading a running Home.** When the profile's home process answers, the action runs under the profile write lock and then sends [C19](c19-home-process.md)'s `changes.reload`, which carries nothing: the Host recomposes the profile through upstream's hot reload. The reload fails when hot reload is off, a plugin fails to load or start, or the change needs a restart. When no home process answers, the command holds the profile's home lock for the action, so no start runs meanwhile, and the next start loads the change.
- **A failed reload goes back.** The approved record, the plugin's active directory and `active.json`, or the bundle list, return to what they held before the action; a second history version `Went back: <id> failed to load` records it; the entry returns to `pending`, or for an undo stays `applied`, with `lastFailure` `{at, failure}`; the Host is reloaded once more; and the command reports the failure and exits 1. A plugin turned off or on that failed to load is listed with its failure and applied again by its id.
- **A plugin in a work session.** `apply` and `undo` of a plugin with an open work session are refused with `NOT_ALLOWED`.
- **Text from files.** File names, folders, diff lines, summaries, specs and failure messages are printed with every control, line or paragraph separator and bidirectional character written as `\uXXXX`, and a line longer than 200 characters continues on the next, starting with `  ↪ `; `--json` writes the same characters as JSON escapes. `off` and `on` refuse a name that is not a package name as a usage error, and every path under `changes/` is built only from a package name.

## What verify and doctor report

`delorun verify` prints a Changes block after the release's check lines: the plugins the person approved, each with its folder and marked when the first start under Changes approved it, then everything present that they did not approve: each plugin whose folder differs from its approved content, each plugin whose active content is of kind `unapproved` (under `warn` or `off`), and each invariant that does not hold. It names the protection setting. A run from outside the runtime store says it is a source checkout or a development build with no signed release to compare its files with. While anything is not approved or protection is `warn` or `off`, the summary line ends with how many changes the person has not approved are present, how many parts of their changes are not as Changes keeps them, and that protection is lowered, so it never reads as a plain pass; the run exits 1 while unapproved content runs or an invariant does not hold. `--json` carries the same report under `changes`.

`delorun doctor` prints `changes` lines: the protection setting, an open work session, the last failed reload in a work session from `run/<profile>/changes-work.json` as `warn`, and for each plugin under Changes whether it loaded at the last start, whether its active content is the approved one, the `engines.dsh` and `engines.delo` its active `package.json` declares, and what the built-in consent, guard and sandbox check finds in its active content. When the last start failed or a plugin did not load, a line names the plugin and its newest applied change with `delorun changes undo <id>`; a failure that names no plugin under Changes names the newest applied change of any plugin. Each change a failed start left out that stays out is named with its plugin, the start's time, its failure and `delorun changes apply <id>` and `undo <id>`, and its plugin's line says it runs the content from before that change, or nothing. A pending change, a change left out, unapproved content, a plugin that did not load and protection at `warn` or `off` are `warn`; an invariant that does not hold is `fail`. Every line is escaped as `delorun changes` escapes its text, and a failure message a plugin or a record carries is cut at 200 characters, saying how many were left out.

`delorun status` names, before its home-process lines, each plugin approved at upgrade that no terminal has shown, each change waiting for review and lowered protection, because `delorun start` shows its start's lines only in the log.

Neither command writes. A folder is read without the scan cache, so a pending change carries its id only when the store already holds the folder's content, and otherwise points to `delorun changes list`. A record that cannot be read is reported as an invariant that does not hold.

After each start the home process writes `run/<profile>/changes-boot.json` ([C1](c01-home-layout.md)), a protected file `{"schema":"delo.changes-boot/1","at":<ISO time>,"plugins":[{"plugin","rows":[{"id","state"}],"loaded","error"?}],"failure"?}`: for each plugin under Changes (approved, or waiting for review as an install), the Loader rows whose module is the package or a path inside it, and whether it has an enabled row and every enabled row became active; `failure` is set when the profile did not boot. A failure to write it is logged and the start goes on; no start reads it.

## Consumers

`delo/apps/cli` (`delorun start`, `delorun headless`, `delorun changes`, `delorun verify`, `delorun doctor`); `@delo/plugin-changes`' routes and upstream's boot page, whose recovery screen reads and acts through them; later the studio's Changes section.

## Compatibility

A profile from before Changes is migrated at its first start without changing what it runs. Every record carries a schema tag; a reader refuses an unknown tag, field or value with `RECORD_UNREADABLE`, and a start then stops rather than guess.

## Security

### Requirements

1. Outside a work session, a plugin linked from a folder never loads from the folder under `block`: the profile's dependency, lockfile entry and link name its active directory, which holds the approved version.
2. A plugin with no approved content loads nothing under `block`.
3. A confined command cannot write `changes/`: it is under the protected home and not a read exemption ([C1](c01-home-layout.md#security)). So a confined command run in a pseudo-terminal, which passes the terminal check, still cannot lower protection or approve a change ([F16](../security/fundamentals.md)).
4. Only a terminal proof changes the protection setting. Only a terminal proof or a studio proof at the computer opens or closes a work session, apart from ending one without the person (Delo stopping, a start after a crash, its end time), which approves nothing and goes through `@delo/changes/stop`, an entry no module but the CLI's start module imports.
5. The store's objects and versions are checked against their names on every read.
6. Every action that changes what the profile runs refuses a proof the attest functions did not issue before it reads or writes anything, `delorun changes` gets its proof only at a terminal, and no module of Delo or upstream other than `delorun changes`, `@delo/changes` and the studio's Changes routes (`delo/packages/plugin-changes/src/routes.ts`) imports an action or an attest function; the routes import neither `attestTerminal` nor a writer of the protection setting.
7. In a work session, a reload that fails leaves the content that last loaded, or the approved content, running, and the session open. Ending a session without the person approves nothing: the approved content stays the version the session started from. `done` approves only the version it showed. A session ends at its `endsAt`, at most 480 minutes after it started.
8. With `plugin_changes_pending` on, an agent's `plugin_manager` install, update or removal changes no profile file and never reaches the tool's approval; with `approved_plugin_write_consent` on, the agent's first file-tool write in a chat to an approved plugin's folder asks, however the path is spelt, and one into the profile's active directories is refused. Applying the agent's request runs no build script that the profile's `allowBuilds` does not allow and installs no version incompatible with this Delo.
9. What `delorun changes`, `verify`, `doctor` and `status` print from a file, a log entry or a plugin's failure cannot move the cursor, start a line of its own or reorder the text around it. A change whose new content the diff does not show, a binary file Node loads, a file above or past the diff's limits or a dependency's file inside the folder, asks the second confirmation and names the file. A profile created after the first start under Changes approves none of its links at upgrade.
10. Before every recomposition of the running profile and at every start, each link names its plugin's active directory and each active directory holds what Changes keeps, or nothing loads: a link to a folder is moved first where the profile write lock allows it, and anything else that differs refuses the start or the reload ([Reloads and restores](#reloads-and-restores)). An approved plugin's installed dependencies load from the approved copy, by hash, never from where they are installed, apart from `warn` and `off` for a plugin over the content limits.
11. A folder that cannot be read as one content version leaves the approved content running and never stops a start; the store keeps only what a record references, apart from versions written within the grace period ([Collecting the store](#collecting-the-store)).
12. A start that fails right after a change leaves out only that change, by writing the change log alone, and loads only content approved before it, or nothing, until the person applies it again or undoes it; the second start leaves nothing out ([When a start fails](#when-a-start-fails)).
13. A Changes route answers only a request Connection admits with the studio's credential. An action acts only for a request at the computer, on the loopback listener under a loopback `Host` that no reach dispatcher admitted, and refuses any other, and a request another site sent, before it reads the body; no route changes the protection setting ([Routes and the recovery screen](#routes-and-the-recovery-screen)).

### Denial tests

| Test | Proves |
| --- | --- |
| `a plugin outside a work session never loads from its folder` | Requirement 1 (`delo/packages/changes/tests/enforce.integration.spec.ts`) |
| `a changed plugin does not load under Block` | Requirement 1 |
| `a new linked plugin without approved content loads nothing under Block` | Requirement 2 |
| `puts a tampered active directory back to the approved version` | Requirement 1 |
| `refuses an object that only looks like a terminal proof`, `refuses when standard input or output is not a terminal` | Requirement 4 (`records.spec.ts`) |
| `a confined command inside a pseudo-terminal cannot lower protection` | Requirement 3: under bwrap, and Landlock where usable, `delorun changes protection off` in a pseudo-terminal answering `y` fails and `changes/protection.json` stays absent, a direct write to `changes/` fails, a workspace containing the home is refused, and without the home rule the same command lowers it (`delo/packages/home-process/tests/changes-confinement.integration.spec.ts`) |
| `refuses an object whose bytes do not have its digest`, `refuses a version file whose content is not the version its name says` | Requirement 5 (`store.integration.spec.ts`) |
| `refuses a fresh start from the store whose runtime files differ, before the profile is touched` | The harness start check (`delo/apps/cli/tests/changes-start.spec.ts`) |
| `every state-changing changes action refuses without a terminal` | Requirement 6 (`delo/apps/cli/tests/changes-command.spec.ts`) |
| `the changes actions refuse a proof the attest functions did not issue` | Requirement 6 (`delo/packages/changes/tests/actions.integration.spec.ts`) |
| `a remote session and the model cannot start or end a work session` | Requirement 4 (`work.integration.spec.ts`; `reach.spec.ts` covers `startWork`, `finishWork` and `finishWorkWithoutPerson`) |
| `a failed reload in a work session leaves the previous version running` | Requirement 7 (`delo/apps/cli/tests/changes-work.spec.ts`) |
| `a work session's edits load live` | [Work sessions](#work-sessions) (`changes-work.spec.ts`) |
| `ending a work session without the person approves nothing new` | Requirement 7: Delo stopping, a start after a crash and the end time each keep the approved content at `from` and leave the folder's content pending (`work.integration.spec.ts`, `changes-work.spec.ts`) |
| `done approves exactly the version it showed` | Requirement 7: a folder changed after the display is refused with `CHANGED_SINCE_REVIEW` and nothing is approved (`work.integration.spec.ts`; `changes-command.spec.ts` changes the folder while the question waits) |
| `a work session ends at its bound` | Requirement 7: nothing loads after `endsAt`, the watcher ends the session then, and a length outside 1 to 480 minutes is refused (`work.integration.spec.ts`, `changes-work.spec.ts`) |
| `no model tool or route reaches a changes action` | Requirement 6 (`reach.spec.ts`) |
| `changes.reload carries no arguments` | [C19](c19-home-process.md)'s closed schema for `changes.reload` (`delo/packages/home-process/tests/changes-reload.integration.spec.ts`) |
| `verify never prints a plain pass with unapproved content` | [What verify and doctor report](#what-verify-and-doctor-report) (`delo/apps/cli/tests/verify/changes.spec.ts`) |
| `verify never prints a plain pass with protection lowered`, `doctor never passes lowered protection` | [What verify and doctor report](#what-verify-and-doctor-report) (`verify/changes.spec.ts`, `doctor/changes.spec.ts`) |
| `writes control and bidirectional characters in file names, diffs, summaries and failures as escapes, and wraps long lines` | Requirement 9 (`changes-command.spec.ts`; `verify/changes.spec.ts` and `doctor/changes.spec.ts` have their own escaping cases) |
| `a .js file with one invalid byte, a file above the limit and a dependency inside the folder each need the second confirmation` | Requirement 9 (`delo/packages/changes/tests/pending.integration.spec.ts`) |
| `a file Node loads that the diff does not show asks the second confirmation and is named`, `apply shows the diff a page at a time before it asks` | Requirement 9 and [Commands](#commands) (`changes-command.spec.ts`) |
| `a profile created after the first start does not approve its links at upgrade` | Requirement 9 (`records.spec.ts`; `changes-start.spec.ts` through a start) |
| `a start whose output reaches no terminal names the plugins approved at upgrade again at the next start`, `changes list names them until a terminal showed them` | [The first start under Changes](#the-first-start-under-changes) (`changes-start.spec.ts`, `changes-command.spec.ts`) |
| `refuses a name that is not a package name before any path is built from it`, `off and on refuse a name that is not a package name before any path is built` | Requirement 9 (`delo/packages/changes/tests/paths.spec.ts`, `changes-command.spec.ts`) |
| `doctor names the plugin and the change that introduced a failed load` | [What verify and doctor report](#what-verify-and-doctor-report) (`delo/apps/cli/tests/doctor/changes.spec.ts`) |
| `no tool can apply a change, start or end a work session, or change the protection setting` | Requirement 6 for `@delo/plugin-changes` and `@delo/plugin-instruction-consent`, with `applyInstallChange` guarded (`reach.spec.ts`) |
| `the studio routes are the only module that attests a studio request, and they do` | Requirement 6 for the routes (`reach.spec.ts`) |
| `an HTTP caller without the studio's credential cannot reach any Changes route` | Requirement 13: every route answers 401 or 403 before it reads the profile or the body (`delo/packages/plugin-changes/tests/routes.spec.ts`) |
| `a remote session cannot use the recovery actions` | Requirement 13: a reach stamp, a reach session and a `Host` that is not loopback each get `403 LOOPBACK_REQUIRED` before the body (`routes.spec.ts`) |
| `a cross-site request is refused before its body is read` | Requirement 13: `Sec-Fetch-Site` and a foreign or `null` `Origin` get `403 CROSS_SITE` with the body unsent (`routes.spec.ts`) |
| `the studio cannot change the protection setting` | Requirements 4 and 13: no route names it, and the setting's writer refuses a studio proof (`routes.spec.ts`; `records.spec.ts` has `refuses a studio proof for the protection setting`) |
| `apply asks the second confirmation when the change has a risk` | [Routes and the recovery screen](#routes-and-the-recovery-screen): `409 CONFIRM_RISK` names the kinds and the file the diff does not show, and nothing is approved until `confirmedRisk` (`delo/packages/plugin-changes/tests/routes.integration.spec.ts`) |
| `the recovery screen renders with every plugin's client code failing` | [Routes and the recovery screen](#routes-and-the-recovery-screen): every plugin bundle fails to load and the screen offers Turn off, Undo and safe mode (`packages/client/web/tests/boot.client.spec.ts`) |
| `the recovery screen shows This needs you at your computer for a remote session` | Requirement 13 on the screen (`packages/client/web/tests/boot-page.client.spec.ts`) |
| `the studio asks a second confirmation before applying a flagged change` | [The studio's Changes section](#the-studios-changes-section): the first Apply sends no `confirmedRisk`, the route's `409 CONFIRM_RISK` opens a dialog naming the kinds and the file the diff does not show, Cancel sends nothing more, and only Apply anyway sends `confirmedRisk: true` (`delo/packages/plugin-changes/tests/changes-section.client.spec.tsx`) |
| `a remote session sees the changes and cannot act on them` | Requirement 13 in the section: with `atComputer: false` every part shows, every action is disabled, a review still reads, and nothing is posted (`changes-section.client.spec.tsx`) |
| `a work session's badge is shown while it lasts` | [The studio's Changes section](#the-studios-changes-section): the badge names the plugin while `state` names the session and is gone once it does not (`changes-section.client.spec.tsx`) |
| `needs the person at their computer` | Requirement 6 for `applyInstallChange` (`install-actions.integration.spec.ts`) |
| `the agent's first write to an approved plugin's folder asks` | Requirement 8; a second write in the same chat does not ask and another chat asks again (`delo/packages/plugin-instruction-consent/tests/plugin-folders.spec.ts`) |
| `the agent's write through a symlink, a case variant or .. into an approved plugin's folder asks` | Requirement 8: compared on the real path the file backend writes (`plugin-folders.spec.ts`) |
| `the agent's write into a plugin's active directory is refused` | Requirement 8 (`plugin-folders.spec.ts`) |
| `a refused ask leaves the file unwritten, and the next write asks again` | [The agent and plugins](#the-agent-and-plugins) (`plugin-folders.spec.ts`) |
| `with the switch at parity the write runs as upstream runs it` | `approved_plugin_write_consent` off asks nothing (`plugin-folders.spec.ts`) |
| `the model's plugin_manager install creates a pending change and installs nothing` | Requirement 8: the manifest, lockfile and `node_modules` are unchanged (`delo/packages/plugin-changes/tests/plugin-changes.spec.ts`) |
| `the model's plugin_manager remove creates a pending change and removes nothing` | Requirement 8 (`plugin-changes.spec.ts`) |
| `the model's plugin_manager update creates a pending change and updates nothing` | Requirement 8 (`plugin-changes.spec.ts`) |
| `a listener that allows the call without the plugin's listener is overruled by its guard` | Requirement 8 (`plugin-changes.spec.ts`) |
| `with the switch at parity the plugin_manager action asks stock's approval` | `plugin_changes_pending` off keeps upstream's flow (`plugin-changes.spec.ts`) |
| `links a folder to its active directory, which holds nothing, and leaves the folder's content waiting for review` | Requirement 1 for an applied agent request (`delo/packages/changes/tests/install-actions.integration.spec.ts`) |
| `applying a held install keeps install scripts held back as stock does` | Requirement 8: with real pnpm, the script does not run, its name waits under `allowBuilds` and `package.json` and the lockfile go back (`delo/apps/cli/tests/changes-plugin-operation.integration.spec.ts`) |
| `applying a held install refuses a version incompatible with this Delo` | Requirement 8 (`changes-plugin-operation.integration.spec.ts`) |
| `a reload refuses an active directory that differs from its approved version` | Requirement 10: through upstream's hot reload with `@delo/plugin-changes` mounted, nothing replaced is evaluated (`delo/packages/plugin-changes/tests/reload-check.spec.ts`; `prepareReload` alone in `delo/packages/changes/tests/load-check.integration.spec.ts`) |
| `a restore that names a folder link loads nothing from the folder` | Requirement 10: upstream's own `pluginManager.restore` of a history version that links the folder, whose recomposition runs under the manager's lock, evaluates nothing from the folder (`reload-check.spec.ts`) |
| `delorun plugin add link:<folder> while Delo runs loads nothing from the folder` | Requirements 2 and 10: refused while the operation holds the lock, moved and loading nothing after it (`reload-check.spec.ts`); `delorun plugin add link:<folder> links the plugin to its empty active directory and leaves the folder waiting for review` covers the command (`delo/apps/cli/tests/plugin-command.spec.ts`) |
| `upstream evaluates nothing of a plugin with no approved content under Block` | Requirement 2: booted through upstream's profile preparation and loader, the plugin's module and bundle patch are not evaluated, and are after the change is applied (`reload-check.spec.ts`) |
| `the model's plugin_manager restore, undo and settings changes do not run and record nothing`, `a listener that allows a restore without the plugin's listener is overruled by its guard` | Requirement 10 for the model (`plugin-changes.spec.ts`) |
| `stops nothing and loads nothing when the distribution's profile check refuses` | Upstream's extension point (`packages/boot/hmr/tests/package-reload.spec.ts`) |
| `a start refuses a profile whose installed link names the folder` | Requirement 10 at start (`load-check.integration.spec.ts`) |
| `an approved plugin's outside dependency loads from the approved copy` | Requirement 10: a changed file in pnpm's store does not change what the copy imports (`load-check.integration.spec.ts`) |
| `judges a relative link by where it resolves on disk, not by its spelling` | Requirement 1: a link through a link that leaves the folder is not kept as an inside link (`delo/packages/changes/tests/tree.integration.spec.ts`) |
| `a scan failure under Block keeps the approved content running` | Requirement 11 (`load-check.integration.spec.ts`; `refuses a plugin over the content limits under Block with the reason, and keeps its approved content` for the limits) |
| `collection keeps every referenced version and removes the rest` | Requirement 11 (`delo/packages/changes/tests/collect.integration.spec.ts`) |
| `a start that fails on a new plugin starts without it and names it` | Requirement 12: the second start loads the content from before the change and both starts name it (`delo/apps/cli/tests/changes-left-out.integration.spec.ts`) |
| `the retry writes nothing to the profile` | Requirement 12: `package.json`, the lockfile, `cordis.patch.yml`, the `node_modules` links and the profile history are byte-identical after leaving a change out and two starts (`delo/packages/changes/tests/left-out.integration.spec.ts`) |
| `a second failure stops with the safe-mode command and does not retry again` | Requirement 12: one second start, the safe-mode line once, and the older change stays applied (`changes-left-out.integration.spec.ts`; `changes-retry.spec.ts` for the background starter) |
| `a left-out change stays out at the next start until applied or undone` | Requirement 12 (`left-out.integration.spec.ts`) |
| `applying a left-out change loads it again` | [When a start fails](#when-a-start-fails): a failed reload keeps it out (`left-out.integration.spec.ts`) |
| `refuses left-out content under block that no change left out of the plugin holds, and accepts holding nothing` | Requirement 12 for the invariants (`left-out.integration.spec.ts`) |
| `only the start's retry leaves a change out, and no route, tool or plugin names it` | Requirement 12 (`reach.spec.ts`) |
| `doctor names the plugin and the change a failed start left out, and what its plugin runs instead` | [What verify and doctor report](#what-verify-and-doctor-report) (`doctor/changes.spec.ts`) |

### What this does not prove

- At the computer in the studio: the routes decide it from where a request arrived, so a request through SSH port forwarding to the loopback listener counts as at the computer, as [C5](c05-device-approval.md) counts it for the owner claim, and so does a local program that holds the studio's cookie; no session factor exists yet.
- Full access: a workspace with full access runs commands with the person's own authority, so a model working there can lower the protection setting and approve changes. Changes protects against a confined model, not against the person's own access.
- Registry, `file:`, git and tarball plugins: only plugins linked from a folder are under Changes; the others load as upstream installs them.
- Dependencies a plugin does not link: an installed package is copied with the dependencies its `package.json` lists that are installed beside it. A module the plugin or a copied package imports without that, such as a package pnpm hoisted, is resolved by Node from the active directory's parent directories up to the filesystem root, which include the person's home folder; a package placed in a `node_modules` directory there, which a confined command may be able to write, would load. Under `warn` and `off` a plugin over the content limits loads its installed packages from where they are installed, and the start says when that is under the home folder.
- A running Host's modules changed through a source watch: Delo sets no `hmr.root`; a profile whose own configuration watches an active directory would replace modules without the check, though only Delo writes active directories.
- Client plugin code: the code a plugin serves to the studio's browser is not reviewed by Changes.
- Running from source: a source checkout runs the whole harness from the checkout, so a model working inside the repository can edit the code the Host runs.
- Plugin code, once approved, can do anything Delo can; the risk summary does not limit it.
- A source checkout is a developer mode, not an installed release: Delo's bundles included, Changes leaves those packages alone.
- Only the file tools' writes are asked about; a shell command's write to a plugin's folder is not asked ([The agent and plugins](#the-agent-and-plugins)). Applying the agent's request runs no `pluginAudit`, because no Delo composition mounts one; a profile whose own bundles provide one is not audited by the terminal apply.
