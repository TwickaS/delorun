---
description: "Contract C22: what a Delorun version promises a plugin: the interfaces the promise covers and their inventory, what a patch, a minor and a major release may change, the upstream base fixed within a minor, how versions before 1.0 are read, how a plugin targets Delorun with engines.delorun, and the release tool's patch rule."
---

# C22 What a Delorun version promises a plugin

English | [中文](c22-delorun-plugin-interface.zh.md)

## Summary

A plugin can declare two version ranges ([C17](c17-plugin-versions.md)): upstream's, `engines.dsh`, and Delorun's, `engines.delorun`. On Delorun, a plugin that declares `engines.delorun` is checked on that range alone and its DSH ranges are not checked; a plugin that declares none is checked on its upstream range, as on stock DSH. This page states what Delorun's version promises a plugin that declares `engines.delorun`: which interfaces the promise covers, what each kind of release may change, that a minor release keeps one upstream base, and how versions before 1.0 are read. The release tool refuses a patch release that would break the promise as far as it can check mechanically. `delorun plugin check <directory>` shows an author what their ranges admit. The inventory's types live in [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md).

## Status

The inventory, the patch rule and `delorun plugin check` are built; no release workflow runs the signing command that applies the rule.

- **Built and reached:** the inventory `plugin-interface.json` and the spec that fails when the sources declare an interface it does not list; the patch rule in the signing command under `delorun/apps/release/src/`, which a person runs by hand ([C2](c02-release-manifest.md#status)); and `delorun plugin check`.
- **Not built:** a release workflow, so the rule applies only when a person signs a release ([release workflow design](../design/release-workflow.md)).

## Contents

- [Status](#status)
- [Covered interfaces](#covered-interfaces)
- [What each release may change](#what-each-release-may-change)
- [Versions before 1.0](#versions-before-10)
- [Targeting Delorun](#targeting-delorun)
- [Checking a plugin](#checking-a-plugin)
- [The patch rule](#the-patch-rule)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## Covered interfaces

The promise covers the entries under `covered` in the inventory `delorun/packages/contract-plugin-versions/plugin-interface.json`, schema `delorun.plugin-interface/1`, and nothing else:

| Kind | Covered | Where it is declared |
| --- | --- | --- |
| `service` | The Cordis services `delorunStudio` and `delorunOnboarding` in the browser, and `delorunWorkspaces` and `delorunChatStates`: their names and the members of the types they are declared with | The `interface Context` member in the named source file |
| `event` | None: Delorun documents no event for third-party plugins, so every event it declares is `internal` | The `interface Events` member in the named source file |
| `manifest-field` | `engines.delorun` and its evaluation ([C17](c17-plugin-versions.md#evaluation)) | Upstream's `plugin-compatibility.ts` with Delorun's edit |

A `service` or `event` entry names the member, its source file and its side, `host` or `browser` (a source under a `client/` directory). Every other service, and every event, declared in `declare module '@deepseek-ai/cordis'` in a `.ts`, `.tsx` or `.d.ts` file under `delorun/packages/*/src` or `delorun/apps/*/src` is listed under `internal`: Delorun's own code uses it, and a plugin that uses it gets no promise. Upstream's interfaces belong to the upstream axis. Delorun's files under the home, its configuration rows and its Connection routes are not plugin interfaces.

A spec of the release tool fails when a Delorun package or app declares a service or event that the inventory does not list, or the inventory lists one that is no longer declared.

## What each release may change

| Release | Covered interfaces | Upstream base (`dsh`) | Data formats |
| --- | --- | --- | --- |
| Patch, `x.y.z` to `x.y.z+1` | Unchanged: nothing added, removed or changed | Unchanged | Unchanged |
| Minor, `x.y` to `x.y+1` | May add; from 1.0, may not remove or change one incompatibly | May move | May change; the update report names it ([C3](c03-update-report.md#data-formats)) |
| Major, `x` to `x+1` | May remove or change any | May move | May change |

A security fix is a patch whenever it can be one, so it turns off no plugin on either axis. A fix that cannot keep the base or the covered interfaces ships as a minor, and the update notice says how many plugins it would turn off ([design](../design/update-notice.md)).

## Versions before 1.0

Before 1.0 a minor release, `0.y` to `0.y+1`, is read as a major one: it may remove or change a covered interface. A patch, `0.y.z` to `0.y.z+1`, keeps the promise above. A range written with `^`, such as `^0.1.0`, admits `>=0.1.0 <0.2.0`, which is exactly one minor and its patches. A pre-release such as `0.2.0-rc.1` takes part in range matching ([C17](c17-plugin-versions.md#the-two-versions)) and makes no promise to a plugin beyond its own version.

## Targeting Delorun

A plugin that uses a covered interface declares `engines.delorun`:

- Before 1.0, `^0.<minor>.0`, the minor it was tested on and its patches.
- From 1.0, `^<major>.<minor>.0`, the minor it needs and every later minor of that major.

`engines.delorun` decides alone on Delorun, so a plugin that targets Delorun needs no `engines.dsh` there. It declares `engines.dsh` as well only so that the same package also runs on stock DeepSeek Harness, which ignores `engines.delorun` and checks `engines.dsh`; Delorun does not read that range when `engines.delorun` is declared. A plugin that uses no covered interface declares no `engines.delorun`, is checked on its `engines.dsh` or DSH peers against the DSH version Delorun reports, and runs on any Delorun that DSH version satisfies, as on stock DSH. A later Delorun minor may move the upstream base, which a plugin that declares `engines.delorun` states by the Delorun range it tests on.

## Checking a plugin

`delorun plugin check <directory> [--json]` reads the directory's `package.json` as JSON, at most 1 MiB, and runs none of the plugin's files. It refuses a `package.json` that is a symbolic link, a FIFO or anything but a regular file, without following or waiting on it, and prints the manifest's strings with terminal control characters escaped. It decides the plugin against the running release with upstream's `evaluatePluginCompatibility`, the evaluation the installer and the start's preflight run, with no exemption, and prints:

- the plugin's name and version, and the running Delorun and DSH versions;
- for the Delorun axis, `engines.delorun` and whether it admits the running Delorun, and that it decides alone, so that the DSH ranges are not checked on Delorun; or that nothing is declared and the range that targets the running minor;
- for the upstream axis, when `engines.delorun` is declared, that it is not checked on Delorun, and no verdict; otherwise `engines.dsh` and whether it admits the running DSH, or each `@deepseek-ai/dsh*` peer range and whether it does, or that nothing is declared;
- whether the installer admits the plugin on this release, and its refusal message when it does not.

It exits 0 when the installer admits the plugin and 1 when it refuses it or cannot read its declarations.

With `--json` it prints one JSON object on one line, and no other output, for tools that must not read English text. Its fields, all always present:

| Field | Meaning |
| --- | --- |
| `decidedBy` | `delorun` when `engines.delorun` is declared, else `dsh` when `engines.dsh` is, else `peer` when a `@deepseek-ai/dsh*` peer is, else `none`. |
| `range` | The range that decided, with leading and trailing whitespace trimmed; for `peer`, each DSH peer as `<name> <range>` joined by `, `; `null` for `none`, when `engines.delorun` or `engines.dsh` is not a string, and for an empty or whitespace-only `engines.delorun`, which is unreadable. |
| `checkedAgainst` | The version the range was checked against: the running Delorun's for `delorun`, the running DSH's for `dsh` and `peer`; `null` for `none`. |
| `verdict` | `admitted` or `refused`: the installer's decision on this release. |
| `readable` | `false` when a declaration is in a form Delorun cannot read, which is refused. |

A declaration Delorun cannot read is refused with `readable` false: a `peerDependencies` that is not an object gives `decidedBy` `none`, `range` `null`, `checkedAgainst` `null` and `verdict` `refused`; a DSH peer whose range is not a string gives `decidedBy` `peer`, `verdict` `refused`, and the peer as `<name> <value>` in `range`. The exit code is the same as without `--json`. The record is the return value of `decidePluginVersion` in `@delorun/update`, a pure function of a parsed manifest, a Delorun version and a DSH version: prereleases take part in ranges, no exemption applies, and nothing reads a file or the environment. The four shapes a tool most needs to tell apart are decided as follows: only `engines.delorun` (`decidedBy` `delorun`); only `engines.dsh` (`dsh`, with peers read only when `engines.dsh` is absent); both, which `engines.delorun` decides, so one that admits is `admitted` whatever `engines.dsh` says; and both with `engines.delorun` refusing, which is `refused` whatever `engines.dsh` says.

## The patch rule

Signing refuses a release `x.y.z` when an earlier release tag `vx.y.w` exists, `w` below `z` and not a pre-release, and any of these differ between that tag's commit and the release's commit ([C2](c02-release-manifest.md)):

- the upstream version, `packages/boot/app-boot/package.json`'s `version`, which must also equal the draft's `dsh`;
- the data formats: `docs/persistence-schema.json` and `delorun/packages/update/src/data-records.json`;
- the `covered` list of the inventory, or a covered service or event that the release commit no longer declares or a covered manifest field it no longer reads.

An `x.y.0` release is not a patch and is not compared. A patch version with no earlier release of its minor tagged refuses unless the signer passes `--first-of-line`, and the earlier tags must lie on the release commit's history and agree with the versions `delorun/changelog/changelog.json` records at the release commit ([C2](c02-release-manifest.md)), so a checkout without the published tags does not skip the rule.

## Consumers

- `delorun/apps/release`: the patch rule at signing, and the inventory's spec.
- `delorun/apps/cli`: `delorun plugin check`.
- Plugin authors, through this page and the command.

## Compatibility

The inventory's `schema` names its major version. Moving an entry from `internal` to `covered` is a minor release's change; moving one from `covered` to `internal` removes it from the promise, which from 1.0 needs a major release.

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
| `patch-rule-refuses-persistence-change`, `patch-rule-refuses-delorun-record-change` | update-notice | A patch whose data formats differ refuses to sign. |
| `patch-rule-refuses-interface-removal`, `patch-rule-refuses-interface-addition` | update-notice | A patch whose covered inventory differs refuses to sign. |
| `patch-rule-refuses-missing-inventory` | update-notice | A patch whose earlier release has no inventory refuses to sign. |
| `patch-rule-refuses-patch-without-earlier-release` | update-notice | A patch version with no earlier release of its minor refuses to sign without `--first-of-line`. |
| `patch-rule-refuses-tag-on-wrong-commit`, `patch-rule-refuses-release-missing-from-changelog` | update-notice | An earlier release tag off the release commit's history, or one that disagrees with the committed changelog, refuses to sign. |

### What this does not prove

- The rule compares names; it does not compare the declarations' text. Hashing the text of each covered declaration, which would catch a changed member type, is the rule's next step. A changed type or behaviour within a patch is caught only by review.
- The rule finds earlier releases from the repository's tags, checked against git's history and the committed changelog. That changelog records versions, not commits, so a tag moved to another ancestor commit passes ([C2](c02-release-manifest.md#what-this-does-not-prove)).
