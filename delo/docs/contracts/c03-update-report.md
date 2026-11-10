---
description: "Contract C3: the update report shown before a Delo update applies, its items (plugin, bundle, row, reason, verified or unverified) and reason codes, the versions and update states of the CLI home and the desktop Host, the health-check criteria, the rollback triggers, and the checks and approval prompt of undo and restore."
---

# C3 Update report

English | [中文](c03-update-report.zh.md)

## Summary

Before an update applies, Delo shows what the target release would change or break in the person's profile: every plugin, bundle and profile row it would disable, remove or change, with the reason and whether the prediction rests on metadata Delo could read (verified) or not (unverified). Nothing applies until the person confirms. The CLI home and the desktop Host are separate installations that update independently, and the report shows the versions and update states of both. After the switch, a health check decides within 120 seconds whether the update stands; a failed check rolls back automatically, and the person can roll back at any later time. Undo and restore of profile history run the same plugin checks an install runs and list what they change before they apply. The types live in [`@delo/contract-update-report`](../../packages/contract-update-report/README.md).

## Contents

- [Installations and update states](#installations-and-update-states)
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
| The CLI home: the runtime store and the home process | `cli-home` | `delorun update` and the studio's "Update now", through the update channel ([C19](c19-home-process.md)) |
| The desktop app and its Host | `desktop-host` | The desktop updater on Delo's feed ([C2](c02-release-manifest.md#desktop-updates-and-rollback)) |

Each installation has its own profile and its own Delo and DSH versions; updating one never switches the other. Each writes its status record (installation id, Delo version, DSH version, channel, update state, target version, time) at the path [C1](c01-home-layout.md) names, and each report reads the other's record. An absent or unreadable record shows that installation as `unknown`.

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

## When a report is made

A report is built for one installation and one target release, after the target's files are downloaded and verified ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md)) and staged, and before anything in the profile or the active runtime changes. A target that fails verification gets no report; the update stops. The report reads the profile and the staged target, and imports no plugin code.

## Report fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `delo.update-report/2` | The report format. |
| `installation` | `cli-home` or `desktop-host` | The installation being updated. |
| `from`, `to` | `{ "delo", "dsh", "channel" }` | The running and target versions ([C17](c17-plugin-versions.md#the-two-versions)). |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | The target's manifest digest and each check's result; all three are `passed` for any report shown. |
| `generated` | timestamp | When the report was built. |
| `installations` | list of `{ "id", "delo", "dsh", "state", "target"? }` | Both installations' versions and update states. |
| `items` | list of item | Everything that changes, sorted by kind, then subject. |
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
| `requirement-undeclared` | plugin | kept | `<plugin> declares no DSH requirement, so its compatibility with DSH <to.dsh> is not stated.` |
| `plugin-revoked` | plugin | disabled | `<plugin> is revoked: <reason>, <message>.` ([C13](c13-catalogue-revocation.md#revocation-list)) |
| `manifest-unreadable` | plugin | kept | `Delo could not read <plugin>'s package.json; it cannot predict what the update does to it.` |
| `bundle-retired` | bundle | removed | `<bundle> is retired in DSH <to.dsh> and leaves the bundle list.` (upstream's `RETIRED_BUNDLES`) |
| `bundle-template-normalised` | bundle | changed | `The bundle list matches an installation-owned list that DSH <to.dsh> replaces with its template.` |
| `bundle-skipped` | bundle | disabled | `<bundle> cannot load on the target: <reason>.` (upstream's `skippedBundles`) |
| `row-disabled` | row | disabled | `Row <id or name> in <layer> loads <plugin>, which the update disables.` |
| `row-include-blocked` | row | disabled | `Include <file> reaches <plugin>, which the update disables, so the whole Include is disabled.` |
| `data-format-changed` | data | changed | `Delo <to.delo> keeps chat data in a format Delo <from.delo> may not read.` |
| `data-format-unknown` | data | changed | `Delo cannot tell whether Delo <from.delo> reads the chat data Delo <to.delo> writes.` |

For a mismatch on either version axis the report names both target versions, and its `actions` offer updating the plugin to a version that meets the target and, for the axis that is unmet, an exact-version exemption on the target version ([C17](c17-plugin-versions.md#exemptions)).

## Verified and unverified

An item is `verified` when every fact it states was read from a source Delo checked: the installed plugin's `package.json`, the staged target's packages and the verified manifest. It is `unverified` when a fact is missing or could not be read, such as a manifest that does not parse, a row whose module cannot be resolved, or a plugin that declares no requirement. Unverified items are never counted as safe: the report shows "Delo cannot predict this item" beside each, and the summary counts them. The health check treats them like named items.

## Data formats

Every runtime closure carries `data-formats.json` at its root, listed in its signed file list ([C2](c02-release-manifest.md)): `{ "schema": "delo.data-formats/1", "persistence": <SHA-256 of upstream's docs/persistence-schema.json at the built commit>, "deloRecords": { <record name>: <version> } }`. `deloRecords` names each versioned record Delo's own packages keep under the home.

The report compares the running and the target release. The chat data differs when the manifests' `dsh` versions differ, the `persistence` digests differ, or the `deloRecords` differ; upstream's schema inventory covers the Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as a difference on its own. Any difference is one `data` item with reason `data-format-changed`, `verified`, and Delo treats every difference as one-way. A `data-formats.json` that is missing or unreadable on either side is `data-format-unknown`, `unverified`, and is treated the same way. There is no downgrade refusal: the comparison never blocks a rollback.

A `data` item offers `copy-session-data`, the default, and `continue-without-copy`. Its detail holds the copy's file count and size and the free space on the home's filesystem, and the report states beside it: `Without the copy, Delo cannot go back to <from.delo> after <to.delo> first starts.` When nothing differs no copy is offered, and `delorun update --data-copy` takes one anyway.

A session-data copy holds the home's `sessions/` and `storages/` as real copies (`COPYFILE_FICLONE`, falling back to a full copy), never hard links. `attachments/` stays in place because nothing deletes from it, `cache/` is left out and rebuilds, and Delo's records under `secrets/` are never copied or restored: the previous release reads every record the current one writes. The copy is written to `data-copies/<to.delo>/` beside `copy.json` (both releases' `data-formats.json`, the file count and the byte total) after running chats have ended and the Host has stopped, while the home lock is held, under a temporary name that is renamed and synced before the runtime switches. A copy that does not fit refuses the update with `DATA_COPY_NO_SPACE`, unless the person chose to continue without it. One copy is kept: a later update's copy removes the older one.

## Applying an update

1. The person confirms the report; `delorun update` prints it and asks, and `delorun update --yes` confirms a report that has no `disabled` or `removed` item and no unverified item. With a `data` item the person also chooses about the copy: `--yes` takes it, and declining needs `--no-data-copy` or the prompt's second choice.
2. A snapshot is written: a profile history version named "Before update to Delo <to.delo>", holding the profile patch, the home patch, the bundle list, both exemption files, the profile's `pnpm-workspace.yaml` and the report. The update record `run/<profile>/update.json` ([C1](c01-home-layout.md)) names the two versions, whether the data differs, whether a copy is taken and the snapshot.
3. Running chats finish, or the person stops them; the CLI switch goes through the home process's update handshake, which never switches under a running chat ([C19](c19-home-process.md)), and the desktop app does this in its pre-restart step. With the Host stopped and the home lock held, the session-data copy is written when the person chose it.
4. The update record's `targetStarted` is written and synced, then the target starts and the health check runs.

## Health check

The update stands when all of these hold within 120 seconds after the target starts:

- H1. The target's runtime files verify against its manifest, and its release-log state is not `failed` ([C2](c02-release-manifest.md#client-verification), [C18](c18-release-log.md#check-states)).
- H2. The Host reaches ready: for `cli-home`, the home process's Host is ready and the studio answers its loopback listener's index with status 200; for `desktop-host`, the Host reports ready over the host protocol and the main window loads the studio.
- H3. Every plugin, bundle and row the target disabled, skipped or removed is one the report named.
- H4. Every row the report did not name loads without a plugin load error, except a row whose load error the previous release also recorded.
- H5. The profile's bundle list equals the list the report predicted.

## Rollback triggers

Automatic rollback runs when:

- T1. any health criterion fails;
- T2. the health check has not finished 120 seconds after the target starts;
- T3. the target's Host process exits during the health check.

On request, the person rolls back at any later time from the studio's update screen, `delorun recover` or the desktop app's rollback.

A rollback restores the snapshot's files and switches the installation back to the release it replaced: for `cli-home`, the runtime the store keeps ([C1](c01-home-layout.md)); for `desktop-host`, the cached previous release ([C2](c02-release-manifest.md#desktop-updates-and-rollback)). After an automatic rollback the studio names the criterion that failed, and the failed release is offered again only with that failure shown. A rollback that fails leaves the state `failed` and offers safe mode and `delorun recover`.

## Rollback

Every way back for `cli-home` reads the update record and applies one table: the handshake's `rollback`, the automatic rollback, the restart after an interrupted update and `delorun recover rollback` with no home process running. None swaps the runtime pointers on its own.

| Data differs | Target started | Copy | Rollback does |
| --- | --- | --- | --- |
| no | either | — | Restores the profile snapshot and switches to the previous runtime. Chats written since stay. |
| yes | no | either | The same; the target never opened the data. |
| yes | yes | present | States how many chats were created or changed since the update and that they are set aside, not deleted. Moves the live `sessions/` and `storages/` to `data-set-aside/<to.delo>-<time>/`, moves the copy into place, restores the snapshot and switches the runtime. |
| yes | yes | absent | Refuses with `ROLLBACK_NEEDS_DATA_COPY` and the reason, and offers `delorun recover rollback --profile-only`, which restores the snapshot and keeps the target runtime. |

Nothing is deleted by a rollback: set-aside data stays until the person removes it, and `delorun recover status` lists it with its size. The restore writes the journal `data-copies/restore.json` before its first rename, and each step is one directory rename; `delorun start` and `delorun recover` complete a restore in progress before any Host starts.

This procedure holds for `cli-home`, the only installation that applies it. The desktop Host shares `sessions/` and takes no home lock, so it is not shipped until a lock covers both installations and its updater uses this procedure.

## Undo and restore

Undo (restore the version before the latest) and restore (any history version) bring back profile files, and with them plugin versions, build approvals and exemptions. Before writing anything, each:

- runs the checks an install runs over every plugin version it brings back: both version axes ([C17](c17-plugin-versions.md)), the revocation list ([C13](c13-catalogue-revocation.md)), the integrity pins, pnpm's build approvals, and the `pluginAudit` service where one is mounted, whose findings render as [C13](c13-catalogue-revocation.md#listed-findings) states; Delo itself runs no plugin audit;
- shows an approval prompt listing the plugins that change (added, removed or another version), the builds that change (pnpm `allowBuilds` entries the restored version allows, denies or leaves pending) and the exemptions that change (grants added to or removed from `compatibility.json` and `delo-compatibility.json`);
- applies only after the person approves, and writes the result as a new history version.

A plugin version the current revocation list revokes is restored disabled with its reason. While the list is stale, an undo or restore that would install a plugin version the profile does not have waits for a fresh list, as a new catalogue install does ([C13](c13-catalogue-revocation.md#stale-state)). A restore whose install step fails reverts every file it wrote.

## Values and limits

| Value | Number |
| --- | --- |
| Health-check limit | 120 seconds after the target starts |
| Status records read per report | 2, one per installation |
| Session-data copies kept | 1 |

## Consumers

- `delo/packages/update/` (WP3.4): builds the report.
- Upstream's `compatibility-preflight.ts`, `profile.ts`, `profile-sanitize.ts` and the plugin manager's restore (WP3.5): no silent disable, history versions before normalisation and sanitising, transactional restore.
- `delo/packages/profile-safety/` (WP3.6): undo, restore, safe mode and `delorun recover`.
- The studio's update screens and the desktop updater (WP6.3).

## Compatibility

The report's `schema` names its major version; reason codes form a closed list in that version, and a new reason is a new major version, so a reader never meets a code it does not know. Upstream's own startup behaviour is changed only as WP3.5 lists: an incompatible plugin at startup is reported with Update, Keep disabled and Roll back instead of being disabled silently, the desktop's fatal-recovery "Disable third-party plugins" writes a history version and offers "Restore profile from before the update", and profile normalisation writes a history version first.

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
| `c03-previous-release-reads-delorun-records` | update | Every record `deloRecords` names is written at the version listed, and the update record a release writes is read back by the same reader. |
