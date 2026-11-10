---
description: "Delo's archive format v1 (C8): the ZIP reader and writer, the path, link, size and ratio refusals, the closed customisation schema, the signature and the signer a person accepts, the staging and atomic publication of an import, the export with its secrets warning, the home key that signs, and the import of a stock DeepSeek Harness home."
---

# @delo/archive

English

## Summary

This package implements the archive half of [contract C8](../../docs/contracts/c08-archive-and-trash.md): an export writes one or more workspaces with their chats and attachments as a ZIP file with a manifest, a customisation document and an Ed25519 signature, and an import checks every byte of such a file before it writes anything. An archive is hostile input until it has passed every check. `delorun export` and `delorun import` ([`@delo/cli`](../../apps/cli/README.md)) are the commands that reach it. The `./dsh-import` export carries out [the stock-home import](../../docs/contracts/c08-archive-and-trash.md#the-stock-home-import), which `delorun import-home` and setup reach.

## Contents

- [Import](#import)
- [The signer](#the-signer)
- [Export](#export)
- [The home key](#the-home-key)
- [The stock-home import](#the-stock-home-import)
- [Tests](#tests)

## Import

`ArchiveImporter` ([`importer.ts`](src/importer.ts)) checks the sizes the central directory declares before it reads any entry, because a read allocates what its record declares; then the manifest, the checksums, the paths, the entries, the limits, the customisation and the signature, in that order. A path that is absolute, climbs with `..`, holds a backslash, a control character or a reserved device name, a link or device member, two paths that differ only in letter case or Unicode normalisation, a declared size that disagrees with the bytes, and an entry past the size or ratio limits are each refused with their C8 code. `inspect` runs every check and writes nothing, so a caller can show the archive before it asks. Every text field of the manifest and the customisation document is refused when it holds a control or bidirectional character (`hasControlCharacter`, [`text.ts`](src/text.ts)), and the origin's `homeKeyId` must be its key's fingerprint. Validation keeps no entry's content, and a caller that holds the archive in memory passes lower `limits`. `import` stages the validated content under a new 0700 directory with 0600 files, reading each entry again as it writes it, publishes each workspace by one rename that never replaces an existing one, even an empty directory, and gives a taken identifier a new one; when a publication fails, every workspace the import already published is withdrawn. A journal beside the staging root names each workspace before it is published, and `recover` withdraws what a crashed import's journal names and removes its staging root. The staging parent, the store root and the directory holding either are refused when they are symbolic links.

## The signer

`checkArchiveSignature` ([`signature.ts`](src/signature.ts)) reports `verified` only for a signature that verifies over the manifest's exact bytes with a key the home vouches for: one in `trustedPublicKeys`, or the key the person confirmed. A confirmation binds the public key, never the identifier the archive declares. The importer refuses a signature that does not verify with `ARCHIVE_SIGNATURE_INVALID`, and refuses with `ARCHIVE_SIGNER_UNTRUSTED` a key that is neither vouched for nor confirmed and an unsigned archive the person did not accept with `acceptUnsigned`. `keyFingerprint` ([`fingerprint.ts`](src/fingerprint.ts)) is what a person compares: the SHA-256 of the raw public key, base64url, which is also the key's `homeKeyId`.

## Export

`exportArchive` ([`exporter.ts`](src/exporter.ts)) scans the chats for secrets first and returns the findings, by kind and chat and never by value, with no archive until the caller passes `confirmSecrets`. It stores each object under its SHA-256, signs the manifest when given a signer, and re-opens the finished archive against the limits an import applies, so it never hands back a file its own import refuses. Reading a home's stores belongs to the caller.

## The home key

`loadHomeKey` ([`home-key.ts`](src/home-key.ts)) reads the home key of [contract C5](../../docs/contracts/c05-device-approval.md), `secrets/home-auth/home-key.pem`, PKCS #8 at mode 0600, through C1's protected-file rules, and creates it on request when the home has none. A new key is written whole to a temporary file and linked into place, so two first uses at once keep one key.

## The stock-home import

`@delo/archive/dsh-import` copies a stock DeepSeek Harness home into a Delo home, and only ever reads the stock home, which it treats as hostile input.

- `planDshHomeImport` ([`plan.ts`](src/dsh-import/plan.ts)) reads both homes and writes nothing. It walks the stock home by `lstat` through the entries the layout table ([`layout.ts`](src/dsh-import/layout.ts)) names, and returns the data it carries (chats, attachments whose bytes have the digest their path names, the workspace list), each category a person says yes to separately (profiles, settings layers, instructions, skills, the DeepSeek key) with the exact text that lands, every entry it leaves behind with a reason, at most 100 listed per reason and all counted, and the blockers that keep it from going on: a Delo home with chats without `merge`, and each collision. A directory without a chat, a profile manifest or a workspace list is refused, and a size limit past its bound throws. A link, a pipe, socket or device, an entry on another device and a name upstream does not write are left behind; a chat goes whole or not at all.
- `SourceReader` ([`source.ts`](src/dsh-import/source.ts)) opens each stock directory with `O_NOFOLLOW` and `O_DIRECTORY` and lists it from the descriptor, and each stock file with `O_NOFOLLOW` and `O_NONBLOCK`; it checks every open descriptor against the identity and path the walk recorded, reads no more than the recorded size, and counts every listed name against the entry limit. It counts the hard links it meets, so a file with a link from outside the stock home is never copied.
- `splitPatchLayer` and `splitSettingsLayer` ([`layers.ts`](src/dsh-import/layers.ts)) parse a patch layer or the earlier settings without evaluating them, carry only the row and setting pairs on the `CARRIED_SETTINGS` allow list with plain values, and hold back every other row with a reason, as an inert file.
- `ChatLogScan` ([`chats.ts`](src/dsh-import/chats.ts)) reads a chat's newest generation as a bounded stream while it is hashed: the header's Session and working folder, and whether the log ends inside a turn. `sensitiveFolder`, `restrictRegistry` and `serializeRegistry` ([`workspaces.ts`](src/dsh-import/workspaces.ts)) hold back a workspace in a sensitive folder and write the list from its parsed value with only what is carried.
- `landManifest` and `carryNotes` ([`profiles.ts`](src/dsh-import/profiles.ts)) write a profile manifest again with a name, `private`, its registry dependencies and its bundle list, list each bundle and plugin as carried, to install, added or not carried, and run [`@delo/profile-safety`](../profile-safety/README.md)'s carry check on texts read once.
- `parseRegistry` and `mergeRegistries` ([`workspaces.ts`](src/dsh-import/workspaces.ts)) read upstream's workspace unit with its own record schemas and join two lists without overwriting a record. The credentials are read with upstream's parser ([`credentials.ts`](src/dsh-import/credentials.ts)), which offers only the DeepSeek key; a value is never returned or printed.
- `applyDshHomeImport` ([`apply.ts`](src/dsh-import/apply.ts)) carries out a plan with the categories the person took: it stages and syncs every file under `archive/stock-import/staging-<id>/`, checks each document's digest again, writes and syncs a journal that names every directory and file it will place, places each new file by one hard link that fails on an existing path, replaces a document it adds to by one rename after linking the original aside, and removes the journal to complete. A failure withdraws what it placed and puts back what it replaced, leaving a file whose bytes changed since it was placed; `recoverDshImport` does the same for a crashed import, refuses a journal whose staging directory is gone, and removes every staging root, and `recoverStockImport` is the form the start path is to call before a profile starts. `readDshImportRecord` returns what completed imports carried.

## Tests

From the repository root, `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/archive` runs the specs: the extraction refusals, the size bounds, the staging directory, the signer consent, the preview, the partway failure, the customisation schema, the export round trip, the home key, and C8's denial tests for control characters, lazy reading, lower limits, recovery and linked directories. The `dsh-import` specs cover the stock-home import: what it carries and leaves behind, the link, pipe, mount, swapped-directory, hard-link, name, size and collision refusals, each class of held-back row, the profile as data, and the journal's withdrawal after a failure or a crash at any placement.
