---
description: "Design of templates: a saved, content-addressed record of how someone uses the harness (pinned plugins, profile rows, presets, skills, harness edits and credential names). A person keeps several, one is active in a profile, and switching, importing, exporting, backing up and restoring each run as one transaction with a restart. Ends with the constraints current work must follow and the current code that conflicts."
---

# Templates

English

## Summary

A template is a record of how someone uses the harness: the plugins they run, pinned with integrity, the profile rows and settings they chose, their agent presets and skills, their edits to the harness as diffs against a stated release, and the names of the credentials those need. It never holds a secret, a chat or a trust decision. A person keeps several templates in their home, such as "work" and "experiments", and exactly one is active in a profile at a time. The active template is the person's configuration: changing a setting, installing a plugin or applying a harness edit changes the active template. Switching to another template stops the Host, saves the active template, loads the other one as one transaction and starts again; a failed start goes back. The same format serves sharing (import and export), backup and restore onto a fresh install or another machine. Delo shows exactly what a template brings, harness edits file by file with their diffs, and runs the same install check as for a plugin before anything runs. Templates are built after 0.1.0. This page fixes their format and rules now so that the code built before then does not block them; the [constraints for current work](#constraints-for-current-work) and the [current code that conflicts](#current-code-that-conflicts) are the parts that apply today.

## Contents

