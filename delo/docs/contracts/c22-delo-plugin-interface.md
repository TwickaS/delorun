---
description: "Contract C22: what a Delo version promises a plugin: the interfaces the promise covers and their inventory, what a patch, a minor and a major release may change, the upstream base fixed within a minor, how versions before 1.0 are read, how a plugin targets Delo with engines.delo, and the release tool's patch rule."
---

# C22 What a Delo version promises a plugin

English

## Summary

A plugin runs on two version axes ([C17](c17-plugin-versions.md)): upstream's, `engines.dsh`, and Delo's, `engines.delo`. The axes are independent; a range on one never stands in for the other. This page states what Delo's version promises a plugin that declares `engines.delo`: which interfaces the promise covers, what each kind of release may change, that a minor release keeps one upstream base, and how versions before 1.0 are read. The release tool refuses a patch release that would break the promise as far as it can check mechanically. `delorun plugin check <directory>` shows an author what their ranges admit. The inventory's types live in [`@delo/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md).

## Status

The inventory, the patch rule and `delorun plugin check` are built; no release workflow runs the signing command that applies the rule.

- **Built and reached:** the inventory `plugin-interface.json` and the spec that fails when the sources declare an interface it does not list; the patch rule in the signing command under `delo/apps/release/src/`, which a person runs by hand ([C2](c02-release-manifest.md#status)); and `delorun plugin check`.
- **Not built:** a release workflow, so the rule applies only when a person signs a release ([release workflow design](../design/release-workflow.md)).

## Contents

- [Status](#status)
- [Covered interfaces](#covered-interfaces)
- [What each release may change](#what-each-release-may-change)
- [Versions before 1.0](#versions-before-10)
- [Targeting Delo](#targeting-delo)
- [Checking a plugin](#checking-a-plugin)
- [The patch rule](#the-patch-rule)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## Covered interfaces

The promise covers the entries under `covered` in the inventory `delo/packages/contract-plugin-versions/plugin-interface.json`, schema `delo.plugin-interface/1`, and nothing else:

| Kind | Covered | Where it is declared |
| --- | --- | --- |
| `service` | The Cordis services `deloStudio` and `deloOnboarding` in the browser, and `deloWorkspaces` and `deloChatStates`: their names and the members of the types they are declared with | The `interface Context` member in the named source file |
| `event` | None: Delo documents no event for third-party plugins, so every event it declares is `internal` | The `interface Events` member in the named source file |
| `manifest-field` | `engines.delo` and its evaluation ([C17](c17-plugin-versions.md#evaluation)) | Upstream's `plugin-compatibility.ts` with Delo's edit |

A `service` or `event` entry names the member, its source file and its side, `host` or `browser` (a source under a `client/` directory). Every other service, and every event, declared in `declare module '@deepseek-ai/cordis'` in a `.ts`, `.tsx` or `.d.ts` file under `delo/packages/*/src` or `delo/apps/*/src` is listed under `internal`: Delo's own code uses it, and a plugin that uses it gets no promise. Upstream's interfaces belong to the upstream axis. Delo's files under the home, its configuration rows and its Connection routes are not plugin interfaces.

A spec of the release tool fails when a Delo package or app declares a service or event that the inventory does not list, or the inventory lists one that is no longer declared.

## What each release may change

| Release | Covered interfaces | Upstream base (`dsh`) | Data formats |
| --- | --- | --- | --- |
| Patch, `x.y.z` to `x.y.z+1` | Unchanged: nothing added, removed or changed | Unchanged | Unchanged |
| Minor, `x.y` to `x.y+1` | May add; from 1.0, may not remove or change one incompatibly | May move | May change; the update report names it ([C3](c03-update-report.md#data-formats)) |
| Major, `x` to `x+1` | May remove or change any | May move | May change |

A security fix is a patch whenever it can be one, so it turns off no plugin on either axis. A fix that cannot keep the base or the covered interfaces ships as a minor, and the update notice says how many plugins it would turn off ([design](../design/update-notice.md)).

## Versions before 1.0

Before 1.0 a minor release, `0.y` to `0.y+1`, is read as a major one: it may remove or change a covered interface. A patch, `0.y.z` to `0.y.z+1`, keeps the promise above. A range written with `^`, such as `^0.1.0`, admits `>=0.1.0 <0.2.0`, which is exactly one minor and its patches. A pre-release such as `0.2.0-rc.1` takes part in range matching ([C17](c17-plugin-versions.md#the-two-versions)) and makes no promise to a plugin beyond its own version.

## Targeting Delo

A plugin that uses a covered interface declares `engines.delo`:

- Before 1.0, `^0.<minor>.0`, the minor it was tested on and its patches.
- From 1.0, `^<major>.<minor>.0`, the minor it needs and every later minor of that major.

It also declares `engines.dsh` for the upstream interfaces it uses, because a later Delo minor may move the upstream base. A plugin that uses no covered interface declares no `engines.delo` and runs on any Delo, as on stock DSH.

## Checking a plugin

`delorun plugin check <directory>` reads the directory's `package.json` as JSON, at most 1 MiB, and runs none of the plugin's files. It refuses a `package.json` that is a symbolic link, a FIFO or anything but a regular file, without following or waiting on it, and prints the manifest's strings with terminal control characters escaped. It evaluates both axes against the running release with upstream's `evaluatePluginCompatibility`, the evaluation the installer and the start's preflight run, with no exemption, and prints:

- the plugin's name and version, and the running Delo and DSH versions;
- for the upstream axis, `engines.dsh` and whether it admits the running DSH, or each `@deepseek-ai/dsh*` peer range and whether it does, or that nothing is declared;
- for the Delo axis, `engines.delo` and whether it admits the running Delo, or that nothing is declared and the range that targets the running minor;
- whether the installer admits the plugin on this release, and its refusal message when it does not.

It exits 0 when the installer admits the plugin and 1 when it refuses it or cannot read its declarations.

## The patch rule

Signing refuses a release `x.y.z` when an earlier release tag `vx.y.w` exists, `w` below `z` and not a pre-release, and any of these differ between that tag's commit and the release's commit ([C2](c02-release-manifest.md)):

- the upstream version, `packages/boot/app-boot/package.json`'s `version`, which must also equal the draft's `dsh`;
- the data formats: `docs/persistence-schema.json` and `delo/packages/update/src/data-records.json`;
- the `covered` list of the inventory, or a covered service or event that the release commit no longer declares or a covered manifest field it no longer reads.

An `x.y.0` release is not a patch and is not compared. A patch version with no earlier release of its minor tagged refuses unless the signer passes `--first-of-line`, and the earlier tags must lie on the release commit's history and agree with the versions `delo/changelog/changelog.json` records at the release commit ([C2](c02-release-manifest.md)), so a checkout without the published tags does not skip the rule.

## Consumers

- `delo/apps/release`: the patch rule at signing, and the inventory's spec.
- `delo/apps/cli`: `delorun plugin check`.
- Plugin authors, through this page and the command.

## Compatibility

The inventory's `schema` names its major version. The `event` kind was added to `delo.plugin-interface/1` before any release was published. Moving an entry from `internal` to `covered` is a minor release's change; moving one from `covered` to `internal` removes it from the promise, which from 1.0 needs a major release.

## Security

### Requirements

- R1. `delorun plugin check` never imports, requires or runs a file of the plugin it checks.
- R2. A patch release never moves the upstream base, changes the data formats or changes the covered inventory, and a missing earlier release tag never skips this check.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `plugin-check-imports-no-code` | update-notice | A plugin whose entry file and install scripts would write a canary leaves no canary after the check. |
| `patch-rule-refuses-base-move` | update-notice | A patch whose upstream version differs from the earlier release's refuses to sign. |
| `patch-rule-refuses-draft-base-mismatch` | update-notice | A draft whose `dsh` differs from the release commit's upstream version refuses to sign. |
| `patch-rule-refuses-persistence-change`, `patch-rule-refuses-delo-record-change` | update-notice | A patch whose data formats differ refuses to sign. |
| `patch-rule-refuses-interface-removal`, `patch-rule-refuses-interface-addition` | update-notice | A patch whose covered inventory differs refuses to sign. |
| `patch-rule-refuses-missing-inventory` | update-notice | A patch whose earlier release has no inventory refuses to sign. |
| `patch-rule-refuses-patch-without-earlier-release` | update-notice | A patch version with no earlier release of its minor refuses to sign without `--first-of-line`. |
| `patch-rule-refuses-tag-on-wrong-commit`, `patch-rule-refuses-release-missing-from-changelog` | update-notice | An earlier release tag off the release commit's history, or one that disagrees with the committed changelog, refuses to sign. |

### What this does not prove

- The rule compares names; it does not compare the declarations' text. Hashing the text of each covered declaration, which would catch a changed member type, is the rule's next step. A changed type or behaviour within a patch is caught only by review.
- The rule finds earlier releases from the repository's tags, checked against git's history and the committed changelog. That changelog records versions, not commits, so a tag moved to another ancestor commit passes ([C2](c02-release-manifest.md#what-this-does-not-prove)).
