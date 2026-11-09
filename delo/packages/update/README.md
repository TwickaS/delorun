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

## Confirming without asking

`confirmsWithoutAsking(report)` is the rule `delorun update --yes` applies: it confirms a report that has no `disabled` or `removed` item and no unverified item. Anything else needs the person, which is why a profile of plugins that declare no requirement cannot be confirmed unattended — their compatibility with the target is not stated.

## The sentences

`reasonMessage(item, versions)` states each reason in the words C3's reason table gives it, and `UNVERIFIED_NOTE` is the sentence shown beside an unverified item. The words live in this package because they are part of the contract, not a screen's copy: `delorun update` prints them as they are. That text reaches a person; nothing here is a session event or a tool result, so no model sees it and no session record carries it.

## Seams for other packages

`src/service.ts` mounts the report as a Cordis service, `ctx.updateReport`, and is the `UpdateReporter` the runtime store's seam declares — `build(version)` returns `{ report, disabledPlugins }`, where `disabledPlugins` is the plugin ids the health check holds the target to (H3).

| Interface | Implemented by | Until it lands |
| --- | --- | --- |
| `ReportSources`: `running`, `statuses`, `profile`, `target`, `now` | the CLI's update path: the profile's reader, C1's runtime store for the installed target, and both installations' status records | the CLI has no update command yet, so `delorun update` prints no report |
| `UpdateReportService.build` | `delo/packages/runtime-store`'s `HomeRuntimeStore.prepare` and `reportRollback` | the store's prepare refuses with its own `VERIFY_FAILED` and no report is built |

One report is built at a time and a second request for the version already building joins it. The build is an effect of the context, so a disposed context returns no report: a caller still waiting is refused with `REPORT_DISPOSED` instead of being handed a report from a context that no longer exists.

## Not yet implemented

- The readers behind `ReportSources`. The profile's plugins, bundle list, layers and exemption files, the installed target's own tables and the two status records are each their owner's file to read, and the CLI's update path composes them; this package decides what they mean.
- A stored report's reader validates nothing yet: a report kept in a profile history version is read back against the contract's types by its reader, and the report format's own validator lands with the history's reader.
- The studio's update screens (WP6.3) show this report. Their copy goes through the Web UI's locale dictionaries when they land; this package's sentences are the CLI's.
- The health check's own criteria (H1 to H5) and the rollback triggers run in the home process's handshake, not here. `disabledPlugins` and `predictBundleList` are what H3 and H5 compare against.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/update` runs the specs: the manifest reader's four classifications, both version axes with exemptions on either side of an update, the report's shape, order, counts and both installations, the bundle and row items, the sentences C3 states, the `--yes` gate, and the service's build, join, version check and disposal. `tests/denial.spec.ts` carries C3's own denial tests for this package — `c03-unverified-metadata-shown`, `c03-delo-requirement-excludes-target`, `c03-no-report-for-unverified-target` and `c03-desktop-update-leaves-cli` — by their contract ids.
