---
description: "Contract C3: the update report shown before a Delorun update applies, its items (plugin, bundle, row, chat data, harness file, reason, verified or unverified) and reason codes, the versions and update states of the CLI home and the desktop Host, the health-check criteria, the rollback triggers, and the checks and approval prompt of undo and restore."
---

# C3 Update report

English | [中文](c03-update-report.zh.md)

## Summary

Before an update applies, Delorun shows what the target release would change or break in the person's profile: every plugin, bundle and profile row it would disable, remove or change, and every file of the harness the person changed with whether that change carries over, with the reason and whether the prediction rests on metadata Delorun could read (verified) or not (unverified). Nothing applies until the person confirms. The CLI home and the desktop Host are separate installations that update independently, and the report shows the versions and update states of both. After the switch, a health check decides within 120 seconds whether the update stands; a failed check rolls back automatically, and the person can roll back at any later time. Undo and restore of profile history run the same plugin checks an install runs and list what they change before they apply. The types live in [`@delorun/contract-update-report`](../../packages/contract-update-report/README.md).

## Status

The CLI home's update and rollback are built and reached by `delorun update` and `delorun recover`; the studio's and the desktop app's are not, and undo and restore run without their checks and approval prompt.

- **Built and reached:** `delorun update` builds the report against the newest release on the channel, applies nothing until the person confirms (`--yes` confirms only a report with no `disabled`, `removed` or unverified item and a `log` of `passed`), writes the snapshot, waits for running chats while the CLI profile's update gate refuses new turns, takes the session-data copy, runs H1 to H5 within 120 seconds and rolls back automatically when one fails. `delorun recover` rolls back through the one table, restores a profile history version, enters and leaves safe mode and discards set-aside data. The [update check](#update-check) runs in the Host of a CLI home that runs from the store, writes its record and serves the notice to the terminal, the studio's sidebar and `delorun doctor`.
- **Built and reached:** the report's `harness` items, one per file the running runtime runs other than its signed one ([C21](c21-changes.md#harness-edits)), merged with the target's verified file, which `delorun update` prints and `--yes` holds to its rule; and applying them right before the switch ([Harness files across an update](#harness-files-across-an-update)).
- **Not built:** the studio's update screen, "Update now" and rollback; the desktop updater's use of this report and procedure; the status records, which the report reads and no installation writes, so the other installation always shows `unknown`; the approval prompt and the install-time plugin checks of undo and restore (R5), so `delorun recover restore` applies a version at once and lists what changed afterwards; the revocation list (no release publishes one, so every report lists `revocations` as not checked); H1's release-log condition, because H1 checks the runtime files only; reverting a restore that fails partway, which leaves the profile partly restored; the startup report with Update, Keep disabled and Roll back, because upstream's start disables an incompatible row and prints one line to standard error; the desktop's fatal recovery writing a history version and offering the profile from before the update; a history version before profile normalisation.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

## Contents

- [Status](#status)
- [Installations and update states](#installations-and-update-states)
- [Update check](#update-check)
- [When a report is made](#when-a-report-is-made)
- [Report fields](#report-fields)
- [Items](#items)
- [Reasons](#reasons)
- [Verified and unverified](#verified-and-unverified)
- [Data formats](#data-formats)
- [Applying an update](#applying-an-update)
- [Harness files across an update](#harness-files-across-an-update)
- [Health check](#health-check)
- [Rollback triggers](#rollback-triggers)
- [Rollback](#rollback)
- [Undo and restore](#undo-and-restore)
- [Values and limits](#values-and-limits)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## Installations and update states

| Installation | Id | Updates through |
| --- | --- | --- |
| The CLI home: the runtime store and the home process | `cli-home` | `delorun update`, through the update channel ([C19](c19-home-process.md)) |
| The desktop app and its Host | `desktop-host` | The desktop updater on Delorun's feed ([C2](c02-release-manifest.md#desktop-updates-and-rollback)) |

Each installation has its own profile and its own Delorun and DSH versions; updating one never switches the other. A report reads each installation's status record (installation id, Delorun version, DSH version, channel, update state, target version, time) at the path [C1](c01-home-layout.md) names. No installation writes its record, so both show as `unknown`; an absent or unreadable record shows that installation as `unknown`.

| State | Meaning |
| --- | --- |
| `current` | No newer release on the channel, or none checked yet. |
| `available` | A newer release is offered by a fresh timestamp. |
| `downloading` | The target's files are downloading. |
| `verifying` | The target's signatures, digests and log entry are being checked. |
| `reporting` | The report is being built. |
| `awaiting-confirmation` | The report is shown and waits for the person. |
| `waiting-for-chats` | Confirmed; waiting for running chats to finish, or for the person to stop them. |
| `applying` | The snapshot is written and the switch is in progress. |
| `health-check` | The target runs and the health check is in progress. |
| `rolling-back` | A rollback is restoring the snapshot and the previous release. |
| `rolled-back` | The previous release runs again after a rollback. |
| `failed` | Verification, the switch or a rollback failed; the reason is shown with `delorun recover` and safe mode. |
| `unknown` | Only for the other installation: its status record is absent or unreadable. |

The desktop app maps upstream's `DesktopUpdateState.phase` onto these: `idle` to `current`, `checking` to `current`, `available` to `available`, `downloading` to `downloading`, `verifying` to `verifying`, `ready` to `awaiting-confirmation`, `installing` to `applying`, and `error` to `failed`.

## Update check

Before any report, a running installation learns that a newer release exists through the update check ([design](../design/update-notice.md)). The check fetches the channel's `timestamp.json`, any newer root file, the channel's manifest and its release-log bundle, and verifies them as an update does, from the same launcher roots and the channel the installation recorded ([C2](c02-release-manifest.md#client-verification) steps 1 to 3 and [C18](c18-release-log.md)'s bundle check), without the online log check; it downloads no archive, writes nothing under `trust/` and sends no identifier. It runs in the CLI home's Host, which looks each hour by the wall clock, so a machine that slept is caught up at its first wake: it checks when the last check is at least the `delorun-update-check` row's `intervalHours` old, and after a failed check one hour later, then two, four and so on, never waiting longer than the interval. Each check has one deadline of `timeoutSeconds`. `delorun update --check` runs it on demand. The row's `enabled` is C16 switch `update_check` ([C16](c16-parity-composition.md)).

Each check writes `run/<profile>/update-check.json` at mode 0600, schema `delorun.update-check/1`: `checked`, the time of the check; `newest`, the newest release the last successful check verified, with its `delorun` and `dsh` versions, its `channel`, `security` (false for a manifest without the mark) `summary` when the manifest carries one and `notes` (the SHA-256 and length of the verified release notes) when the check downloaded notes that matched the manifest's `notes` reference and passed `isValidNotes`; `verified`, when `newest` was verified; `timestamp`, the version of the timestamp that named `newest`; and `failure`, why the last check failed, as one of the codes `running-release-unreadable`, `trust-state-invalid`, `unreachable`, `download-refused`, `deadline`, `unverified`, `log-bundle-invalid`, `regressed` and `internal`. The record holds the code and never the failure's own text, which can carry text the channel's host chose; the home log holds that text with its control characters escaped. A failed check keeps `newest`, `verified` and `timestamp`. A check is `regressed` when the channel's timestamp has a lower version than the record's, or its release on the same channel is lower than `newest`. A record that is laxer than mode 0600 or does not validate reads as absent. The verified notes are stored beside the record as `run/<profile>/update-notes.txt` at mode 0600, replaced by each check and removed with the record. A notes file that does not download, match or pass `isValidNotes` is dropped and the update still shows without notes. The Host serves the text on `GET /api/delorunUpdateCheck.notes` only while the file's length and SHA-256 equal the record's `notes`.

A notice exists when `newest.delorun` is newer than the running Delorun version. It states the running release, the newer release, the step by semantic version (`patch`, `minor` or `major`) and how many installed plugins of the profile the newer release would disable on either version axis, which [Items](#items)' plugin evaluation decides with no revocation list, from the profile as it is installed when the notice is read. The notice names `delorun update` and applies nothing. The terminal shows it as one line, the studio's sidebar through the Connection route `GET /api/delorunUpdateCheck.notice`, which answers `{ "notice": <notice> | null }` to the owner and refuses a remote-access device, and `delorun doctor` as its `update` line. With the switch off, the row registers no route, and the next start removes the record.

The Host also answers `GET /api/delorunUpdateCheck.channel` with `{ "host": <string or null> }`, whether or not the check is on. `host` is the host, with its port when it has one, of the channel origin that the launcher recorded in the home's `trust/channel.json`; the channel serves the timestamp, the root file, the manifest and the log record, so the check contacts no other host. It is `null` on the production channel, which contacts releases.delorun.com and GitHub. The studio uses it to name the contacted host in the release check's consent copy.

## When a report is made

A report is built for one installation and one target release, after the target's files are downloaded and verified ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md)) and staged, and before anything in the profile or the active runtime changes. A target that fails verification gets no report; the update stops. The report reads the profile and the staged target, and imports no plugin code.

## Report fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `delorun.update-report/3` | The report format. |
| `installation` | `cli-home` or `desktop-host` | The installation being updated. |
| `from`, `to` | `{ "delorun", "dsh", "channel" }` | The running and target versions ([C17](c17-plugin-versions.md#the-two-versions)). |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | The target's manifest digest and each check's result. `signature` is `passed` or `failed`: the store verifies the signature when it builds the report. `freshness` is `passed` when the signed timestamp the install verified and stored names this release, `unchecked` when the release channel could not confirm the release is current and the person agreed at a terminal to install it anyway (`delorun update --from`), and `failed` for a verifiable failure; a reader that compares it with `passed` treats `unchecked` as not passed. `log` is the state the install recorded in `trust/release-log.json` ([C18](c18-release-log.md)): `passed` for `verified`, `unchecked` when the online check did not complete or no state is recorded, `failed` for a verifiable failure. A report is made for `passed` and `unchecked`, and the report says when the log was not reached. |
| `generated` | timestamp | When the report was built. |
| `installations` | list of `{ "id", "delorun", "dsh", "state", "target"? }` | Both installations' versions and update states. |
| `items` | list of item | Everything that changes, sorted by kind, then subject. |
| `notChecked` | list of `revocations` | The sources the report did not read; the report says so instead of counting them as checked. `revocations` means the target publishes no revocation list, and the report states: `Not checked: revocations. This release publishes no revocation list; the health check after the switch holds what one would show.` |
| `counts` | `{ "disabled", "removed", "changed", "unverified", "data", "harness" }` | The number of items with each effect, of unverified items, of `data` items and of `harness` items. |

The report is stored in the snapshot's history version, so the history shows what the update was predicted to change. No release reads a stored report back, so `log`'s `unchecked` value belongs to format 2 without a new version: a report an earlier release wrote never carries it.

## Items

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `plugin`, `bundle`, `row`, `data` or `harness` | What the item is about. |
| `subject` | object | For `plugin`: `{ "name", "version" }`; for `bundle`: `{ "package" }`; for `row`: `{ "id"?, "name", "layer" }`, where `layer` names the bundle, profile patch, home patch or overlay that holds the row; for `data`: `{ "directories": ["sessions", "storages"] }`; for `harness`: `{ "file" }`, the file's path relative to the runtime's root. |
| `reason` | reason code | Why it changes ([reasons](#reasons)). |
| `effect` | `disabled`, `removed`, `changed` or `kept` | What happens to it on the target; `kept` appears only for an exempted or unverified subject the person should see. |
| `verification` | `verified` or `unverified` | Whether the prediction rests on metadata Delorun read ([verified and unverified](#verified-and-unverified)). |
| `detail` | object | The reason's facts, such as the requirement range, the axis, the revocation message, the replacement bundle, or a harness file's `merge`, `result` and `diff`. |
| `actions` | list | Offered choices: `update-plugin`, `keep-disabled`, `allow-version`, `skip-update`, `copy-session-data`, `continue-without-copy`. |

## Reasons

The report judges the target's plugins with the running release's rule, because the running release builds it: a plugin that declares `engines.delorun` is judged on that range alone ([C17](c17-plugin-versions.md)). This holds for a rollback's report too, which judges the release rolled back to by the release that rolls back.

| Reason | Kind | Effect | Message |
| --- | --- | --- | --- |
| `dsh-requirement-unmet` | plugin | disabled | `<plugin> requires DSH <range>; Delorun <to.delorun> runs DSH <to.dsh>.` |
| `delorun-requirement-unmet` | plugin | disabled | `<plugin> requires Delorun <range>; the update installs Delorun <to.delorun>.` |
| `requirement-unreadable` | plugin | disabled | `<plugin> declares engines.<axis> in a form Delorun cannot read.` |
| `requirement-exempted` | plugin | kept | `<plugin> requires <DSH or Delorun> <range>; your exemption for this exact version covers <version>.` |
| `exemption-not-carried` | plugin | disabled | `<plugin> runs today under your exemption for <from version>; the exemption does not cover <to version>.` |
| `requirement-undeclared` | plugin | kept | `<plugin> declares no DSH requirement, so its compatibility with DSH <to.dsh> is not stated.` Given only when the plugin declares none of `engines.delorun`, `engines.dsh` and a `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer: `engines.delorun` states compatibility on its own and decides alone on Delorun ([C17](c17-plugin-versions.md)). |
| `plugin-revoked` | plugin | disabled | `<plugin> is revoked: <reason>, <message>.` ([C13](c13-catalogue-revocation.md#revocation-list)) |
| `manifest-unreadable` | plugin | kept | `Delorun could not read <plugin>'s package.json; it cannot predict what the update does to it.` |
| `bundle-retired` | bundle | removed | `<bundle> is retired in DSH <to.dsh> and leaves the bundle list.` (upstream's `RETIRED_BUNDLES`) |
| `bundle-template-normalised` | bundle | changed | `The bundle list matches an installation-owned list that DSH <to.dsh> replaces with its template.` |
| `bundle-skipped` | bundle | disabled | `<bundle> cannot load on the target: <reason>.` (upstream's `skippedBundles`) |
| `row-disabled` | row | disabled | `Row <id or name> in <layer> loads <plugin>, which the update disables.`; with `detail.bundlePatch`: `Delorun <to.delorun> switches off row <id> through its bundle <bundle>; the row stays in your profile but does not run.` |
| `row-include-blocked` | row | disabled | `Include <file> reaches <plugin>, which the update disables, so the whole Include is disabled.` |
| `data-format-changed` | data | changed | `Delorun <to.delorun> keeps chat data in a format Delorun <from.delorun> may not read.` |
| `data-format-unknown` | data | changed | `Delorun cannot tell whether Delorun <from.delorun> reads the chat data Delorun <to.delorun> writes.` |
| `harness-change-carried` | harness | kept | `Your change to <file> carries over to Delorun <to.delorun>.` |
| `harness-change-merged` | harness | changed | `Your change to <file> and Delorun <to.delorun>'s change to it merge into a file neither has; read the merge before you confirm.` |
| `harness-change-conflicts` | harness | disabled | `Your change to <file> conflicts with Delorun <to.delorun>'s file; the new release's file runs, and yours is kept beside it as <file>.mine.`; for `release-changed-removed`: `You removed <file>, and Delorun <to.delorun> changed it; the new release's file runs.` |

The `bundle-skipped` items and the rows of bundle layers come from the bundle list the target would load: the template, or the profile's list without the retired bundles. Each bundle resolves from the target's install anchor first and the profile second, as upstream's profile load resolves it. The target skips a bundle that does not resolve, declares no `dsh.bundle`, lists `dsh.bundle.platforms` without this machine's platform, has a DSH requirement (`engines.dsh`, else its `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers) that the target does not meet and no exact-version exemption covers, or has an `engines.delorun` the target does not meet. The patch files a loaded bundle declares in `dsh.bundle.patch` are walked row by row, like the profile patch, and each row's `layer` is the bundle. A patch entry with an `id` and a literal `disabled: true`, or a disabled inserted row with an `id`, switches that row off; the report names every such row the target's bundle patches disable and the running release's did not (`row-disabled` with `detail.bundlePatch`, `disabled`, `verified`), so H3 accepts it. The running release's patches are read from its own runtime with the same reader. A `!!js` expression counts as not disabled.

A `harness` item is `verified` and comes from a three-way merge of the running release's signed file, the content the running runtime runs (the approved content, or for a change a failed start left out that stays out, what runs instead) and the target's signed file, read after the target's file list is verified; its `detail.merge` names the outcome. The change carries as it is (`harness-change-carried`, no action) when the target left the file as it was (`release-unchanged`) or when the target's file already equals the approved content (`in-release`). When both releases' files differ and the patch from the running release's file to the approved content applies to the target's file with no fuzz and no line-ending conversion, or only the execute bits differ, the target runs a merge of both sides that neither had (`merged`, `harness-change-merged`, action `skip-update`): the item carries `detail.diff`, the unified diff from the target's file to the merged file with `old mode` and `new mode` lines when the execute bit differs, bounded as [C21](c21-changes.md)'s diffs are (no lines of a side that is binary or larger than 1 MiB, and none of any diff once the report's merged diffs pass 256 KiB, each with `notShown` saying why), which `delorun update` prints under the item. For each file the target runs of a carried or merged change, `detail.result` holds the SHA-256 and execute bit of what it runs. Every other case conflicts (`harness-change-conflicts`, action `skip-update`): the edits overlap (`edits-overlap`), both sides changed a file that is not UTF-8 text (`binary`) or one larger than 1 MiB (`too-large`), the target removes a file the person changed (`release-removed`), the person removed a file the target changed (`release-changed-removed`), or both add the file with different content (`both-added`). A conflicted file never silently keeps either side. A rollback's report has no `harness` item, because the runtime rolled back to runs its own approved files.

For a mismatch on either version axis the report names both target versions, and its `actions` offer updating the plugin to a version that meets the target and, for the axis that is unmet, an exact-version exemption on the target version ([C17](c17-plugin-versions.md#exemptions)).

Each plugin's two axes are decided by upstream's own evaluation, the functions the plugin installer and the start's preflight call (`evaluatePluginCompatibility` and `evaluateDelorunRequirement`), with the target's DSH and Delorun versions in place of the running ones and no exemption; the report then applies the exemption files per axis. On the DSH axis `engines.dsh` decides alone when it is declared; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range must admit the target's DSH, a `workspace:` peer admitting any. An unmet peer is named in `<range>` as `<peer range> (peer <package>)`, so the report disables every plugin the next start would disable. A declaration upstream refuses to read, including a peer range that is not a string, is `requirement-unreadable`. The update check counts the plugins it would disable with the same evaluation, and `delorun plugin check` shows it for one plugin ([C17](c17-plugin-versions.md#checking-a-plugin-before-it-is-installed)).

**Rows a release changes (`row-settings-changed`, a row item, effect `changed` or `removed`).** A release's bundles can set a key on a protected row, add a protected row or drop one, and H3 holds a protected row to its previous settings. The report therefore compares the two releases' bundles: for each protected row, its keys as the bundle patches of the running release and of the target write them (the patch entries that insert the row or update it by id, merged in bundle order, top-level `config` keys only). A row is protected when the `protectedPlugins` list of either release's `plugin-manager` row names its plugin. A key whose value differs, or that only one release sets, makes a `row-settings-changed` item with `detail.settings`: `{ "change": "changed" | "added" | "removed", "keys": [{ "key", "before"?, "after"? }] }`, where a number or boolean is shown as it is and every other value as its kind and size, such as `<text, 42 chars>` or `<list, 3 items>`, `changed` and `verified`, or `removed` for a dropped row. The sentence is `Delorun <to.delorun> changes the settings of <row>: <what each key does>.`, or `Delorun <to.delorun> adds <row>, which Delorun protects.` or `Delorun <to.delorun> removes <row>, which Delorun protects.`; it names the row by its title where Delorun has one and by its id otherwise, and never shows JSON: a boolean `enabled` key reads `turns on` or `turns off`, a string or number reads `sets <key> to <value>`, and any other value reads `changes the <key> setting`. The profile's and the home's own patches are not read, because the person or an agent can write them. A row that no `protectedPlugins` entry names, such as `delorun-prompt-wording`, is not a protected-row change and is not named.

The running release builds the report, and only a running release of 0.1.0-preview.2.5 or later can name these changes. The target's health check therefore derives them again, from the signed files of both releases: it checks the previous and the running release against their signed file lists, reads each bundle's `package.json` and patch file once and hashes the bytes it parses against the signed digest (whatever the start check recorded), and resolves only the release's own bundle list, only from each release's own `app/` directory. Nothing the person, a plugin or an agent can write is an input. It accepts a protected row whose booted config differs from the previous Host's only when the row loads the same protected plugin in the previous Host, in the target and in both releases' bundles, exactly one booted row has the id, setting each changed key back to the previous release's value (or removing it where that release sets none) gives the previous Host's config hash, and the booted value of each changed key is the target's. A key the person set by hand, one more changed key, another value, another plugin behind the id, a row only one release has, or a release that does not verify, has a file that does not hash to its signed digest or whose bundle metadata cannot be read leaves H3 as it is. The sandbox row's protection is checked before any row is accepted. Known limit: a previous Host that runs an earlier release than 0.1.0-preview.2.5 does not say which rows the person's patches touched, so an explicit setting the person made equal to the previous release's value and then deleted before the update is not told from the release's own value; a previous Host of 0.1.0-preview.2.5 or later marks each protected row the profile's or the home's patch touched (`personEdited`), and the successor derives no change of such a row. The accepted changes are written to the outcome record's `rowChanges` (C19's outcome record) as sentences that name numbers and booleans and describe every other value in words, and the studio shows them with the update's outcome.

## Verified and unverified

An item is `verified` when every fact it states was read from a source Delorun checked: the installed plugin's `package.json`, the staged target's packages and the verified manifest. It is `unverified` when a fact is missing or could not be read, such as a manifest that does not parse, a row whose module cannot be resolved, a plugin that declares no requirement, or a bundle whose `package.json`, `dsh.bundle`, requirements or patch files are not in the form upstream reads, which is a `bundle-skipped` item. Unverified items are never counted as safe: the report shows "Delorun cannot predict this item" beside each, and the summary counts them. The health check treats them like named items.

## Data formats

Every runtime closure carries `data-formats.json` at its root, listed in its signed file list ([C2](c02-release-manifest.md)): `{ "schema": "delorun.data-formats/1", "persistence": <SHA-256 of upstream's docs/persistence-schema.json at the built commit>, "delorunRecords": { <record name>: <version> } }`. `delorunRecords` names each versioned record Delorun's own packages keep under the home.

The report compares the running and the target release. The chat data differs when the manifests' `dsh` versions differ, the `persistence` digests differ, or the `delorunRecords` differ; upstream's schema inventory covers the Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as a difference on its own. Any difference is one `data` item with reason `data-format-changed`, `verified`, and Delorun treats every difference as one-way. A `data-formats.json` that is missing or unreadable on either side is `data-format-unknown`, `unverified`, and is treated the same way. There is no downgrade refusal: the comparison never blocks a rollback.

A `data` item offers `copy-session-data`, the default, and `continue-without-copy`. Its detail holds the copy's file count and size and the free space on the home's filesystem, and the report states beside it: `Without the copy, Delorun cannot go back to <from.delorun> after <to.delorun> first starts.` When nothing differs no copy is offered, and `delorun update --data-copy` takes one anyway.

`delorun repair` reads the home's `data-format.json` ([C1](c01-home-layout.md)) against the release it installs, where this comparison reads two releases: a record that is newer or unordered refuses the repair with `DATA_NEWER`, and a home with a record that cannot be compared with the release (unreadable release formats, a version that is not semver) refuses it with `DATA_UNREADABLE`; only a home with no record continues. `--restore-copy` puts back the copy for the release that wrote the data, which sets today's `sessions/` and `storages/` aside through the restore below, only when the copy's formats are the release's or older (otherwise `DATA_COPY_NEWER`), and then writes the copy's facts as the home's record.

A session-data copy holds the home's `sessions/` and `storages/` as real copies (`COPYFILE_FICLONE`, falling back to a full copy), never hard links. `attachments/` stays in place because nothing deletes from it, `cache/` is left out and rebuilds, and Delorun's records under `secrets/` are never copied or restored: the previous release reads every record the current one writes. The copy is written to `data-copies/<to.delorun>/` beside `copy.json` (both releases' `data-formats.json`, the file count and the byte total) after running chats have ended and the Host has stopped, while the home lock is held, under a temporary name that is renamed and synced before the runtime switches. A copy that does not fit refuses the update with `DATA_COPY_NO_SPACE`, unless the person chose to continue without it. One copy is kept: when a later update commits, its copy replaces the older one, and the copy of an update that ended before switching is removed.

## Applying an update

1. The person confirms the report; `delorun update` prints it and asks, and `delorun update --yes` confirms a report that has no `disabled` or `removed` item, no `harness-change-merged` item, no unverified item and a `log` of `passed`. With a `data` item the person also chooses about the copy: `--yes` takes it, and declining needs `--no-data-copy` or the prompt's second choice.
2. A snapshot is written: a profile history version named "Before update to Delorun <to.delorun>", holding the profile patch, the home patch, the bundle list, both exemption files, the profile's `pnpm-workspace.yaml` and the report. The update record `run/<profile>/update.json` ([C1](c01-home-layout.md)) names the two versions, whether the data differs, whether a copy is taken and the snapshot's history version (`snapshot`).
3. Running chats finish, or the person stops them; the CLI switch goes through the home process's update handshake, which never switches under a running chat ([C19](c19-home-process.md)), and the desktop app does this in its pre-restart step. With the Host stopped and the home lock held, the session-data copy is written when the person chose it.
4. The update record's `targetStarted` is written and synced, then the target starts and the health check runs.

## Harness files across an update

An update refuses with [C19](c19-home-process.md)'s `HARNESS_CHANGES_PENDING` while changes to the running runtime's harness wait for review in its writable copy: at `update.prepare` before anything is fetched, and again right before the switch. The person applies or discards them first, so an update never leaves a change behind unseen. When the copy cannot be scanned, because it passes the scan's limits, an entry cannot be read or a file changed while it was read, the update refuses at the same two points with `HARNESS_COPY_UNREADABLE`, naming what failed and the commands that clear it: `delorun changes edit-harness --discard`, or fixing the copy and `delorun changes list`.

Right before the switch, after the session-data copy and under the harness's lock, which the runtime switch runs inside, the home process plans the merge again against the target's verified files and compares it with the `harness` items of the report the person confirmed, which it kept from `update.prepare`; it reads nothing of the report from the client. A file in one and not the other, another `merge`, or another `result` refuses the update with `HARNESS_REPORT_STALE`, which names the files and tells the person to run `delorun update` again; nothing is written for the target and the update ends `aborted` with the Host running again. Otherwise it writes the target runtime's harness files ([C21](c21-changes.md#harness-edits)). Whatever an earlier install left under `changes/harness/<to>/` is removed first, never merged into. Each carried file becomes an approved file of the target whose `signed` is the target's file, logged as an applied `harness-edit` of the target runtime with `decidedFrom: "update"`; a file the target already holds needs nothing. A conflicted file runs the target's file: when the running runtime has a writable copy, or any file conflicts, the target gets a writable copy, and each conflicted file the person changed is kept in it as `<file>.mine`, which is never a change; a file the person removed has nothing to keep. When anything fails before the switch, what was written for the target is removed, the update ends `aborted` and the Host runs again. The running runtime's record, copy and log entries are never written, so a rollback to it runs its approved files again. The target's composed tree is built by its first start, whose signed entry hands off to it with the handover descriptor ([C21](c21-changes.md#harness-edits)), so the health check covers the files it runs.

## Health check

The update stands when all of these hold within 120 seconds after the target starts:

- H1. The target's runtime files verify against its manifest; the release-log state is not read ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md#check-states)).
- H2. The Host reaches ready: for `cli-home`, the home process's Host is ready and its loopback listener answers `GET /delorun/health`, a route that answers only a request from this computer to that listener under a loopback `Host` and any other with 421, with status 204 (a listener bound to every address is asked at `127.0.0.1`), which the route answers when the Host reads the studio's index in-process as the owner's browser with status 200; the route reads no cookie and returns no content, so the studio's sign-in, which answers every page and API without a session cookie with 401, stays in force; for `desktop-host`, the Host reports ready over the host protocol and the main window loads the studio.
- H3. Every plugin, bundle and row the target disabled, skipped or removed is one the report named, and so is every row of a plugin the CLI profile protects whose settings changed, unless the signed bundles of the two releases bring exactly that change (rows a release changes, under Reasons); the report names a change before the update only when the running release builds it that way, so a release that adds a protected row's setting is accepted at its first start from an earlier release and named in the outcome record. The sandbox row's protection is compared on its own, and no report excuses a weaker one: the target's row must protect the same home, deny every socket and hide every escape directory the previous Host's row did, and let confined commands read no entry of the home the previous row did not, so a release may tighten the protection but not loosen it. The sockets a start finds on the computer, the Docker context's socket with its real path and Docker Desktop's sockets, are left out of the previous Host's protection unless a layer of the profile lists them, because the next start may find others; a rollback's target is not held to the protection of the release it replaces; the protected home, its read exemptions, the home's own sockets and the escape directories are fixed by the release and the home.
- H4. Every row the report did not name loads without a plugin load error, except a row whose load error the previous release also recorded.
- H5. The profile's bundle list equals the list the report predicted.

## Rollback triggers

Automatic rollback runs when:

- T1. any health criterion fails;
- T2. the health check has not finished 120 seconds after the target starts;
- T3. the target's Host process exits during the health check.

On request, the person rolls back at any later time with `delorun recover rollback`. The studio has no update screen, and the desktop app has no Delorun rollback.

The studio's Go back sends the same request as `delorun recover rollback`, and its wording is this table's. A rollback restores the snapshot's files and switches the installation back to the release it replaced: for `cli-home`, the runtime the store keeps ([C1](c01-home-layout.md)); for `desktop-host`, the cached previous release ([C2](c02-release-manifest.md#desktop-updates-and-rollback)), which is not built. After an automatic rollback `delorun update` names the criterion that failed. A rollback that fails leaves the state `failed` and offers safe mode and `delorun recover`.

## Rollback

Every way back for `cli-home` reads the update record and applies one table: the handshake's `rollback`, the automatic rollback, the restart after an interrupted update and `delorun recover rollback` with no home process running. None swaps the runtime pointers on its own. A rollback that is not profile-only refuses while another process uses the chat data, another profile's home process included, and `delorun recover rollback` with no home process running registers as an exclusive user of the chat data before it checks, so no home process starts while it runs ([C19](c19-home-process.md)). A copy counts as present only when the record says a copy was taken and the copy is no older than the update. Before anything changes, the version rolled back to must be installed and pass its start check; then the record is marked `rolling-back`, and the data, the profile and the runtime follow in that order. A start or `delorun recover` that finds a `rolling-back` record completes it, and the record goes only after the version rolled back to has started healthy. After an automatic rollback the table refused, no start runs the new release unasked: the person chooses with `delorun recover rollback --profile-only` or safe mode.

| Data differs | Target started | Copy | Rollback does |
| --- | --- | --- | --- |
| no | either | — | Restores the profile snapshot and switches to the previous runtime. Chats written since stay. |
| yes | no | either | The same; the target never opened the data. |
| yes | yes | present | States how many chats were created or changed since the update and that they are set aside, not deleted. Moves the live `sessions/` and `storages/` to `data-set-aside/<to.delorun>-<time>/`, moves the copy into place, restores the snapshot and switches the runtime. |
| yes | yes | absent | Refuses with `ROLLBACK_NEEDS_DATA_COPY` and the reason, and offers `delorun recover rollback --profile-only`, which restores the snapshot and keeps the target runtime. |

Nothing is deleted by a rollback: set-aside data stays until the person removes it, and `delorun recover status` lists it with its size. `delorun recover discard` takes the home lock and refuses while a restore or a rollback runs and for a copy an update record still refers to. `delorun headless` registers as a user of the chat data, refuses while an update, a rollback or a restore is in progress, and makes an update, a copy, a restore or a rollback refuse while it runs. The restore writes the journal `data-copies/restore.json` before its first rename, and each step is one directory rename; `delorun start` and `delorun recover` complete a restore in progress before any Host starts.

This procedure holds for `cli-home`, the only installation that applies it. The desktop Host shares `sessions/` and takes no home lock, so it is not shipped until a lock covers both installations and its updater uses this procedure.

## Undo and restore

Undo (restore the version before the latest) and restore (any history version) bring back profile files, and with them plugin versions, build approvals and exemptions. `delorun recover restore <version>` plans the restore, writes the files the plan lists at once, and prints what changed after it applied; it runs none of the checks below, shows no prompt, and passes no revocation list. A restore that fails partway leaves the profile partly restored and reports it as a failed restore. The requirement is that, before writing anything, each:

- runs the checks an install runs over every plugin version it brings back: both version axes ([C17](c17-plugin-versions.md)), the revocation list ([C13](c13-catalogue-revocation.md)), the integrity pins, pnpm's build approvals, and the `pluginAudit` service where one is mounted, whose findings render as [C13](c13-catalogue-revocation.md#listed-findings) states; Delorun itself runs no plugin audit;
- shows an approval prompt listing the plugins that change (added, removed or another version), the builds that change (pnpm `allowBuilds` entries the restored version allows, denies or leaves pending) and the exemptions that change (grants added to or removed from `compatibility.json` and `delorun-compatibility.json`);
- applies only after the person approves, and writes the result as a new history version.

A plugin version the current revocation list revokes is restored disabled with its reason. While the list is stale, an undo or restore that would install a plugin version the profile does not have waits for a fresh list, as a new catalogue install does ([C13](c13-catalogue-revocation.md#stale-state)). A restore whose install step fails reverts every file it wrote. No revocation list exists, and none of this paragraph is built.

## Values and limits

| Value | Number |
| --- | --- |
| Health-check limit | 120 seconds after the target starts |
| Status records read per report | 2, one per installation |
| Session-data copies kept | 1 |
| Update check interval | 24 hours by default, from 1 to 480 |
| Update check deadline | 15 seconds by default, from 1 to 120 |

## Consumers

- `delorun/packages/update/`: builds the report.
- Upstream's `compatibility-preflight.ts`, `profile.ts`, `profile-sanitize.ts` and the plugin manager's restore: no silent disable, history versions before normalisation and sanitising, transactional restore.
- `delorun/packages/profile-safety/`: undo, restore, safe mode and `delorun recover`.
- The studio's update screens and the desktop updater.

## Compatibility

The report's `schema` names its major version; reason codes form a closed list in that version, and a new reason is a new major version, so a reader never meets a code it does not know. Release 0.1.0-preview.2.5 adds the reason `row-settings-changed` and `detail.settings` to format 3 because no existing reason states a change of settings: a reader from an earlier release that meets it names the row with its plugin sentence, and every item it does know is unchanged. Formats 1 and 2 are retired: no Delorun release wrote either, so no reader of them ships. Releases 0.1.0-rc.1 to rc.3 wrote format 3, so its reason list is closed; a change since then adds only optional `detail` fields (`bundlePatch`) that readers of format 3 ignore, and a release that needs a new reason writes format 4 with a reader for 3. The required changes to upstream's own startup behaviour are that an incompatible plugin at startup is reported with Update, Keep disabled and Roll back instead of being disabled with one line on standard error, that the desktop's fatal-recovery "Disable third-party plugins" writes a history version and offers "Restore profile from before the update", and that profile normalisation writes a history version first; none of the three is built, and normalisation rewrites the bundle list without a history version.

## Security

### Requirements

- R1. No update disables, removes or changes a plugin, bundle or row the report did not name; the health check enforces it and rolls back otherwise.
- R2. Nothing applies before the person confirms the report, and a report exists only for a target that passed the signature check and whose freshness and log checks did not fail; a freshness or log check that did not complete is shown as `unchecked`, `--yes` does not confirm it, and the studio asks for a tick for each.
- R3. Unverified items are shown as such and never counted as safe.
- R4. A failed health check rolls back automatically; the person can roll back at any later time; a rollback changes the profile and the runtime store, and chat data only by restoring a copy the person took, with the newer data set aside.
- R5. Undo and restore run the install-time plugin checks over what they bring back and list the plugins, builds and exemptions that change before applying.
- R6. Both installations' versions and update states are shown, and updating one never switches the other.
- R7. No update whose data differs applies before the person has seen the `data` item and chosen about the copy.
- R8. No rollback deletes chat data.
- R9. The update check sends nothing about the person or the profile, shows only a release whose signed metadata verified, applies nothing, never delays a start, and does not run while its switch is off.

### Denial tests

| Test | Component | Behaviour it shows |
| --- | --- | --- |
| `c03-unnamed-disable-rolls-back` | `update`, plugin manager | A target that disables a plugin the report did not name fails H3 and rolls back to the previous release and snapshot. |
| `c03-health-timeout-rolls-back` | `update` | A target whose Host is not ready 120 seconds after start rolls back. |
| `c03-unverified-metadata-shown` | `update` | A plugin whose `package.json` does not parse appears as `manifest-unreadable` and `unverified`, and `--yes` does not confirm the report. |
| `c03-yes-refuses-unchecked-log` | release-chain | A report whose `log` is `unchecked`, as the install recorded it, shows that state and the line that the log was not reached; `--yes` refuses it and nothing applies. |
| `c03-delorun-requirement-excludes-target` | `update` | A plugin whose `engines.delorun` excludes the target appears as `delorun-requirement-unmet` with both target versions. |
| `c03-no-report-for-unverified-target` | `update` | A target whose manifest signature fails produces no report and the update stops. |
| `c03-no-silent-disable-at-start` | plugin manager | An incompatible plugin at startup is reported with Update, Keep disabled and Roll back. |
| `c03-sanitize-writes-history` | plugin manager | Desktop fatal recovery writes a history version before disabling third-party plugins. |
| `c03-restore-lists-changes` | `profile-safety` | Restoring a version that brings back a plugin, a build approval and an exemption shows all three in the approval prompt before any file changes. |
| `c03-restore-revoked-stays-disabled` | `profile-safety` | Restoring a version that holds a revoked plugin version brings it back disabled with its reason. |
| `c03-failed-restore-reverts` | plugin manager | A restore whose install step fails leaves every profile file as it was. |
| `c03-desktop-update-leaves-cli` | `update`, desktop updater | Updating the desktop Host leaves the CLI home's version and state unchanged, and both appear in the report. |
| `c03-data-change-named` | update | Two releases whose data facts differ produce one `data-format-changed` item with the copy's size and the free space. |
| `c03-unknown-data-format-is-unverified` | update | A release without `data-formats.json` produces `data-format-unknown`, `unverified`, and `--yes` does not confirm the report. |
| `c03-yes-takes-the-copy` | update | `delorun update --yes` on a report with a `data` item takes the session-data copy. |
| `c03-copy-without-space-refuses` | update | A copy larger than the free space refuses the update with `DATA_COPY_NO_SPACE`, and the runtime stays. |
| `c03-rollback-restores-copy-and-sets-aside` | update | A rollback after the target started restores the copy and moves the newer data to `data-set-aside/`. |
| `c03-rollback-without-copy-refuses` | update | A rollback after the target started with changed data and no copy refuses with `ROLLBACK_NEEDS_DATA_COPY`, and `--profile-only` restores the snapshot and keeps the target. |
| `c03-rollback-before-first-start-needs-no-copy` | update | A rollback before the target started restores the snapshot and the runtime without a copy and leaves the data. |
| `c03-pointer-swap-applies-the-table` | update | `delorun recover rollback` with no home process running applies the table; it never swaps the pointers alone. |
| `c03-second-rollback-keeps-both-set-asides` | update | Two update-and-rollback rounds leave two set-aside directories. |
| `c03-interrupted-restore-completes-before-a-host-starts` | update | A restore killed between its renames is completed at the next start before the Host boots. |
| `c03-peer-requirement-excludes-target` | update-notice | A plugin that states its DSH range only through peers, one of which excludes the target, is `dsh-requirement-unmet` and disabled, with the requirement upstream's preflight reports for it. |
| `update-notice-sends-no-identifier` | update-notice | Every request of a check is a bare `GET` of a channel file with no query, cookie, body, profile, plugin or running version. |
| `update-notice-unverified-index-silent` | update-notice | A timestamp or manifest that does not verify records the failure and keeps the last verified release. |
| `update-notice-replayed-timestamp-refused` | update-notice | A timestamp older than the stored one is refused. |
| `update-notice-writes-no-trust-state` | update-notice | A check leaves `trust/` as it was and runs no online log check. |
| `update-notice-deadline` | update-notice | A host that never answers ends the check at its deadline. |
| `update-notice-regressed` | update-notice | A timestamp older than the record's, or a lower release on the same channel, records `regressed` and keeps the release verified before. |
| `update-notice-hostile-text` | update-notice | Text the host puts in an unsigned field reaches neither the record nor `delorun doctor`, and the home log holds it escaped. |
| `update-notice-manifest-length-capped` | update-notice | A timestamp that states a manifest above its size limit is refused before the manifest is fetched. |
| `update-notice-retries-after-failure` | update-notice | A failed check is tried again after one hour, then two and four, never later than the interval. |
| `update-notice-wall-clock` | update-notice | A machine that slept past the interval checks at its first hourly wake. |
| `update-notice-running-release-retried` | update-notice | The running release's files are read again after a read that failed. |
| `update-notice-record-unremovable` | update-notice | A record that cannot be removed is logged and the start goes on. |
| `update-report-applies-nothing` | update | `delorun update --report` prints the report, asks nothing and applies nothing. |
| `update-notice-off-makes-no-request` | update-notice | With the switch off the row mounts no service and no route. |
| `update-notice-remote-session-offers-no-action` | update-notice | A remote session's notice offers no control. |
| `c03-harness-change-carried` | update | A change to a harness file the target did not change is one `harness-change-carried` item, `kept` and `verified`, stating the SHA-256 of what the target runs, and `--yes` still confirms the report; applying the update writes the target's record with the carried file and an applied log entry decided at `update`, and a rollback runs the previous runtime's own record again (`harness-items.spec.ts`, `harness-update.integration.spec.ts`, `update.e2e.integration.spec.ts`). |
| `c03-harness-change-merged` | update | A change to a harness file the target changed without overlapping it is one `harness-change-merged` item, `changed` and `verified`, offering `skip-update`, with the diff from the target's file to the merged file; `delorun update` prints the diff and `--yes` does not confirm the report (`harness-items.spec.ts` in `@delorun/update` and in the CLI, `command.spec.ts`, `harness-merge.spec.ts`). |
| `c03-harness-report-stale` | update | An apply whose merge under the harness lock differs from the confirmed report's `harness` items, by file, `merge` or `result`, refuses with `HARNESS_REPORT_STALE` before anything is written or switched; the home process hands the carry the report it kept (`harness-carry.integration.spec.ts`, `harness-update.integration.spec.ts`, `handshake.integration.spec.ts`). |
| `c03-harness-conflict-keeps-mine` | update | A harness file whose change conflicts with the target's is one `harness-change-conflicts` item, `disabled`, offering `skip-update`, and `--yes` does not confirm the report; applying the update runs the target's file and writes the person's content beside it as `<file>.mine` in the target's writable copy (`harness-items.spec.ts`, `command.spec.ts`, `harness-update.integration.spec.ts`). |
| `c03-previous-release-reads-delorun-records` | update | Every record `delorunRecords` names is written at the version listed, and the update record a release writes is read back by the same reader. |
