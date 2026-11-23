---
description: "Delorun's install path: the release files a launcher fetches over HTTPS, contract C2's client verification steps 1 to 5, contract C18's bundle and online log check, and the extraction of a verified archive into the runtime store's staging directory."
---

# @delorun/install

English | [中文](README.zh.md)

## Summary

`@delorun/install` is the install path behind the `delorun` launcher of [`@delorun/npm-launcher`](../npm-launcher/README.md). It fetches a release's files over HTTPS from the hosts contract C1 lists, verifies every one of them before anything is unpacked, and writes the runtime archive into the runtime store's staging directory. The store publishes what this package prepares: nothing here switches `current`, and a refused install leaves no directory under `~/.delorun/runtimes/`.

## Contents

- [Downloads](#downloads)
- [Verification](#verification)
- [The release log](#the-release-log)
- [Extraction](#extraction)
- [What a home remembers](#what-a-home-remembers)
- [Failures](#failures)
- [Development](#development)

<a id="downloads"></a>

## Downloads

`Downloader` is contract C1's download rule, and one instance serves one install. It fetches over HTTPS from the release hosts contract C1 lists, follows a redirect only to those hosts and at most five times, allows 30 seconds for a connection to open and 60 seconds without a byte, and holds a file to its limit while its body arrives rather than after it has been read. `bytes` keeps a small metadata file in memory; `file` writes an archive to a new file at mode 0600, hashing it as it arrives and removing it when anything fails, a file that cannot be created, written to completion (a disk that fills raises `ENOSPC`, a file-size limit `EFBIG`) or closed included — the write is the same `DOWNLOAD_FAILED` refusal, never a raw file-system error.

<a id="verification"></a>

## Verification

`verify.ts` runs contract C2's client verification, and no step of it is skipped before the archive is extracted:

1. The root chain from the root the launcher embeds, each root verified by the version before it, with the newest held to its own threshold and expiry.
2. The timestamp's signature, its lifetime, its expiry and its version against the one this home stored, which refuses a replay.
3. The channel's manifest, by the digest the fresh timestamp names and the targets threshold's signature, and the version a person asked for when they named one. A manifest whose builder is `local release (no independent rebuild)` (`LOCAL_RELEASE_BUILDER`), which only `local-release.ts` writes, is built and signed on the maintainer's PC and no second builder rebuilt it. A channel that fetches from contract C2's production publication, or whose roots are production roots, installs such a manifest only while `localBuilderAllowed` (`src/local-builder.ts`) holds: the release is a 0.x release, and the root that verified it is the preview root, the root file whose SHA-256 (`PREVIEW_ROOT_SHA256`) the [trust page](../../docs/guide/safety-and-updates/trust.md#how-releases-are-signed-in-the-preview) publishes. A 1.0 release (including `1.0.0-rc.1`) or any other root file refuses with `INSTALL_VERIFY_FAILED`. That is the one exception: every signature, digest, threshold, release-log, freshness and path check still runs first.
4. The platform's file list, held to the manifest's length and SHA-256 and to its own signature.
5. The archive itself, held to the manifest's length and SHA-256 as it is read from disk.

`LauncherChannel` is the composition the launcher drives: `resolve` names and verifies a release and records what it proved under `trust/`, and `fill` downloads that release's archive and file list, checks both against the manifest, and extracts into the staging directory the store made, after it removes the `.download-*` directories that earlier runs left in `staging/` (the store's lock is held, so none belongs to a running install). Each download is held to the length its signed reference gives it: the manifest to the length the timestamp names, and the archive and the file list to the lengths the manifest names, with contract C1's limits as the ceiling and the release-log bundle at its 64 KiB limit. `recordInstalled` records the release's check state; a caller runs it after the store's install returned, so a release the store refused leaves no record. The roots, the timestamp and the checkpoint that verified are recorded as they verify, because a later install holds the root chain, the timestamp and the log to them even when this install ends before the runtime lands. The channel reports each step as an `InstallProgress` event through its `progress` option and formats nothing: `resolving`, `resolved`, `signature-checked`, `log-checked`, `downloading` with the archive's signed size, `download-bytes` (at most ten a second, and always the last), `downloaded`, `download-verified` once the archive's length and SHA-256 match the signed manifest, `unpacking` with the file count of the signed list, and `unpack-files` (at most ten a second, and always the last). The caller adds `installing`, `installed`, `starting` and `failed`, and a plugin pack's own download reports `pack-downloading`, `pack-bytes`, `pack-installing` and `pack-installed`. `Downloader.file` and `extractArchive` take a callback that counts bytes and files; it displays and decides nothing. `InstallRenderer` (`createRenderer` makes one for a stream) turns the events into the checklist a person reads: a redrawn block with a spinner, durations right-aligned in one column, a bar, the speed and the time left on a terminal, and plain lines, one for each tenth of a download, anywhere else. The launcher, `delorun update`, `delorun repair` and the plugin pack downloads all use it. The size, speed and time-left formats and the speed over the last five seconds live in `@delorun/install/transfer`, which imports nothing, so the studio's download rows measure and word a pack's download the same way.

<a id="the-release-log"></a>

## The release log

A release that publishes no bundle is `RELEASE_LOG_FAILED`, and nothing installs. `resolve` runs contract C18's check through `@delorun/release-verify`'s `checkAndStore`, the one implementation the launcher's start and `delorun verify` also run, in `enforce` mode: the bundle offline, then the online check against the log's latest checkpoint, from the checkpoint the bundle carries or the newer one this home stored, storing the checkpoint that verified in `trust/checkpoint.json`. That package's README states which answers leave the release `unchecked` and which fail it. A `failed` check refuses the install with `RELEASE_LOG_FAILED`; an `unchecked` release installs on its signature, and the channel reports `log-checked` with the reason so the launcher can warn (contract C18, "Behaviour per client"). A failure of the check's own code refuses with `RELEASE_LOG_FAILED` as well, and a record under `trust/` that is a link, another user's, laxer than 0600 or cannot be written refuses with `TRUST_STATE_INVALID`. `recordInstalled` writes the outcome, `verified` or `unchecked` with its reason, to `trust/release-log.json` through `recordResult`, keeping the entries of other releases; a `failed` check records nothing. The `log` option is the transport the check reads, or a function that makes one for the root being trusted; the launcher passes `@delorun/release-verify`'s `tilesTransport` at the endpoints the root's `log.origin` names, or a local log's endpoints in a build made for one.

<a id="extraction"></a>

## Extraction

`extractArchive` accepts exactly the files the signed list names, at the list's length, SHA-256 and mode. Each file is hashed once, from the bytes it is written from, created exclusively at its installed mode (0444, or 0555 for an executable) and reported with its identity right after the write, so the runtime store confirms the identity instead of reading the file again. An entry type the archive format forbids, a path the list does not name, a path that would land outside the staging directory, a repeated path and a length or digest the list contradicts each stop the extraction, and a listed file the archive lacks stops it too. The staging directory is left for the caller to remove, and nothing is written outside it. Up to 16 files, holding at most 64 MiB between them, are written at once while the archive is read on; an entry whose file already exists, as two names that differ only by case are on a file system that ignores case, is a refused archive, and a file that cannot be written otherwise stops the extraction with `DOWNLOAD_FAILED`, as a download that cannot be written does; a refusal or a failed write returns only after every write has ended, so the caller's removal of the staging directory races none. No file is synced on its own: the runtime store syncs the store's directory before and after it moves the staging directory in. `tests/timing/extract-timing.ts` times the archive read, the read with hashing and the extraction against a real closure.

<a id="what-a-home-remembers"></a>

## What a home remembers

Three files under `trust/` are the rollback protection an install keeps, and each is written at mode 0600 through a temporary file: the newest root that verified, the newest timestamp that verified, and the newest log checkpoint that verified. Beside them, `trust/roots/<n>.root.json` keeps the chain an install walked, one file per root version, oldest first. A later install walks the root chain forward from the stored root once the launcher's shipped roots lead to it, refuses a timestamp that names a root below the stored one, refuses one that names more than `MAX_ROOT_ROTATIONS` (32) roots past it before it asks for any, and verifies each root file as it arrives. It refuses a timestamp below the stored one, and a root or timestamp file that does not read, and any of these files that belongs to another user or is laxer than 0600, refuses the install with `TRUST_STATE_INVALID` rather than being replaced. The checkpoint and the check state are `@delorun/release-verify`'s records: a stored checkpoint holds the log to its tree, and one that does not read is replaced with a notice in the check's result rather than refusing the install.

The stored root is also what a start anchors on, so `readStoredRootBytes` reads it back and `verifyStoredRoot` holds it to the roots the launcher ships: at a version the launcher ships, the stored root must be that very root, keys and roles included. A stored root older than the newest shipped root, one older than every shipped root included, is not the anchor: `verifyStoredRoot` returns the newest shipped root, so a targets key that root revoked fails the start check. A stored root newer than every shipped root is trusted only when the chain an install walked reaches it from a shipped root, every version signed by the previous root's keys and by its own; a root that no shipped root leads to is refused, so a file a restore or a sync leaves under `trust/` cannot become an anchor. Nothing else about the stored root is taken on trust. `readShippedRoots(directory)` reads a launcher's `roots/<n>.root.json` files, oldest first, and refuses a directory that holds none, skips a version or does not walk as a chain; `readAnchoredRoot(home, shipped)` reads `trust/root.json` and the walked chain and applies `verifyStoredRoot`, which is how the runtime the launcher starts anchors every update, rollback and health check.

<a id="failures"></a>

## Failures

Every refusal is an `InstallError`, which `isInstallError` tests for:

| Code | What it means |
| --- | --- |
| `DOWNLOAD_REFUSED` | The URL is not HTTPS, names a host outside contract C1's list, or redirects to one |
| `DOWNLOAD_FAILED` | The connection did not open or stalled, the answer was not 200, the file passed its limit, or the file cannot be created, written to completion or closed |
| `INSTALL_VERIFY_FAILED` | A signature, digest, length or version check failed |
| `ARCHIVE_REFUSED` | The archive holds an entry its format forbids or its signed list does not name |
| `RELEASE_LOG_FAILED` | Contract C18's bundle or online check failed verifiably; an online check that could not run is not a failure |
| `RELEASE_NOT_OFFERED` | The version a person named is not the release the fresh timestamp names |
| `PLATFORM_NOT_RELEASED` | The verified release lists no runtime for this computer's platform; the refusal names the platform and the platforms the release lists |
| `RELEASE_METADATA_INVALID` | A release file does not read at all |
| `TRUST_STATE_INVALID` | A file under `trust/` does not read or cannot be written |
| `NO_TRUSTED_ROOT` | The launcher supplied no root, so nothing can be verified |

<a id="development"></a>

## Development

The package's tests are in `tests/`, and they serve the releases they verify from local bytes rather than from the network. Run them with the repository's Vitest configuration: `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/install`.
