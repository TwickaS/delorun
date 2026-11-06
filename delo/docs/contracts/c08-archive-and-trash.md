---
description: "Contract C8: the archive format v1 and its manifest, the closed customisation schema and its denied rows, signature verification, limits, staging and publication, the error taxonomy, untrusted imported chats, and trash with its purge."
---

# Contract C8: archive format v1 and trash

English | [中文](c08-archive-and-trash.zh.md)

<a id="summary"></a>
## Summary

An archive is the export file of one or more workspaces with their chats, attachments and customisation. Its format is versioned. An import validates the whole archive in a staging directory before it writes anything, and it publishes each new workspace atomically without overwriting an existing one. Customisation is data under a closed schema. It cannot contain code, and it cannot set a sandbox mode, a credential reference, a reach option or egress. Trash keeps a deleted chat or workspace for 30 days, and a purge removes its content from every store that holds it.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Contract](#contract)
  - [Archive file](#archive-file)
  - [Manifest](#manifest)
  - [Customisation schema](#customisation-schema)
  - [Signature](#signature)
  - [Limits](#limits)
  - [Import and export](#import-and-export)
  - [Errors](#errors)
  - [Untrusted imported chats](#untrusted-imported-chats)
  - [Trash and purge](#trash-and-purge)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="archive-file"></a>
### Archive file

An archive is a ZIP file. Its root holds these entries.

- `manifest.json`: the manifest described below.
- `customisation.json`: the customisation document, which is always present, even when it lists no rows.
- `signature.json`: the signature over `manifest.json`. It is present only when the exporting home signed the archive.
- `objects/<sha256>`: one entry for each distinct content, named by the SHA-256 of its bytes. An attachment, a chat generation and a workspace entity record each refer to an object by its digest.

No other top-level entry is valid. The archive carries no project files of a workspace, because a workspace's code lives in the person's own repository. It carries the workspace entity, its chats, its attachments and its customisation.

<a id="manifest"></a>
### Manifest

`manifest.json` is a JSON object with these fields.

| Field | Type | Rule |
| --- | --- | --- |
| `formatVersion` | Integer `1`. | Readers refuse any other value with `ARCHIVE_UNSUPPORTED_VERSION`. |
| `createdBy` | String. | The Delo version that wrote the archive. It is informational and does not change how the archive is read. |
| `exportedAt` | RFC 3339 time in UTC. | The time the export finished. |
| `origin` | Object with `homeKeyId` and `publicKey`, both base64url. | The exporting home's key. Present whether or not the archive is signed. |
| `workspaces` | Array. | One object for each workspace: its `id` as the archive names it, its name, and its chats, attachments and objects. |
| `entries` | Array. | One object for each object and document: `path`, `sha256`, `size` in bytes, and `kind`. The `kind` is one of `chat-generation`, `attachment`, `workspace-entity` and `customisation`. |

Every `path` is normalised, relative and free of `..` segments, and it refers to an entry of the archive. The manifest lists each entry once.

<a id="customisation-schema"></a>
### Customisation schema

`customisation.json` is a JSON object with `schemaVersion` `1` and an array `rows`. Each row has a `kind` from the table below. Any other kind, and any field that the kind's schema does not define, is refused.

| Row kind | Holds | Rule |
| --- | --- | --- |
| `bundle` | A bundle package name. | Listed on the diff screen. Setup does not install it. |
| `profile-row` | A row id and plain config values for that row. | Values are data. Expressions and `insert` rows are refused. |
| `preset` | A preset definition. | Cannot raise a permission above the person's own presets. |
| `skill` | A skill's files. | Imported disabled. |
| `theme` | Theme values. | Data only. |
| `plugin-declaration` | A plugin name and its pinned version. | Listed on the diff screen. Never installed automatically. |

The denied row kinds are `sandbox-mode`, `credential-reference`, `reach-row` and `egress`. A row that sets a sandbox mode, a credential reference, a reach option or an egress limit is refused. Any `!!js` expression and any `insert` row is refused before evaluation, so an archive causes no evaluation.

The customisation applies only after the person has seen its diff. The diff screen shows each row, its kind and its target before the change is written.

<a id="signature"></a>
### Signature

`signature.json` is a JSON object with `algorithm` `ed25519`, the `homeKeyId` of the signing key, and the `signature` in base64url. The signature covers the exact bytes of `manifest.json`. The signing key is the exporting home's key. An archive without `signature.json`, whose signature fails, or whose key the importing home does not vouch for is imported in the unverified state. The importing home vouches for a key that it already holds as a trusted home key, or that the person confirms by its fingerprint at import.

Verification happens before anything is written. The unverified state is shown on the diff screen and in the report that `delorun import` prints.

<a id="limits"></a>
### Limits

An import refuses an archive that exceeds these limits, with `ARCHIVE_TOO_MANY_ENTRIES`, `ARCHIVE_ENTRY_TOO_LARGE`, `ARCHIVE_TOTAL_TOO_LARGE` or `ARCHIVE_RATIO_EXCEEDED`.

| Limit | Value |
| --- | --- |
| Entries in one archive | 100,000 |
| Uncompressed size of the whole archive | 4 GiB |
| Uncompressed size of one entry | 1 GiB |
| Ratio of uncompressed to compressed size of one entry | 100:1 |

The check is made on the sizes that the central directory and the entry headers declare and again on the bytes read, so a declared size that is smaller than the bytes read is refused.

<a id="import-and-export"></a>
### Import and export

Export streams each object into the archive and records its SHA-256 and size in the manifest. The export warns the person about secrets that it finds in chat history, and the person decides whether to continue.

Import reads the archive into a staging directory under the home directory, on the same file system as the workspace store. It validates the manifest, the checksums, the paths, the entries, the limits, the customisation and the signature, in that order. Only a fully validated archive is published. Each new workspace is published by one atomic rename from the staging directory into the workspace store. An import never overwrites an existing workspace or chat. When an identifier already exists, the import assigns a new one.

The import of a stock DeepSeek Harness home copies its plugins, settings and sessions into a new Delo home, and it never modifies the stock home.

<a id="errors"></a>
### Errors

Each refusal carries one code from this table. A refusal writes nothing.

| Code | Cause |
| --- | --- |
| `ARCHIVE_UNSUPPORTED_VERSION` | `formatVersion` or the customisation `schemaVersion` is not one the reader knows. |
| `ARCHIVE_TRUNCATED` | The ZIP structure or an entry ends early, or a declared size does not match the bytes. |
| `ARCHIVE_CHECKSUM_MISMATCH` | An entry's bytes do not match its SHA-256 in the manifest. |
| `ARCHIVE_PATH_REJECTED` | A path is absolute, contains `..`, contains a backslash or names a reserved device. |
| `ARCHIVE_LINK_REJECTED` | An entry is a symbolic or hard link. |
| `ARCHIVE_CASE_COLLISION` | Two paths differ only in letter case. |
| `ARCHIVE_TOO_MANY_ENTRIES` | The archive exceeds the entry limit. |
| `ARCHIVE_ENTRY_TOO_LARGE` | An entry exceeds the per-entry size limit. |
| `ARCHIVE_TOTAL_TOO_LARGE` | The archive exceeds the total size limit. |
| `ARCHIVE_RATIO_EXCEEDED` | An entry exceeds the compression ratio limit. |
| `ARCHIVE_SCHEMA_INVALID` | The customisation document does not match the closed schema. |
| `ARCHIVE_EXPRESSION_REFUSED` | A row contains a `!!js` expression or an `insert` row. |
| `ARCHIVE_DENIED_ROW` | A row is of a denied kind. |
| `ARCHIVE_SIGNATURE_INVALID` | `signature.json` is present and its signature does not verify. |
| `ARCHIVE_STAGING_FAILED` | The staging directory cannot be written, or the atomic rename fails. |

An absent signature is not an error. It is the unverified state.

<a id="untrusted-imported-chats"></a>
### Untrusted imported chats

Every imported chat is untrusted until the person marks it trusted. An untrusted chat shows a banner that names its source, meaning the archive's origin or file name. Its history stays out of model context until the person marks it trusted. Deleting an untrusted chat moves it to trash, and purging it removes it at once.

<a id="trash-and-purge"></a>
### Trash and purge

Deleting a chat or a workspace moves it to trash. Trash keeps each item for 30 days. The person can restore an item from trash before its retention ends. At the end of its retention, the item is purged. Trash keeps the secrets in the item until it is purged.

A purge removes the item from each store that holds its content.

- The item's rows in the SQLite FTS5 full-text index of `session-query-sqlite`.
- The session directory of each chat in the item, with every generation in it, which is every `session*.jsonl.zstd` file.
- The attachments of the item.
- The spill files of the item in the `spill` storage.
- The draft entries of the item in the browser that performs the purge, under every host scope, as the host-qualified keys contract sets.

Fragments of purged content may remain in the operational logs until those logs are removed. Under the operational-log contract, each operational-log record is kept for at most 14 days. A purge states this residue. It offers to clear the affected log files, current and rotated, at once. When the person accepts, the purge deletes them.

<a id="consumers"></a>
## Consumers

- `delo/packages/archive/`: the export, the import and the validation, with the stock-home import under `src/dsh-import/`.
- `delo/packages/trash/`: trash, restore and purge, and the trash retention.
- The studio's trash screen and its draft entries under the host-qualified keys contract.
- `delorun import`, which prints the verification report.
- `delo/packages/contract-archive-and-trash/`: the manifest, row kinds, error codes, limits and retention constants.

<a id="compatibility"></a>
## Compatibility

The archive format is versioned by `formatVersion`, which is `1`. A reader refuses any other version, and no reader falls back to an older format or downgrades an archive. A future format is a new version with its own reader. An archive of an older version is read by the reader for that version.

Session data inside an archive follows upstream's session readers and migrations. The current session format version is recorded in the [session format status page](../../../docs/session-format-status.md), and this contract does not restate it.

The customisation `schemaVersion` changes only with an incompatible change to a row kind. Adding a row kind is a new version. Removing a denied kind is a breaking change that needs an upgrade guide.

The trash retention is a behaviour that a person can rely on. Changing it is a change to this contract and its upgrade guide.

<a id="security"></a>
## Security

Requirements:

- Nothing is written until the whole archive validates in staging.
- An archive never evaluates a `!!js` expression, and it never writes a row that contains one.
- A row of a denied kind is refused, so an archive cannot change a sandbox mode, a credential reference, a reach option or an egress limit.
- An archive whose signature does not verify, or that carries none, imports only in the unverified state, and the diff screen and the report both show that state.
- Imported plugin declarations are listed and never installed automatically.
- Imported presets cannot raise a permission above the person's own presets.
- Imported skills start disabled, and imported chats start untrusted.
- An import never overwrites a workspace or chat.
- Trash keeps secrets until purged, and a purge removes the content from every store listed in this contract.
- Export warns about secrets in chat history before it writes the archive.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `archive with a !!js expression causes no evaluation or write` | A customisation row that contains `!!js` is refused before evaluation, and no file is written. |
| `archive with an insert row is refused` | A customisation row of the `insert` form is refused with `ARCHIVE_EXPRESSION_REFUSED`. |
| `archive that sets a sandbox mode, credential reference, reach row or egress is refused` | Each such row is refused with `ARCHIVE_DENIED_ROW`, and no row is applied. |
| `traversal, link, size, ratio, case, truncation, version and canary fixtures cause no write` | Each fixture is refused with its error code, and the workspace store is unchanged. |
| `unverified archive imports only with the unverified label` | An archive with no signature, or with a failing signature, shows the unverified label on the diff screen and in the report. |
| `imported plugin declarations are listed and never installed` | After import, no plugin declared by the archive is installed. |
| `imported presets do not raise permissions` | An imported preset cannot grant a permission above the person's own presets. |
| `imported skills start disabled` | Each imported skill is disabled after import. |
| `imported chat stays out of model context until trusted` | An untrusted chat shows its banner, and its history is absent from every model request until the person marks it trusted. |
| `import into an existing identifier never overwrites` | An import whose identifier exists writes a new workspace and leaves the existing one unchanged. |
| `canary is absent from the index and every generation after purge` | After purge, the canary text is absent from the full-text index and from every session generation of the chat. |
| `purge with clear-logs chosen leaves no canary residue anywhere` | After purge with the clear offer accepted, the canary text is absent from every store and every log file. |
| `purge without clear-logs leaves residue only in retained process logs` | After purge without the clear offer, the canary text remains only in process logs inside their 14-day retention. |
| `export warns about secrets found in chat history` | An export of a chat with a planted secret shows a warning before it writes the archive. |

<a id="decided-values"></a>
## Decided values

- The archive limits are 100,000 entries, 4 GiB uncompressed in total, 1 GiB per entry, and a 100:1 compression ratio per entry.
- Trash keeps each item for 30 days.
- Purged content stays in process logs for at most 14 days, the retention of the operational-log contract.
- An imported chat is untrusted until the person marks it trusted. Its banner names its source. Deleting it moves it to trash, and purging it removes it at once.
- The archive signature algorithm is Ed25519, and its key is the exporting home's key.
