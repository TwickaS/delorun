---
description: "Contract C2: the files of a Delo release, the signed release manifest and its Ed25519 envelope, the root, targets, timestamp and catalogue key roles, freshness, rollback protection and key rotation, the rebuild the targets-key holder runs before signing, npm trusted publishing, the dependency advisory check and the desktop rollback rule."
---

# C2 Release manifest and signature

English | [中文](c02-release-manifest.zh.md)

## Summary

Every Delo release is a set of files on GitHub Releases described by one release manifest, which the offline targets key signs. The manifest lists every per-platform runtime archive, the desktop installers, the S2 and S3 image digests, the SPDX SBOM, the npm packages and the install scripts, each with its length and SHA-256 digest. An online timestamp key re-signs a small timestamp file daily that names each channel's current manifest and expires after 3 days, so a host that withholds a release is noticed. The root key, also offline, signs the list of keys for every role and each rotation of it. The targets-key holder signs only after rebuilding the release from the tagged source on a machine they control, outside CI, and after the release's lockfile passes the dependency advisory check. Clients (the npm launcher, the install script, the CLI launcher at every start, `delorun verify` and the desktop updater) verify these files as this page states, and also require the release's log entry that [C18](c18-release-log.md) defines. The types live in [`@delo/contract-release-manifest`](../../packages/contract-release-manifest/README.md).

## Contents

