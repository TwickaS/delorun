---
description: "Contract C17: the two version axes a plugin is checked on, upstream's engines.dsh against @deepseek-ai/dsh-app-boot and Delorun's engines.delorun against Delorun's own version, how a plugin declares them, the exact-version exemptions, refusal and report messages for each mismatch, and the output of delorun --version."
---

# C17 Plugin version requirements

English | [中文](c17-plugin-versions.zh.md)

## Summary

Delorun has its own semantic version and builds on one upstream DSH version, so a plugin is checked on two axes. The upstream axis is unchanged: `engines.dsh` (or, without it, the plugin's `@deepseek-ai/dsh*` peer dependencies) is checked against the version of `@deepseek-ai/dsh-app-boot` by upstream's `evaluatePluginCompatibility`. The Delorun axis is `engines.delorun`, checked against Delorun's version with the same rules. A plugin written for stock DSH declares no `engines.delorun` and is compatible on the Delorun axis. Each axis has its own exact-version exemption, which the person grants after a risk warning. Every refusal and every update-report line names both versions. [C22](c22-delorun-plugin-interface.md) states what a Delorun version promises a plugin that declares `engines.delorun`, and `delorun plugin check` shows an author what their ranges admit before they install. The types live in [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md).

## Status

Both axes are checked at install, at every start of a profile `delorun` runs, and in the update report; the Delorun-axis exemption, the studio's report and the messages as listed here are not built.

- **Built and reached:** `evaluatePluginCompatibility` in upstream's app-boot checks `engines.delorun` against the Delorun version `delorun` exports; the plugin manager refuses an install on either axis, upstream's profile preflight disables an unmet row before the Loader imports it, `delorun update`'s report names both axes, and `delorun --version` prints both versions. The upstream-axis exemption works through `delorun plugin --profile default allow-version ... --dsh-version`, which passes through to upstream.
- **Not built:** the Delorun-axis exemption: no code writes `delorun-compatibility.json`, a Delorun mismatch is never exempted, and `delorun plugin --profile default allow-version ... --delorun-version` is refused by upstream's argument parser although the printed remedy names it; the studio's report with Update, Keep disabled and Roll back, since a row disabled at start is reported by one line on standard error; the message table below, since the built text is upstream's sentence followed by Delorun's sentence; the catalogue corpus and its badges; the Verification panel and `delorun status` showing the versions.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

## Contents

- [Status](#status)
- [The two versions](#the-two-versions)
- [Declaring requirements](#declaring-requirements)
- [Evaluation](#evaluation)
- [Checking a plugin before it is installed](#checking-a-plugin-before-it-is-installed)
- [Exemptions](#exemptions)
- [Results and messages](#results-and-messages)
- [Version output](#version-output)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## The two versions

| Axis | Version | Source |
| --- | --- | --- |
| Upstream | DSH version | The `version` of `@deepseek-ai/dsh-app-boot` in the running runtime, read by upstream's `getDshRuntimeVersion()` in [`plugin-compatibility.ts`](../../../packages/boot/app-boot/src/plugin-compatibility.ts). The release manifest records it as `dsh` ([C2](c02-release-manifest.md#release-manifest)). |
| Delorun | Delorun version | Delorun's release version, the manifest's `version`, read by every Delorun process through `delorun/apps/cli/src/version.ts`; the desktop app's application version equals it. |

Both are semantic versions; prereleases (`1.0.0-rc.1`) take part in range matching.

## Declaring requirements

A plugin declares both in its `package.json`:

```json
{
  "name": "example-delorun-plugin",
  "version": "1.4.0",
  "engines": {
    "dsh": ">=0.2.2 <0.3.0",
    "delorun": ">=1.0.0 <2.0.0"
  }
}
```

- `engines.dsh` follows upstream's rules unchanged: when present it decides the upstream axis alone; when absent, every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer dependency must match, with `workspace:^`, `workspace:~` and `workspace:*` meaning the running version.
- `engines.delorun` is a semantic-version range string. It alone decides the Delorun axis; peer dependencies on `@delorun/*` packages are not read for it.
- A plugin that declares no `engines.delorun` has no Delorun requirement.
- The catalogue index copies both ranges into each version entry ([C13](c13-catalogue-revocation.md#catalogue-index)).

## Evaluation

For each axis, with `semver.satisfies(version, range, { includePrerelease: true })`:

| Declaration | Upstream axis | Delorun axis |
| --- | --- | --- |
| Range that the version satisfies | met | met |
| Range that the version does not satisfy | unmet | unmet |
| Empty string, a `workspace:` value or an invalid range | unmet | unmet |
| Not a string | unreadable | unreadable |
| Absent | decided by the peer rule: met or unmet, or `none` when the plugin has no DSH peer | `none` |

An unreadable declaration is treated as unmet: upstream refuses requirement metadata it cannot validate, and the Delorun axis does the same. Evaluation reads only the plugin's manifest and never imports plugin code.

Where the axes are checked:

- at install, by the plugin manager, before the package is added;
- at every start, by upstream's profile preflight (`prepareProfileEntries` in [`compatibility-preflight.ts`](../../../packages/boot/app-boot/src/compatibility-preflight.ts)), which disables an unmet row before the Loader imports it and prints one line to standard error naming the row and the reason; the studio shows no report;
- before an update, against the target release's two versions, for the update report ([C3](c03-update-report.md)), by the same upstream functions with the target's versions, so the peer rule applies there too;
- by the update check, against the channel's newest release's two versions, to count the installed plugins it would disable ([C3](c03-update-report.md#update-check));
- in the catalogue corpus, which records the versions a badge ran ([C13](c13-catalogue-revocation.md#badge-record)).

## Checking a plugin before it is installed

`delorun plugin check <directory>` reads a plugin's `package.json` without running any of its files and evaluates both axes against the running release with the installer's own functions, `evaluatePluginCompatibility` and `evaluateDelorunRequirement`, and no exemption; the update report and the update check call the same ones. It prints what each declared range admits, what is undeclared, the `engines.delorun` range that targets the running Delorun minor, and whether the installer admits the plugin; [C22](c22-delorun-plugin-interface.md#checking-a-plugin) states its output and exit codes. A plugin targets Delorun with `engines.delorun` alone: the Delorun axis never overrides the upstream axis, and a plugin that uses upstream interfaces still declares `engines.dsh`.

## Exemptions

The person can accept an unmet requirement for one exact plugin version on one exact version of the axis, after the warning that running it may cause crashes or data loss.

| Axis | File in the profile directory | Command |
| --- | --- | --- |
| Upstream | `compatibility.json`, upstream's file, unchanged | `delorun plugin --profile default allow-version <package>@<version> --dsh-version <dsh> --accept-risk` |
| Delorun | `delorun-compatibility.json`, the same record format: exact `package@version` keys mapped to lists of exact Delorun versions; not built: nothing writes it, and the start check reads no Delorun exemption | `delorun plugin --profile default allow-version <package>@<version> --delorun-version <delorun> --accept-risk`; not built: upstream's parser refuses `--delorun-version` |

- Both files are written atomically with mode 0600 under the file's lock, as upstream's `setProfileVersionExemption` writes `compatibility.json`.
- A grant must name the running version of its axis; a revocation may name an earlier one.
- A missing file grants nothing; an unreadable file grants nothing and is reported, and the profile still starts.
- An exemption covers exactly one axis: a plugin unmet on both axes needs both.
- A grant is a profile change and is recorded as a history version.

## Results and messages

The result of evaluating one plugin against one pair of versions:

| Field | Meaning |
| --- | --- |
| `plugin` | `{ "name", "version" }` from the manifest. |
| `dsh` | The DSH version checked. |
| `delorun` | The Delorun version checked. |
| `axes.dsh`, `axes.delorun` | Each `{ "status", "requirement"?, "exempted" }`; `status` is `met`, `unmet`, `unreadable` or `none`. |

Messages, in English in logs and stderr and localised in the studio. The built text differs: a refusal and a start-time line carry upstream's sentence for the upstream axis followed by Delorun's sentence for the Delorun axis, both naming the Delorun and the DSH version, and the studio shows none of them.

| Case | Message |
| --- | --- |
| Install refused, upstream axis | `<package>@<version> requires DSH <range>; this is Delorun <delorun> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk.` |
| Install refused, Delorun axis | `<package>@<version> requires Delorun <range>; this is Delorun <delorun> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --delorun-version <delorun> --accept-risk.` |
| Install refused, unreadable | `<package>@<version> declares engines.<axis> in a form Delorun cannot read; this is Delorun <delorun> on DSH <dsh>. It was not installed.` |
| Disabled at start | `Disabled <package>@<version>: it requires <DSH or Delorun> <range>, and this is Delorun <delorun> on DSH <dsh>.` |
| Exempted | `<package>@<version> requires <DSH or Delorun> <range>; it runs on Delorun <delorun> on DSH <dsh> because you accepted the risk for this exact version.` |

The update report's item for each case is in [C3](c03-update-report.md#reasons).

## Version output

`delorun --version` prints exactly two lines:

```text
Delorun 1.0.0
DSH 0.2.2
```

`delorun --version --json` prints one line, `{"delorun":"1.0.0","dsh":"0.2.2"}`. The Verification panel does not exist, and `delorun status` does not show the versions.

## Consumers

- Upstream's app-boot hunk in `plugin-compatibility.ts` and `delorun/apps/cli/src/version.ts` (WP3.8).
- The pre-update report (WP3.4, [C3](c03-update-report.md)).
- The catalogue corpus and badges (WP7.2, [C13](c13-catalogue-revocation.md)).
- The update check's plugin count ([C3](c03-update-report.md#update-check)) and `delorun plugin check` ([C22](c22-delorun-plugin-interface.md)).

## Compatibility

Upstream's axis, its peer rule, `compatibility.json` and `dsh plugin allow-version` are unchanged, so a stock DSH plugin installs and loads on Delorun exactly as on stock DSH. Stock DSH ignores `engines.delorun`, so a plugin that declares it still installs on stock DSH, where only its upstream requirement is checked. In the parity composition ([C16](c16-parity-composition.md)) the Delorun axis stays on, because it changes no model-visible input.

## Security

### Requirements

- R1. A plugin whose requirement on either axis is unmet or unreadable is refused at install and disabled at start, never loaded silently.
- R2. Every refusal and report names both the Delorun and the DSH version.
- R3. An exemption covers one exact plugin version, one axis and one exact version, needs the person's explicit risk acceptance, and is stored mode 0600.
- R4. Evaluation never imports plugin code.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `c17-newer-delorun-required-refused` | WP3.8 | A plugin with `engines.delorun` `>=2.0.0` is refused at install on Delorun 1.x with the message naming both versions. |
| `c17-unmet-delorun-disabled-at-start` | WP3.8 | An installed plugin whose `engines.delorun` the running Delorun does not satisfy is disabled before import and reported in the studio. |
| `c17-unreadable-delorun-refused` | WP3.8 | A plugin whose `engines.delorun` is a number is refused as unreadable. |
| `c17-exemption-one-axis-only` | WP3.8 | A Delorun-axis exemption does not admit a plugin whose upstream requirement is also unmet. |
| `c17-exemption-needs-accept-risk` | WP3.8 | A grant without `--accept-risk`, or naming a Delorun version other than the running one, is refused. |
| `c17-stock-plugin-unaffected` | WP3.8 | A plugin without `engines.delorun` installs and loads exactly as on stock DSH. |
| `plugin-check-imports-no-code` | update-notice | `delorun plugin check` reads the manifest and runs none of the plugin's files. |
| `plugin-check-refuses-special-files` | update-notice | A manifest that is a FIFO or a symbolic link is refused without waiting or following it. |
| `plugin-check-escapes-manifest-text` | update-notice | The manifest's name and ranges print with terminal control characters escaped. |
| `c17-version-output` | WP3.8 | `delorun --version` prints the two lines with the Delorun and the DSH version. |
