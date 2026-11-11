---
description: "Design of setups: a published, content-addressed record of how someone uses the harness (pinned plugins, profile rows, presets, skills, harness edits and credential names) that is applied, removed and switched as one transaction, stacks as layers between Delorun's release and the person's own layer, records which layer each contribution came from, and serves sharing, backup and switching. Ends with the constraints current work must follow and the current code that conflicts."
---

# Setups

English

## Summary

A setup is a file that describes how someone uses the harness: the plugins they run, pinned with integrity, the profile rows and settings they chose, their agent presets and skills, optionally their edits to the harness as patches against a stated release, and the names of the credentials those need. It never holds a secret, a chat or a trust decision. A person can apply a setup someone else published, keep several setups and switch between them, and back up their whole harness as setups. Applying, removing and switching are each one transaction: Delo shows exactly what the change adds before anything runs, runs the same install check as for a plugin, stops the Host, writes one profile history version and one Changes entry, and starts again; a failed start goes back to the version before. Several setups stack as layers between Delorun's release and the person's own layer, and every row, plugin, preset, skill and harness edit records the layer it came from, so removing a setup removes exactly its contributions and an update rebases each layer on its own. Setups are built after 0.1.0. This page fixes their format and rules now so that the code built before then does not block them; the [constraints for current work](#constraints-for-current-work) and the [current code that conflicts](#current-code-that-conflicts) are the parts that apply today.

## Contents

- [Terms](#terms)
- [What exists today](#what-exists-today)
- [The rules](#the-rules)
  - [The setup file](#the-setup-file)
  - [The layer list](#the-layer-list)
  - [When two layers touch the same thing](#when-two-layers-touch-the-same-thing)
  - [Which layer a contribution came from](#which-layer-a-contribution-came-from)
  - [Apply, remove and switch](#apply-remove-and-switch)
  - [Chats and presets across a switch](#chats-and-presets-across-a-switch)
  - [Setups, presets and profiles](#setups-presets-and-profiles)
  - [The library](#the-library)
  - [Saving the person's layer, export and backup](#saving-the-persons-layer-export-and-backup)
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

- **Setup**: one file in the format below, identified by the SHA-256 of its manifest. Its name and version are labels its author chose.
- **Layer**: the [glossary](../reference/glossary.md#profile)'s term, a bundle, the profile patch, the home patch or an overlay. This page adds the **layer id**, which says whose a layer is: `base` for the bundles of the running release, `setup:<sha256>` for an applied setup, and `person` for the person's own layer, which is the bundles they installed themselves, the profile patch and the home patch.
- **Layer list**: a profile's layers in the order they compose: `base`, then the applied setups bottom to top, then `person`, then the start overlays.
- **Library**: the setups a home keeps, whether applied to a profile or not.
- **Switch**: replacing the setups in a profile's layer list with another list of setups from the library, as one transaction.

## What exists today

- A profile composes upstream's layers in a fixed order: the bundles of `dsh.profile.bundles` in list order, the profile's `cordis.patch.yml`, the home's `cordis.patch.yml`, then the start's `--patch` overlays ([architecture](../../../docs/architecture.md#profiles-and-bundles)). A patch that targets a row by id replaces the row's whole `config`; nothing merges field by field. `delo/apps/cli/src/patch-layers.ts` reads the same order and names the file that set a value, as a free-text `source`.
- Upstream's settings are rows in the profile patch. The config editor measures a field against the composition of the bundle layers and refuses to save a row that the home patch or an overlay overrides (`packages/boot/config-editor/src/index.ts:78-95`, `:150-156`). A layer that sits among the bundles is therefore the only kind a person can still edit over in Settings.
- Agent presets are rows of `@deepseek-ai/dsh-agent-preset` in patch layers, so they belong to a profile. A second definition with the same id is refused (`packages/preset/agent-preset-registry/src/index.ts:100`). A chat records its preset by id in the event `agent-preset/selected` (`packages/preset/agent-preset-registry/src/session.ts:31`, appended at `index.ts:375`); a resumed chat resolves the id again and mounts the current definition, and an id no layer defines fails with `agent-preset/not-found` (`index.ts:220-224`).
- Skills load from the workspace, from `customSkillDirs`, from the home's `skills/` and `~/.agents/skills`, and from bundled skills; every custom directory carries the source `custom` (`packages/skill/skill-filesystem/src/index.ts:52-90`). Skills are home-wide, not per profile.
- Credential values live in the home's `.credentials.yaml`, and config names them through fields of role `credential-ref`, such as `apiKeyEnv`. Some upstream plugins also have fields of role `secret`, whose values Settings writes into the profile patch in plain text (`packages/web/web-deepseek-api/src/index.ts:50`, `packages/web/web-search-deepseek/src/index.ts:69`).
- Chats, workspaces and attachments are home-wide and shared by every profile.
- The profile history is upstream's git-backed history over a fixed list of files, which Delo extends with its own records and a copy of the home patch (`delo/packages/profile-safety/src/files.ts:52-58`). A version records a summary and who changed it: `person`, `agent` or `outside`.
- `delorun export` writes chats and workspaces with an empty customisation document, and `delorun import` lists customisation rows and applies none ([C8](../contracts/c08-archive-and-trash.md#customisation-schema)).
- On branches not merged into `v5`: Changes ([design](changes.md)) keeps approved plugins keyed by package name and approved harness files keyed by path per runtime, and the plugin install check writes one install record per plugin. Neither records which layer a contribution came from.
- There is no setup file, no layer id, no layer record, no library and no command for any of it.

## The rules

### The setup file

1. **Container.** A setup is a zip file read with the reader and limits of [C8](../contracts/c08-archive-and-trash.md#limits). Its top-level entries are `setup.json`, the manifest; `signature.json`, present only when signed; `rows.patch.yml`; `plugins/`, packed plugins; `skills/`; and `harness/`, harness edits. No other top-level entry is valid.
2. **Manifest.** `setup.json` has `schema` `delo.setup/1`; `name`, 1 to 32 lowercase letters, digits and hyphens, starting with a letter; `version`, a semantic version; `title` and `description`, plain text without control characters; `author`, with `name` and an optional `url`; `requires`, with a `delo` range checked like a plugin's `engines.delo` ([C17](../contracts/c17-plugin-versions.md)); `plugins`; `credentials`; an optional `harness`; and `files`, listing every other entry with its `path`, `sha256` and `size`. A field the schema does not define is refused.
3. **Identity.** A setup's id is the SHA-256 of the exact bytes of `setup.json`. Because the manifest lists the digest of every other entry, a change to any byte of the setup gives a new id. Delo identifies a setup by its id everywhere it stores one; the name and version are what the person reads. Two setups with the same name and version but different ids are two setups, and Delo says so when the second is added.
4. **Versions.** `schema` is the format's version: a reader refuses a schema it does not know, and a new schema is an adjacent successor, never an edit of `delo.setup/1`. `version` is the author's: a later version of a setup is another setup with the same name, which the library offers as an update of the first.
5. **Signature.** `signature.json` follows [C8's signature](../contracts/c08-archive-and-trash.md#signature): Ed25519 over the exact bytes of `setup.json`, the signer's key fingerprint, and the same states. A home vouches for its own key and for keys the person confirmed by typing the fingerprint; an unsigned setup is accepted only when the person types `unverified`. A signature says who published the setup, not that it is safe.
6. **Plugins.** Each entry of `plugins` has `name`, an exact `version`, `integrity` (a Subresource Integrity SHA-512 value) and `from`: `registry`, installed from the registry the profile's plugin manager uses and checked against `integrity`; or `file`, a packed tarball under `plugins/` whose integrity is the tarball's. A range, a tag, a `link:`, `file:` or `git` reference and a package in the `@delo/` scope are refused.
7. **Rows.** `rows.patch.yml` is a Cordis patch list. Settings are rows, so a setup's settings are config of rows here, and its agent presets are rows of `@deepseek-ai/dsh-agent-preset`. A row it inserts has an id that starts with the setup's name and a dot, such as `research.reviewer`; a patch without `insert` may target an existing row. A setup's rows are refused when they hold a `!!js` expression, insert a plugin that is neither in the setup's `plugins` nor in the running release, set a value of a field of role `secret`, target a row that [C19's Host invariants](../contracts/c19-home-process.md#host-invariants) protect (the `sandbox` row, every Delo row, the prompt rows and the guard rows), the `plugin-manager` row or the `hmr` row, or set a sandbox mode, a reach option or an egress limit. Code belongs in a plugin, which the install check sees; a row is data.
8. **Skills.** `skills/<name>/` holds one skill each, in upstream's skill layout.
9. **Harness edits.** `harness` names the release the edits were made against, by its Delo version and the SHA-256 of its signed release manifest ([C2](../contracts/c02-release-manifest.md)), and lists one entry per file: the path under `app/`, the SHA-256 of the signed file the edit starts from, and a unified diff under `harness/`. A setup without harness edits has no `harness` field.
10. **Credentials.** `credentials` lists each credential the setup's rows name, by the name a `credential-ref` field holds, with a one-line purpose. It never holds a value.
11. **Never in a setup.** Chats, workspaces, attachments, credential values, the files of `secrets/`, `trust/` and `run/`, logs, the protection setting, permission and full-access grants, MCP and other consents, device approvals, version exemptions and build approvals. These are the receiving home's own decisions.

### The layer list

12. **Order.** A profile's layer list is `base`, then each applied setup in the order the person chose, then `person`, then the start overlays (safe mode, the sandbox overlay, a change left out at start). A higher layer's patch of a row replaces a lower layer's, as in Cordis today.
13. **A setup is a bundle layer.** Applying a setup creates a local bundle at `profiles/<profile>/setups/<id>/` whose `package.json` names it `delorun-setup-<name>` and declares `rows.patch.yml` as its `dsh.bundle.patch`, links it into the profile, and places it in `dsh.profile.bundles` after the release's bundles and before every bundle the person installed. Setups therefore compose with upstream's own mechanism, the config editor treats their rows as inherited, and the person's edits in Settings land in the profile patch above them.
14. **The layer record.** `profiles/<profile>/delo-layers.json`, schema `delo.layers/1`, lists the applied setups bottom to top, each with its id, name, version, bundle name, signer state, the plugins it pinned, the credentials it names and when it was applied. It is the one source of which bundles are setup layers; `base` is the release's bundle list and `person` is everything else. The profile history tracks it, so every history version holds the layer list it had.
15. **Lists come from registrations, not from shared values.** Because a patch replaces a row's whole config, no layer appends to a list another layer set. A setup's skills are offered by one skill provider per setup layer, registered by a Delo row of the release that reads the layer record and tags each skill's source `setup:<name>`; no setup writes `customSkillDirs`.
16. **One profile at a time.** A layer list belongs to one profile. The library is home-wide, so several profiles can apply the same setup.

### When two layers touch the same thing

17. **The same row.** When two layers patch the same row, the higher layer's config replaces the lower one's whole config. Before applying, Delo lists every row the setup patches that a lower layer also patches, whose values the setup replaces, and every row it patches that a higher layer, the person's included, also patches, whose values from the setup will not take effect.
18. **The same inserted id.** Inserted ids carry the setup's name, so two setups cannot insert the same id. A setup that would insert an id any layer already inserts is refused, which C19's check of a row inserted again also refuses at start.
19. **The same plugin.** A profile installs one version of a package. Two layers that pin the same name, version and integrity share the installed package, and the layer record lists it under both. Two layers that pin different versions or integrities are refused at apply, naming both layers and both pins.
20. **The same skill or preset name.** A setup that offers a skill whose name another layer offers is refused at apply, naming both layers. Preset ids are row ids, so rule 18 covers them.
21. **Removing a layer that another layer configures.** When a removed setup inserted a row that a higher layer patches, the higher layer's patch stays where it is and targets no row; Delo lists it before the removal, and `delorun doctor` lists it afterwards as "configures a row no layer inserts". A plugin stays installed while any remaining layer pins it.
22. **Protected rows.** Before writing anything, an apply, a removal or a switch composes the new layer list without importing plugin code and runs the Host-invariant check of the start on it; a layer list the start would refuse is never written.

### Which layer a contribution came from

23. Each contribution records its layer id where it is stored:
    - a row: the bundle layer that holds it, which the layer record maps to a layer id; `patch-layers.ts` returns the id beside the file it names;
    - a plugin: the layer record's `plugins` of each setup, and the `requestedBy` layer ids of its install record and of its Changes record;
    - a preset or a setting: a row, as above;
    - a skill: its source, `setup:<name>` for a setup's skills;
    - a harness edit: the layer under which the harness record holds it;
    - a Changes entry: its `layer` field.
24. `delorun doctor`, `delorun verify`, the update report and the studio name the layer beside each contribution they show.

### Apply, remove and switch

25. **What the person sees first.** Before anything runs, the preview lists: the setup's name, version, id and signer state; each plugin with its version, source, integrity and the install check's findings, and any build it asks to run; each row it inserts or patches, with the conflicts of rules 17 to 21; each preset and skill, whose text the person can open; each harness edit as a diff; each credential it names, with whether the home has it; and what the transaction removes. Nothing is installed, imported or run before the person confirms.
26. **Only at the home's computer.** A setup is added to the library, applied, removed or switched only by a `delorun` command at a terminal on the home's computer or by the studio on its loopback address with the studio's credential. A remote session, a model's tool and a plugin route cannot start, confirm or undo any of them.
27. **The Host is stopped.** The transaction stops the Host the way `delorun update` does: the chat gate refuses new turns, running turns end, and the Host stops; `--cancel` cancels running turns instead of waiting, after the person confirms. Nothing is swapped while chats run.
28. **One transaction.** Under the home lock, the transaction writes the history version "Before <action>", then the library entry when the setup is new, the setup's bundle directory, the layer record, the bundle list and dependencies, the installed packages, their install records and the harness record, then the history version "<action>", for example "Applied setup research 1.2.0", and one Changes entry whose `historyVersion` names it. It then starts the Host.
29. **A failed start goes back.** The start after the transaction runs [C3's health check](../contracts/c03-update-report.md#health-check) H4: every row the new layers add loads, and every row that loaded before still loads. A failure restores the "Before" version through the profile-safety restore, reinstalls, starts again and marks the Changes entry failed with the error. Nothing of the setup stays applied.
30. **Undo.** Undoing the Changes entry is a restore of the "Before" version, with the checks and approval prompt that [C3 requires for restore](../contracts/c03-update-report.md#undo-and-restore).
31. **Remove.** Removing a setup is the same transaction with the setup's bundle, its layer record entry, the plugins no other layer pins and its harness edits taken out. The library keeps the setup.
32. **Switch.** A switch names a target list of setups from the library. Setups in both lists at the same relative order stay; the others come off or go on; the person's layer stays. The preview lists both sides, and the switch is one transaction with one history version and one Changes entry, "Switched from work to experiments". Undo switches back.
33. **Logs.** Each start writes the layer list it composed, as layer ids, to the home's operational log ([C20](../contracts/c20-operational-logs.md)).

### Chats and presets across a switch

34. **History stays.** A switch changes no chat. Every chat keeps its history, and its next turn runs under the Host the switch started.
35. **A preset that is still there.** A chat resolves its recorded preset id when it next runs, as upstream does today. When the new layer list defines the id, the chat uses the definition the new list gives it.
36. **A preset that is gone.** A setup's preset ids carry its name, so a chat started under `work.reviewer` resolves it only while `work` is applied. When the id is not defined, the chat does not run under another preset. The studio shows the chat with "Its preset work.reviewer comes from the setup work, which is not applied" and offers two actions: switch back, or choose another preset for this chat, which appends `agent-preset/selected` to its session. A scheduled delivery to that chat is refused with the same reason and recorded.

### Setups, presets and profiles

37. **A preset is per chat; a setup is per profile.** An agent preset composes one agent: its plugins in its own `config.plugins`, its instructions and its model. A chat chooses one, the session records it, several coexist in one Host, and changing a chat's preset needs no restart. A setup is a layer of the profile: it decides which plugins the Host loads, the config of rows, which presets exist, which skills are offered and which harness edits run. It applies to every chat of the profile, and changing it restarts the Host.
38. **A setup carries presets as rows.** A setup defines presets by inserting preset rows with its own ids, and may patch an existing preset row's `config.plugins` or the preset registry's default under rule 17.
39. **A switch is a change of the layer list, not of the profile.** Switching keeps one profile, so the person keeps one studio address, one history, one install of the plugins two setups share, and one person's layer whose own choices apply under every setup they switch to. A person who wants a choice only under one setup saves it into that setup ([rule 43](#saving-the-persons-layer-export-and-backup)).
40. **Profiles are for running two compositions at once.** A profile has its own Host, lock, run directory, history and installed packages, and two profiles can run together. A person who wants "work" and "experiments" running at the same time uses two profiles, each with its own layer list, both drawing setups from the home's library. Chats stay shared across profiles, as today, and rules 35 and 36 apply when a chat moves between them.

### The library

41. **Where it is.** `setups/` at the top of the home, mode 0700: `setups/library/<id>/` holds each verified setup's entries as published, never rewritten, and `setups/library.json` lists each entry's id, name, version, title, signer state, where it came from (`file`, `saved` or `backup`) and when it was added. A setup is staged under `setups/staging/` and published by one rename after it has validated.
42. **Names and versions.** The library may hold several versions of one name. `delorun setups list` shows each name with its versions, which profiles apply which version, and whether a newer version is in the library. Applying a newer version of an applied setup is a switch from the older to the newer, with the preview showing the difference. Removing an entry from the library is refused while a profile's layer record names it; a history version that names an id the library no longer holds is restored only after the person adds that setup again.

### Saving the person's layer, export and backup

43. **Save.** `delorun setups save <name>` makes a new setup from the person's layer and adds it to the library. Optionally, in the same transaction, it applies the new setup as the top setup layer and empties the person's layer, so the person can keep a "work" and an "experiments" setup and switch between them.
44. **What save and export take.** From the profile patch, every row the person wrote, and from the home patch, its rows only when the person chooses them, because the home patch applies to every profile. Every plugin the person installed: a registry plugin pinned with its lockfile integrity, a plugin linked from a folder packed from its approved content in Changes' store, never from the live folder. The person's presets, which are rows. The skills in the home's `skills/` that the person picks. The person's approved harness edits, as diffs against the running release. The name of every credential a row names.
45. **What save and export leave out.** Everything rule 11 lists, Delo's own rows and the setup answers that write the person's rows for prompts and privacy, which are the receiving home's own choices. A row value of a field of role `secret` is left out and named, with the advice to store the value as a credential and name it. A value that holds an absolute path on this machine is named so the person can decide.
46. **Backup.** `delorun setups backup <file>` writes one signed file holding, for each CLI profile, the saved person's layer as a setup, every applied setup by its full content, and each profile's layer list. `delorun setups restore <file>` verifies it, shows one preview for everything it applies, runs the install check over every plugin, and applies each profile's layer list as one transaction per profile, onto a fresh home or another machine. It carries no chat and no secret; it lists the credentials to add. Backing up chats is [C8's export](../contracts/c08-archive-and-trash.md), a separate feature.

### Updates

47. **The report names layers.** [C3's report](../contracts/c03-update-report.md#items) evaluates every layer's plugins and rows, and each item names its layer id. A setup whose `requires.delo` excludes the target gives one item for the whole setup; its actions are to skip the update or to update with that setup left out. A setup is never partly applied.
48. **The carry check reads layers.** The carry check of `@delo/profile-safety` reads each setup layer as the person's own choice: a target that would drop a setup's row, plugin or position in the bundle list is refused as for the person's rows, and the layer record, not a package-name prefix, says which bundles are setup layers.
49. **Harness edits rebase per layer.** Each layer's harness edits are recorded against the release they were last applied on. An update merges them in layer order, each with a three-way merge per file whose base is that release's signed file, whose ours is the file after that layer's edits, and whose theirs is the target's signed file with the lower layers' merged edits applied. For the person's layer, a conflict keeps C21's rule: the target's content runs and `<file>.mine` holds the person's. For a setup layer, a conflict in any file is one report item for the whole setup, with the same actions as rule 47.
50. **Applying on another release.** A setup whose harness edits name a release other than the running one applies only when each edit merges cleanly with that release's signed file as base, which the runtime store or a verified download provides; otherwise the apply is refused, naming the files.

### Changes, protection and the install check

51. **One Changes entry per transaction.** Apply, remove, switch and save are Changes kinds `setup-apply`, `setup-remove`, `setup-switch` and `setup-save`. Each entry lists its plugins and harness files as children, each with its layer id, so Changes shows a setup as one item that opens into its parts.
52. **Approved content.** Applying a setup approves its content. The library entry is content-addressed, and at each start the files of `profiles/<profile>/setups/<id>/` are compared with it under the protection setting, as Changes compares a plugin's files with its approved version: under Block, a setup layer whose files differ is not loaded, and the person is offered to put the library's content back.
53. **The install check over the set.** The install check runs over every plugin of the setup as one set before anything is written. A blocking finding in any plugin stops the whole apply; the person's acceptance of a finding is recorded per plugin with the layer that asked for it.
54. **The model and remote sessions.** The agent cannot add, apply, remove, switch, save or restore a setup, and cannot write to the library or to a setup layer's directory.

### Secrets and credentials

55. **Names only.** A setup names credentials; the home holds their values in `.credentials.yaml`. Applying a setup whose credentials the home lacks succeeds; the preview and the studio name each missing credential and how to add it, and a row that needs it fails at use as it does today.
56. **One set of values per home.** Credentials are home-wide, so two setups that name the same credential use the same value. A setup that needs a different value uses a different name, such as `WORK_GITHUB_TOKEN`.
57. **No secret in a layer.** Delo refuses to write a secret into any file a layer owns: the patch files, the layer record, a setup's files and every file the profile history tracks.

### Commands and the studio

58. **Commands.** `delorun setups list`; `show <file | name[@version]>`, the preview without applying; `add <file>`, to the library; `apply <name[@version]>`; `remove <name>`; `switch <name>[,<name>…]`; `save <name>`; `export <name> <file>`; `backup <file>`; `restore <file>`. Each takes `--profile`. Each that changes a profile prints the preview and asks; `--yes` confirms only a preview with no finding, conflict or missing requirement and never accepts an unknown signer.
59. **The studio.** A Setups section beside Changes shows the library, the profile's layer list with each layer's contributions, the preview screen, and the switch. A remote session sees the layer list and nothing that changes it.

## What this does not protect against

- **Plugin code has the harness's authority.** A setup's plugins run with the same authority as any plugin. The preview and the install check show what a plugin is and what is known about it, not what its code does.
- **A signer is not a reviewer.** A valid signature proves which key published the setup.
- **Rows that weaken a choice.** A setup cannot touch protected rows, but its other rows can turn off a tool, change a model or replace a preset. The preview lists them; the person decides.
- **Instructions in presets and skills.** A preset's instructions and a setup's skills reach the model once applied. The preview lets the person read them; nothing checks their content.
- **Secrets in fields that are not marked.** Save and export leave out values of fields of role `secret`. A plugin that keeps a secret in a field without that role, such as a plain `apiKey` string, is not detected.
- **A process of the same user.** A program running as the person outside the sandbox can change the library and the setup layers, as the [threat model](../security/threat-model.md#other-local-processes-under-the-same-user) states for the whole home; protection Block names the change at the next start.

## Denial tests

- `a setup that differs by one byte from its manifest is refused before anything is written`
- `a setup with a !!js expression, a protected row, a secret value or an unpinned plugin is refused`
- `nothing of a setup is installed or imported before the person confirms the preview`
- `no route, tool or remote session can add, apply, remove, switch, save or restore a setup`
- `a setup whose layer list would fail the Host-invariant check is never written`
- `two setups pinning different versions of one plugin are refused at apply`
- `a failed start after an apply leaves the profile byte-identical to the version before`
- `removing a setup leaves every file of every other layer byte-identical`
- `a chat whose preset came from a removed setup does not run under another preset without the person choosing it`
- `save and export carry no credential value, chat or trust decision`
- `an update with a conflicted setup harness edit applies none of that setup's edits`
- `a setup layer whose files differ from the library under Block is not loaded`

## Constraints for current work

Setups are built after 0.1.0, but homes created by 0.1.0 keep the formats it writes. These rules keep layers possible without a format migration. They apply to every change from now on, the in-flight Changes, install-check and plugin-authoring lanes included.

1. **One layer id type.** Delo has one branded type, `LayerId`, exported from one Delo contract package, with the values `base`, `person` and `setup:<sha256>`. Today only `base` and `person` occur. No record, report or function uses a free string or a second enum for "which layer".
2. **Every record of a contribution carries its layer.** Changes entries, approved plugins, approved harness files, active-content entries, install records and the update report's row subjects carry a `layer` (or, for a plugin several layers can ask for, `requestedBy: LayerId[]`) from their first released schema, set to `person` or `base` today. Readers that reject unknown fields make this cheap only before the schema ships.
3. **Several layers may ask for one plugin.** A record keyed by package name holds the one installed version and the list of layers that ask for it; it never assumes one owner per package.
4. **Harness edits are grouped by layer.** The harness record holds its files under a layer id, the three-way merge takes an ordered list of edit sets, and the run directory's digest covers that ordered list.
5. **The person's patch files hold only the person's choices.** Setup answers are the person's choices and belong there. Machinery Delo composes for one start or one command, such as a plugin dev session's watched folders, goes into an overlay under `run/<profile>/`, as the sandbox and safe-mode overlays do. No absolute path of a temporary folder is written into `cordis.patch.yml`.
6. **Row writes measure against every layer below.** A write that sets some fields of a row restates the config that the layers below the profile patch compose to, as upstream's config editor does, never the config of one named bundle file. The write edits the YAML document so comments survive.
7. **Lists come from registrations.** A feature that lets several sources add to one list adds a row or a registration per source; it never asks a layer to append to a list value another layer sets.
8. **Distributed ids are namespaced.** Rows and presets that Delo or a plugin author ship for others carry an id prefixed with their package's or setup's name. Nothing assumes a bare preset id is unique across layers or that a chat's preset id always resolves.
9. **No secret in a layer's files.** No Delo code writes a credential value into a patch file, a record a layer owns or a file the profile history tracks. Delo's profiles do not offer a Settings field that saves a value of role `secret` into the patch; such a value is a credential named through a `credential-ref` field.
10. **Configuration files are in the history.** A file Delo adds to a profile that holds the person's configuration is tracked by the profile history or derived from tracked files, so a restore brings back the layer list with the rest.
11. **One stop, write and start routine.** Profile-wide transactions that need a stopped Host (update, rollback, restore, and a setup's apply, removal and switch) use one routine: the chat gate, the home lock, the "Before" history version, the write, the start, the health check and the restore on failure. A new feature calls it instead of copying it.
12. **Recovery keeps bundles it does not own.** Code that rewrites `dsh.profile.bundles` (sanitizing, normalisation, migrations that add a Delo bundle) keeps every other bundle in its order and puts Delo's bundles among the release's bundles, before the first bundle the release does not list.
13. **Which bundles are the release's comes from a list.** Code that classifies a bundle as the release's, a setup's or the person's reads the release's bundle list and, once setups exist, the layer record. The `@delo/` scope stays reserved for the release's own packages.
14. **The install check decides a set before it writes.** The install check can take a set of plugins and return every decision before it writes any record, so a whole setup is checked and then committed or refused.
15. **C8's customisation schema does not grow.** Export keeps writing no customisation rows, and no new row kind is added to C8's customisation document; the setup format takes its place after 0.1.0.
16. **Trust decisions stay out of layers.** Permission and full-access grants, consents, the protection setting, version exemptions, build approvals and device approvals are stored apart from configuration and name their subject, so a removed layer can list the decisions its plugins leave behind.

## Current code that conflicts

"Before 0.1.0" marks a conflict whose fix changes a persisted format or data a 0.1.0 home keeps, which is cheap now and needs a migration after the release. "After 0.1.0" marks code that can change when setups are built without touching a released file.

| Where | Conflict | Smallest fix | When |
| --- | --- | --- | --- |
| `delo/packages/changes/src/types.ts:125-143` (branch `lane/changes`) | `ApprovedPlugin` and `ApprovedRecord.plugins` are keyed by package name with no layer; readers refuse unknown fields (`records.ts:257-260`), so adding one after the schema ships is a schema change. | Add `requestedBy: LayerId[]`, `["person"]` today. | Before 0.1.0 |
| `delo/packages/changes/src/types.ts:202-227` (`lane/changes`) | `ChangeEntry` has `decidedFrom` but no layer. | Add `layer: LayerId`, `person` today; add the setup kinds to `ChangeKind` when setups are built. | Before 0.1.0 |
| `delo/packages/changes/src/types.ts:150-171` (`lane/changes`) | `HarnessRecord.files` is one set per runtime, keyed by path, home-wide. | Hold the files under `layers: { person: { files } }` in `delo.changes-harness/1` before it ships. | Before 0.1.0 |
| `delo/packages/changes/src/types.ts:306-308` (`lane/changes`) | `active.json` maps a package name to one content kind with no layer. | Add `layer: LayerId`. | Before 0.1.0 |
| `delo/packages/changes/src/harness-merge.ts:204-227` (`lane/changes`) | `planHarnessCarry` and `runningHarnessRecord` merge one edit set. | Take an ordered list of per-layer sets; with one `person` set the result is the same. | After 0.1.0 |
| `delo/packages/changes/src/ids.ts:25-27` (`lane/changes`) | `changeId` hashes no layer, so the same change from two layers gets one id. | Add the layer to the hashed parts only when it is not `person`, which keeps every existing id. | After 0.1.0 |
| `delo/packages/plugin-install-check/src/record.ts:68-87` (uncommitted `feat/plugin-supply-chain`) | `InstallRecord` (`delo.plugin-install/1`, strict schema) names no layer or requester. | Add `requestedBy: LayerId[]`, `["person"]` today, before the schema ships. | Before 0.1.0 |
| `delo/packages/plugin-install-check/src/check.ts:288-299` (`feat/plugin-supply-chain`) | `reconcileProfile` writes each record as it goes and shares one `allowedAdvisories` list across plugins. | Split into a pass that returns every decision and a commit that writes the records; keep the advisories per plugin. | After 0.1.0 |
| `delo/packages/contract-update-report/src/index.ts:96-104` | `RowSubject.layer` is free text, and reports are kept in history versions. | Make it `{ id: LayerId, source: string }`, where `source` is today's text, in the next report schema. | Before 0.1.0 |
| `delo/packages/profile-safety/src/inventory.ts:25` and `delo/apps/cli/src/patch-layers.ts:16-23` | Two different `PatchLayer` types, neither with a layer id; `ProfileInventory` assumes the profile and home patches are the only person's layers. | Use `LayerId` in both; the inventory reads setup layers from the layer record when it exists. | After 0.1.0 |
| `delo/packages/profile-safety/src/files.ts:52-58` | The history's file list is fixed; a setup's layer record and bundle directory would not be tracked. | Add `delo-layers.json` when setups are built; upstream's `admitManagedFiles` admits new names into existing histories. | After 0.1.0 |
| `delo/apps/cli/src/setup/writes.ts:110-114`, `:124-134` | `writePatchList` rewrites the person's file with `stringify`, dropping comments; `setPatchRow` adds a new row with only the fields it sets, which replaces the whole config every lower layer composed. | Edit with `parseDocument`, as `plugin-dev.ts` does, and restate the composed config of the layers below for a new row. | After 0.1.0 |
| `delo/apps/cli/src/setup/update-check.ts:19-34` with `writes.ts:156-171` | `setRowFields` measures against `@delo/bundle-local`'s patch file alone; with a setup layer that patches the row below the person's, the person's write would silently drop the setup's values. | Pass the config the layers below the profile patch compose to (`composedRow` over those layers). | After 0.1.0 |
| `delo/apps/cli/src/plugin-dev.ts:51-142` (branch `feat/plugin-authoring`) | `addDevRoot` writes an `hmr` row with an absolute folder path into the person's `cordis.patch.yml`, recognised only by a comment that `writes.ts` erases, and left behind after a crash; export and backup would carry it. | Write the dev roots into an overlay under `run/<profile>/` that the start passes, as safe mode does. | Before 0.1.0 |
| `packages/web/web-deepseek-api/src/index.ts:50`, `packages/web/web-search-deepseek/src/index.ts:69` | Fields of role `secret` are saved by Settings into the profile patch, which the profile history keeps in git. | Leave these rows out of Delo's profiles or hide their secret fields in Delo's Settings, so only the `credential-ref` field is offered. | Before 0.1.0 |
| `packages/preset/agent-preset-registry/src/index.ts:220-224` with `packages/api/session-controller/src/agent.ts:271-283` | A chat whose preset id no layer defines fails with `agent-preset/not-found`, and the studio offers no choice. | Show the chat with the missing preset and the two actions of rule 36; no fallback to the default preset. | After 0.1.0 |
| `packages/skill/skill-filesystem/src/index.ts:52-90` | Skills come from one home directory and `custom` directories with no per-source tag. | A Delo row that registers one provider per setup layer with source `setup:<name>`. | After 0.1.0 |
| `delo/apps/cli/src/studio-bundle.ts:65-69` with `delo/apps/cli/src/delo-bundles.ts:113` | Linking a Delo bundle through `dsh plugin add` appends it at the end of the bundle list, which would put it above setup layers. | Insert Delo's bundles before the first bundle the release does not list. | After 0.1.0 |
| `packages/boot/app-boot/src/profile-sanitize.ts:18` and `packages/boot/app-boot/src/profile.ts:596-619` | Sanitizing replaces the bundle list with the caller's list, and normalisation rewrites a shipped tuple, so setup bundles would be dropped. | Keep bundles the caller does not own, in order. | After 0.1.0 |
| `delo/apps/cli/src/compose.ts:250-253` | The declaring bundle of a protected row is recognised by the `@delo/` package-name prefix. | Refuse any setup plugin or bundle in the `@delo/` scope (rule 6), and classify by the release's bundle list. | After 0.1.0 |
| `delo/packages/contract-archive-and-trash/src/index.ts:26-32` | C8's customisation rows deny credential references, which setups need by name, and overlap the setup format. | Freeze the customisation schema (constraint 15); the archive carries a setup when setups are built. | After 0.1.0 |

## Open questions

1. **The word.** `delorun setup` already names the first-run questions ([C11](../contracts/c11-setup-answers.md)). Keep "setup" for this feature with the command `delorun setups`, or choose another noun for the feature and its command? Recommended: another noun, because "run setup" and "apply a setup" would mean different things in the same help text.
2. **Switching unit.** This page switches by changing the layer list within one profile and uses profiles only to run two compositions at once (rules 39 and 40). Confirm, or prefer one profile per kept setup?
3. **Plugin version conflicts.** Rule 19 refuses two layers that pin different versions of one plugin. Should the higher layer's pin win instead, shown in the preview?
4. **Setups that require other setups.** Format 1 has no dependency between setups. Should a setup be able to require another by name and version range?
5. **Harness edits in shared setups.** Should published setups carry harness edits at all, or only setups a person saves and backs up for themselves?
6. **Unsigned setups.** Rule 5 accepts an unsigned setup after the person types `unverified`, as C8 does for archives. Should published setups require a signature, with unsigned ones limited to the person's own saves and backups?
7. **Scope of a backup.** Rule 46 backs up every CLI profile. Should a backup also hold the home's `AGENTS.md` and every skill in `skills/`, or only the skills the person picks?
8. **The stock-home import.** The import of a stock DeepSeek Harness home writes its allow-listed rows into the person's layer. Should it instead produce a setup, so the imported configuration can be removed as one?
9. **Per-setup credentials.** Rule 56 shares credential values across setups and asks for distinct names. Is that enough, or should a profile be able to use its own credentials file?

## What is built so far

Nothing on this page is built. The profile layers, the profile history with its restore, safe mode's overlay and C8's archive reader that the rules reuse are built and described by their own contracts.