- [Release files](#release-files)
- [Signature envelope](#signature-envelope)
- [Key roles](#key-roles)
- [Root metadata](#root-metadata)
- [Timestamp metadata](#timestamp-metadata)
- [Release manifest](#release-manifest)
- [Runtime file list](#runtime-file-list)
- [Client verification](#client-verification)
- [Freshness and rollback protection](#freshness-and-rollback-protection)
- [Key rotation](#key-rotation)
- [Rebuild before signing](#rebuild-before-signing)
- [Dependency advisory check](#dependency-advisory-check)
- [npm publication](#npm-publication)
- [Desktop updates and rollback](#desktop-updates-and-rollback)
- [Values and limits](#values-and-limits)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## Release files

A release with version `<version>` (Delo's semantic version, without a leading `v`) is the git tag `v<version>` of Delo's public repository, `https://github.com/Delo-Run/delo`, and the GitHub release of that tag. Platform identifiers are Node's `process.platform` and `process.arch` joined by a hyphen: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and `win32-x64`.

| File | Content |
| --- | --- |
| `delorun-<version>.manifest.json` | The release manifest in its signature envelope. |
| `delorun-<version>.manifest.log.json` | The manifest's release-log bundle ([C18](c18-release-log.md)). |
| `delorun-<version>-<platform>.tar.gz` | The runtime closure for a Linux or macOS platform. |
| `delorun-<version>-win32-x64.zip` | The runtime closure for Windows. |
| `delorun-<version>-<platform>.files.json` | The runtime file list of that platform's archive. |
| `delorun-<version>.spdx.json` | The SPDX 2.3 JSON SBOM of every archive, installer and image in the release. |
| `delorun-<version>.rebuild.json` | The rebuild record of the targets-key holder's rebuild. |
| `delorun-<version>.advisories.json` | The dependency advisory check's result. |
| `install.sh`, `install.ps1` | The install scripts of this release. |
| `Delo-<version>-mac-arm64.dmg`, `Delo-<version>-mac-x64.dmg` | The macOS desktop installers. |
| `Delo-<version>-mac-arm64.zip`, `Delo-<version>-mac-x64.zip` | The macOS desktop update archives electron-updater applies. |
| `Delo-<version>-win-x64.exe` | The Windows desktop installer (NSIS). |
| `*.blockmap` | electron-updater's block maps of the desktop files. |
| `latest.yml`, `latest-mac.yml` (stable); `beta.yml`, `beta-mac.yml` (beta) | electron-updater's feed files. They are not signed; the desktop app trusts only the manifest. |

Release metadata that is not tied to one release is served as static files through GitHub Pages from a `Delo-Run` repository at `releases.delorun.com`: `root/<n>.root.json` for every root version `n` and `timestamp.json`. The host is not trusted: every file is signed, and a client refuses one that does not verify.

## Signature envelope

Every signed file (root, timestamp, manifest, runtime file list, the catalogue files of [C13](c13-catalogue-revocation.md)) is UTF-8 JSON of this form:

```json
{
  "signed": { "schema": "delo.release-manifest/1" },
  "signatures": [{ "keyid": "<64 lowercase hex>", "sig": "<base64>" }]
}
```

- The signed bytes are the RFC 8785 JSON Canonicalization Scheme serialization of `signed`.
- Each signature is a pure Ed25519 signature (RFC 8032) over those bytes, in standard base64 with padding.
- A key's `keyid` is the lowercase hex SHA-256 of its 32-byte raw public key.
- `signed.schema` names the file kind and its major version; a reader refuses a kind or major version it does not know.
- A file verifies when signatures from distinct keys of the role's current key set reach the role's threshold. Signatures from unknown keys are ignored; a duplicate key counts once.
- Readers refuse unknown fields in `signed`, duplicate JSON keys, and a file above its size limit before parsing it.
- Timestamps are RFC 3339 UTC strings with a `Z` suffix and whole seconds.

## Key roles

| Role | Held | Signs | Threshold |
| --- | --- | --- | --- |
| `root` | Offline, by the owner | Root metadata: every role's keys and thresholds, the witness keys of [C18](c18-release-log.md), and each rotation | 1; 2 of N once maintainers hold root keys |
| `targets` | Offline, by the targets-key holder | Each release manifest and its runtime file lists | 1 |
| `timestamp` | Online, in the release workflow's protected environment | Timestamp metadata only; it attests freshness and names manifests by digest, and cannot change what a manifest lists | 1 |
| `catalogue` | Online, in the catalogue repository's publish environment | The catalogue index and revocation list of [C13](c13-catalogue-revocation.md) | 1 |

The root and targets private keys never enter CI, a cloud service or a machine the release workflow can reach. Windows Authenticode, macOS Developer ID and notarisation are platform signatures on the files themselves; the manifest records the digests of the signed files, and the platform signing route is outside this contract.

## Root metadata

`root/<n>.root.json`, schema `delo.release-root/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer ≥ 1 | Root version `n`; each rotation adds exactly 1. |
| `issued`, `expires` | timestamp | `expires` is at most 365 days after `issued`. |
| `keys` | map of `keyid` to `{ "algorithm": "ed25519", "public": <base64 32 bytes> }` | Every key any role names. |
| `roles.root`, `roles.timestamp`, `roles.catalogue` | `{ "keyids": [...], "threshold": n }` | The role's current keys. |
| `roles.targets` | `{ "keys": [{ "keyid", "status", "lastRelease"? }], "threshold": n }` | `status` is `active`, `retired` or `revoked`; a `retired` key carries `lastRelease`, the last Delo version it signed. |
| `log` | `{ "origin", "vkey" }` | The release log's checkpoint origin line and verifier key ([C18](c18-release-log.md)). |
| `witnesses` | `{ "keys": [{ "name", "vkey" }], "threshold": n }` | The witness verifier keys and how many must cosign ([C18](c18-release-log.md)). |

The npm launcher, the install script and the desktop app each embed the newest root version at their build. A client trusts a newer root only by walking `n + 1, n + 2, …` from the newest it trusts, where each new version verifies with the threshold of the previous version's root keys and with the threshold of its own root keys. A root the client trusts that has expired blocks every install and update until a newer root verifies; it does not stop a start. The root key holder signs the next version at least 30 days before the current one expires.

## Timestamp metadata

`timestamp.json`, schema `delo.release-timestamp/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer ≥ 1 | Adds 1 at every signing. |
| `issued`, `expires` | timestamp | `expires` is exactly 3 days (259,200 seconds) after `issued`. |
| `root` | `{ "version", "sha256" }` | The newest root version and its file digest. |
| `channels.stable`, `channels.beta` | `{ "release": <version>, "manifest": FileRef }` | Each channel's current release and its manifest file. |

A scheduled job of the release workflow re-signs it every 24 hours, and the release workflow signs it again when it publishes a release. `channels.stable` names a stable release; `channels.beta` names a beta release or a stable release. No signing moves a channel to a lower version than the previous timestamp names for it. A `FileRef` is `{ "name", "length", "sha256" }`: the file name, one path segment matching `^[A-Za-z0-9._+-]+$` other than `.` and `..`; its length in bytes; and the lowercase hex SHA-256 of its bytes.

## Release manifest

`delorun-<version>.manifest.json`, schema `delo.release-manifest/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | semantic version | Delo's version of this release. |
| `dsh` | semantic version | The `version` of `@deepseek-ai/dsh-app-boot` in the release, upstream's version ([C17](c17-plugin-versions.md)). |
| `channel` | `stable` or `beta` | The channel the release is published on. |
| `source` | `{ "repository", "tag", "commit" }` | The public repository URL (`https://github.com/Delo-Run/delo`), `v<version>` and the 40-hex commit the tag names. |
| `published` | timestamp | When the targets key signed it. |
| `runtime` | map of platform to `{ "archive": FileRef, "files": FileRef }` | Each runtime archive and its file list. |
| `desktop` | map of `mac-arm64`, `mac-x64`, `win-x64` to `{ "installer": DesktopFileRef, "update": DesktopFileRef, "blockmap": FileRef }` | Desktop files; `DesktopFileRef` adds `sha512`, the standard base64 SHA-512 electron-updater compares. On Windows the installer is also the update file. |
| `images` | `{ "s2": ImageRef, "s3": ImageRef }` | The Docker images [C9](c09-runtime-supervisor.md) runs. `ImageRef` is `{ "repository", "index": "sha256:<hex>", "platforms": { "linux/amd64": "sha256:<hex>", "linux/arm64": "sha256:<hex>" } }`. |
| `sbom` | `FileRef` with `"format": "SPDX-2.3+json"` | The release's SBOM. |
| `npm` | list of `{ "name", "version", "integrity" }` | Each npm package of the release (`delorun`, `create-delorun`) with its tarball's `sha512-` integrity string. |
| `install` | `{ "sh": FileRef, "ps1": FileRef }` | The install scripts; the release notes and the Trust page print the same digests. |
| `rebuild` | `{ "record": FileRef, "builders": [{ "name", "ci": false }] }` | The rebuild record and who rebuilt ([rebuild before signing](#rebuild-before-signing)). |
| `advisories` | `{ "report": FileRef, "accepted": [advisory ids] }` | The advisory check's result and every accepted advisory. |

A manifest carries no expiry: freshness is the timestamp's job, so a manifest stays valid for a rollback to its release for as long as its signing key verifies it.

## Runtime file list

`delorun-<version>-<platform>.files.json`, schema `delo.release-files/1`, signed by the targets key:

| Field | Type | Meaning |
| --- | --- | --- |
| `version`, `platform` | string | The release and platform. |
| `files` | list of `{ "path", "length", "sha256", "mode" }` | Every regular file of the extracted archive; `path` is relative, `/`-separated and normalised, `mode` is `0644` or `0755`. |

The archive holds no symbolic link, hard link, device or path outside its root, and its entries are exactly the list's files. The installed list sits beside the installation at the path [C1](c01-home-layout.md) names.

## Client verification

Installing or updating a runtime (npm launcher, install script, `delorun update`):

1. Read the trusted root and walk to the root the timestamp names.
2. Fetch `timestamp.json`; verify its signature with the timestamp role, its expiry and its `version` against the stored one.
3. Fetch the channel's manifest; check its length and SHA-256 against the timestamp; verify the targets signature.
4. Fetch and verify the release-log bundle and run the online log check ([C18](c18-release-log.md)); installing never proceeds without a verified inclusion proof.
5. Fetch the platform's archive and file list; check each length and SHA-256 against the manifest before extracting; verify the file list's targets signature.
6. Extract into a staging directory outside `~/.delo/runtimes/`, check every entry against the file list, then publish the installation as [C1](c01-home-layout.md) states. No file lands under `~/.delo/runtimes/` before steps 1 to 5 pass.

Every start of the CLI runtime, in every verification mode (`warn`, `enforce`, `off`), the launcher verifies the stored manifest's and file list's signatures with the stored root, then every installed file's length and SHA-256 against the list. A missing, changed or extra regular file stops the start and offers reinstall or rollback. This check needs no network and lives outside `@delo/integrity`.

`delorun verify` runs the same checks and reports each result ([C15](c15-verification-checks.md)). The S2 and S3 images run only by a digest in the verified manifest ([C9](c09-runtime-supervisor.md)).

## Freshness and rollback protection

- A client stores the highest timestamp `version` it verified and refuses a lower one; an equal `version` must have identical bytes.
- A timestamp past `expires` is refused. No clock tolerance applies; the refusal message names the expiry and the local time, so a wrong clock can be seen.
- Update offers come only from a fresh timestamp: a manifest whose digest differs from the timestamp's channel entry is not offered as the channel's release.
- No client moves to a lower Delo version on its own. A rollback the person requests may install an earlier release whose manifest verifies with a targets key valid for that release and whose log entry verifies ([C18](c18-release-log.md)); the CLI rollback switches to the runtime the store keeps ([C1](c01-home-layout.md), [C19](c19-home-process.md)), and the desktop rollback follows [desktop updates and rollback](#desktop-updates-and-rollback).
- A stale or missing timestamp never stops a start; it blocks installs and updates, and `delorun verify` reports it.

## Key rotation

- Every rotation is a new root version, published at `root/<n>.root.json`, signed by the threshold of the previous root keys and of its own root keys.
- A targets key is `active` (signs new releases), `retired` (verifies only manifests whose `version` is at most its `lastRelease`) or `revoked` (verifies nothing). Exactly one targets key is `active`.
- A routine targets rotation retires the old key. A compromised targets key is revoked: the new active key re-signs, without changing them, the manifests and file lists of the releases still offered or kept for rollback, and the re-signed files replace the old ones on GitHub Releases and gain new log entries.
- A client that adopts a root revoking the key of its installed runtime fetches the re-signed manifest and file list of that release; until it has them, the start check fails as for a bad signature.
- The timestamp and catalogue keys rotate by a new root version; their old keys verify nothing after the rotation.

## Rebuild before signing

The targets key signs a release only after its holder rebuilds it from the tagged source with the published recipe, on a machine they control, outside CI, and the rebuild matches the release workflow's output. The recipe, the toolchain pins and the comparison script live in `delo/apps/release/`.

Reproducibility scope:

- pinned toolchains: the exact Node release and its distribution digest, pnpm at the root `packageManager` version, and the compiler and linker of the native addon under `native/system`, recorded in `delo/apps/release/toolchain.json`;
- `SOURCE_DATE_EPOCH` set to the tagged commit's committer time, and `-ffile-prefix-map=<build root>=.` for compiled code;
- deterministic archives: entries sorted by byte-wise path, owner and group 0 with empty names, mode `0644` or `0755`, every mtime `SOURCE_DATE_EPOCH`, and gzip headers with mtime 0 and no file name;
- native addons built by the pinned toolchain, or taken as prebuilt files whose SHA-256 digests `delo/apps/release/prebuilt-pins.json` lists;
- the comparison `node_modules/.bin/tsx delo/apps/release/src/compare-rebuild.ts <first> <second>`, which exits 0 when the two outputs differ only in the entries of `delo/apps/release/rebuild-exceptions.json`, each with its reason, and 1 on any other difference. PE files are compared with their Authenticode signature and checksum removed, which is the file's first listed exception.

The signing command, `node_modules/.bin/tsx delo/apps/release/src/sign-release.ts`, runs on the targets-key holder's machine. The rebuild record `delorun-<version>.rebuild.json` (schema `delo.release-rebuild/1`) holds the release version, the commit, the SHA-256 of the recipe files, the builder's `name` and `ci: false`, the toolchain versions, the digest of every output file, the release workflow run it was compared against and the comparison result. The signing command refuses, with a message naming the required source ("a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe"), when:

- no rebuild record exists, or its comparison result is not a match;
- the record says `ci: true`, or the signing command runs with `CI` or `GITHUB_ACTIONS` set;
- the rebuild's output directory is not on the signing machine, or the digests it recomputes from that directory differ from the record's;
- the record's commit differs from the tag's.

When maintainers hold keys, signing requires matching rebuild records from two of the N listed builders, at least one with `ci: false`.

## Dependency advisory check

Signatures and the rebuild show integrity, not that the locked dependencies are free of known vulnerabilities. Before signing, the release workflow checks every package name and version in the runtime closure's lockfile against the GitHub Advisory Database through npm's bulk advisory API (`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`), and the signing command re-runs the check.

The check fails, and the release stops, when an advisory of any severity affects a locked version and no valid acceptance covers it, when an acceptance has lapsed, or when the feed cannot be reached or returns a malformed response.

Accepted advisories are reviewed entries in `delo/release/advisory-acceptances.yaml`:

```yaml
acceptances:
  - advisory: GHSA-aaaa-bbbb-cccc
    package: example-package
    range: '>=1.2.0 <1.2.5'
    reason: The vulnerable parser is not reachable from the closure's code paths.
    approver: example-maintainer
    lapsesAfter: 1.3.0
```

| Field | Meaning |
| --- | --- |
| `advisory` | The GHSA id. |
| `package` | The npm package name. |
| `range` | The semantic-version range of locked versions the acceptance covers. |
| `reason` | Why the release may ship with it. |
| `approver` | The GitHub login of the maintainer who approved it, a CODEOWNERS owner of `delo/release/`. |
| `lapsesAfter` | The last Delo version the acceptance covers; a later release fails the check until the entry is renewed or removed. |

An acceptance covers an advisory when the id and package match, the locked version satisfies `range`, and the release's version is at most `lapsesAfter`. Unknown fields fail the check. The release notes list every accepted advisory with its package, range, reason, approver, lapse release and the date of the commit that added the entry; the manifest's `advisories.accepted` lists their ids.

## npm publication

`delorun` and `create-delorun` publish through npm trusted publishing from the release workflow of `https://github.com/Delo-Run/delo`: the publish job requests an OIDC token (`permissions: id-token: write`), holds no npm token, and npm attaches a Sigstore-signed SLSA build attestation naming the repository, the workflow file and the commit. The manifest records each tarball's integrity. The launcher has no runtime dependencies; `npx` runs the launcher npm serves before any Delo check runs, so the npm launcher is the pre-install trust anchor, and the Trust page says so.

## Desktop updates and rollback

The desktop app keeps upstream's update flow (`DesktopUpdateCoordinator` in `apps/desktop/src/update-coordinator.ts`: download and install each on the person's click, `allowDowngrade` false) on Delo's feed, with these additions:

- Before `install` hands the download to electron-updater's `quitAndInstall`, the app verifies a fresh timestamp, the manifest's signature, the downloaded file's SHA-512 and SHA-256 against the manifest's `desktop` entry and the manifest's log entry ([C18](c18-release-log.md)). Any failure refuses the install and leaves the running version unchanged.
- After an update applies, the app keeps the installer or update archive of the release it replaced in its update cache directory, verified against that release's manifest. The cache keeps exactly one previous release.
- The feed refuses an automatic downgrade: a feed that names a version lower than or equal to the running one offers nothing.
- A rollback the person requests installs the cached previous release, or an earlier release the person names, downloaded from GitHub Releases. The target must verify as signed (manifest and file digests) and logged (inclusion proof); an unsigned, unlogged or mismatching target is refused. After the install, the profile is restored from history ([C3](c03-update-report.md)).

## Values and limits

| Value | Number |
| --- | --- |
| Timestamp expiry | 3 days (259,200 seconds) after `issued` |
| Timestamp re-signing | every 24 hours, and at each release |
| Root expiry | at most 365 days after `issued`; the next version is signed at least 30 days before expiry |
| Thresholds | 1 for each role; root moves to 2 of N once maintainers hold root keys |
| Clock tolerance | 0 seconds |
| Desktop update cache | 1 previous release |
| Size limits before parsing | root 64 KiB, timestamp 16 KiB, manifest 1 MiB, file list 32 MiB, rebuild record 1 MiB, advisory report 8 MiB |
| Metadata request timeout | 30 seconds per request |

## Consumers

- `delo/apps/release/` (WP3.1): builds, compares, checks advisories, signs and publishes.
- `delo/apps/install/` and `delo/apps/npm-launcher/` (WP3.2): verify and install.
- `delo/packages/runtime-store/` (WP3.3): the start check, switching and rollback.
- The desktop updater (WP6.3): verified updates and rollback.
- `@delo/integrity` and `delorun verify` ([C15](c15-verification-checks.md)), the Docker supervisor's image check ([C9](c09-runtime-supervisor.md)) and the catalogue's key ([C13](c13-catalogue-revocation.md)).

## Compatibility

Each file's `schema` names its major version; a change that an older reader would misread adds a new major version, and the release publishes both versions of a file while clients that read only the old one are supported. New optional fields need a new major version too, because readers refuse unknown fields. Upstream's desktop update flow, `latest.yml` feeds and electron-updater stay as upstream ships them; the manifest check is added before installation, so an upstream feed file alone never installs anything.

## Security

### Requirements

- R1. Root and targets keys are offline; the timestamp key is online and signs only freshness; the catalogue key signs only [C13](c13-catalogue-revocation.md)'s files.
- R2. Timestamp metadata expires 3 days after issue and is re-signed every 24 hours; a client refuses an expired or older timestamp, and a manifest the timestamp does not name for the channel is not offered.
- R3. No client downgrades on its own; a person-requested rollback reaches only a signed, logged release.
- R4. Rotation is by root version, signed by the old and new root thresholds; a revoked targets key verifies nothing.
- R5. The CLI launcher checks every runtime file against the signed file list at every start in every verification mode; one changed, missing or extra file stops the start.
- R6. The desktop app verifies the manifest, the file digests and the log entry before every update applies, on every platform.
- R7. Signing refuses without a matching rebuild record from the targets-key holder's machine outside CI; once maintainers sign, two of N builders with at least one outside CI.
- R8. The advisory check fails the release on any advisory without a valid acceptance, on a lapsed acceptance and on an unreachable feed; the release notes show every acceptance.
- R9. Nothing lands under `~/.delo/runtimes/` before signature, digest and log checks pass; the install script's digest is published, and the script verifies the closure before installing.
- R10. npm packages publish only through trusted publishing with an OIDC build attestation; no npm token exists in the workflow.
- R11. Every PE file in a Windows closure and the desktop app carries an Authenticode signature, and the manifest records the signed files' digests.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `c02-start-stops-on-changed-byte` | WP3.3 | One changed byte in an installed runtime file stops the CLI start in `warn`, `enforce` and `off`, and offers reinstall or rollback. |
| `c02-start-stops-on-extra-file` | WP3.3 | An added regular file under the installation stops the start. |
| `c02-install-refuses-bad-signature` | WP3.2 | A manifest signed by a key outside the targets role is refused, and no file appears under `~/.delo/runtimes/`. |
| `c02-install-refuses-tampered-archive` | WP3.2 | An archive whose SHA-256 differs from the manifest is refused before extraction. |
| `c02-refuses-expired-timestamp` | WP3.1, WP3.2, WP6.3 | A timestamp one second past `expires` blocks the update and names the expiry. |
| `c02-refuses-replayed-timestamp` | WP3.2, WP6.3 | A validly signed timestamp with a lower `version` than the stored one is refused. |
| `c02-refuses-replayed-manifest` | WP3.1, WP3.2, WP6.3 | A validly signed older manifest that the fresh timestamp does not name is not offered or installed. |
| `c02-root-rotation-needs-both-thresholds` | WP3.2 | A new root version signed only by its own keys, or only by the previous ones, is refused. |
| `c02-revoked-targets-key-verifies-nothing` | WP3.2, WP3.3 | After a root revokes a targets key, a manifest signed only by it fails install and the start check. |
| `c02-desktop-refuses-bad-manifest` | WP6.3 | A desktop update whose manifest signature fails, or whose downloaded file's SHA-512 differs from the manifest, is refused before `quitAndInstall`. |
| `c02-desktop-refuses-unrequested-downgrade` | WP6.3 | A feed naming a lower version offers no update. |
| `c02-desktop-rollback-signed-logged` | WP6.3 | A requested rollback to a signed, logged earlier release applies and restores the profile from history. |
| `c02-desktop-rollback-refuses-unsigned-or-unlogged` | WP6.3 | A requested rollback to a release without a verifying manifest, or without a verified log entry, is refused. |
| `c02-rebuild-difference-blocks-signing` | WP3.1 | `compare-rebuild.ts` exits 1 on a difference outside `rebuild-exceptions.json`, and the signing step stops. |
| `c02-signing-refuses-without-rebuild` | WP3.1 | Signing without a rebuild record refuses with the message naming the required source. |
| `c02-signing-refuses-ci-rebuild` | WP3.1 | A record with `ci: true`, a signing run with `GITHUB_ACTIONS` set, or a record whose digests the local output directory does not reproduce, refuses with the same message. |
| `c02-advisory-fails-release` | WP3.1 | A fixture lockfile with a planted advisory id fails the check. |
| `c02-advisory-acceptance-passes-and-shows` | WP3.1 | The same lockfile passes with a matching acceptance, and the assembled release notes show the advisory, its package, range, reason, approver, lapse release and date. |
| `c02-advisory-lapsed-acceptance-fails` | WP3.1 | A release whose version is above the acceptance's `lapsesAfter` fails the check. |
| `c02-advisory-feed-unreachable-fails` | WP3.1 | A feed stand-in that refuses connections fails the check. |
| `c02-npm-publish-has-no-token` | WP3.2 | A workflow lint fails when the npm publish job references an npm token or lacks `id-token: write`. |
| `c02-pe-files-signed` | WP3.1 | `signtool verify /pa` passes on every PE file in the Windows closure. |

### What this does not prove

- **Rebuild outside CI.** The signing command verifies that a rebuild record exists and says `ci: false`, that the signing run has no `CI` or `GITHUB_ACTIONS` variable set, and that the digests it recomputes from the rebuild output on the signing machine match the record. It cannot show that the machine is independent of the release workflow or that its toolchain is uncompromised; that rests on the targets-key holder rebuilding on a machine they control.
- **Advisory coverage.** The advisory check covers the npm packages in the runtime closure's lockfile and the advisories the GitHub Advisory Database publishes for them. It does not cover the pinned Node binary, the native addon's compiler and linker, the system packages of the S2 and S3 images, or the Python and Office payloads the desktop app carries, and it cannot report a vulnerability that has no published advisory.
- **Clock dependence.** Expiry checks compare against the client's clock. A clock set back accepts a timestamp past its real expiry, so a host that withholds releases goes unnoticed for as long as the clock is wrong; a clock set forward refuses fresh metadata, and the refusal names the expiry and the local time.
- **Start hash check.** The launcher detects a changed, missing or extra file in the installed runtime. A process that runs with the person's own access can also change the launcher, the stored root or the stored manifest, and then the check passes; the check detects tampering that does not also alter the launcher, and `delorun verify` states the same limit ([C15](c15-verification-checks.md)).
