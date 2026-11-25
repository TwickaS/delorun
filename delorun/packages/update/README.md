---
description: "The @delorun/update package, for maintainers of Delorun's update path and the studio's update screens: the pre-update report of contract C3, which names every plugin, bundle and profile row an update would disable, remove or change, its reasons and whether each prediction rests on metadata Delorun read, both installations' versions and update states, and the gate `delorun update --yes` must pass."
kind: "package-library"
---

# @delorun/update

English | [中文](README.zh.md)

## Summary

This package builds [contract C3](../../docs/contracts/c03-update-report.md)'s update report: what a target release would change or break in the person's profile, shown before anything changes. It reads the profile and the staged target and imports no plugin code, and it returns the report's facts — every plugin, bundle and profile row the target would disable, remove or change, each with its reason, whether the prediction is `verified` or `unverified`, and the choices the report offers; both installations' versions and update states; and the counts. The report is an instance of [`@delorun/contract-update-report`](../contract-update-report/README.md), whose types are its format. The runtime store's `prepare` and `reportRollback` ([`@delorun/runtime-store`](../runtime-store/README.md)) call it through the home process's update handshake ([`@delorun/home-process`](../home-process/README.md)), and `delorun update` prints the report before it asks for the person's confirmation.

## Contents

- [What the report decides](#what-the-report-decides)
- [The two version axes](#the-two-version-axes)
- [Bundles and rows](#bundles-and-rows)
- [Both installations](#both-installations)
- [Data formats](#data-formats)
- [Harness changes](#harness-changes)
- [The session-data copy](#the-session-data-copy)
- [The one rollback function](#the-one-rollback-function)
- [Confirming without asking](#confirming-without-asking)
- [The sentences](#the-sentences)
- [Seams for other packages](#seams-for-other-packages)
- [Not implemented](#not-implemented)
- [Tests](#tests)

## What the report decides

`buildUpdateReport(input)` takes the installation being updated, both releases, the profile's facts, the target's facts and both status records, and returns the report. It sorts the items by kind — `plugin`, `bundle`, `row`, `data`, `harness` — and then by subject, and it fills `counts` with the items per effect and the unverified, `data` and `harness` items beside them.

Two refusals are the report's own guarantees and it raises them as a typed `UpdateReportError`. A target whose signature or freshness check did not pass, or whose log check failed, gets no report at all (`REPORT_TARGET_UNVERIFIED`), because C3's R2 makes a report exist only for such a target; a log check the install recorded as `unchecked` gets a report whose `release.log` says so. And an item is `unverified` whenever a fact it states was missing or could not be read: an unparseable `package.json`, a declaration in a form that is not a range, a plugin that declares no requirement, a row whose plugin's metadata is unreadable. Unverified items are never counted as safe, and R3 makes that visible rather than silent.

Three decisions the contractors left to the report are recorded here. A plugin the target's revocation list revokes gets one `plugin-revoked` item and no requirement item, because the list refuses the version whatever its ranges say and offering an exemption would offer to keep running a version the list revokes. A plugin whose manifest cannot be read is kept, with `manifest-unreadable` and `unverified`: nothing says the update breaks it, and nothing says it does not. An item that changes nothing — a `kept` plugin, a replaced bundle list, a disabled row that follows a plugin's own item — offers no action, because C3's closed list is a list of choices that change an outcome.

## The two version axes

Each installed plugin is checked on [contract C17](../../docs/contracts/c17-plugin-versions.md)'s two axes by `evaluatePluginAxes`, which calls `decidePluginVersion`, which calls upstream's own `evaluatePluginCompatibility` from `@deepseek-ai/dsh-app-boot`, the function the plugin installer and the start's preflight call, with the DSH and the Delorun the update would install. A plugin that declares `engines.delorun` is decided on that range alone (A567): its DSH axis is not checked, so it is never reported on a DSH range, and a DSH exemption has no effect on it. `decidePluginVersion(manifest, delorun, dsh)` is that decision as a pure function with no exemption, which returns which declaration decided (`decidedBy`: `delorun`, `dsh`, `peer` or `none`), its range, the version it was checked against and `admitted` or `refused`; `delorun plugin check --json` prints it. On the DSH axis of a plugin without `engines.delorun`, `engines.dsh` decides alone when declared; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must admit the target, so a plugin that states its range only through peers is disabled when the next start would disable it. A range is met when the version satisfies it with prereleases taking part, and an empty, `workspace:` or invalid range is unmet; a declaration upstream refuses to read is `requirement-unreadable`.

Each axis has its own exact-version exemption file from the profile ([`@delorun/contract-plugin-versions`](../contract-plugin-versions/README.md) names both), mapping an exact `package@version` key to exact versions of that axis. An exemption admits one version, never a range, so three outcomes are distinct and the report keeps them apart: a plugin the target does not satisfy and no exemption covers is `dsh-requirement-unmet` or `delorun-requirement-unmet` and is disabled; a plugin whose exemption names the target version is `requirement-exempted` and is kept; and a plugin that runs today under an exemption for the version it runs on now, which does not name the target, is `exemption-not-carried` and is disabled — the sentence names both versions, so the person sees what the update takes away. A mismatch on either axis offers `update-plugin` and `allow-version`, as C3 requires, and names both target versions in its sentence.

## Bundles and rows

The target's own tables and its bundles' metadata decide the bundle items. A bundle in the target's retired list leaves the bundle list (`bundle-retired`, removed). A bundle the target could not load is disabled with the failure the caller read (`bundle-skipped`), `verified` when one of upstream's skip rules decides it and `unverified` when the bundle's metadata could not be read; a bundle the template adds is named as skipped when the target cannot load it. And when the profile's list matches an installation-owned list that DSH replaces with its template, the whole list is replaced: every bundle that leaves and every bundle the template adds is `bundle-template-normalised`, and `predictBundleList` returns the target's template, which health criterion H5 compares the profile against.

The layers decide the row items: the patch layers of the bundles the target loads (`BundleFacts.layers`), then the profile's own (`ProfileFacts.layers`). Each layer — a bundle, the profile patch, the home patch or an overlay — is walked row by row. A row that loads a plugin the update disables is `row-disabled`, and its sentence names the row, the layer and the plugin. An Include is disabled whole when any row inside it reaches such a plugin (`row-include-blocked`), because the Include loads as one file. A row's item carries the verification of the plugin item that disabled it, so a row that rests on unreadable metadata is unverified too.

A bundle layer also carries the keys its patch gives each row that has an id (`LayerFact.settings`, read from the bundle's patch files like `disabledRows`). `releaseSettingChanges` compares the running and the target release's layers for the rows whose plugin either release's `protectedPlugins` names, and `settingsItems` makes a `row-settings-changed` item for each difference: `changed` for a new or different key, `removed` for a row the target drops. The health check of the target release reads the same comparison from both releases' signed files and asks `previousConfigsOf` for the configs the previous Host could have booted with, so it accepts exactly the changes the bundles bring (C3, rows a release changes); `settingsNote` words a change for the outcome record. A changed or added row is not given to H3 as named, and a removed row is. `tests/row-settings.spec.ts` runs the comparison, the sentences and `previousConfigsOf`.

## Both installations

`installations` always holds both installations in display order, `cli-home` first. Each entry is the record its installation wrote, read by the caller, and a record that is absent or unreadable shows that installation as `unknown` with no versions — the report invents no state. Updating one installation never switches the other: the report for the desktop Host shows the CLI home's own Delorun version, DSH version and state unchanged, and the builder writes nothing at all.

## Data formats

`dataFormatsOf` writes a release's `data-formats.json` from upstream's `docs/persistence-schema.json` and `DELORUN_RECORDS`, the versioned records Delorun's own packages keep under the home; `delorun/apps/release` writes it at the root of each runtime closure, so the signed file list carries it. `compareDataFacts` compares two releases: the manifests' `dsh` versions, the `persistence` digests and `delorunRecords`. Upstream's schema inventory covers the Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as a change on its own. `dataItems` turns a change into one `data` item, `data-format-changed` and verified, and a missing or unreadable file on either side into `data-format-unknown` and unverified; each carries the copy's size and the free space and offers `copy-session-data` and `continue-without-copy`.

## Harness changes

`harnessItems` turns each approved harness file of the running runtime into one `harness` item from its `HarnessFact`: the file and the `HarnessMerge` the CLI's sources computed with `@delorun/changes`'s three-way merge against the target's verified file. A merge of `release-unchanged` or `in-release` is `harness-change-carried`, kept, with no action; `merged` is `harness-change-merged`, changed, offering `skip-update`, with the fact's `diff` from the target's file to the merged file, and `confirmsWithoutAsking` returns false for it, so `--yes` never confirms it; any other is `harness-change-conflicts`, disabled, offering `skip-update`, so `--yes` never confirms it either. A carried or merged item states the fact's `result`, the SHA-256 and execute bit of what the target runs, which the apply compares with its own merge. All are verified. This package reads no harness record and no store, so it does not depend on `@delorun/changes`. `ReportSources.harness` is read only for a report whose purpose is `update`: a rollback's report (`rollback`) has no `harness` item, because the runtime rolled back to runs its own approved files.

## The session-data copy

`saveDataCopy` copies the home's `sessions/` and `storages/` into `data-copies/.tmp-<16 hex>/` with `COPYFILE_FICLONE`, which falls back to a full copy, syncs every file and `copy.json`, and renames it to `data-copies/<to>/`, replacing an earlier copy for the same version; copies for other versions stay. It refuses with `DATA_NOT_A_DIRECTORY`, before anything is written, when `sessions/` or `storages/` is a symbolic link or not a directory; symbolic links inside them are copied as links and never followed. `assertCopyFits` refuses a copy larger than the free space with `DATA_COPY_NO_SPACE`. `keepOnlyCopy` removes every copy except the committed update's when an update commits, and `discardCopy` removes the ended update's copy when an update ends before its switch; both refuse with `DATA_IN_USE` while a restore's journal exists.

`restoreDataCopy` refuses with `DATA_IN_USE` while another restore's journal exists. It writes `data-copies/restore.json` before its first rename, moves the live directories to `data-set-aside/<to>-<time>/`, the copy's into the home and `copy.json` beside the set-aside data, and counts the chats it set aside that the copy did not hold. After each rename it syncs both directories and rewrites the journal's `done` count durably. `recoverDataCopies` completes a killed restore from that journal and removes unfinished copies, before any Host starts: it skips the steps `done` counts, takes a next step whose source is gone and whose destination exists as finished, and refuses with `DATA_RESTORE_INCONSISTENT` when both or neither exist, so a restore killed at any point ends in the same state as an uninterrupted one.

`listKeptData` and `discardKeptData` are `delorun recover status` and `discard`. `discardKeptData` refuses with `DATA_IN_USE` while a restore's journal exists or a rollback is in progress, and for a copy an update record still refers to. Nothing here deletes chat data except `keepOnlyCopy`, `discardCopy` and the person's `discard`.

## The one rollback function

`rollbackUpdate` is contract C3's rollback table, and every way back calls it: the home process's `rollback`, its automatic rollback, the restart after an interrupted update and `delorun recover rollback` with no home process. With `profileOnly` it restores only the profile snapshot. Otherwise `decideRollback` picks the row from the update record and whether a usable copy exists: the record says a copy was taken, `data-copies/<to>/` holds a whole copy, and the copy was taken no earlier than the update started, so a copy from an earlier attempt is never restored. A refusal (`ROLLBACK_NEEDS_DATA_COPY`) comes before any step. Then the caller's `preflight` checks that the version rolled back to is installed and passes its start check, and its error reaches the caller unchanged with nothing changed; `markRollingBack` writes the phase `rolling-back` into the update record; and the function restores the copy when the row says so, the profile snapshot, and calls the caller's pointer switch.

A record already in phase `rolling-back` completes that rollback: the function never refuses, runs `preflight`, completes a restore a kill interrupted, restores the copy only while a usable one remains, because otherwise the data step already ran, and then restores the profile snapshot and switches the runtime.

## Confirming without asking

`confirmsWithoutAsking(report)` is the rule `delorun update --yes` applies: it confirms a report that has no `disabled` or `removed` item, no unverified item and a `release.log` of `passed`. Anything else needs the person, which is why a profile of plugins that declare no requirement cannot be confirmed unattended — their compatibility with the target is not stated. A verified `data` item is `changed` and does not stop `--yes`, which takes the copy; a `data-format-unknown` item is unverified and does.

## The sentences

`reasonMessage(item, versions)` states each reason in the words C3's reason table gives it, `UNVERIFIED_NOTE` is the sentence shown beside an unverified item, and `uncheckedMessage(source)` is the sentence shown for a source in `notChecked`. The words live in this package because they are part of the contract, not a screen's copy: `delorun update` prints them as they are. That text reaches a person; nothing here is a session event or a tool result, so no model sees it and no session record carries it.

## Seams for other packages

`buildFromSources(installation, sources, version)` reads every fact and returns `{ report, health, dataDiffers }`: `health` is what C3's health check holds the target to (the disabled plugins for H3, the named rows for H3 and H4, the predicted bundle list for H5). It is the `UpdateReporter` the runtime store's seam declares, and `src/service.ts` mounts the same build as a Cordis service, `ctx.updateReport`.

| Interface | Implemented by |
| --- | --- |
| `ReportSources`: `running`, `statuses`, `profile`, `target`, `data`, `harness`, `now` | `delorun/apps/cli/src/update/sources.ts`: C1's store for both runtimes, the profile's manifest, plugins, patch layers and exemption files, the target's bundle tables and the bundles it loads (`bundle-layers.ts`), both status records, both releases' `data-formats.json`, and the running runtime's harness record merged with the target's verified files (`harness-items.ts`) |
| `UpdateReporter.build` | `buildFromSources`, which `HomeRuntimeStore.prepare` (purpose `update`) and `reportRollback` (purpose `rollback`) call through the CLI's update support |

One report is built at a time and a second request for the version and purpose already building joins it. The build is an effect of the context, so a disposed context returns no report: a caller still waiting is refused with `REPORT_DISPOSED` instead of being handed a report from a context that no longer exists.

## Not implemented

- The CLI's readers read no revocation list, because no release publishes one; the report names `revocations` in `notChecked`, and the health check's H3 catches a plugin the target disables that the report did not name.
- A stored report's reader validates nothing: a report kept in a profile history version is read back against the contract's types by its reader, and the report format has no validator of its own.
- The studio's update screens are not in this package: `@delorun/plugin-update` shows this report, with its copy in the Web UI's locale dictionaries; this package's sentences are the CLI's.
- The health check's own criteria (H1 to H5) run in the CLI's Host (`delorun/apps/cli/src/update/host.ts`) and the rollback triggers in the home process's handshake, not here; `health` is what they compare against.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/update` runs the specs: the manifest reader, both version axes with exemptions on either side of an update, the report's shape, order, counts and both installations, the bundle and row items, the sentences C3 states, the `--yes` gate, and the service's build, join, version check and disposal. `tests/denial.spec.ts` carries C3's own denial tests for this package — `c03-unverified-metadata-shown`, `c03-delorun-requirement-excludes-target`, `c03-peer-requirement-excludes-target`, `c03-no-report-for-unverified-target` and `c03-desktop-update-leaves-cli` — by their contract ids; `tests/harness-items.spec.ts` carries `c03-harness-change-carried`, `c03-harness-change-merged` and `c03-harness-conflict-keeps-mine`; `tests/data-formats.spec.ts`, `tests/data-copy.spec.ts` and `tests/rollback.spec.ts` carry the data-format, copy and rollback-table ones, and `delorun/apps/cli/tests/update/` the end-to-end ones.
