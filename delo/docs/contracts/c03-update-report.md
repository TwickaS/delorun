---
description: "Contract C3: the update report shown before a Delo update applies, its items (plugin, bundle, row, reason, verified or unverified) and reason codes, the versions and update states of the CLI home and the desktop Host, the health-check criteria, the rollback triggers, and the checks and approval prompt of undo and restore."
---

# C3 Update report

English | [中文](c03-update-report.zh.md)

## Summary

Before an update applies, Delo shows what the target release would change or break in the person's profile: every plugin, bundle and profile row it would disable, remove or change, with the reason and whether the prediction rests on metadata Delo could read (verified) or not (unverified). Nothing applies until the person confirms. The CLI home and the desktop Host are separate installations that update independently, and the report shows the versions and update states of both. After the switch, a health check decides within 120 seconds whether the update stands; a failed check rolls back automatically, and the person can roll back at any later time. Undo and restore of profile history run the same plugin checks an install runs and list what they change before they apply. The types live in [`@delo/contract-update-report`](../../packages/contract-update-report/README.md).

## Status

The CLI home's update and rollback are built and reached by `delorun update` and `delorun recover`; the studio's and the desktop app's are not, and undo and restore run without their checks and approval prompt.

- **Built and reached:** `delorun update` builds the report against the newest release on the channel, applies nothing until the person confirms (`--yes` confirms only a report with no `disabled`, `removed` or unverified item), writes the snapshot, waits for running chats while the CLI profile's update gate refuses new turns, takes the session-data copy, runs H1 to H5 within 120 seconds and rolls back automatically when one fails. `delorun recover` rolls back through the one table, restores a profile history version, enters and leaves safe mode and discards set-aside data. The [update check](#update-check) runs in the Host of a CLI home that runs from the store, writes its record and serves the notice to the terminal, the studio's sidebar and `delorun doctor`.
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
| The desktop app and its Host | `desktop-host` | The desktop updater on Delo's feed ([C2](c02-release-manifest.md#desktop-updates-and-rollback)) |

Each installation has its own profile and its own Delo and DSH versions; updating one never switches the other. A report reads each installation's status record (installation id, Delo version, DSH version, channel, update state, target version, time) at the path [C1](c01-home-layout.md) names. No installation writes its record, so both show as `unknown`; an absent or unreadable record shows that installation as `unknown`.

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

