---
description: "The @delo/update package, for maintainers of Delo's update path and the studio's update screens: the pre-update report of contract C3, which names every plugin, bundle and profile row an update would disable, remove or change, its reasons and whether each prediction rests on metadata Delo read, both installations' versions and update states, and the gate `delorun update --yes` must pass."
kind: "package-library"
---

# @delo/update

English | [中文](README.zh.md)

## Summary

This package builds [contract C3](../../docs/contracts/c03-update-report.md)'s update report: what a target release would change or break in the person's profile, shown before anything changes. It reads the profile and the staged target and imports no plugin code, and it returns the report's facts — every plugin, bundle and profile row the target would disable, remove or change, each with its reason, whether the prediction is `verified` or `unverified`, and the choices the report offers; both installations' versions and update states; and the counts. The report is an instance of [`@delo/contract-update-report`](../contract-update-report/README.md), whose types are its format. The runtime store's `prepare` and `reportRollback` ([`@delo/runtime-store`](../runtime-store/README.md)) call it through the home process's update handshake ([`@delo/home-process`](../home-process/README.md)), and `delorun update` prints the report before it asks for the person's confirmation.

## Contents

- [What the report decides](#what-the-report-decides)
- [The two version axes](#the-two-version-axes)
- [Bundles and rows](#bundles-and-rows)
- [Both installations](#both-installations)
- [Data formats](#data-formats)
- [The session-data copy](#the-session-data-copy)
- [The one rollback function](#the-one-rollback-function)
- [Confirming without asking](#confirming-without-asking)
- [The sentences](#the-sentences)
- [Seams for other packages](#seams-for-other-packages)
- [Not yet implemented](#not-yet-implemented)
- [Tests](#tests)

## What the report decides

`buildUpdateReport(input)` takes the installation being updated, both releases, the profile's facts, the target's facts and both status records, and returns the report. It sorts the items by kind — `plugin`, `bundle`, `row` — and then by subject, and it fills `counts` with the items per effect and the unverified items beside them.

Two refusals are the report's own guarantees and it raises them as a typed `UpdateReportError`. A target whose signature, freshness or log check did not pass gets no report at all (`REPORT_TARGET_UNVERIFIED`), because C3's R2 makes a report exist only for a target that passed those checks. And an item is `unverified` whenever a fact it states was missing or could not be read: an unparseable `package.json`, a declaration in a form that is not a range, a plugin that declares no requirement, a row whose plugin's metadata is unreadable. Unverified items are never counted as safe, and R3 makes that visible rather than silent.

Three decisions the contractors left to the report are recorded here. A plugin the target's revocation list revokes gets one `plugin-revoked` item and no requirement item, because the list refuses the version whatever its ranges say and offering an exemption would offer to keep running a version the list revokes. A plugin whose manifest cannot be read is kept, with `manifest-unreadable` and `unverified`: nothing says the update breaks it, and nothing says it does not. An item that changes nothing — a `kept` plugin, a replaced bundle list, a disabled row that follows a plugin's own item — offers no action, because C3's closed list is a list of choices that change an outcome.

## The two version axes

Each installed plugin is checked on [contract C17](../../docs/contracts/c17-plugin-versions.md)'s two axes: `engines.dsh` against the DSH the update would install, and `engines.delo` against the Delo it would install. The semantics are upstream's `plugin-compatibility.ts` one release forward: a range is met when the version satisfies it with prereleases taking part, and an empty, `workspace:` or invalid range is unmet.

Each axis has its own exact-version exemption file from the profile ([`@delo/contract-plugin-versions`](../contract-plugin-versions/README.md) names both), mapping an exact `package@version` key to exact versions of that axis. An exemption admits one version, never a range, so three outcomes are distinct and the report keeps them apart: a plugin the target does not satisfy and no exemption covers is `dsh-requirement-unmet` or `delo-requirement-unmet` and is disabled; a plugin whose exemption names the target version is `requirement-exempted` and is kept; and a plugin that runs today under an exemption for the version it runs on now, which does not name the target, is `exemption-not-carried` and is disabled — the sentence names both versions, so the person sees what the update takes away. A mismatch on either axis offers `update-plugin` and `allow-version`, as C3 requires, and names both target versions in its sentence.

## Bundles and rows

The target's own tables decide the bundle items. A bundle in the target's retired list leaves the bundle list (`bundle-retired`, removed). A bundle the target could not load is disabled with upstream's failure text (`bundle-skipped`). And when the profile's list matches an installation-owned list that DSH replaces with its template, the whole list is replaced: every bundle that leaves and every bundle the template adds is `bundle-template-normalised`, and `predictBundleList` returns the target's template, which health criterion H5 compares the profile against.

The profile's layers decide the row items. Each layer — a bundle, the profile patch, the home patch or an overlay — is walked row by row. A row that loads a plugin the update disables is `row-disabled`, and its sentence names the row, the layer and the plugin. An Include is disabled whole when any row inside it reaches such a plugin (`row-include-blocked`), because the Include loads as one file. A row's item carries the verification of the plugin item that disabled it, so a row that rests on unreadable metadata is unverified too.

## Both installations

`installations` always holds both installations in display order, `cli-home` first. Each entry is the record its installation wrote, read by the caller, and a record that is absent or unreadable shows that installation as `unknown` with no versions — the report invents no state. Updating one installation never switches the other: the report for the desktop Host shows the CLI home's own Delo version, DSH version and state unchanged, and the builder writes nothing at all.

## Data formats

`dataFormatsOf` writes a release's `data-formats.json` from upstream's `docs/persistence-schema.json` and `DELO_RECORDS`, the versioned records Delo's own packages keep under the home; `delo/apps/release` writes it at the root of each runtime closure, so the signed file list carries it. `compareDataFacts` compares two releases: the manifests' `dsh` versions, the `persistence` digests and `deloRecords`. Upstream's schema inventory covers the Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as a change on its own. `dataItems` turns a change into one `data` item, `data-format-changed` and verified, and a missing or unreadable file on either side into `data-format-unknown` and unverified; each carries the copy's size and the free space and offers `copy-session-data` and `continue-without-copy`.

## The session-data copy

`saveDataCopy` copies the home's `sessions/` and `storages/` into `data-copies/.tmp-<16 hex>/` with `COPYFILE_FICLONE`, which falls back to a full copy, syncs every file and `copy.json`, renames it to `data-copies/<to>/` and removes every other copy. `assertCopyFits` refuses a copy larger than the free space with `DATA_COPY_NO_SPACE`. `restoreDataCopy` writes `data-copies/restore.json` before its first rename, moves the live directories to `data-set-aside/<to>-<time>/` and the copy's into the home, and counts the chats it set aside that the copy did not hold; `recoverDataCopies` completes a killed restore from that journal and removes unfinished copies, before any Host starts. `listKeptData` and `discardKeptData` are `delorun recover status` and `discard`. Nothing here deletes chat data except a later copy replacing an older one and the person's `discard`.

## The one rollback function

`rollbackUpdate` is contract C3's rollback table, and every way back calls it: the home process's `rollback`, its automatic rollback, the restart after an interrupted update and `delorun recover rollback` with no home process. `decideRollback` picks the row from the update record and whether a copy exists; a refusal (`ROLLBACK_NEEDS_DATA_COPY`) comes before any step, and otherwise the function restores the copy when the row says so, then the profile snapshot, then, unless only the profile goes back, calls the caller's pointer switch.

## Confirming without asking

`confirmsWithoutAsking(report)` is the rule `delorun update --yes` applies: it confirms a report that has no `disabled` or `removed` item and no unverified item. Anything else needs the person, which is why a profile of plugins that declare no requirement cannot be confirmed unattended — their compatibility with the target is not stated. A verified `data` item is `changed` and does not stop `--yes`, which takes the copy; a `data-format-unknown` item is unverified and does.

## The sentences

`reasonMessage(item, versions)` states each reason in the words C3's reason table gives it, and `UNVERIFIED_NOTE` is the sentence shown beside an unverified item. The words live in this package because they are part of the contract, not a screen's copy: `delorun update` prints them as they are. That text reaches a person; nothing here is a session event or a tool result, so no model sees it and no session record carries it.

## Seams for other packages

`buildFromSources(installation, sources, version)` reads every fact and returns `{ report, health, dataDiffers }`: `health` is what C3's health check holds the target to (the disabled plugins for H3, the named rows for H3 and H4, the predicted bundle list for H5). It is the `UpdateReporter` the runtime store's seam declares, and `src/service.ts` mounts the same build as a Cordis service, `ctx.updateReport`.

| Interface | Implemented by |
| --- | --- |
| `ReportSources`: `running`, `statuses`, `profile`, `target`, `data`, `now` | `delo/apps/cli/src/update/sources.ts`: C1's store for both runtimes, the profile's manifest, plugins, patch layers and exemption files, both status records, and both releases' `data-formats.json` |
| `UpdateReporter.build` | `buildFromSources`, which `HomeRuntimeStore.prepare` and `reportRollback` call through the CLI's update support |

One report is built at a time and a second request for the version already building joins it. The build is an effect of the context, so a disposed context returns no report: a caller still waiting is refused with `REPORT_DISPOSED` instead of being handed a report from a context that no longer exists.

## Not yet implemented

- The CLI's readers walk the profile patch and the home patch but no bundle's own layer, report no bundle the target would skip, and read no revocation list; the health check's H3 to H5 catch what the report did not name.
- A stored report's reader validates nothing yet: a report kept in a profile history version is read back against the contract's types by its reader, and the report format's own validator lands with the history's reader.
- The studio's update screens (WP6.3) show this report. Their copy goes through the Web UI's locale dictionaries when they land; this package's sentences are the CLI's.
- The health check's own criteria (H1 to H5) run in the CLI's Host (`delo/apps/cli/src/update/host.ts`) and the rollback triggers in the home process's handshake, not here; `health` is what they compare against.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/update` runs the specs: the manifest reader's four classifications, both version axes with exemptions on either side of an update, the report's shape, order, counts and both installations, the bundle and row items, the sentences C3 states, the `--yes` gate, and the service's build, join, version check and disposal. `tests/denial.spec.ts` carries C3's own denial tests for this package — `c03-unverified-metadata-shown`, `c03-delo-requirement-excludes-target`, `c03-no-report-for-unverified-target` and `c03-desktop-update-leaves-cli` — by their contract ids; `tests/data-formats.spec.ts`, `tests/data-copy.spec.ts` and `tests/rollback.spec.ts` carry the data-format, copy and rollback-table ones, and `delo/apps/cli/tests/update/` the end-to-end ones.