- [Terms](#terms)
- [What exists today](#what-exists-today)
- [The rules](#the-rules)
  - [The template file](#the-template-file)
  - [The active template is the person's configuration](#the-active-template-is-the-persons-configuration)
  - [What stays with the home and the machine](#what-stays-with-the-home-and-the-machine)
  - [The library](#the-library)
  - [Save and switch](#save-and-switch)
  - [Chats and presets across a switch](#chats-and-presets-across-a-switch)
  - [Templates, presets and profiles](#templates-presets-and-profiles)
  - [Import and export](#import-and-export)
  - [Backup and restore](#backup-and-restore)
  - [Updates](#updates)
  - [Changes, protection and the install check](#changes-protection-and-the-install-check)
  - [Secrets and credentials](#secrets-and-credentials)
  - [Commands and the studio](#commands-and-the-studio)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Constraints for current work](#constraints-for-current-work)
- [Current code that conflicts](#current-code-that-conflicts)
- [Open questions](#open-questions)
- [What is built so far](#what-is-built-so-far)

## Terms

- **Template**: one record in the format below, identified by the SHA-256 of its manifest. Its name and version are labels.
- **Active template**: the template a profile runs. Its content is the profile's own files.
- **Saved template**: a template kept in the home's library, active in no profile or in one.
- **Switch**: making another saved template the active one in a profile, as one transaction.
- **Machine choices**: the rows Delo writes from `delorun setup`'s answers and the Privacy section ([C11](../contracts/c11-setup-answers.md)), and the reach row. They belong to the profile on this machine, not to a template.

## What exists today

- A profile composes upstream's layers in a fixed order: the bundles of `dsh.profile.bundles`, the profile's `cordis.patch.yml`, the home's `cordis.patch.yml`, then the start's `--patch` overlays ([architecture](../../../docs/architecture.md#profiles-and-bundles)). A patch that targets a row by id replaces the row's whole `config`.
- Upstream's settings are rows in the profile patch, written by the config editor (`packages/boot/config-editor/src/index.ts:150-157`). Delo's setup answers are rows in the same file (`delo/apps/cli/src/setup/writes.ts:124-171`).
- Some upstream plugins have fields of role `secret`, whose values Settings writes into the profile patch in plain text (`packages/web/web-deepseek-api/src/index.ts:50`, `packages/web/web-search-deepseek/src/index.ts:69`); the base bundle composes both rows. The profile history keeps that file in git.
- Agent presets are rows of `@deepseek-ai/dsh-agent-preset`, so they belong to a profile. A chat records its preset by id (`packages/preset/agent-preset-registry/src/session.ts:31`); a resumed chat resolves the id again, and an id nothing defines fails with `agent-preset/not-found` (`index.ts:220-224`).
- Skills load from the workspace, from `customSkillDirs`, from the home's `skills/` and `~/.agents/skills`, and from bundled skills (`packages/skill/skill-filesystem/src/index.ts:52-90`). The home's `skills/` and `AGENTS.md` are shared by every profile.
- Credential values live in the home's `.credentials.yaml`; config names them through fields of role `credential-ref`.
- Chats, workspaces and attachments are home-wide and shared by every profile.
- The profile history is upstream's git-backed history over a fixed list of profile files, which Delo extends with its own records and a copy of the home patch (`delo/packages/profile-safety/src/files.ts:52-58`).
- `delorun export` writes chats and workspaces with an empty customisation document, and `delorun import` lists customisation rows and applies none ([C8](../contracts/c08-archive-and-trash.md#customisation-schema)). `delorun import-home` imports a stock DeepSeek Harness home and writes its allow-listed rows into the profile patch.
- On branches not merged into `v5`: Changes ([design](changes.md)) keeps approved plugins in the profile's `package.json`, but the approved harness files in one home-wide record per runtime; the plugin install check writes one install record per plugin.
- There is no template file, library or command.

## The rules

### The template file

1. **Container.** A template file is a zip read with the reader and limits of [C8](../contracts/c08-archive-and-trash.md#limits). Its top-level entries are `template.json`, the manifest; `signature.json`, present only when signed; `rows.patch.yml`; `plugins/`, packed plugins; `skills/`; and `harness/`, harness edits. No other top-level entry is valid.
2. **Manifest.** `template.json` has `schema` `delo.template/1`; `name`, 1 to 32 lowercase letters, digits and hyphens, starting with a letter; `version`, a semantic version; `title` and `description`, plain text without control characters; `author`, with `name` and an optional `url`; `requires`, with a `delo` range checked like a plugin's `engines.delo` ([C17](../contracts/c17-plugin-versions.md)); `origin`, the id, name and version of the template it was imported from, when it was; `plugins`; `credentials`; an optional `harness`; and `files`, listing every other entry with its `path`, `sha256` and `size`. A field the schema does not define is refused.
3. **Identity.** A template's id is the SHA-256 of the exact bytes of `template.json`. Because the manifest lists the digest of every other entry, a change to any byte gives a new id. Two templates with the same name and version but different ids are two templates, and Delo says so when the second arrives.
4. **Versions.** `schema` is the format's version: a reader refuses a schema it does not know, and a new schema is an adjacent successor, never an edit of `delo.template/1`. `version` is the author's for a published template; for the person's own templates, each save gives the next patch version.
5. **Signature.** `signature.json` follows [C8's signature](../contracts/c08-archive-and-trash.md#signature): Ed25519 over the exact bytes of `template.json`, with the same states. A home vouches for its own key and for keys the person confirmed by typing the fingerprint; an unsigned template is accepted only when the person types `unverified`. A signature says who published the template, not that it is safe.
6. **Plugins.** Each entry of `plugins` has `name`, an exact `version`, `integrity` (a Subresource Integrity SHA-512 value) and `from`: `registry`, installed from the registry the profile's plugin manager uses and checked against `integrity`; or `file`, a packed tarball under `plugins/`. A plugin the person links from a folder is packed from its approved content in Changes' store, never from the live folder. A range, a tag, a `link:`, `file:` or `git` reference and a package in the `@delo/` scope are refused. The release's own bundles and plugins are not listed; the template holds only what the person added.
7. **Rows.** `rows.patch.yml` is a Cordis patch list: the person's rows, which include their settings and their agent presets. It never holds the machine choices. A template's rows are refused when they hold a `!!js` expression, insert a plugin that is neither in the template's `plugins` nor in the running release, set a value of a field of role `secret`, target a row that [C19's Host invariants](../contracts/c19-home-process.md#host-invariants) protect (the `sandbox` row, every Delo row, the prompt rows and the guard rows), the `plugin-manager` row or the `hmr` row, or set a sandbox mode, a reach option or an egress limit. Code belongs in a plugin, which the install check sees.
8. **Skills.** `skills/<name>/` holds one skill each, in upstream's skill layout. These are the template's skills; the home's `skills/` stays outside every template ([rule 15](#what-stays-with-the-home-and-the-machine)).
9. **Harness edits.** `harness` names the release the edits were made against, by its Delo version and the SHA-256 of its signed release manifest ([C2](../contracts/c02-release-manifest.md)), and lists one entry per file: the path under `app/`, the SHA-256 of the signed file the edit starts from, and a unified diff under `harness/`.
10. **Credentials.** `credentials` lists each credential the rows name, by the name a `credential-ref` field holds, with a one-line purpose. It never holds a value.

### The active template is the person's configuration

11. **One active template per profile.** A profile runs the release's composition and exactly one template. Templates do not stack.
12. **The person's edits live in the active template.** There is no separate layer for the person's own changes. The active template's rows are the profile's `cordis.patch.yml` without the machine choices, its plugins are the profile's dependencies and bundles beyond the release's, its skills are `profiles/<profile>/skills/`, which the release's composition offers as a skill source, and its harness edits are the profile's approved harness files. Changing a setting, installing or removing a plugin, editing a preset or applying a harness edit changes the active template, and the next save or switch records it.
13. **Why one place.** A separate person's layer above the active template would make "what this profile runs" two things the person has to compose in their head, and a switch would not switch everything: a plugin or setting added while "experiments" was active would follow the person into "work". It would also need a composition mechanism of its own, while today's profile files are already the one place upstream's config editor, plugin manager and profile history write. Keeping the person's edits in the active template uses those as they are: a template is the content of the profile's own files, the switch replaces it, and the profile history versions it. A choice that should apply under every template belongs in the home patch, which applies over every profile and is in no template.
14. **Delo's record of the active template.** `profiles/<profile>/delo-template.json` names the active template's name, the id of the version it was last saved or loaded as, and its `origin`. The profile history tracks it.

### What stays with the home and the machine

15. **Home-wide files are in no template.** The home patch, the home's `skills/` and `AGENTS.md` apply to every profile and every template; a switch leaves them as they are, and a backup carries them.
16. **Machine choices stay across a switch.** The rows of the machine choices are listed by id in one exported list. Save, export and switch leave those rows out of the template and keep them in the profile across a switch, so the prompts answer, privacy, the update check, the studio's address and reach do not change when the person switches.
17. **Trust decisions stay with the home.** Permission and full-access grants, MCP and other consents, the protection setting, device approvals, version exemptions (`compatibility.json`, `delo-compatibility.json`) and build approvals (`allowBuilds` in `pnpm-workspace.yaml`) are in no template. Loading a template whose plugins need a build or an exemption asks for that decision in the preview.
18. **Never in a template.** Chats, workspaces, attachments, credential values and the files of `secrets/`, `trust/` and `run/`.

### The library

19. **Where it is.** `templates/` at the top of the home, mode 0700: `templates/store/<id>/` holds each template version's entries, never rewritten, and `templates/library.json` lists each saved template's name, its versions by id with their time and source (`saved`, `imported` or `restored`), its `origin` and signer state, and which profile has it active. A template is staged under `templates/staging/` and published by one rename after it validates.
20. **Names and versions.** A name identifies one saved template; its versions are kept until the person removes them. Removing a template or a version is refused while a profile has it active. A history version of a profile that names a template version the library no longer holds is restored with the profile files it holds, and the library gains nothing.

### Save and switch

21. **Save.** `delorun template save [<name>]` records the active template's current content as a new version in the library. With a new name, it saves the current content as a new template and makes it the active one. Save writes no profile file except `delo-template.json`.
22. **Only at the home's computer.** A save, switch, import, export, backup or restore runs only from a `delorun` command at a terminal on the home's computer or from the studio on its loopback address with the studio's credential. A remote session, a model's tool and a plugin route cannot start, confirm or undo any of them.
23. **What the person sees before a switch.** The preview lists what the switch changes: plugins added, removed or moved to another version, with source, integrity, the install check's findings and any build they ask to run; rows added, removed or changed, presets and skills among them; harness edits, file by file with their diffs; credentials the target names, with whether the home has them; and requirements the running release does not meet. Nothing is installed, imported or run before the person confirms.
24. **The Host is stopped.** A switch stops the Host the way `delorun update` does: the chat gate refuses new turns, running turns end, and the Host stops; `--cancel` cancels running turns instead of waiting, after the person confirms. Nothing changes while chats run.
25. **One transaction.** Under the home lock, the switch saves the active template when its content differs from its last version, writes the history version "Before switching to <name>", writes the target's rows into the profile patch beside the machine choices, its dependencies and bundles, its skills, its approved harness files and `delo-template.json`, installs the plugins and writes their install records, writes the history version "Switched from <old> to <new>" and one Changes entry whose `historyVersion` names it, and starts the Host.
26. **A failed start goes back.** The start after the switch runs [C3's health check](../contracts/c03-update-report.md#health-check) H4: every row of the new template loads. A failure restores the "Before" version through the profile-safety restore, reinstalls, starts again and marks the Changes entry failed with the error. Undoing the Changes entry is a switch back.
27. **Logs.** Each start writes the active template's name and id to the home's operational log ([C20](../contracts/c20-operational-logs.md)).

### Chats and presets across a switch

28. **History stays.** A switch changes no chat. Every chat keeps its history, and its next turn runs under the Host the switch started.
29. **A chat follows its preset id.** A chat resolves its recorded preset id when it next runs, as upstream does today, and uses the definition the active template gives that id. Two templates that define the same preset id differently give the chat each one's definition in turn.
30. **A preset that is gone.** When the active template does not define the chat's preset id, the chat does not run under another preset. The studio shows the chat with "Its preset <id> is not in the template <name>" and offers two actions: switch to the template that had it, when the library knows one, or choose another preset for this chat, which appends `agent-preset/selected` to its session. A scheduled delivery to that chat is refused with the same reason and recorded.

### Templates, presets and profiles

31. **A preset is per chat; a template is per profile.** An agent preset composes one agent: its plugins in its own `config.plugins`, its instructions and its model. A chat chooses one, the session records it, several coexist in one Host, and changing a chat's preset needs no restart. A template decides which plugins the Host loads, the config of rows, which presets exist, which skills are offered and which harness edits run. It applies to every chat of the profile, and switching it restarts the Host.
32. **A template carries presets as rows.** Its presets are preset rows in `rows.patch.yml`, and it may set the preset registry's default.
33. **Switching is within one profile.** A switch keeps one profile, so the person keeps one studio address, one history and their machine choices. Profiles stay the way to run two compositions at the same time: each has its own Host, lock, run directory, history and installed packages, and each has its own active template from the same library. Chats are shared across profiles, as today, and rules 29 and 30 apply when a chat moves between them.

### Import and export

34. **Export.** `delorun template export <name> <file>` writes a saved template as a template file, signed with the home key when the person chooses. Values of fields of role `secret` are never in a template; a value that holds an absolute path on this machine is named before writing so the person can decide.
35. **Import.** `delorun template import <file>` verifies the file (C8's reader and limits, the manifest digests, the signature, the rules of [the template file](#the-template-file)), shows the preview of rule 23 for the template as it would load in this profile, harness edits file by file with their diffs, and adds it to the library. Import does not activate the template; a switch does.
36. **A newer version of an imported template.** Importing a template whose `name` and signer match a saved template's `origin` offers it as an update of that template. The preview is a three-way comparison per item: the base is the version the person imported, theirs is the new version, and ours is the saved template with the person's edits. Rows are compared by id, plugins by name and harness edits per file. An item only one side changed takes that side; an item both changed is shown with both values and the person picks one, so no item is merged silently. The result is a new version of the saved template.
37. **The stock-home import.** `delorun import-home` writes the stock home's allow-listed rows into the active template, as it writes them into the profile patch today; the next save records them.

### Backup and restore

38. **Backup.** `delorun template backup <file>` writes one file, signed with the home key, holding every saved template with every version the library keeps, each profile's active template, the machine choices of each profile, the home patch, the home's `skills/` and `AGENTS.md`. Harness edits are always included. It holds no chat, credential value or trust decision, and lists the credentials the templates name. Backing up chats is [C8's export](../contracts/c08-archive-and-trash.md), a separate feature.
39. **Restore.** `delorun template restore <file>` verifies the file, shows one preview for everything it brings, runs the install check over every plugin of each active template, asks for the build and version decisions rule 17 keeps with the home, and then fills the library and loads each profile's active template as one transaction per profile, onto a fresh install or another machine. A restore never overwrites a saved template of the same name with different content: it adds the restored versions beside it.

### Updates

40. **The active template is the profile.** [C3's report](../contracts/c03-update-report.md#items) and the carry check of `@delo/profile-safety` evaluate the active template as they evaluate the profile's files today. Its harness edits carry by C21's three-way merge, with the target's content running and `<file>.mine` holding the person's for a conflicted file.
41. **Saved templates that are not active.** An update changes no saved template. A switch to a template whose `requires.delo` excludes the running release, whose plugins the running release disables, or whose harness edits name another release shows that in its preview: a harness edit is merged three-way with its stated release's signed file as base, which the runtime store or a verified download provides, and a file that does not merge cleanly is shown with both sides for the person to pick before anything applies.

### Changes, protection and the install check

42. **One Changes entry per transaction.** Save, switch, import, restore and the update of an imported template are Changes kinds `template-save`, `template-switch`, `template-import`, `template-restore` and `template-update`. Each entry lists the plugins and harness files it changes as children.
43. **Approved content.** Loading a template approves its content. The plugins and harness files it brings are approved versions in Changes' store, and the protection setting applies to them at each start as to any approved content. The store's collection keeps every version a saved template refers to.
44. **The install check over the set.** The install check runs over every plugin a switch, import or restore brings, as one set, before anything is written. A blocking finding in any plugin stops the whole transaction.
45. **The model and remote sessions.** The agent cannot save, switch, import, export, back up or restore a template, and cannot write to `templates/`.

### Secrets and credentials

46. **Names only.** A template names credentials; the home holds their values in `.credentials.yaml`, shared by every template. A template that needs a different value uses a different name, such as `WORK_GITHUB_TOKEN`. Loading a template whose credentials the home lacks succeeds; the preview and the studio name each missing credential and how to add it.
47. **No secret in a profile file.** No value of a field of role `secret` is written into a patch file, a template or any file the profile history tracks. Delo's Settings offers the `credential-ref` field of such a row and not its `secret` field.

### Commands and the studio

48. **Commands.** `delorun template list`; `show <name | file>`, the preview without changing anything; `save [<name>]`; `switch <name>[@<version>]`; `import <file>`; `export <name> <file>`; `backup <file>`; `restore <file>`; `remove <name>[@<version>]`. Each takes `--profile`. Each that changes a profile prints the preview and asks; `--yes` confirms only a preview with no finding, conflict or unmet requirement and never accepts an unknown signer.
49. **The studio.** A Templates section beside Changes shows the library, the active template with its contents, the preview screen and the switch. A remote session sees the active template's name and nothing that changes it.

## What this does not protect against

- **Plugin code has the harness's authority.** A template's plugins run with the same authority as any plugin. The preview and the install check show what a plugin is and what is known about it, not what its code does.
- **A signer is not a reviewer.** A valid signature proves which key published the template.
- **Rows that weaken a choice.** A template cannot touch protected rows or machine choices, but its other rows can turn off a tool, change a model or replace a preset. The preview lists them; the person decides.
- **Instructions in presets and skills.** A preset's instructions and a template's skills reach the model once loaded. The preview lets the person read them; nothing checks their content.
- **Harness edits run as the harness.** A published template's harness edits change the harness's own code. The preview shows every diff; nothing checks what the code does.
- **Secrets in fields that are not marked.** A plugin that keeps a secret in a field without the role `secret`, such as a plain `apiKey` string, is not detected, and its value goes wherever the row goes.
- **A process of the same user.** A program running as the person outside the sandbox can change the library and the profile's files, as the [threat model](../security/threat-model.md#other-local-processes-under-the-same-user) states for the whole home; protection Block names the change at the next start.

## Denial tests

- `a template that differs by one byte from its manifest is refused before anything is written`
- `a template with a !!js expression, a protected row, a machine-choice row, a secret value or an unpinned plugin is refused`
- `nothing of a template is installed or imported before the person confirms the preview`
- `the import preview shows every harness edit's diff before anything applies`
- `no route, tool or remote session can save, switch, import, export, back up or restore a template`
- `a failed start after a switch leaves the profile byte-identical to the version before`
- `a switch keeps every machine-choice row and leaves the home patch, skills and AGENTS.md byte-identical`
- `a chat whose preset the active template lacks does not run under another preset without the person choosing it`
- `export and backup carry no credential value, chat or trust decision`
- `an update of an imported template never merges an item both sides changed without the person's pick`
- `the store's collection keeps every version a saved template refers to`
- `Settings never writes a secret-role value into the profile patch`

## Constraints for current work

Delorun does not include templates ([roadmap](../guide/roadmap.md)). Homes created by 0.1.0 keep the formats and files it writes, and these rules keep templates possible without a migration. They apply to every change, the Changes, install-check and plugin-authoring lanes included.

1. **The profile's own files are the person's whole configuration.** Every choice the person makes about what the harness runs (rows, plugins, approved plugin content, harness edits) is recorded in the profile directory and tracked by the profile history. Home-wide stores hold only content-addressed objects, trust decisions and records of what happened.
2. **No secret in a profile file.** No code writes a credential value into `cordis.patch.yml` or any file the profile history tracks; such a value is a credential named through a `credential-ref` field.
3. **No machine-specific temporary state in a profile file.** State that one command or start composes, such as a plugin dev session's watched folders, goes into an overlay under `run/<profile>/`, as the sandbox and safe-mode overlays do.
4. **Machine choices are listed.** Every row Delo writes from a setup answer, the Privacy section or reach has its id in one exported list beside the code that writes it, so a template can leave those rows out by id.
5. **Trust decisions stay in their own files.** Grants, consents, exemptions and build approvals are never stored as rows of `cordis.patch.yml` or beside the person's plugin list, so a template leaves them out by file.
6. **The release's bundles come from a list.** Code that tells the release's bundles from the person's reads the release's bundle list. The `@delo/` scope stays reserved for the release's own packages.
7. **One stop, write and start routine.** Profile-wide transactions that need a stopped Host (update, rollback, restore, and a template switch or restore) use one routine: the chat gate, the home lock, the "Before" history version, the write, the start, the health check and the restore on failure.
8. **The install check decides a set before it writes.** The install check can take a set of plugins and return every decision before it writes any record.
9. **The store's collection takes more referrers.** The collection of Changes' store reads its referrers from a list that another feature can extend, so saved templates can keep the versions they refer to.
10. **C8's customisation schema does not grow.** Export keeps writing no customisation rows, and no new row kind is added; the template format takes its place.

## Current code that conflicts

"Format" marks a conflict whose fix changes a file or format that 0.1.0 homes keep, so fixing it later needs a migration. "Code" marks code that can change when templates are built without touching a released file.

| Where | Conflict | Smallest fix | Kind of fix |
| --- | --- | --- | --- |
| `packages/web/web-deepseek-api/src/index.ts:50`, `packages/web/web-search-deepseek/src/index.ts:69` (both rows in the base bundle) | Settings saves values of role `secret` into the profile patch, which the profile history keeps in git; a template, export or backup of the profile would carry them. Must be fixed whatever happens to templates. | Hide the `secret` field of these rows in Delo's Settings, so only the `credential-ref` field is offered, and refuse a `secret` value in the profile patch at start; a value already there is named with the command that moves it into `.credentials.yaml`. | Format |
| `delo/packages/changes/src/types.ts:150-171` and `paths.ts` (branch `lane/changes`) | Approved harness files are one record per runtime under `changes/harness/<runtime>/approved.json`, shared by every profile and outside the profile history, so they cannot belong to a template or switch with it. | Keep the approved file map in the profile, beside the approved plugins in `package.json` under `delo.changes` or in a tracked `delo-harness.json`, before the record ships; contents stay in the store, and the copy and run directories stay keyed by digest. | Format |
| `delo/apps/cli/src/plugin-dev.ts:51-142` (branch `feat/plugin-authoring`) | `addDevRoot` writes an `hmr` row with an absolute folder path into the person's `cordis.patch.yml`, recognised only by a comment that `writes.ts` erases, and left behind after a crash; a save or backup would carry it. | Write the dev roots into an overlay under `run/<profile>/` that the start passes, as safe mode does. | Format |
| `delo/apps/cli/src/setup/writes.ts:124-171` with its callers `setup/sections.ts:425`, `setup/prompt-switches.ts:48`, `setup/update-check.ts:34`, `reach/row.ts:96` | Machine choices are written into the same file as the person's rows with no list of their ids. | Export the ids these writers set as one list (constraint 4). | Code |
| `delo/packages/changes/src/collect.ts:1-20`, `:54-72` (`lane/changes`) | The store's collection keeps only versions that current profile and harness records name. | Take the referrers as a list another feature extends (constraint 9). | Code |
| `delo/packages/plugin-install-check/src/check.ts:288-299` (uncommitted `feat/plugin-supply-chain`) | `reconcileProfile` writes each record as it goes. | Split into a pass that returns every decision and a commit that writes the records. | Code |
| `delo/packages/profile-safety/src/files.ts:52-58` | The history's file list does not hold `delo-template.json`. | Add it when templates are built; upstream's `admitManagedFiles` admits new names into existing histories. | Code |
| `packages/preset/agent-preset-registry/src/index.ts:220-224` with `packages/api/session-controller/src/agent.ts:271-283` | A chat whose preset id no definition has fails with `agent-preset/not-found`, and the studio offers no choice. | Show the chat with the two actions of rule 30; no fallback to the default preset. | Code |
| `delo/packages/contract-archive-and-trash/src/index.ts:26-32` | C8's customisation rows deny credential references, which templates need by name, and overlap the template format. | Freeze the customisation schema (constraint 10); the archive refers to a template when templates are built. | Code |

## Open questions

1. **Collisions of the word "template".** No `delorun` command is named `template`, so the command is free. Two uses of the word exist: upstream calls its shipped profiles (`web`, `headless`, `sdk`, `acp`) "profile templates", in `dsh --from-default-profile <name>` and in Delo's own pages ("upstream's headless template"); and `delorun template import` and `export` sit beside `delorun import` and `export`, which move chat archives, and `delorun import-home`. Recommended: keep "template" for this feature and write "upstream's shipped profile" where Delo's pages now say "upstream's template", so the person meets one meaning; keep both import commands and say in each one's help which it moves. Confirm.
2. **Auto-save on switch.** Rule 25 saves the active template as a new version when it changed since its last save, so a switch never loses an edit. Confirm, or should the switch ask?
3. **Unsigned shared templates.** Rule 5 accepts an unsigned template after the person types `unverified`, as C8 does for archives. Should templates from other people require a signature, with unsigned ones limited to the person's own export and backup files?

Decided defaults, recorded here for review: a backup covers every saved template, the home's `skills/` and `AGENTS.md` and the home patch (rule 38); the stock-home import writes into the active template (rule 37); harness edits in a shared template are shown file by file with their diffs before anything applies (rules 23 and 35); switching is within one profile (rule 33).

## What is built so far

Nothing on this page is built. The profile files and their history with its restore, safe mode's overlay and C8's archive reader that the rules reuse are built and described by their own contracts.
