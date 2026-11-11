---
description: "Delo's plugin install check and install records, for maintainers changing what an installation is checked for, what refuses it, what a start compares installed plugins with, and the trust status other surfaces read."
---

# @delo/plugin-install-check

English | [中文](README.zh.md)

## Summary

`@delo/plugin-install-check` provides upstream's `pluginAudit` hook, which the [plugin manager](../../../packages/boot/plugin-manager/README.md) asks before it selects, enables or restores a bundle, so before any of the bundle's plugin code loads, and the `deloPluginTrust` service. For the plugin and every package its installation adds to the profile's lockfile, it shows every finding: a missing integrity or a git source without a full commit, a GitHub advisory, a version published less than a configurable age ago, and a name close to one the profile or Delo already has. A known critical advisory refuses the installation until the person allows it; nothing else refuses. It then records the SHA-256 of every installed file, which each start compares cheaply and `delorun verify` fully. `delorun plugin` runs the same check after its pnpm operation ([`plugin-install-check.ts`](../../apps/cli/src/plugin-install-check.ts)). With its switch off, the parity value, it provides nothing and nothing is audited, as in stock; `@delo/bundle-local` and `@delo/bundle-headless` mount it on.

## Contents

- [Contract](#contract)
- [The trust status](#the-trust-status)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **What is checked.** A plugin installed from npm, a tarball or git, once per installed lockfile reference. The plugin's own package is always checked; of its dependencies, only the lockfile entries that no other install record already holds. A linked folder (`link:`) or a local folder (`file:` directory) is neither checked nor recorded: its files change as the person works on it. A plugin the profile does not depend on, such as an optional bundle the installation ships, is skipped.
- **Findings.** `missing-integrity` and `unpinned-commit` read the lockfile's `resolution`; `advisory` asks npm's bulk advisory API, which answers from the GitHub Advisory Database, through [`@delo/release-formats/advisory/feed`](../release-formats/src/advisory/feed.ts), the client the release's own advisory check uses; `recent-publish` reads `time[version]` from the registry's package document; `similar-name` compares names with their scope and punctuation folded and an edit distance. A feed or registry that cannot be reached, times out or answers malformed is an `advisory-unchecked` or `publish-time-unchecked` finding naming why; no check is skipped silently. Each finding names the package, its version and its lockfile line.
- **Refusal.** Only an advisory whose severity is `critical` refuses. The audit answers `needs-acceptance`, which the studio shows with every finding and an "Install anyway" button; accepting names exactly that set of advisories (the digest `blockingDigest` computes), so a new critical advisory asks again. `delorun plugin` refuses the same advisory and takes `--allow-advisory <GHSA id>`. Every other finding answers `clear`, and the studio lists each one on the done screen.
- **Trusted sources.** A plugin whose npm scope or git owner `trustedSources` lists shows only critical advisories, which still refuse.
- **Install record.** `<profile>/delo-plugin-installs/records/<name>.json` (a scoped name's `/` as `+`), mode 0600 in a 0700 directory: the source (`registry`, `tarball` or `git`, with the lockfile reference, integrity, commit and URL), the version, the findings shown, the advisories allowed, the lockfile entries of the plugin's closure, and per package of the closure its directory, each file's SHA-256 (`link:<target>` for a link) and identity. A refused installation writes none. When the audit meets a plugin whose record names its current lockfile reference, as when it is enabled again, it compares the files, shows the recorded findings and a `changed-files` finding when they differ, and keeps the record as it was.
- **Change check.** `checkProfileTrust` compares each recorded plugin's files with its record. The quick check, which every start runs before the Host boots, hashes only a file whose identity (`@delo/runtime-store/identity`: inode, mode, size, modification and change times) differs from the recorded one, or whose identity could not vouch because its change time lay within two seconds of the capture or its file system is not one whose change times only the local kernel sets; the full check, which `delorun verify` runs, hashes every file. A file added or removed is a change. A check that hashed a file and found it unchanged records its identity again.
- **Never blocking for its own failure.** An error inside the audit answers `clear` with a `delo.check-failed` finding, and a start whose change check fails prints a warning and goes on.

## The trust status

A start and `delorun verify` write the result of their change check to `<profile>/delo-plugin-installs/trust.json`, mode 0600, as a `delo.plugin-trust/1` record. Read it with `readPluginTrust(profileDir)` from `@delo/plugin-install-check/check`, or in the Host through the `deloPluginTrust` service: `status()` reads the last result and `check(full)` runs a check now and writes it. The record:

| Field | Meaning |
| --- | --- |
| `checkedAt` | When the check finished, in milliseconds since the epoch. |
| `mode` | `quick` (a start) or `full` (`delorun verify`, or `check(true)`). |
| `plugins[]` | One entry per plugin from npm, a tarball or git, sorted by name; linked and local folders are left out. |
| `plugins[].state` | `unchanged`, `changed` (a recorded file differs, was added or is gone), or `unrecorded` (no record, or a record for another lockfile reference). Never `unchanged` without a record. |
| `plugins[].changedCount`, `changedFiles` | How many files differ, and up to 20 of them as `<package dir>/<file>`. |
| `plugins[].version`, `installedAt`, `installFindings` | The recorded version, installation time and number of findings shown then; `null` and 0 without a record. |
| `problem` | Present when the profile's lockfile did not read, and `plugins` is then empty. |

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Provide `pluginAudit` and `deloPluginTrust`. Off, the parity value, nothing is audited; Delo's bundles mount it on. |
| `advisoryFeed` | npm's bulk advisory endpoint | An https URL. |
| `registry` | `https://registry.npmjs.org/` | The https registry whose package documents give publish times. |
| `minimumAgeHours` | `24` | A version younger than this is a warning. |
| `similarNameDistance` | `1` | The largest edit distance between names that is a warning, from 0 to 3. |
| `similarNameMinLength` | `4` | Shorter names are not compared. |
| `requestTimeoutMs` | `15000` | Each request's time limit. |
| `requestConcurrency` | `8` | Package documents read at once. |
| `metadataMaxBytes` | 64 MiB | The largest package document read. |
| `maxFiles` | `20000` | Files recorded per package; a package with more is recorded in part and its unrecorded files are not compared. |
| `trustedSources` | `[]` | npm scopes (`@scope`) and git owners (`github.com/owner`) whose plugins show critical advisories only. |

A person changes them by restating the `delo-plugin-install-check` row in the profile's own `cordis.patch.yml` with the whole `config`. `delorun plugin` and a start read the same composed row.

## Known limitations

- The check knows published advisories only. A malicious version that no advisory names yet passes with at most a publish-age or name warning.
- In the studio, pnpm runs the build scripts the person allowed before the audit; `delorun plugin` checks after pnpm, so the same holds. A restore audits before it runs them, and a package whose allowed build writes files after the record then shows as changed at the next start until it is reinstalled.
- The record detects a change made outside the plugin: an edited file, pnpm's store edited through a link, a package operation outside Delo. Code that runs as the person can rewrite the record too.
- Publish times come from the configured registry; a package from a private registry gets a `publish-time-unchecked` finding.

## Tests

[`tests/install-check.integration.spec.ts`](tests/install-check.integration.spec.ts) covers each finding over a hand-written profile and a loopback stand-in for the feed and the registry: the refusal of a critical advisory until it is allowed, the feed and registry failures, trusted scopes and git owners, linked folders, the record and its file hashes, and the change check finding an edited, added or removed file. [`tests/provider.integration.spec.ts`](tests/provider.integration.spec.ts) mounts the plugin and covers its switch, the audit's `clear`, `needs-acceptance` and `accepted` answers, its own failure, `deloPluginTrust`, and the configuration's https and trusted-source validation.
