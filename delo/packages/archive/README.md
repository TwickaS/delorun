---
description: "Delo's archive format v1 (C8): the ZIP reader and writer, the path, link, size and ratio refusals, the closed customisation schema, the signature and the signer a person accepts, the staging and atomic publication of an import, the export with its secrets warning, and the home key that signs."
---

# @delo/archive

English

## Summary

This package implements the archive half of [contract C8](../../docs/contracts/c08-archive-and-trash.md): an export writes one or more workspaces with their chats and attachments as a ZIP file with a manifest, a customisation document and an Ed25519 signature, and an import checks every byte of such a file before it writes anything. An archive is hostile input until it has passed every check. `delorun export` and `delorun import` ([`@delo/cli`](../../apps/cli/README.md)) are the commands that reach it.

## Contents

- [Import](#import)
- [The signer](#the-signer)
- [Export](#export)
- [The home key](#the-home-key)
- [Tests](#tests)

## Import

`ArchiveImporter` ([`importer.ts`](src/importer.ts)) checks the sizes the central directory declares before it reads any entry, because a read allocates what its record declares; then the manifest, the checksums, the paths, the entries, the limits, the customisation and the signature, in that order. A path that is absolute, climbs with `..`, holds a backslash, a control character or a reserved device name, a link or device member, two paths that differ only in letter case or Unicode normalisation, a declared size that disagrees with the bytes, and an entry past the size or ratio limits are each refused with their C8 code. `inspect` runs every check and writes nothing, so a caller can show the archive before it asks. Every text field of the manifest and the customisation document is refused when it holds a control or bidirectional character (`hasControlCharacter`, [`text.ts`](src/text.ts)), and the origin's `homeKeyId` must be its key's fingerprint. Validation keeps no entry's content, and a caller that holds the archive in memory passes lower `limits`. `import` stages the validated content under a new 0700 directory with 0600 files, reading each entry again as it writes it, publishes each workspace by one rename that never replaces an existing one, even an empty directory, and gives a taken identifier a new one; when a publication fails, every workspace the import already published is withdrawn. A journal beside the staging root names each workspace before it is published, and `recover` withdraws what a crashed import's journal names and removes its staging root. The staging parent, the store root and the directory holding either are refused when they are symbolic links.

## The signer

`checkArchiveSignature` ([`signature.ts`](src/signature.ts)) reports `verified` only for a signature that verifies over the manifest's exact bytes with a key the home vouches for: one in `trustedPublicKeys`, or the key the person confirmed. A confirmation binds the public key, never the identifier the archive declares. The importer refuses a signature that does not verify with `ARCHIVE_SIGNATURE_INVALID`, and refuses with `ARCHIVE_SIGNER_UNTRUSTED` a key that is neither vouched for nor confirmed and an unsigned archive the person did not accept with `acceptUnsigned`. `keyFingerprint` ([`fingerprint.ts`](src/fingerprint.ts)) is what a person compares: the SHA-256 of the raw public key, base64url, which is also the key's `homeKeyId`.

## Export

`exportArchive` ([`exporter.ts`](src/exporter.ts)) scans the chats for secrets first and returns the findings, by kind and chat and never by value, with no archive until the caller passes `confirmSecrets`. It stores each object under its SHA-256, signs the manifest when given a signer, and re-opens the finished archive against the limits an import applies, so it never hands back a file its own import refuses. Reading a home's stores belongs to the caller.

## The home key

`loadHomeKey` ([`home-key.ts`](src/home-key.ts)) reads the home key of [contract C5](../../docs/contracts/c05-device-approval.md), `secrets/home-auth/home-key.pem`, PKCS #8 at mode 0600, through C1's protected-file rules, and creates it on request when the home has none. A new key is written whole to a temporary file and linked into place, so two first uses at once keep one key.

## Tests

From the repository root, `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/archive` runs the specs: the extraction refusals, the size bounds, the staging directory, the signer consent, the preview, the partway failure, the customisation schema, the export round trip, the home key, and C8's denial tests for control characters, lazy reading, lower limits, recovery and linked directories.
