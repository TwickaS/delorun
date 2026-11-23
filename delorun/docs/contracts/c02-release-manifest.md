---
description: "Contract C2: the files of a Delorun release, the signed release manifest and its Ed25519 envelope, the root, targets, timestamp and catalogue key roles, freshness, rollback protection and key rotation, the rebuild the targets-key holder runs before signing, npm trusted publishing, the dependency advisory check and the desktop rollback rule."
---

# C2 Release manifest and signature

English | [中文](c02-release-manifest.zh.md)

## Summary

Every Delorun release is a set of files on GitHub Releases described by one release manifest, which the offline targets key signs. The manifest lists the runtime archive of each platform the release publishes, the desktop installers, the S2 and S3 image digests, the SPDX SBOM, the npm packages and the install scripts, each with its length and SHA-256 digest. An online timestamp key signs a small timestamp file that names each channel's current manifest and expires after 3 days, so a host that withholds a release is noticed at the next install, update or update check, which refuse a stale timestamp; a start goes on with the release it has. The root key, also offline, signs the list of keys for every role and each rotation of it. The targets-key holder signs a published release only after rebuilding it from a signed tag on the release branch on a machine they control, outside CI, and after the release's lockfile passes the dependency advisory check; a local release, signed without a rebuild for a channel of its own, may not use a production root or key, and a launcher fetching from the production publication refuses it. The npm launcher, `delorun update`, the launcher at every start and `delorun verify` verify these files as this page states, and also require the release's log entry that [C18](c18-release-log.md) defines. The types live in [`@delorun/contract-release-manifest`](../../packages/contract-release-manifest/README.md).

## Status

The client verification, the start check and the signing, timestamp and advisory commands are built; the release workflow, the desktop updater's checks and the install scripts are not.

- **Built and reached:** the install verification of the npm launcher and `delorun update` (`delorun/apps/install`), the launcher's check of every installed file at each start (`delorun/packages/runtime-store`), the two release checks of `delorun verify`, and the commands under `delorun/apps/release/src/` that sign a release after a matching rebuild, sign a timestamp without lowering a channel, and check advisories.
- **Not built:** a release workflow, so no CI job and no workflow step runs the advisory check or publishes to npm; npm trusted publishing; two of N rebuilds; Authenticode signatures; the install scripts; and every check of the desktop app, which is upstream's unchanged. These rules are in the [release workflow design](../design/release-workflow.md) and the [update and rollback design](../design/update-and-rollback.md#the-desktop-app).
- **Partly built:** an advisory acceptance counts only an owner named by login in `.github/CODEOWNERS`, which names only a team, so no acceptance is valid and every advisory fails the check. The closure recipe compiles upstream's native system addon only for the Linux platforms, so the macOS platforms are not release platforms and a release publishes no macOS runtime until the recipe has a pinned toolchain for the macOS binaries ([rebuild before signing](#rebuild-before-signing)).

The requirements and denial tests below that this list names as not built protect no one until a change builds them.

## Contents

