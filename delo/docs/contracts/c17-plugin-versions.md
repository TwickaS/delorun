---
description: "Contract C17: the two version axes a plugin is checked on, upstream's engines.dsh against @deepseek-ai/dsh-app-boot and Delo's engines.delo against Delo's own version, how a plugin declares them, the exact-version exemptions, refusal and report messages for each mismatch, and the output of delorun --version."
---

# C17 Plugin version requirements

English | [中文](c17-plugin-versions.zh.md)

## Summary

Delo has its own semantic version and builds on one upstream DSH version, so a plugin is checked on two axes. The upstream axis is unchanged: `engines.dsh` (or, without it, the plugin's `@deepseek-ai/dsh*` peer dependencies) is checked against the version of `@deepseek-ai/dsh-app-boot` by upstream's `evaluatePluginCompatibility`. The Delo axis is `engines.delo`, checked against Delo's version with the same rules. A plugin written for stock DSH declares no `engines.delo` and is compatible on the Delo axis. Each axis has its own exact-version exemption, which the person grants after a risk warning. Every refusal and every update-report line names both versions. The types live in [`@delo/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md).

## Contents

- [The two versions](#the-two-versions)
- [Declaring requirements](#declaring-requirements)
- [Evaluation](#evaluation)
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
| Delo | Delo version | Delo's release version, the manifest's `version`, read by every Delo process through `delo/apps/cli/src/version.ts`; the desktop app's application version equals it. |

Both are semantic versions; prereleases (`1.0.0-rc.1`) take part in range matching.

## Declaring requirements

A plugin declares both in its `package.json`:

```json
{
  "name": "example-delo-plugin",
  "version": "1.4.0",
  "engines": {
    "dsh": ">=0.2.2 <0.3.0",
    "delo": ">=1.0.0 <2.0.0"
  }
}
```

- `engines.dsh` follows upstream's rules unchanged: when present it decides the upstream axis alone; when absent, every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer dependency must match, with `workspace:^`, `workspace:~` and `workspace:*` meaning the running version.
- `engines.delo` is a semantic-version range string. It alone decides the Delo axis; peer dependencies on `@delo/*` packages are not read for it.
- A plugin that declares no `engines.delo` has no Delo requirement.
- The catalogue index copies both ranges into each version entry ([C13](c13-catalogue-revocation.md#catalogue-index)).

## Evaluation

For each axis, with `semver.satisfies(version, range, { includePrerelease: true })`:

| Declaration | Upstream axis | Delo axis |
| --- | --- | --- |
| Range that the version satisfies | met | met |
| Range that the version does not satisfy | unmet | unmet |
| Empty string, a `workspace:` value or an invalid range | unmet | unmet |
| Not a string | unreadable | unreadable |
| Absent | decided by the peer rule: met or unmet, or `none` when the plugin has no DSH peer | `none` |

An unreadable declaration is treated as unmet: upstream refuses requirement metadata it cannot validate, and the Delo axis does the same. Evaluation reads only the plugin's manifest and never imports plugin code.

Where the axes are checked:

- at install, by the plugin manager, before the package is added;
- at every start, by upstream's profile preflight (`prepareProfileEntries` in [`compatibility-preflight.ts`](../../../packages/boot/app-boot/src/compatibility-preflight.ts)), which disables an unmet row before the Loader imports it and reports it in the studio with Update, Keep disabled and Roll back;
- before an update, against the target release's two versions, for the update report ([C3](c03-update-report.md));
- in the catalogue corpus, which records the versions a badge ran ([C13](c13-catalogue-revocation.md#badge-record)).

## Exemptions

The person can accept an unmet requirement for one exact plugin version on one exact version of the axis, after the warning that running it may cause crashes or data loss.

| Axis | File in the profile directory | Command |
| --- | --- | --- |
| Upstream | `compatibility.json`, upstream's file, unchanged | `delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk` |
| Delo | `delo-compatibility.json`, the same record format: exact `package@version` keys mapped to lists of exact Delo versions | `delorun plugin allow-version <package>@<version> --delo-version <delo> --accept-risk` |

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
| `delo` | The Delo version checked. |
| `axes.dsh`, `axes.delo` | Each `{ "status", "requirement"?, "exempted" }`; `status` is `met`, `unmet`, `unreadable` or `none`. |

Messages, in English in logs and stderr and localised in the studio:

| Case | Message |
| --- | --- |
| Install refused, upstream axis | `<package>@<version> requires DSH <range>; this is Delo <delo> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk.` |
| Install refused, Delo axis | `<package>@<version> requires Delo <range>; this is Delo <delo> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --delo-version <delo> --accept-risk.` |
| Install refused, unreadable | `<package>@<version> declares engines.<axis> in a form Delo cannot read; this is Delo <delo> on DSH <dsh>. It was not installed.` |
| Disabled at start | `Disabled <package>@<version>: it requires <DSH or Delo> <range>, and this is Delo <delo> on DSH <dsh>.` |
| Exempted | `<package>@<version> requires <DSH or Delo> <range>; it runs on Delo <delo> on DSH <dsh> because you accepted the risk for this exact version.` |

The update report's item for each case is in [C3](c03-update-report.md#reasons).

## Version output

`delorun --version` prints exactly two lines:

```text
Delo 1.0.0
DSH 0.2.2
```

`delorun --version --json` prints one line, `{"delo":"1.0.0","dsh":"0.2.2"}`. The Verification panel and `delorun status` show the same two versions.

## Consumers

- Upstream's app-boot hunk in `plugin-compatibility.ts` and `delo/apps/cli/src/version.ts` (WP3.8).
- The pre-update report (WP3.4, [C3](c03-update-report.md)).
- The catalogue corpus and badges (WP7.2, [C13](c13-catalogue-revocation.md)).

## Compatibility

Upstream's axis, its peer rule, `compatibility.json` and `dsh plugin allow-version` are unchanged, so a stock DSH plugin installs and loads on Delo exactly as on stock DSH. Stock DSH ignores `engines.delo`, so a plugin that declares it still installs on stock DSH, where only its upstream requirement is checked. In the parity composition ([C16](c16-parity-composition.md)) the Delo axis stays on, because it changes no model-visible input.

## Security

### Requirements

- R1. A plugin whose requirement on either axis is unmet or unreadable is refused at install and disabled at start, never loaded silently.
- R2. Every refusal and report names both the Delo and the DSH version.
- R3. An exemption covers one exact plugin version, one axis and one exact version, needs the person's explicit risk acceptance, and is stored mode 0600.
- R4. Evaluation never imports plugin code.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `c17-newer-delo-required-refused` | WP3.8 | A plugin with `engines.delo` `>=2.0.0` is refused at install on Delo 1.x with the message naming both versions. |
| `c17-unmet-delo-disabled-at-start` | WP3.8 | An installed plugin whose `engines.delo` the running Delo does not satisfy is disabled before import and reported in the studio. |
| `c17-unreadable-delo-refused` | WP3.8 | A plugin whose `engines.delo` is a number is refused as unreadable. |
| `c17-exemption-one-axis-only` | WP3.8 | A Delo-axis exemption does not admit a plugin whose upstream requirement is also unmet. |
| `c17-exemption-needs-accept-risk` | WP3.8 | A grant without `--accept-risk`, or naming a Delo version other than the running one, is refused. |
| `c17-stock-plugin-unaffected` | WP3.8 | A plugin without `engines.delo` installs and loads exactly as on stock DSH. |
| `c17-version-output` | WP3.8 | `delorun --version` prints the two lines with the Delo and the DSH version. |
