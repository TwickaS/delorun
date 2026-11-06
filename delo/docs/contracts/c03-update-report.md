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
- [Applying an update](#applying-an-update)
- [Health check](#health-check)
- [Rollback triggers](#rollback-triggers)
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
| `schema` | `delo.update-report/1` | The report format. |
| `installation` | `cli-home` or `desktop-host` | The installation being updated. |
| `from`, `to` | `{ "delo", "dsh", "channel" }` | The running and target versions ([C17](c17-plugin-versions.md#the-two-versions)). |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | The target's manifest digest and each check's result; all three are `passed` for any report shown. |
| `generated` | timestamp | When the report was built. |
| `installations` | list of `{ "id", "delo", "dsh", "state", "target"? }` | Both installations' versions and update states. |
| `items` | list of item | Everything that changes, sorted by kind, then subject. |
| `counts` | `{ "disabled", "removed", "changed", "unverified" }` | The number of items with each effect, and of unverified items. |

The report is stored in the snapshot's history version, so the history shows what the update was predicted to change.

## Items

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `plugin`, `bundle` or `row` | What the item is about. |
| `subject` | object | For `plugin`: `{ "name", "version" }`; for `bundle`: `{ "package" }`; for `row`: `{ "id"?, "name", "layer" }`, where `layer` names the bundle, profile patch, home patch or overlay that holds the row. |
| `reason` | reason code | Why it changes ([reasons](#reasons)). |
| `effect` | `disabled`, `removed`, `changed` or `kept` | What happens to it on the target; `kept` appears only for an exempted or unverified subject the person should see. |
| `verification` | `verified` or `unverified` | Whether the prediction rests on metadata Delo read ([verified and unverified](#verified-and-unverified)). |
| `detail` | object | The reason's facts, such as the requirement range, the axis, the revocation message or the replacement bundle. |
| `actions` | list | Offered choices: `update-plugin`, `keep-disabled`, `allow-version`, `skip-update`. |

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

For a mismatch on either version axis the report names both target versions, and its `actions` offer updating the plugin to a version that meets the target and, for the axis that is unmet, an exact-version exemption on the target version ([C17](c17-plugin-versions.md#exemptions)).

## Verified and unverified

An item is `verified` when every fact it states was read from a source Delo checked: the installed plugin's `package.json`, the staged target's packages and the verified manifest. It is `unverified` when a fact is missing or could not be read, such as a manifest that does not parse, a row whose module cannot be resolved, or a plugin that declares no requirement. Unverified items are never counted as safe: the report shows "Delo cannot predict this item" beside each, and the summary counts them. The health check treats them like named items.

## Applying an update

1. The person confirms the report; `delorun update` prints it and asks, and `delorun update --yes` confirms a report that has no `disabled` or `removed` item and no unverified item.
2. A snapshot is written: a profile history version named "Before update to Delo <to.delo>", holding the profile patch, the home patch, the bundle list, both exemption files, the profile's `pnpm-workspace.yaml` and the report.
3. Running chats finish, or the person stops them; the CLI switch goes through the home process's update handshake, which never switches under a running chat ([C19](c19-home-process.md)), and the desktop app does this in its pre-restart step.
4. The target starts and the health check runs.

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

A rollback restores the snapshot's files and switches the installation back to the release it replaced: for `cli-home`, the runtime the store keeps ([C1](c01-home-layout.md)); for `desktop-host`, the cached previous release ([C2](c02-release-manifest.md#desktop-updates-and-rollback)). It changes no chat, workspace or file outside the profile and the runtime store. After an automatic rollback the studio names the criterion that failed, and the failed release is offered again only with that failure shown. A rollback that fails leaves the state `failed` and offers safe mode and `delorun recover`.

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
- R4. A failed health check rolls back automatically; the person can roll back at any later time; a rollback changes nothing outside the profile and the runtime store.
- R5. Undo and restore run the install-time plugin checks over what they bring back and list the plugins, builds and exemptions that change before applying.
- R6. Both installations' versions and update states are shown, and updating one never switches the other.

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