- [Status](#status)
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

A release with version `<version>` (Delorun's semantic version, without a leading `v`) is the git tag `v<version>` of Delorun's public repository, `https://github.com/twickas/delorun`, and the GitHub release of that tag. Platform identifiers are Node's `process.platform` and `process.arch` joined by a hyphen: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and `win32-x64`. A release publishes the runtime of the platforms its recipe lists as release platforms (`platforms` in `delorun/apps/release/closure.json` at the release's commit), and its manifest names exactly those. The recipe refuses to list a platform whose native code it cannot build from the tagged source, so `darwin-x64` and `darwin-arm64` are not release platforms until it can; the release platforms today are `linux-x64`, `linux-arm64` and `win32-x64`.

| File | Content |
| --- | --- |
| `delorun-<version>.manifest.json` | The release manifest in its signature envelope. |
| `delorun-<version>.manifest.log.json` | The manifest's release-log bundle ([C18](c18-release-log.md)). |
| `delorun-<version>-<platform>.tar.gz` | The runtime closure for a Linux or macOS platform. |
| `delorun-<version>-win32-x64.zip` | The runtime closure for native Windows, which the recipe can build; releases up to and including 0.1.0 publish none, because Windows runs the Linux runtime in WSL2. |
| `delorun-<version>-<platform>.files.json` | The runtime file list of that platform's archive. |
| `delorun-<version>.packs.json` | The release's plugin packs ([Packs](#packs)), in the signature envelope; absent from a release with none. |
| `delorun-<version>.packs.log.json` | The packs file's release-log bundle ([C18](c18-release-log.md)). |
| `delorun-<version>-pack-<name>.<platform or any>.tar.gz` | One pack's archive. |
| `delorun-<version>.spdx.json` | The SPDX 2.3 JSON SBOM of every archive, installer and image in the release, and of the pinned packages of the builder image that compiled the archives' native code. |
| `delorun-<version>.rebuild.json` | The rebuild record of the targets-key holder's rebuild. |
| `delorun-<version>.advisories.json` | The dependency advisory check's result. |
| `install.sh`, `install.ps1` | The install scripts of this release. |
| `Delorun-<version>-mac-arm64.dmg`, `Delorun-<version>-mac-x64.dmg` | The macOS desktop installers. |
| `Delorun-<version>-mac-arm64.zip`, `Delorun-<version>-mac-x64.zip` | The macOS desktop update archives electron-updater applies. |
| `Delorun-<version>-win-x64.exe` | The Windows desktop installer (NSIS). |
| `*.blockmap` | electron-updater's block maps of the desktop files. |
| `latest.yml`, `latest-mac.yml` (stable); `beta.yml`, `beta-mac.yml` (beta) | electron-updater's feed files. They are not signed; the desktop app trusts only the manifest. |

Release metadata that is not tied to one release is served at `releases.delorun.com`: `root/<n>.root.json` for every root version `n` and `timestamp.json`. The same host serves every release file at `releases/download/v<version>/<file>`. Two mirrors serve the same bytes: the spare host `releases.delo.run` for every file, and the GitHub release of the tag for release files. A client tries a mirror only after the host before it fails on the network or by HTTP status, or serves bytes that do not match the signed reference. The hosts are not trusted: every file is signed, and a client refuses one that does not verify.

## Signature envelope

Every signed file (root, timestamp, manifest, runtime file list, the catalogue files of [C13](c13-catalogue-revocation.md)) is UTF-8 JSON of this form:

```json
{
  "signed": { "schema": "delorun.release-manifest/1" },
  "signatures": [{ "keyid": "<64 lowercase hex>", "sig": "<base64>" }]
}
```

- The signed bytes are the RFC 8785 JSON Canonicalization Scheme serialisation of `signed`.
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
| `timestamp` | Online, by whoever runs the timestamp command; the [release workflow design](../design/release-workflow.md) keeps it in a workflow's protected environment | Timestamp metadata only; it attests freshness and names manifests by digest, and cannot change what a manifest lists | 1 |
| `catalogue` | Online, in the catalogue repository's publish environment | The catalogue index and revocation list of [C13](c13-catalogue-revocation.md) | 1 |

The root and targets private keys never enter CI, a cloud service or a machine the release workflow can reach. Windows Authenticode, macOS Developer ID and notarisation are platform signatures on the files themselves; the manifest records the digests of the signed files, and the platform signing route is outside this contract.

## Root metadata

`root/<n>.root.json`, schema `delorun.release-root/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer ≥ 1 | Root version `n`; each rotation adds exactly 1. |
| `issued`, `expires` | timestamp | `expires` is at most 365 days after `issued`. |
| `keys` | map of `keyid` to `{ "algorithm": "ed25519", "public": <base64 32 bytes> }` | Every key any role names. |
| `roles.root`, `roles.timestamp`, `roles.catalogue` | `{ "keyids": [...], "threshold": n }` | The role's current keys. |
| `roles.targets` | `{ "keys": [{ "keyid", "status", "lastRelease"? }], "threshold": n }` | `status` is `active`, `retired` or `revoked`; a `retired` key carries `lastRelease`, the last Delorun version it signed. |
| `log` | `{ "origin", "vkey" }` | The release log's checkpoint origin line and verifier key ([C18](c18-release-log.md)): the log new releases are logged in and the online check reads. |
| `logs` | `[{ "origin", "vkey" }]` | Every log whose checkpoints verify a bundle, `log` among it with the same verifier key, each origin once; an earlier log, such as a previous shard, keeps the releases logged there verifying. A checkpoint of a listed log still needs the witnesses' cosignatures. |
| `logEntryKeys` | `[{ "keyDetails", "public", "status", "lastRelease"? }]` | The keys trusted to sign release log entries, in the order the signing tool tries them ([C18](c18-release-log.md#log-entry)). `keyDetails` is the entry key type, upper-case letters, digits and `_` (`PKIX_ED25519_PH` and `PKIX_ECDSA_P256_SHA_256` are defined; a client ignores a type it does not implement); `public` is the base64 DER (PKIX SubjectPublicKeyInfo) public key, a key of the type's kind for a defined type; `status` is `active`, `retired` (with `lastRelease`, the last version whose entry it signed, compared with the version of the signed manifest) or `revoked`, which verifies no release whatever `lastRelease` says. Each key is listed once and at least one key of a defined type is `active`. A listed key is not in `keys` and signs no metadata; a targets key signs log entries only when it is listed here. |
| `witnesses` | `{ "keys": [{ "name", "vkey" }], "threshold": n }` | The witness verifier keys and how many must cosign ([C18](c18-release-log.md)). |

The npm launcher embeds the root versions it is packed with, and refuses every install when it embeds none. A client trusts a newer root only by walking `n + 1, n + 2, …` from the newest it trusts, where each new version verifies with the threshold of the previous version's root keys and with the threshold of its own root keys. A root the client trusts that has expired blocks every install and update until a newer root verifies; it does not stop a start. The root key holder signs the next version at least 30 days before the current one expires.

## Timestamp metadata

`timestamp.json`, schema `delorun.release-timestamp/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer ≥ 1 | Adds 1 at every signing. |
| `issued`, `expires` | timestamp | `expires` is exactly 3 days (259,200 seconds) after `issued`. |
| `root` | `{ "version", "sha256" }` | The newest root version and its file digest. |
| `channels.stable`, `channels.beta` | `{ "release": <version>, "manifest": FileRef }` | Each channel's current release and its manifest file. |

The timestamp command, `node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts`, signs it, and refuses a timestamp key that `delorun/release/production-keys.json`, as the release branch commits it, does not list; the production channel's cron Worker re-signs the timestamp every 24 hours with `delorun/apps/release-channel/src/resign-core.ts` ([release channel](../../apps/release-channel/README.md)). A re-signed timestamp is the current signed JSON with only `version` (the next), `issued` (one hour before the signing) and `expires` (the lifetime above) replaced, so the root and every channel entry, known or not, stay as signed. The Worker refuses to re-sign a timestamp that does not verify under the newest stored root, or that lies below its high-water mark (a lower version, or a channel on a lower release), which it keeps in storage the publish token cannot write. `channels.stable` names a stable release; `channels.beta` names a beta release or a stable release. The timestamp command refuses to move a channel to a lower version than the previous timestamp names for it. A `FileRef` is `{ "name", "length", "sha256" }`: the file name, one path segment matching `^[A-Za-z0-9._+-]+$` other than `.` and `..`; its length in bytes; and the lowercase hex SHA-256 of its bytes.

## Release manifest

`delorun-<version>.manifest.json`, schema `delorun.release-manifest/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | semantic version | Delorun's version of this release. |
| `dsh` | semantic version | The `version` of `@deepseek-ai/dsh-app-boot` in the release, upstream's version ([C17](c17-plugin-versions.md)). |
| `channel` | `stable` or `beta` | The channel the release is published on. |
| `source` | `{ "repository", "tag", "commit" }` | The public repository URL (`https://github.com/twickas/delorun`), `v<version>` and the 40-hex commit the tag names. |
| `published` | timestamp | When the targets key signed it. |
| `runtime` | map of platform to `{ "archive": FileRef, "files": FileRef }` | Each runtime archive and its file list, for exactly the release platforms and at least one; a platform without an entry is not in the release. |
| `desktop` | map of `mac-arm64`, `mac-x64`, `win-x64` to `{ "installer": DesktopFileRef, "update": DesktopFileRef, "blockmap": FileRef }` | Desktop files; `DesktopFileRef` adds `sha512`, the standard base64 SHA-512 electron-updater compares. On Windows the installer is also the update file. |
| `images` | `{ "s2": ImageRef, "s3": ImageRef }` | The Docker images [C9](c09-runtime-supervisor.md) runs. `ImageRef` is `{ "repository", "index": "sha256:<hex>", "platforms": { "linux/amd64": "sha256:<hex>", "linux/arm64": "sha256:<hex>" } }`, with an optional `"seccomp": FileRef`: the release file holding the seccomp profile that [C9](c09-runtime-supervisor.md) runs the image's containers under. Without it, they run under the engine's default profile. |
| `sbom` | `FileRef` with `"format": "SPDX-2.3+json"` | The release's SBOM. |
| `npm` | list of `{ "name", "version", "integrity" }` | Each npm package of the release (`delorun`, `create-delorun`) with its tarball's `sha512-` integrity string. |
| `install` | `{ "sh": FileRef, "ps1": FileRef }` | The install scripts; the release notes and the Trust page print the same digests. |
| `rebuild` | `{ "record": FileRef, "builders": [{ "name", "ci": false }] }` | The rebuild record and who rebuilt ([rebuild before signing](#rebuild-before-signing)). |
| `advisories` | `{ "report": FileRef, "accepted": [advisory ids] }` | The advisory check's result and every accepted advisory. |
| `security` | boolean, optional | Whether the release is marked as a security fix. A reader treats an absent value as `false`. |
| `summary` | string, optional | The release's one-line summary: 1 to 200 Unicode code points, no control (Cc), format (Cf), line separator (Zl) or paragraph separator (Zp) character, no lone UTF-16 surrogate, and no whitespace at either end, so it prints as one plain line on a terminal and in the studio (`isValidSummary`). A reader treats an absent value as no summary. |
| `notes` | file reference, optional | The release notes: a plain-text file in the release directory of 1 to 65,536 bytes (`isValidNotes`): well-formed UTF-8 with no control character except line feed and tab, no format (Cf), line separator (Zl) or paragraph separator (Zp) character and no lone surrogate. A reader treats an absent value as no notes. The studio shows the text as plain text after the update check has verified its length and SHA-256 against this reference. |

Signing writes `security` and `summary` into every manifest, and an update notice shows them with `version` and `dsh`; they are in the targets-signed manifest because the timestamp key signs only freshness.

A manifest carries no expiry: freshness is the timestamp's job, so a manifest stays valid for a rollback to its release for as long as its signing key verifies it.

## Runtime file list

`delorun-<version>-<platform>.files.json`, schema `delorun.release-files/1`, signed by the targets key:

| Field | Type | Meaning |
| --- | --- | --- |
| `version`, `platform` | string | The release and platform. |
| `files` | list of `{ "path", "length", "sha256", "mode" }` | Every regular file of the extracted archive; `path` is relative, `/`-separated and normalised, `mode` is `0644` or `0755`. |

The archive holds no symbolic link, hard link, device or path outside its root, and its entries are exactly the list's files. The installed list sits beside the installation at the path [C1](c01-home-layout.md) names.

## Packs

`delorun-<version>.packs.json`, schema `delorun.release-packs/1`, signed by the targets key with its own release-log record, lists the plugin packages the install does not carry. It is a separate file so that a reader of `delorun.release-manifest/1` never meets it. Fields: `version`; `manifest`, the SHA-256 of the release's manifest file, which binds the file to that release; and `packs`, a list of `{ name, version, experimental, variants }`. `variants` maps a platform, or `any`, to `{ archive, files, external, peers }`: `peers` names the packages that platform's runtime provides, which the install links into the pack; the archive is a `FileRef` with `sha512`, `files` lists every regular file as a runtime file list does, and `external` lists packages the pack never carries because their licence forbids redistribution, each with its exact `version`, its tarball `url` on `https://registry.npmjs.org/`, its `sha512` and its `length`. Pack, peer and external names are lower-case npm names; an archive's and an external's `length` is at most 512 MiB. A client fetches the archive only by its signed name from the release channel and an external only by its signed URL, follows no redirect, and stops reading at the signed length. A pack archive is named `delorun-<version>-pack-<name>.<platform or any>.tar.gz`, so it never reads as a runtime archive. The install seals the pack's tree (files 0444, or 0555 when executable; directories 0555), records the digests of the external files under `trust/runtime-files/packs/<version>/`, and the start check and `delorun verify` hash every installed file against the signed list and that record.

Turning a pack on verifies the packs file with the installed release's root, checks that it names the installed manifest's SHA-256 and that its log record verifies, downloads the archive named there and each external package, and refuses any whose length or digest differs. Nothing appears under `packs/<version>/` before every check passes. A pack is installed for one release only; an update fetches and verifies the packs the person added for the new release before it switches.

## Client verification

Installing or updating a runtime (the npm launcher, `delorun update`):

1. Read the trusted root and walk to the root the timestamp names.
2. Fetch `timestamp.json`; verify its signature with the timestamp role, its expiry and its `version` against the stored one.
3. Fetch the channel's manifest; check its length and SHA-256 against the timestamp; verify the targets signature.
4. Fetch and verify the release-log bundle and run the online log check ([C18](c18-release-log.md)); installing never proceeds without a verified inclusion proof.
5. Refuse, with `PLATFORM_NOT_RELEASED` naming the platform and the platforms the release lists, when the verified manifest has no `runtime` entry for this computer's platform. Otherwise fetch the platform's archive and file list; check each length and SHA-256 against the manifest before extracting; verify the file list's targets signature.
6. Extract into a staging directory outside `~/.delorun/runtimes/`, check every entry against the file list, then publish the installation as [C1](c01-home-layout.md) states. No file lands under `~/.delorun/runtimes/` before steps 1 to 5 pass.

At every start of the CLI runtime the npm launcher verifies the stored manifest's and file list's signatures with the newest root it ships, or with the stored root when an install walked from a shipped root past it, lists the installation, and checks every installed file against the list. A missing, extra or irregular entry stops the start. Each listed file is either vouched for by the installation's identity record or hashed: its length and SHA-256 are compared with the list, and a difference stops the start. Both stops offer reinstall or rollback. A stored root older than the newest root the launcher ships is never the anchor, so a targets key that root revoked fails the next start with a launcher that ships it. A release whose stored release-log bundle is missing fails [C18](c18-release-log.md)'s start check: every install through the runtime store keeps the bundle it verified. The check needs no network, lives in the launcher and the runtime store, and runs whatever verification mode is set, because the launcher reads no mode. `delorun update` runs the same check, with the interval the launcher reads, on the running release before it opens the channel, on a target already installed, as by an earlier `delorun update --check`, as any start checks it, on the target before the switch and again as the target's first health check of [C19](c19-home-process.md); every file of a target the update installs is hashed as the install writes it, and the record captured then vouches for the files at those checks.

- **The identity record.** `trust/runtime-files/delorun-<version>-<platform>.json` at mode 0600 ([C1](c01-home-layout.md#the-home-tree)), written atomically under `store.lock` only by a process that has just hashed or written the files it records. It holds one identity per listed file (inode, mode with the file type, size, and modification and change times in nanoseconds), the capture time, the time of the last pass that hashed every file, and its binding: the schema `delorun.runtime-identity/1`, the version, the platform, the SHA-256 of the file list and of the manifest, the installation directory's inode and the file system's `statfs` type. It carries no key, because every process that can write it can also read a key under the same home.
- **What vouches.** A file is vouched for when it lies on the installation directory's device and its identity equals the recorded one, and that change time is at least 2 s older than the record's capture time; any other file is hashed. A start whose hash passes rewrites the record, and so does the scheduled full pass; a full check on request, such as `delorun verify`'s, rewrites it only when the record is missing, unbound or names another identity. A hash that fails never writes it.
- **The full hash.** Every file is hashed at install, where each file is hashed once from the bytes it is written from; by the launcher before every `delorun verify` starts, which gives it an interval of 0, and again inside it; when the last full pass is older than `DELORUN_RUNTIME_FULL_CHECK_DAYS` days (7 by default, from 0, which hashes at every start, to 30) or later than the clock; and when the record is missing, unreadable, malformed, laxer than 0600, linked, another user's, or bound to anything else. These rules hold for the start checks an update runs too; its prepare shares one check per runtime between the channel's opener, the install and the report's readers.
- **What an ordinary start does not catch.** The record carries no key, so a program running with the person's access can rewrite it to vouch for a file it changed, the Node executable and `delorun`'s own files included; an ordinary start then passes until the next full hash. `delorun verify` and the studio's Check now, which runs it through the launcher, hash every file first and find the change.
- **Where change times vouch.** Linux on ext2, ext3 and ext4, XFS, Btrfs, F2FS and tmpfs, whose change times only the local kernel sets and no unprivileged process can set back. On every other file system and platform, overlayfs, macOS and Windows included, every start hashes every file and no record is written: overlayfs reports its own type whatever file systems its layers lie on.

`delorun verify` runs the same checks and reports each result ([C15](c15-verification-checks.md)). The Docker supervisor of [C9](c09-runtime-supervisor.md), which no shipped command launches, runs only an S2 or S3 image digest the verified manifest lists.

## Freshness and rollback protection

- A client stores the highest timestamp `version` it verified and refuses a lower one; an equal `version` must have identical bytes.
- A timestamp past `expires` is refused. No clock tolerance applies; the refusal message names the expiry and the local time, so a wrong clock can be seen.
- `delorun update` offers only the release a fresh timestamp names for the channel: a manifest whose digest differs from the timestamp's channel entry is not offered. The update channel's `update.prepare` also accepts a version already installed in the runtime store as its target, without a timestamp; only a caller holding the start token can send it, `delorun update` never names a target, and a target lower than the running version is refused as below.
- Nothing installs or switches a runtime without the person: the npm launcher installs only into an empty runtime store, and `delorun update` applies only after the person confirms. An update never goes to a lower version: the runtime store refuses with `TARGET_LOWER`, before anything installs, a target or a channel release lower than the version `current` names, and `delorun update` refuses a report whose target is lower than the running release. `delorun recover rollback` is the only way back, to the version `previous` names. A channel names a lower release only if a timestamp signer moves it there, which the timestamp command refuses, and a client refuses a timestamp older than the one it stored.
- The CLI rollback switches to the runtime the store keeps ([C1](c01-home-layout.md), [C19](c19-home-process.md)).
- A stale or missing timestamp never stops a start; it blocks installs and updates, and `delorun verify` reports it.

## Key rotation

- Every rotation is a new root version, published at `root/<n>.root.json`, signed by the threshold of the previous root keys and of its own root keys.
- A targets key is `active` (signs new releases), `retired` (verifies only manifests whose `version` is at most its `lastRelease`) or `revoked` (verifies nothing). Exactly one targets key is `active`.
- A routine targets rotation retires the old key. A compromised targets key is revoked: the new active key re-signs, without changing them, the manifests and file lists of the releases still offered or kept for rollback, and the re-signed files replace the old ones on GitHub Releases and gain new log entries.
- No client fetches the re-signed manifest and file list of an installed release. A start whose launcher ships a root revoking the key of the installed runtime fails the start check as for a bad signature and offers that check's remedies.
- The timestamp and catalogue keys rotate by a new root version; their old keys verify nothing after the rotation.
- `logEntryKeys` and `logs` change only by a new root version, so the offline root key alone adds or removes a log-entry key type, a log-entry key or a log; the timestamp and targets keys cannot. A log-entry key that stops signing is `retired` with its `lastRelease`, so installed releases keep verifying at start; a compromised one is `revoked`. A client keeps the newest root it verified, so an older root that a channel replays cannot bring back a removed key or log.
- A release verifies only under a root that carries `logEntryKeys` and `logs`. Both fields are optional in the schema only so that a root chain can still read `1.root.json`, which predates them; no release verifies under it, and releases signed under it are not re-signed.

## Rebuild before signing

The targets key signs a release only after its holder rebuilds it from the tagged source with the published recipe, on a machine they control, outside CI, and the rebuild matches the release workflow's output. The recipe, the toolchain pins and the comparison script live in `delorun/apps/release/`.

Reproducibility scope:

- pinned toolchains: the exact Node release and its distribution digest, pnpm at the root `packageManager` version, and the builder image that compiles upstream's native system addon under `native/system`: the Debian base by digest, a Debian snapshot and the exact versions of the compiler, linker, C library and kernel header packages, recorded in `delorun/apps/release/toolchain.json`;
- `SOURCE_DATE_EPOCH` set to the tagged commit's committer time, and `-ffile-prefix-map=<build root>=.` for compiled code that reads `CFLAGS`; upstream's native build reads none, and its binaries embed no build path;
- deterministic archives: entries sorted by byte-wise path, owner and group 0 with empty names, mode `0644` or `0755`, every mtime `SOURCE_DATE_EPOCH`, and gzip headers with mtime 0 and no file name;
- native code: the `linux-x64` and `linux-arm64` binaries of upstream's native system addon compiled from `native/system` in the builder image, with no network; every other native addon taken as a prebuilt file from an npm tarball the lockfile pins by integrity; and the SHA-256 of every native file each closure holds listed in `delorun/apps/release/prebuilt-pins.json`. The recipe first removes the foreign-platform prebuild directories that `foreignPrebuilds` in `closure.json` lists, so no closure pins or ships another platform's code the package carries; an unlisted foreign prebuild fails the pin check. The recipe has no pinned toolchain for the macOS binaries of the addon: `toolchain.json` marks `darwin-x64` and `darwin-arm64` `unbuilt`, and reading the recipe fails when `closure.json` lists an `unbuilt` platform;
- the release platforms: the build, the SBOM, the rebuild record's required outputs and signing cover exactly the platforms `closure.json` lists at the release's commit. The build refuses a platform the list does not name, and signing refuses a manifest draft whose `runtime` names other platforms or misses one;
- the comparison `node_modules/.bin/tsx delorun/apps/release/src/compare-rebuild.ts <first> <second>`, which exits 0 when the two outputs differ only in the entries of `delorun/apps/release/rebuild-exceptions.json`, each with its reason, and 1 on any other difference. PE files are compared with their Authenticode signature and checksum removed, which is the file's first listed exception.

The signing command, `node_modules/.bin/tsx delorun/apps/release/src/sign-release.ts`, runs on the targets-key holder's machine. The rebuild record `delorun-<version>.rebuild.json` (schema `delorun.release-rebuild/1`) holds the release version, the commit, the SHA-256 of the recipe files, the builder's `name` and `ci: false`, the toolchain versions, the digest of every output file, the release workflow run it was compared against and the comparison result. The signing command refuses, with a message naming the required source ("a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe"), when:

- no rebuild record exists, or its comparison result is not a match;
- the record says `ci: true`, or the signing command runs with `CI` or `GITHUB_ACTIONS` set;
- the rebuild's output directory is not on the signing machine, or the digests it recomputes from that directory differ from the record's;
- the record's commit differs from the tag's.

It also refuses, before it writes anything, when:

- the release commit is not an ancestor of the release branch, `origin/main` unless `--release-branch` names another;
- the targets key is not listed in `delorun/release/production-keys.json` as the release branch commits it; the registry lists no key until the owner records the keys of the key ceremony, so signing stops until then;
- the release tag is not an annotated tag whose `tag` header names it, carrying an SSH signature that `git verify-tag` verifies with a key listed in `delorun/release/allowed-signers` as the release branch commits it, never the working tree's copy; the committed file lists no key until the owner adds the release signers' keys, so every tag is refused until then;
- the draft's `install.sh` or `install.ps1` is not a zero-length placeholder, because the rebuild comparison does not cover the install scripts;
- an `npm` entry's packed tarball, `<name>-<version>.tgz` in the release directory, is missing, or its `sha512-` integrity, or the name and version in its `package/package.json`, differ from the entry.

`local-release.ts` builds and signs a release for a channel directory of its own, with no rebuild and no advisory check. Its manifest names the builder `local release (no independent rebuild)`; it refuses a root file whose SHA-256, or a root, targets or timestamp key id, `delorun/release/production-keys.json` lists; and a launcher fetching from the production publication refuses a manifest that names that builder unless both hold: the release is a 0.x release, and the root that verified it is the preview root, the one root file the launcher pins by its SHA-256 (`PREVIEW_ROOT_SHA256` in `delorun/apps/install/src/local-builder.ts`, which the [Trust page](../guide/safety-and-updates/trust.md#how-releases-are-signed-in-the-preview) publishes; it moves from `1.root.json` to `2.root.json` with the root rotation that adds the log-entry keys). Until `1.0.0` the signing ceremony is deferred, so the maintainer builds and signs 0.x releases on the maintainer's PC with no independent rebuild; a `1.0.0` release (a prerelease of it too) and a release under any other root file are refused, so the allowance ends with the ceremony's root. Every other check of this contract applies to such a release unchanged.

The signing command accepts one rebuild record; two of N builders once maintainers hold keys is in the [release workflow design](../design/release-workflow.md) and is not built.

## Dependency advisory check

Signatures and the rebuild show integrity, not that the locked dependencies are free of known vulnerabilities. Before it signs, the signing command checks every package name and version in the runtime closure's lockfile, every installed package version its SBOM lists and the pinned pnpm against the GitHub Advisory Database through npm's bulk advisory API (`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`); `check-advisories.ts` runs the same check on its own. No release workflow runs it.

The check fails, and the release stops, when an advisory of any severity affects a locked version and no valid acceptance covers it, when an acceptance has lapsed, or when the feed cannot be reached or returns a malformed response.

Accepted advisories are reviewed entries in `delorun/release/advisory-acceptances.yaml`:

```yaml
acceptances:
  - advisory: GHSA-aaaa-bbbb-cccc
    package: example-package
    range: '>=1.2.0 <1.2.5'
    reason: The vulnerable parser is not reachable from the closure's code paths.
    approver: example-maintainer
    lapsesAfter: 1.3.0
    added: 2026-11-06
```

| Field | Meaning |
| --- | --- |
| `advisory` | The GHSA id. |
| `package` | The npm package name. |
| `range` | The semantic-version range of locked versions the acceptance covers. |
| `reason` | Why the release may ship with it. |
| `approver` | The GitHub login of the maintainer who approved it, a CODEOWNERS owner of `delorun/release/`. |
| `lapsesAfter` | The last Delorun version the acceptance covers; a later release fails the check until the entry is renewed or removed. |
| `added` | The date the entry was added, `YYYY-MM-DD`. |

An acceptance covers an advisory when the id and package match, the locked version satisfies `range`, the release's version is at most `lapsesAfter`, and `approver` is an owner of the file in `.github/CODEOWNERS` at the release's commit, named there by login; a team owner does not count. Unknown and missing fields fail the check. The manifest's `advisories.accepted` lists the accepted ids.

## npm publication

`delorun/apps/npm-launcher/src/build.ts` packs the `delorun` package with the release roots it is given and refuses a build with none. The manifest records each tarball's integrity. The launcher has no runtime dependencies; `npx` runs the launcher npm serves before any Delorun check runs, so the npm launcher is the pre-install trust anchor. The launcher tells the runtime it starts its own version in `DELORUN_LAUNCHER_VERSION`: `delorun setup` installs the `delorun` command as `delorun@<that version>`, never the newest npm serves, and `delorun verify` prints the integrity the installed release's manifest gives that version, which a person compares with `npm view delorun@<version> dist.integrity` ([Trust page](../guide/safety-and-updates/trust.md)). No workflow publishes it; publication through npm trusted publishing without an npm token is in the [release workflow design](../design/release-workflow.md).

## Desktop updates and rollback

The desktop app is upstream's, unchanged, and Delorun builds none. Its updater (`DesktopUpdateCoordinator` in `apps/desktop/src/update-coordinator.ts`) downloads and installs each update on the person's click and refuses a downgrade (`allowDowngrade` false). It checks no Delorun timestamp, manifest or log entry, keeps no previous release and offers no rollback. The rules for a desktop app that verifies each update and rolls back to a signed, logged release are in the [update and rollback design](../design/update-and-rollback.md#the-desktop-app).

## Values and limits

| Value | Number |
| --- | --- |
| Timestamp expiry | 3 days (259,200 seconds) after `issued` |
| Root expiry | at most 365 days after `issued`; the next version is signed at least 30 days before expiry |
| Thresholds | 1 for each role; root moves to 2 of N once maintainers hold root keys |
| Clock tolerance | 0 seconds |
| Size limits before parsing | root 64 KiB, timestamp 16 KiB, manifest 1 MiB, file list 32 MiB, rebuild record 1 MiB, advisory report 8 MiB |
| Metadata request timeout | 30 seconds per request |

## Consumers

- `delorun/apps/release/`: builds, compares, checks advisories and signs.
- `delorun/apps/install/` and `delorun/apps/npm-launcher/`: verify and install.
- `delorun/packages/runtime-store/`: the start check, switching and rollback.
- `delorun verify` ([C15](c15-verification-checks.md)), the Docker supervisor's image check ([C9](c09-runtime-supervisor.md)) and the catalogue's key ([C13](c13-catalogue-revocation.md)).

## Compatibility

Each file's `schema` names its major version; a change that an older reader would misread adds a new major version, and the release publishes both versions of a file while clients that read only the old one are supported. New optional fields need a new major version too, because readers refuse unknown fields. The optional `notes` field is part of `delorun.release-manifest/1` from 0.1.0-rc.1 on, on the same terms: the readers in 0.1.0-rc.1 accept it, and no earlier reader exists. The optional `security` and `summary` fields were added to `delorun.release-manifest/1` before any release was published, so no reader that refuses them exists; from the first published release, a new field needs a new major version.

Three places stay open so that a reader of today's release survives growth of the release set. In a manifest, `runtime` ignores a platform key that is not one of the platform identifiers above, and `desktop`, `images` and `install` may be absent. In timestamp metadata, `channels` ignores a channel other than `stable` and `beta`. A reader drops an ignored key and never uses it; the signature still covers it, so changing it after signing is refused. A release whose `runtime` lists no platform the reader knows is refused, because the reader cannot install it. Everything else stays closed: an unknown field anywhere else, an unknown `schema` and an unknown `roles` key are refused. Signing still requires `desktop`, `images` and `install`. Upstream's desktop update flow, `latest.yml` feeds and electron-updater stay as upstream ships them.

## Security

### Requirements

- R1. Root and targets keys are offline; the timestamp key is online and signs only freshness; the catalogue key signs only [C13](c13-catalogue-revocation.md)'s files.
- R2. Timestamp metadata expires 3 days after issue; a client refuses an expired or older timestamp, and `delorun update` does not offer a manifest the timestamp does not name for the channel. The cron Worker of the [release channel](../../apps/release-channel/README.md) re-signs it every 24 hours. Whoever holds the timestamp key can therefore keep a stale release current beyond 3 days, but cannot forge a release: every channel entry names a manifest the offline targets key signed, and no signing moves a channel to a lower version.
- R3. No client downgrades on its own; a person-requested rollback reaches only a signed, logged release. Built for the CLI home: nothing installs or switches without the person's confirmation, the runtime store refuses an update target lower than the running version with `TARGET_LOWER`, `delorun update` refuses such a report, and `delorun recover rollback` reaches only the version `previous` names ([freshness and rollback protection](#freshness-and-rollback-protection)).
- R4. Rotation is by root version, signed by the old and new root thresholds; a revoked targets key verifies nothing.
- R5. The CLI launcher checks every runtime file against the signed file list at every start: it hashes every file the identity record cannot vouch for, and takes an unchanged recorded identity for the rest; one changed, missing or extra file it finds stops the start. The identity record carries no key, so a program running with the person's access can rewrite it and make any changed file, the Node executable and `delorun`'s own files included, pass ordinary starts; the scheduled full pass falls due by the time the record names, and the launcher hashes every file before `delorun verify` runs.
- R6. The desktop app verifies the manifest, the file digests and the log entry before every update applies, on every platform. Not built: the desktop app is upstream's ([update and rollback design](../design/update-and-rollback.md#the-desktop-app)).
- R7. Signing refuses without a matching rebuild record from the targets-key holder's machine outside CI. Two of N builders once maintainers sign is not built ([release workflow design](../design/release-workflow.md)).
- R8. The advisory check fails the release on any advisory without a valid acceptance, on a lapsed acceptance and on an unreachable feed. Listing every acceptance in the release notes is not built.
- R9. Nothing lands under `~/.delorun/runtimes/` before signature, digest and log checks pass. The install scripts, with their published digests, are not built.
- R10. npm packages publish only through trusted publishing with an OIDC build attestation; no npm token exists in the workflow. Not built: no workflow publishes them.
- R11. Every PE file in a Windows closure and the desktop app carries an Authenticode signature, and the manifest records the signed files' digests. Not built.
- R12. Signing refuses a draft whose `dsh` is not the `version` of `packages/boot/app-boot/package.json` at the release commit, and refuses a patch release (a version whose major and minor equal those of a lower `v<major>.<minor>.<patch>` tag without a pre-release suffix) whose upstream version, `docs/persistence-schema.json`, `delorun/packages/update/src/data-records.json` or covered plugin-facing interface (`delorun/packages/contract-plugin-versions/plugin-interface.json`) differs from that release's, or whose release commit no longer declares a covered service or event; a missing file refuses. A security fix therefore ships as a patch that disables no plugin, and a release that moves the upstream base is at least a minor. For a patch version (patch number above 0, any pre-release suffix ignored), signing also refuses when an earlier release tag's commit is not an ancestor of the release commit; when `delorun/changelog/changelog.json` at the release commit is missing or unreadable, does not list an earlier tag's version, or lists a non-pre-release version of the same major and minor below the release that has no tag; and when no earlier release of that major and minor is found unless the holder passes `--first-of-line`, which states the release is the first of its line and is refused when an earlier release is tagged or the version is `X.Y.0`.
- R13. Signing refuses a draft without `security` or `summary`, or with a summary that is not one plain line within the limit; readers refuse such a manifest too.

### Denial tests

| Test | Component | Behaviour it shows |
| --- | --- | --- |
| `c02-start-stops-on-changed-byte` | `runtime-store` | One changed byte in an installed runtime file stops the CLI start and offers reinstall or rollback. |
| `c02-start-stops-on-extra-file` | `runtime-store` | An added regular file under the installation stops the start. |
| `c02-start-catches-in-place-change` | `runtime-store` | A changed byte with the file's size, mode and modification time restored by `utimes` stops the start with the identity record present. |
| `c02-start-catches-renamed-replacement` | `runtime-store` | A file renamed over the original with the same size, mode and modification time stops the start. |
| `c02-start-missing-record-hashes-every-file` | `runtime-store` | A missing, truncated, unparsable, laxer, linked, foreign or rebound record makes the start hash every file. |
| `c02-start-periodic-full-hash` | `runtime-store` | A last full pass older than the interval or later than the clock, or an interval of 0, makes the start hash every file. |
| `c02-verify-always-hashes` | `runtime-store` | The full check behind `delorun verify` hashes every file even when every identity matches the record. |
| `c02-start-record-forgery-out-of-scope` | `runtime-store` | A record rewritten to a changed file's identity lets the start pass, the documented limit, and the full check still stops it. |
| `c02-update-start-check-catches-in-place-change` | `runtime-store` | The start check an update runs on the running release and its target stops at a changed byte with the file's size, mode and modification time restored, with the identity record present. |
| `c02-install-refuses-bad-signature` | `install` | A manifest signed by a key outside the targets role is refused, and no file appears under `~/.delorun/runtimes/`. |
| `c02-install-refuses-tampered-archive` | `install` | An archive whose SHA-256 differs from the manifest is refused before extraction. |
| `c02-refuses-expired-timestamp` | `release`, `install` | A timestamp one second past `expires` blocks the update and names the expiry. |
| `c02-refuses-replayed-timestamp` | `install` | A validly signed timestamp with a lower `version` than the stored one is refused. |
| `c02-refuses-replayed-manifest` | `release`, `install` | A validly signed older manifest that the fresh timestamp does not name is not offered or installed. |
| `c02-root-rotation-needs-both-thresholds` | `install` | A new root version signed only by its own keys, or only by the previous ones, is refused. |
| `c02-revoked-targets-key-verifies-nothing` | `install`, `runtime-store` | After a root revokes a targets key, a manifest signed only by it fails install and the start check. |
| `sign-release-refuses-unsigned-tag` | release-chain | Signing refuses a lightweight or unsigned release tag, one signed by a key `allowed-signers` does not list, one whose tag object names another tag, and any tag while the allowed-signers file lists no key. |
| `sign-release-refuses-commit-off-release-branch` | release-chain | Signing refuses a release commit that is not an ancestor of the release branch, and signs once the branch holds it. |
| `sign-release-refuses-install-script` | release-chain | Signing refuses a draft whose `install.sh` or `install.ps1` is not a zero-length placeholder. |
| `sign-release-refuses-unlisted-production-key` | release-chain | Signing refuses a targets key the release branch's `production-keys.json` does not list, and every key while it lists none. |
| `sign-timestamp-refuses-unlisted-production-key` | release-chain | The timestamp command refuses a timestamp key the release branch's `production-keys.json` does not list, and every key while it lists none. |
| `sign-release-reads-allowed-signers-from-the-release-branch` | release-chain | A signer added to the working tree's `allowed-signers` and not committed on the release branch does not verify the tag. |
| `sign-release-refuses-npm-integrity-mismatch` | release-chain | Signing refuses an `npm` entry whose packed tarball's integrity differs from the entry. |
| `local-release-refuses-production-keys` | release-chain | A local release refuses a root file, or a root, targets or timestamp key id, that `production-keys.json` lists, and writes nothing. |
| `c02-start-anchors-on-newest-shipped-root` | release-chain | A runtime signed by a targets key that the newest shipped root revoked fails the start check though the stored root is the older one that lists the key, and nothing is spawned. |
| `c02-production-refuses-local-release` | release-chain | A channel that fetches from the production publication refuses a manifest whose builder is `local release (no independent rebuild)`, on install and on the update check, unless the release is a 0.x release verified under the pinned preview root; `1.0.0`, `1.0.0-rc.1` and every other root file refuse, and a bad signature or digest refuses whatever the builder. A channel of its own installs it. |
| `c02-setup-installs-pinned-launcher` | release-chain | Setup installs `delorun@<version>` at the version the launcher named in `DELORUN_LAUNCHER_VERSION`, and offers no install when the launcher named none. |
| `c02-rebuild-difference-blocks-signing` | `release` | `compare-rebuild.ts` exits 1 on a difference outside `rebuild-exceptions.json`, and the signing step stops. |
| `c02-signing-refuses-without-rebuild` | `release` | Signing without a rebuild record refuses with the message naming the required source. |
| `c02-signing-covers-release-platforms` | `release` | Signing refuses a draft whose `runtime` names a platform `closure.json` does not list or misses one it lists; reading a recipe whose `closure.json` lists an `unbuilt` platform fails; the build refuses an unlisted platform. |
| `c02-install-refuses-unreleased-platform` | `install` | An install or update on a platform the verified manifest does not list refuses with `PLATFORM_NOT_RELEASED`, naming the platform, before the log check and any runtime download. |
| `c02-signing-refuses-ci-rebuild` | `release` | A record with `ci: true`, a signing run with `GITHUB_ACTIONS` set, or a record whose digests the local output directory does not reproduce, refuses with the same message. |
| `c02-advisory-fails-release` | `release` | A fixture lockfile with a planted advisory id fails the check. |
| `c02-advisory-acceptance-passes-and-shows` | `release` | The same lockfile passes with a matching acceptance, and the assembled release notes show the advisory, its package, range, reason, approver, lapse release and date. |
| `c02-advisory-lapsed-acceptance-fails` | `release` | A release whose version is above the acceptance's `lapsesAfter` fails the check. |
| `c02-advisory-feed-unreachable-fails` | `release` | A feed stand-in that refuses connections fails the check. |
| `c02-summary-control-characters-refused` | update-notice | A summary holding an ESC (`\u001b`), a newline or a U+202E right-to-left override is refused by the manifest reader and by signing. |
| `c02-summary-too-long-refused` | update-notice | A summary of 201 code points is refused by the reader and by signing; 200 reads. |
| `c02-security-not-boolean-refused` | update-notice | A `security` that is a string, a number or `null` is refused by the reader and by signing. |
| `c02-notes-invalid-text-refused` | whats-new | Notes holding a right-to-left override, an escape, a carriage return, a byte-order mark or bytes that are not UTF-8, empty notes, and notes above 65,536 bytes are refused by `isValidNotes`, by signing and by the update check; line feeds and tabs read. |
| `c02-manifest-without-notice-fields-reads` | update-notice | A manifest without `security` and `summary` reads, and its reader sees no security marker and no summary. |
| `c02-draft-without-notice-fields-refused` | update-notice | Signing refuses a draft without `security`, and one without `summary`, and writes nothing. |
| `patch-rule-refuses-base-move` | update-notice | A patch whose upstream version differs from the earlier release's is refused, naming both versions and the minor to release instead. |
| `patch-rule-refuses-draft-base-mismatch` | update-notice | A draft whose `dsh` differs from the app-boot version at the release commit is refused, patch or not. |
| `patch-rule-refuses-persistence-change` | update-notice | A patch whose `docs/persistence-schema.json` differs from, or is missing at, the earlier release or the release commit is refused. |
| `patch-rule-refuses-delorun-record-change` | update-notice | A patch whose `data-records.json` differs from the earlier release's is refused. |
| `patch-rule-refuses-interface-removal` | update-notice | A patch that drops a covered entry, or whose release commit no longer declares a covered service or reads a covered manifest field, is refused. |
| `patch-rule-refuses-interface-addition` | update-notice | A patch that adds or changes a covered entry is refused. |
| `patch-rule-refuses-missing-inventory` | update-notice | A patch whose inventory is missing or unreadable at the earlier release or at the release commit is refused. |
| `patch-rule-allows-equal-patch` | update-notice | A security-fix patch with the earlier release's base, data formats and covered interface signs, and its manifest carries `security: true`. |
| `patch-rule-skips-new-minor` | update-notice | `0.2.0` after `0.1.x` signs on a moved upstream base. |
| `patch-rule-ignores-prerelease-tags` | update-notice | A pre-release tag is no existing release, and `0.1.3-rc.1` is checked as `0.1.3`. |
| `patch-rule-refuses-patch-without-earlier-release` | update-notice | `0.1.3` with no `v0.1.x` release tag refuses, naming `--first-of-line`, and signs with it; the option is refused for `0.2.0` and when `v0.1.2` is tagged. |
| `patch-rule-refuses-tag-on-wrong-commit` | update-notice | An earlier release tag moved to a commit that is not an ancestor of the release commit refuses. |
| `patch-rule-refuses-release-missing-from-changelog` | update-notice | A tag whose version the release commit's `changelog.json` does not list, a listed earlier version of the same minor without a tag, or a missing or unreadable `changelog.json` refuses. |
| `c02-rotation-adds-log-entry-key` | `install` | A release logged with an ECDSA P-256 key, refused under a root without `logEntryKeys`, installs once the home adopts a root 2, signed by root 1's threshold and its own, that lists the key; the home then keeps root 2. |
| `c02-log-entry-keys-unverified-root-refused` | `install`, `release` | A root 2 listing a log-entry key that root 1's keys did not sign is refused, and its list is never read. |
| `c02-replayed-root-cannot-restore-type` | `install` | After a root 3 revokes a log-entry key, an entry by that key is refused, and a timestamp naming root 2, which listed it, is refused as older than the trusted root. |
| `local-builder-pins-root-digest` | `install` | A locally built 0.x release from the production channel installs under the root 2 the launcher pins by digest, and is refused under the same root 2 when the pin names root 1. |
| `c02-summary-lone-surrogate-refused` | update-notice | A summary holding a lone high or low UTF-16 surrogate is refused by the manifest reader and by signing; a surrogate pair reads. |

### What this does not prove

- **Earlier releases of a patch.** The patch rule finds earlier releases from the repository's tags and cross-checks them with git's history and with `delorun/changelog/changelog.json` at the release commit, the committed record of every assembled version. The changelog records versions, not commits, so the check does not prove that an earlier tag names the commit its release was published from: a tag moved to another ancestor commit passes. Both sources are written in the same repository, so a history whose changelog also omits a released version passes, and `--first-of-line` is the holder's statement, checked only against the tags and the changelog. The published manifests and the release log, which record each release's commit, are not consulted.
- **Rebuild outside CI.** The signing command verifies that a rebuild record exists and says `ci: false`, that the signing run has no `CI` or `GITHUB_ACTIONS` variable set, and that the digests it recomputes from the rebuild output on the signing machine match the record. It cannot show that the machine is independent of the release workflow or that its toolchain is uncompromised; that rests on the targets-key holder rebuilding on a machine they control.
- **Advisory coverage.** The advisory check covers the npm packages in the runtime closure's lockfile and the advisories the GitHub Advisory Database publishes for them. It does not cover the pinned Node binary, the native addon's compiler and linker, the system packages of the S2 and S3 images, or the Python and Office payloads the desktop app carries, and it cannot report a vulnerability that has no published advisory.
- **Clock dependence.** Expiry checks compare against the client's clock. A clock set back accepts a timestamp past its real expiry, so a host that withholds releases goes unnoticed for as long as the clock is wrong; a clock set forward refuses fresh metadata, and the refusal names the expiry and the local time.
- **Start hash check.** The launcher detects a changed, missing or extra file in the installed runtime. A process that runs with the person's own access can rewrite the identity record, and then any changed file passes every start, and runs when a command loads it, until the record's scheduled full pass or the next `delorun verify` or Check now. It can also change the launcher, the stored root or the stored manifest, and then every check passes, `delorun verify` included. The check detects tampering that does not also alter the launcher, and `delorun verify` states the same limit ([C15](c15-verification-checks.md)).
- **A write in the same clock step as an install's write.** An install takes each file's identity right after writing it, so a write to the staged file within the same step of the kernel's clock that also restores its mode keeps that identity. Only a process with the person's own access can write the staging directory; the next full pass finds the change.
- **Corruption without a change time.** Storage corruption, a write to the block device or an edit of the disk from another system can change a file's bytes without giving it a new change time. A start does not detect that; the next full pass, at most the configured interval later, and `delorun verify` do. This is a reliability gap, not a gain for an attacker, who needs root or the person's own access to do it.