Before any report, a running installation learns that a newer release exists through the update check ([design](../design/update-notice.md)). The check fetches the channel's `timestamp.json`, any newer root file, the channel's manifest and its release-log bundle, and verifies them as an update does, from the same launcher roots and the channel the installation recorded ([C2](c02-release-manifest.md#client-verification) steps 1 to 3 and [C18](c18-release-log.md)'s bundle check), without the online log check; it downloads no archive, writes nothing under `trust/` and sends no identifier. It runs in the CLI home's Host, which looks each hour by the wall clock, so a machine that slept is caught up at its first wake: it checks when the last check is at least the `delo-update-check` row's `intervalHours` old, and after a failed check one hour later, then two, four and so on, never waiting longer than the interval. Each check has one deadline of `timeoutSeconds`. `delorun update --check` runs it on demand. The row's `enabled` is C16 switch `update_check` ([C16](c16-parity-composition.md)).

Each check writes `run/<profile>/update-check.json` at mode 0600, schema `delo.update-check/1`: `checked`, the time of the check; `newest`, the newest release the last successful check verified, with its `delo` and `dsh` versions, its `channel`, `security` (false for a manifest without the mark) and `summary` when the manifest carries one; `verified`, when `newest` was verified; `timestamp`, the version of the timestamp that named `newest`; and `failure`, why the last check failed, as one of the codes `running-release-unreadable`, `trust-state-invalid`, `unreachable`, `download-refused`, `deadline`, `unverified`, `log-bundle-invalid`, `regressed` and `internal`. The record holds the code and never the failure's own text, which can carry text the channel's host chose; the home log holds that text with its control characters escaped. A failed check keeps `newest`, `verified` and `timestamp`. A check is `regressed` when the channel's timestamp has a lower version than the record's, or its release on the same channel is lower than `newest`. A record that is laxer than mode 0600 or does not validate reads as absent.

A notice exists when `newest.delo` is newer than the running Delo version. It states the running release, the newer release, the step by semantic version (`patch`, `minor` or `major`) and how many installed plugins of the profile the newer release would disable on either version axis, which [Items](#items)' plugin evaluation decides with no revocation list, from the profile as it is installed when the notice is read. The notice names `delorun update` and applies nothing. The terminal shows it as one line, the studio's sidebar through the Connection route `GET /api/deloUpdateCheck.notice`, which answers `{ "notice": <notice> | null }`, and `delorun doctor` as its `update` line. With the switch off, the row registers no route, and the next start removes the record.

## When a report is made

A report is built for one installation and one target release, after the target's files are downloaded and verified ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md)) and staged, and before anything in the profile or the active runtime changes. A target that fails verification gets no report; the update stops. The report reads the profile and the staged target, and imports no plugin code.

## Report fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `delo.update-report/2` | The report format. |
| `installation` | `cli-home` or `desktop-host` | The installation being updated. |
| `from`, `to` | `{ "delo", "dsh", "channel" }` | The running and target versions ([C17](c17-plugin-versions.md#the-two-versions)). |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | The target's manifest digest and each check's result. `delorun update` sets all three to `passed`: the store verifies the signature when it builds the report, and the install verified freshness and the release log before the files landed. A release-log check that could not complete at install, and so recorded `unchecked`, is still reported `passed` here. |
| `generated` | timestamp | When the report was built. |
| `installations` | list of `{ "id", "delo", "dsh", "state", "target"? }` | Both installations' versions and update states. |
| `items` | list of item | Everything that changes, sorted by kind, then subject. |
| `notChecked` | list of `revocations` | The sources the report did not read; the report says so instead of counting them as checked. `revocations` means the target publishes no revocation list, and the report states: `Not checked: revocations. This release publishes no revocation list; the health check after the switch holds what one would show.` |
| `counts` | `{ "disabled", "removed", "changed", "unverified", "data" }` | The number of items with each effect, of unverified items and of `data` items. |

The report is stored in the snapshot's history version, so the history shows what the update was predicted to change.

## Items

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `plugin`, `bundle`, `row` or `data` | What the item is about. |
| `subject` | object | For `plugin`: `{ "name", "version" }`; for `bundle`: `{ "package" }`; for `row`: `{ "id"?, "name", "layer" }`, where `layer` names the bundle, profile patch, home patch or overlay that holds the row; for `data`: `{ "directories": ["sessions", "storages"] }`. |
| `reason` | reason code | Why it changes ([reasons](#reasons)). |
| `effect` | `disabled`, `removed`, `changed` or `kept` | What happens to it on the target; `kept` appears only for an exempted or unverified subject the person should see. |
| `verification` | `verified` or `unverified` | Whether the prediction rests on metadata Delo read ([verified and unverified](#verified-and-unverified)). |
| `detail` | object | The reason's facts, such as the requirement range, the axis, the revocation message or the replacement bundle. |
| `actions` | list | Offered choices: `update-plugin`, `keep-disabled`, `allow-version`, `skip-update`, `copy-session-data`, `continue-without-copy`. |

## Reasons

| Reason | Kind | Effect | Message |
| --- | --- | --- | --- |
| `dsh-requirement-unmet` | plugin | disabled | `<plugin> requires DSH <range>; Delo <to.delo> runs DSH <to.dsh>.` |
| `delo-requirement-unmet` | plugin | disabled | `<plugin> requires Delo <range>; the update installs Delo <to.delo>.` |
| `requirement-unreadable` | plugin | disabled | `<plugin> declares engines.<axis> in a form Delo cannot read.` |
| `requirement-exempted` | plugin | kept | `<plugin> requires <DSH or Delo> <range>; your exemption for this exact version covers <version>.` |
| `exemption-not-carried` | plugin | disabled | `<plugin> runs today under your exemption for <from version>; the exemption does not cover <to version>.` |
| `requirement-undeclared` | plugin | kept | `<plugin> declares no DSH requirement, so its compatibility with DSH <to.dsh> is not stated.` Given only when the plugin declares neither `engines.dsh` nor a `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer. |
| `plugin-revoked` | plugin | disabled | `<plugin> is revoked: <reason>, <message>.` ([C13](c13-catalogue-revocation.md#revocation-list)) |
| `manifest-unreadable` | plugin | kept | `Delo could not read <plugin>'s package.json; it cannot predict what the update does to it.` |
| `bundle-retired` | bundle | removed | `<bundle> is retired in DSH <to.dsh> and leaves the bundle list.` (upstream's `RETIRED_BUNDLES`) |
| `bundle-template-normalised` | bundle | changed | `The bundle list matches an installation-owned list that DSH <to.dsh> replaces with its template.` |
| `bundle-skipped` | bundle | disabled | `<bundle> cannot load on the target: <reason>.` (upstream's `skippedBundles`) |
| `row-disabled` | row | disabled | `Row <id or name> in <layer> loads <plugin>, which the update disables.` |
| `row-include-blocked` | row | disabled | `Include <file> reaches <plugin>, which the update disables, so the whole Include is disabled.` |
| `data-format-changed` | data | changed | `Delo <to.delo> keeps chat data in a format Delo <from.delo> may not read.` |
| `data-format-unknown` | data | changed | `Delo cannot tell whether Delo <from.delo> reads the chat data Delo <to.delo> writes.` |

The `bundle-skipped` items and the rows of bundle layers come from the bundle list the target would load: the template, or the profile's list without the retired bundles. Each bundle resolves from the target's install anchor first and the profile second, as upstream's profile load resolves it. The target skips a bundle that does not resolve, declares no `dsh.bundle`, lists `dsh.bundle.platforms` without this machine's platform, has a DSH requirement (`engines.dsh`, else its `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers) that the target does not meet and no exact-version exemption covers, or has an `engines.delo` the target does not meet. The patch files a loaded bundle declares in `dsh.bundle.patch` are walked row by row, like the profile patch, and each row's `layer` is the bundle.

For a mismatch on either version axis the report names both target versions, and its `actions` offer updating the plugin to a version that meets the target and, for the axis that is unmet, an exact-version exemption on the target version ([C17](c17-plugin-versions.md#exemptions)).

Each plugin's two axes are decided by upstream's own evaluation, the functions the plugin installer and the start's preflight call (`evaluatePluginCompatibility` and `evaluateDeloRequirement`), with the target's DSH and Delo versions in place of the running ones and no exemption; the report then applies the exemption files per axis. On the DSH axis `engines.dsh` decides alone when it is declared; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range must admit the target's DSH, a `workspace:` peer admitting any. An unmet peer is named in `<range>` as `<peer range> (peer <package>)`, so the report disables every plugin the next start would disable. A declaration upstream refuses to read, including a peer range that is not a string, is `requirement-unreadable`. The update check counts the plugins it would disable with the same evaluation, and `delorun plugin check` shows it for one plugin ([C17](c17-plugin-versions.md#checking-a-plugin-before-it-is-installed)).

## Verified and unverified

An item is `verified` when every fact it states was read from a source Delo checked: the installed plugin's `package.json`, the staged target's packages and the verified manifest. It is `unverified` when a fact is missing or could not be read, such as a manifest that does not parse, a row whose module cannot be resolved, a plugin that declares no requirement, or a bundle whose `package.json`, `dsh.bundle`, requirements or patch files are not in the form upstream reads, which is a `bundle-skipped` item. Unverified items are never counted as safe: the report shows "Delo cannot predict this item" beside each, and the summary counts them. The health check treats them like named items.

## Data formats

Every runtime closure carries `data-formats.json` at its root, listed in its signed file list ([C2](c02-release-manifest.md)): `{ "schema": "delo.data-formats/1", "persistence": <SHA-256 of upstream's docs/persistence-schema.json at the built commit>, "deloRecords": { <record name>: <version> } }`. `deloRecords` names each versioned record Delo's own packages keep under the home.

The report compares the running and the target release. The chat data differs when the manifests' `dsh` versions differ, the `persistence` digests differ, or the `deloRecords` differ; upstream's schema inventory covers the Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as a difference on its own. Any difference is one `data` item with reason `data-format-changed`, `verified`, and Delo treats every difference as one-way. A `data-formats.json` that is missing or unreadable on either side is `data-format-unknown`, `unverified`, and is treated the same way. There is no downgrade refusal: the comparison never blocks a rollback.

A `data` item offers `copy-session-data`, the default, and `continue-without-copy`. Its detail holds the copy's file count and size and the free space on the home's filesystem, and the report states beside it: `Without the copy, Delo cannot go back to <from.delo> after <to.delo> first starts.` When nothing differs no copy is offered, and `delorun update --data-copy` takes one anyway.

A session-data copy holds the home's `sessions/` and `storages/` as real copies (`COPYFILE_FICLONE`, falling back to a full copy), never hard links. `attachments/` stays in place because nothing deletes from it, `cache/` is left out and rebuilds, and Delo's records under `secrets/` are never copied or restored: the previous release reads every record the current one writes. The copy is written to `data-copies/<to.delo>/` beside `copy.json` (both releases' `data-formats.json`, the file count and the byte total) after running chats have ended and the Host has stopped, while the home lock is held, under a temporary name that is renamed and synced before the runtime switches. A copy that does not fit refuses the update with `DATA_COPY_NO_SPACE`, unless the person chose to continue without it. One copy is kept: when a later update commits, its copy replaces the older one, and the copy of an update that ended before switching is removed.

## Applying an update

1. The person confirms the report; `delorun update` prints it and asks, and `delorun update --yes` confirms a report that has no `disabled` or `removed` item and no unverified item. With a `data` item the person also chooses about the copy: `--yes` takes it, and declining needs `--no-data-copy` or the prompt's second choice.
2. A snapshot is written: a profile history version named "Before update to Delo <to.delo>", holding the profile patch, the home patch, the bundle list, both exemption files, the profile's `pnpm-workspace.yaml` and the report. The update record `run/<profile>/update.json` ([C1](c01-home-layout.md)) names the two versions, whether the data differs, whether a copy is taken and the snapshot's history version (`snapshot`).
3. Running chats finish, or the person stops them; the CLI switch goes through the home process's update handshake, which never switches under a running chat ([C19](c19-home-process.md)), and the desktop app does this in its pre-restart step. With the Host stopped and the home lock held, the session-data copy is written when the person chose it.
4. The update record's `targetStarted` is written and synced, then the target starts and the health check runs.

## Health check

The update stands when all of these hold within 120 seconds after the target starts:

- H1. The target's runtime files verify against its manifest; the release-log state is not read ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md#check-states)).
- H2. The Host reaches ready: for `cli-home`, the home process's Host is ready and its loopback listener answers `GET /delo/health`, a route that answers only a request from this computer to that listener under a loopback `Host` and any other with 421, with status 204 (a listener bound to every address is asked at `127.0.0.1`), which the route answers when the Host reads the studio's index in-process as the owner's browser with status 200; the route reads no cookie and returns no content, so the studio's sign-in, which answers every page and API without a session cookie with 401, stays in force; for `desktop-host`, the Host reports ready over the host protocol and the main window loads the studio.
- H3. Every plugin, bundle and row the target disabled, skipped or removed is one the report named.
- H4. Every row the report did not name loads without a plugin load error, except a row whose load error the previous release also recorded.
- H5. The profile's bundle list equals the list the report predicted.

## Rollback triggers

Automatic rollback runs when:

- T1. any health criterion fails;
- T2. the health check has not finished 120 seconds after the target starts;
- T3. the target's Host process exits during the health check.

On request, the person rolls back at any later time with `delorun recover rollback`. The studio has no update screen, and the desktop app has no Delo rollback.

A rollback restores the snapshot's files and switches the installation back to the release it replaced: for `cli-home`, the runtime the store keeps ([C1](c01-home-layout.md)); for `desktop-host`, the cached previous release ([C2](c02-release-manifest.md#desktop-updates-and-rollback)), which is not built. After an automatic rollback `delorun update` names the criterion that failed. A rollback that fails leaves the state `failed` and offers safe mode and `delorun recover`.

## Rollback

Every way back for `cli-home` reads the update record and applies one table: the handshake's `rollback`, the automatic rollback, the restart after an interrupted update and `delorun recover rollback` with no home process running. None swaps the runtime pointers on its own. A rollback that is not profile-only refuses while another process uses the chat data, another profile's home process included, and `delorun recover rollback` with no home process running registers as an exclusive user of the chat data before it checks, so no home process starts while it runs ([C19](c19-home-process.md)). A copy counts as present only when the record says a copy was taken and the copy is no older than the update. Before anything changes, the version rolled back to must be installed and pass its start check; then the record is marked `rolling-back`, and the data, the profile and the runtime follow in that order. A start or `delorun recover` that finds a `rolling-back` record completes it, and the record goes only after the version rolled back to has started healthy. After an automatic rollback the table refused, no start runs the new release unasked: the person chooses with `delorun recover rollback --profile-only` or safe mode.

| Data differs | Target started | Copy | Rollback does |
| --- | --- | --- | --- |
| no | either | — | Restores the profile snapshot and switches to the previous runtime. Chats written since stay. |
| yes | no | either | The same; the target never opened the data. |
| yes | yes | present | States how many chats were created or changed since the update and that they are set aside, not deleted. Moves the live `sessions/` and `storages/` to `data-set-aside/<to.delo>-<time>/`, moves the copy into place, restores the snapshot and switches the runtime. |
| yes | yes | absent | Refuses with `ROLLBACK_NEEDS_DATA_COPY` and the reason, and offers `delorun recover rollback --profile-only`, which restores the snapshot and keeps the target runtime. |

Nothing is deleted by a rollback: set-aside data stays until the person removes it, and `delorun recover status` lists it with its size. `delorun recover discard` takes the home lock and refuses while a restore or a rollback runs and for a copy an update record still refers to. `delorun headless` registers as a user of the chat data, refuses while an update, a rollback or a restore is in progress, and makes an update, a copy, a restore or a rollback refuse while it runs. The restore writes the journal `data-copies/restore.json` before its first rename, and each step is one directory rename; `delorun start` and `delorun recover` complete a restore in progress before any Host starts.

This procedure holds for `cli-home`, the only installation that applies it. The desktop Host shares `sessions/` and takes no home lock, so it is not shipped until a lock covers both installations and its updater uses this procedure.

## Undo and restore

Undo (restore the version before the latest) and restore (any history version) bring back profile files, and with them plugin versions, build approvals and exemptions. `delorun recover restore <version>` plans the restore, writes the files the plan lists at once, and prints what changed after it applied; it runs none of the checks below, shows no prompt, and passes no revocation list. A restore that fails partway leaves the profile partly restored and reports it as a failed restore. The requirement is that, before writing anything, each:

- runs the checks an install runs over every plugin version it brings back: both version axes ([C17](c17-plugin-versions.md)), the revocation list ([C13](c13-catalogue-revocation.md)), the integrity pins, pnpm's build approvals, and the `pluginAudit` service where one is mounted, whose findings render as [C13](c13-catalogue-revocation.md#listed-findings) states; Delo itself runs no plugin audit;
- shows an approval prompt listing the plugins that change (added, removed or another version), the builds that change (pnpm `allowBuilds` entries the restored version allows, denies or leaves pending) and the exemptions that change (grants added to or removed from `compatibility.json` and `delo-compatibility.json`);
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

- `delo/packages/update/` (WP3.4): builds the report.
- Upstream's `compatibility-preflight.ts`, `profile.ts`, `profile-sanitize.ts` and the plugin manager's restore (WP3.5): no silent disable, history versions before normalisation and sanitising, transactional restore.
- `delo/packages/profile-safety/` (WP3.6): undo, restore, safe mode and `delorun recover`.
- The studio's update screens and the desktop updater (WP6.3).

## Compatibility

The report's `schema` names its major version; reason codes form a closed list in that version, and a new reason is a new major version, so a reader never meets a code it does not know. The required changes to upstream's own startup behaviour are that an incompatible plugin at startup is reported with Update, Keep disabled and Roll back instead of being disabled with one line on standard error, that the desktop's fatal-recovery "Disable third-party plugins" writes a history version and offers "Restore profile from before the update", and that profile normalisation writes a history version first; none of the three is built, and normalisation rewrites the bundle list without a history version.

## Security

### Requirements

- R1. No update disables, removes or changes a plugin, bundle or row the report did not name; the health check enforces it and rolls back otherwise.
- R2. Nothing applies before the person confirms the report, and a report exists only for a target that passed signature, freshness and log checks.
- R3. Unverified items are shown as such and never counted as safe.
- R4. A failed health check rolls back automatically; the person can roll back at any later time; a rollback changes the profile and the runtime store, and chat data only by restoring a copy the person took, with the newer data set aside.
- R5. Undo and restore run the install-time plugin checks over what they bring back and list the plugins, builds and exemptions that change before applying.
- R6. Both installations' versions and update states are shown, and updating one never switches the other.
- R7. No update whose data differs applies before the person has seen the `data` item and chosen about the copy.
- R8. No rollback deletes chat data.
- R9. The update check sends nothing about the person or the profile, shows only a release whose signed metadata verified, applies nothing, never delays a start, and does not run while its switch is off.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `c03-unnamed-disable-rolls-back` | WP3.4, WP3.5 | A target that disables a plugin the report did not name fails H3 and rolls back to the previous release and snapshot. |
| `c03-health-timeout-rolls-back` | WP3.4 | A target whose Host is not ready 120 seconds after start rolls back. |
| `c03-unverified-metadata-shown` | WP3.4 | A plugin whose `package.json` does not parse appears as `manifest-unreadable` and `unverified`, and `--yes` does not confirm the report. |
| `c03-delo-requirement-excludes-target` | WP3.4 | A plugin whose `engines.delo` excludes the target appears as `delo-requirement-unmet` with both target versions. |
| `c03-no-report-for-unverified-target` | WP3.4 | A target whose manifest signature fails produces no report and the update stops. |
| `c03-no-silent-disable-at-start` | WP3.5 | An incompatible plugin at startup is reported with Update, Keep disabled and Roll back. |
| `c03-sanitize-writes-history` | WP3.5 | Desktop fatal recovery writes a history version before disabling third-party plugins. |
| `c03-restore-lists-changes` | WP3.6 | Restoring a version that brings back a plugin, a build approval and an exemption shows all three in the approval prompt before any file changes. |
| `c03-restore-revoked-stays-disabled` | WP3.6 | Restoring a version that holds a revoked plugin version brings it back disabled with its reason. |
| `c03-failed-restore-reverts` | WP3.5 | A restore whose install step fails leaves every profile file as it was. |
| `c03-desktop-update-leaves-cli` | WP3.4, WP6.3 | Updating the desktop Host leaves the CLI home's version and state unchanged, and both appear in the report. |
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
| `c03-previous-release-reads-delorun-records` | update | Every record `deloRecords` names is written at the version listed, and the update record a release writes is read back by the same reader. |
