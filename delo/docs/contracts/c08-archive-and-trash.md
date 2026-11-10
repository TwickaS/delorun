---
description: "Contract C8: the archive format v1 and its manifest, the closed customisation schema and its denied rows, signature verification, limits, staging and publication, the error taxonomy, where imported chats are kept, and trash with its purge."
---

# Contract C8: archive format v1 and trash

English | [中文](c08-archive-and-trash.zh.md)

<a id="summary"></a>
## Summary

An archive is the export file of one or more workspaces with their chats, attachments and customisation. Its format is versioned. An import validates the whole archive in a staging directory before it writes anything, and it publishes each new workspace atomically without overwriting an existing one. Customisation is data under a closed schema. It cannot contain code, and it cannot set a sandbox mode, a credential reference, a reach option or egress. Trash keeps a deleted chat or workspace for 30 days, and a purge removes its content from every store this page lists.

<a id="status"></a>
## Status

Export, import, trash and purge are built; using what an import stores is not.

- **Built and reached:** `delorun export`, `delorun import`, `delorun trash`, and the studio's trash and purge through `@delo/plugin-trash` in the CLI profile.
- **Not built:** opening imported chats, which no row of the CLI profile reads; their untrusted state, banner and the action that marks one trusted; applying customisation rows, which an import lists and never writes, with the diff screen and the rules for imported skills, presets and plugin declarations; and the import of a stock DeepSeek Harness home. These rules are in the [imported chats design](../design/imported-chats.md).

The requirements and denial tests below that this list names as not built protect no one until a change builds them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Archive file](#archive-file)
  - [Manifest](#manifest)
  - [Customisation schema](#customisation-schema)
  - [Signature](#signature)
  - [Limits](#limits)
  - [Import and export](#import-and-export)
  - [Errors](#errors)
  - [Imported chats](#untrusted-imported-chats)
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
| `origin` | Object with `homeKeyId` and `publicKey`, both base64url. | The exporting home's key. Present whether or not the archive is signed. `homeKeyId` is the key's fingerprint; any other value is refused with `ARCHIVE_SCHEMA_INVALID`. |
| `workspaces` | Array. | One object for each workspace: its `id` as the archive names it, its name, and its chats, attachments and objects. |
| `entries` | Array. | One object for each object and document: `path`, `sha256`, `size` in bytes, and `kind`. The `kind` is one of `chat-generation`, `attachment`, `workspace-entity` and `customisation`. |

Every `path` is normalised, relative and free of `..` segments, and it refers to an entry of the archive. The manifest lists each entry once. No text field of the manifest or of the customisation document holds a C0 or C1 control, DEL or a bidirectional control, because an import prints these fields; one that does is refused with `ARCHIVE_SCHEMA_INVALID`.

<a id="customisation-schema"></a>
### Customisation schema

`customisation.json` is a JSON object with `schemaVersion` `1` and an array `rows`. Each row has a `kind` from the table below. Any other kind, and any field that the kind's schema does not define, is refused.

| Row kind | Holds | Rule |
| --- | --- | --- |
| `bundle` | A bundle package name. | Listed by the import. Never installed. |
| `profile-row` | A row id and plain config values for that row. | Values are data. Expressions and `insert` rows are refused. |
| `preset` | A preset definition. | Listed by the import. |
| `skill` | A skill's files. | Listed by the import. |
| `theme` | Theme values. | Data only. |
| `plugin-declaration` | A plugin name and its pinned version. | Listed by the import. Never installed. |

The denied row kinds are `sandbox-mode`, `credential-reference`, `reach-row` and `egress`. A row that sets a sandbox mode, a credential reference, a reach option or an egress limit is refused. Any `!!js` expression and any `insert` row is refused before evaluation, so an archive causes no evaluation.

An import lists each row's kind and target and applies no row: no bundle or plugin is installed and no preset, skill, theme or profile row is written. `delorun export` writes no rows. Applying rows after a diff screen, with imported skills starting disabled and imported presets unable to raise a permission, is in the [imported chats design](../design/imported-chats.md) and is not built.

<a id="signature"></a>
### Signature

`signature.json` is a JSON object with `algorithm` `ed25519`, the `homeKeyId` of the signing key, and the `signature` in base64url. The signature covers the exact bytes of `manifest.json`. The signing key is the exporting home's key, the home key of [C5](c05-device-approval.md) at `secrets/home-auth/home-key.pem`, which the home's first export creates when no earlier component has. A key's fingerprint is the SHA-256 of its raw 32-byte public key in base64url, the home key id of C5; a person compares and confirms the fingerprint, because the archive chooses its declared `homeKeyId` itself.

An import goes on only with a signer the person has accepted:

- A signature that does not verify, or that names another key than the manifest's origin, is refused with `ARCHIVE_SIGNATURE_INVALID`.
- A signature by a key the importing home vouches for is the verified state. The home vouches for its own home key, and for a key the person confirms at import by typing its fingerprint.
- A signature by any other key is refused with `ARCHIVE_SIGNER_UNTRUSTED` until the person confirms the key.
- An archive without `signature.json` is refused with `ARCHIVE_SIGNER_UNTRUSTED` until the person accepts it in the unverified state.

Verification happens before anything is written. `delorun import` prints what Delo checked first, the signer's fingerprint and whether the home trusts it, and then what the archive states about itself, each archive-controlled string quoted with every control character escaped, before it asks. The person confirms an unknown key by typing its fingerprint, and accepts an unsigned archive by typing `unverified`, which a yes does not replace.

<a id="limits"></a>
### Limits

An import refuses an archive that exceeds these limits, with `ARCHIVE_TOO_MANY_ENTRIES`, `ARCHIVE_ENTRY_TOO_LARGE`, `ARCHIVE_TOTAL_TOO_LARGE` or `ARCHIVE_RATIO_EXCEEDED`.

| Limit | Value |
| --- | --- |
| Entries in one archive | 100,000 |
| Uncompressed size of the whole archive | 4 GiB |
| Uncompressed size of one entry | 1 GiB |
| Ratio of uncompressed to compressed size of one entry | 100:1 |

The check is made on the sizes that the central directory and the entry headers declare and again on the bytes read, so a declared size that is smaller than the bytes read is refused. A reader that holds the archive in memory may set lower limits: `delorun import` reads a file of at most 1 GiB and refuses an entry over 512 MiB, because it inflates one entry at a time into memory. Validation keeps no entry's content; each entry is read again as it is staged.

<a id="import-and-export"></a>
### Import and export

`delorun export <chat-or-workspace> --out <file>` writes one chat, or one workspace with its chats, from the home's stores: each chat's newest session generation, and the attachments a chat names by its content digest that the home's attachment store holds. Export writes each object into the archive and records its SHA-256 and size in the manifest. The export warns the person about secrets that it finds in chat history, naming each finding by its kind and chat and never by its value, and writes nothing until the person decides to continue. The archive file is created new at mode 0600 and never replaces an existing file.

`delorun import <file>` refuses a file larger than the total limit before it reads it. Import then checks the sizes the central directory declares before it reads any entry, and validates the manifest, the checksums, the paths, the entries, the limits, the customisation and the signature, in that order. Only a fully validated archive, whose signer the person accepted, is written: it is staged under `archive/staging/` in the home, and each new workspace is published by one atomic rename into `archive/imported/`, on the same file system. A publication that fails partway removes every workspace the same import already published, so a failed import leaves no partial workspace or chat. An import never overwrites an existing workspace or chat. When an identifier already exists, the import assigns a new one. Imported chats stay in `archive/imported/`, out of every model request; the customisation rows are listed and not applied.

An import keeps a journal beside its staging root that names each workspace before it is published. An import that a crash interrupts leaves its journal and staging root; the next import first withdraws every workspace the journal names and removes the staging root, which holds decoded chat content. A journal stays only when a withdrawal itself failed. The staging parent, the workspace store root and the directory that holds either must not be symbolic links, and a publication refuses a target that exists, even an empty directory a rename would replace.

`delorun trash` restore and purge, `delorun export` and `delorun import` run while the command holds the home lock of every profile of the home, because every profile shares the stores they read and change. A profile whose home process runs refuses the command, and no home process starts while the command holds the locks. The command also registers as the exclusive user of the stores under `run/data-users/` ([C1](c01-home-layout.md)): it refuses while `delorun headless` or another user is registered, or an update, a rollback or a restore of a session-data copy is in progress, and `delorun headless` refuses while it runs.

No command imports a stock DeepSeek Harness home; that import is in the [imported chats design](../design/imported-chats.md).

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
| `ARCHIVE_SCHEMA_INVALID` | The manifest or the customisation document does not match its schema, including a text field with a control character and a `homeKeyId` that is not the fingerprint of `publicKey`. |
| `ARCHIVE_EXPRESSION_REFUSED` | A row contains a `!!js` expression or an `insert` row. |
| `ARCHIVE_DENIED_ROW` | A row is of a denied kind. |
| `ARCHIVE_SIGNATURE_INVALID` | `signature.json` is present and its signature does not verify. |
| `ARCHIVE_SIGNER_UNTRUSTED` | The signing key is one the importing home does not vouch for and the person did not confirm, or the archive is unsigned and the person did not accept it unverified. |
| `ARCHIVE_STAGING_FAILED` | The staging directory or the import's journal cannot be written, the atomic rename fails, or the staging parent, the workspace store root or the directory that holds either is a symbolic link. |

An absent signature that the person accepted is not an error. It is the unverified state.

<a id="untrusted-imported-chats"></a>
### Imported chats

`delorun import` publishes imported workspaces, with their chats, to `archive/imported/`, creates no session, and says in its report that imported chats stay out of every model request and cannot be opened in the studio. No row of the CLI profile reads `archive/imported/`, so an imported chat reaches no Host plugin and no model request. An imported chat has no trust state, banner or trust action, and the trash and purge do not reach it. Opening imported chats as untrusted chats, with their history kept out of model context until the person marks them trusted, is in the [imported chats design](../design/imported-chats.md) and is not built.

<a id="trash-and-purge"></a>
### Trash and purge

Deleting a chat or a workspace moves it to trash. In the studio, the "Move to trash" action of a chat's or a workspace's menu archives its chats with their running work stopped, moves each chat's session directory into `trash/` under the home, and, for a workspace, records and removes its registration. A chat whose session lock a live writer holds stays at its origin, archived and hidden, until the next start moves it in. The Trash section in Settings lists every item with the days it has left; `delorun trash list` prints the same. Trash keeps each item for 30 days. The person can restore an item from trash before its retention ends: its chats return to their origin, a workspace is registered again with its chats, and every chat the delete archived is unarchived. Each start of the home process purges every item whose retention has ended. Trash keeps the secrets in the item until it is purged.

A delete writes the item's record, naming where each chat goes in the trash, before it moves the chat, and each start moves in a chat whose content is still at its origin, so a crash between the two loses nothing. A restore checks every target before it moves anything, refuses one where a session directory exists, and rewrites the record after each chat returns, so a restore that stops partway leaves a record of exactly what the trash still holds. A record names its chats' places as two encoded path segments under the configured sessions root; any other record is damaged. A damaged item directory is listed with its directory and the reason, and nothing restores, purges or expires it. `delorun trash restore` restores chats only: a workspace is restored in the Trash section in Settings, because a restore registers it again in the workspace list the home process owns.

The retention pass trusts the clock only within bounds. It purges nothing when an item was deleted later than the clock reads, or when the clock reads earlier than the last pass it recorded in `trash/retention.json`. When the clock reads more than 365 days after the last pass, the pass purges nothing once, records the new time, and runs at the next start.

A purge removes the item from each store that holds its content.

- The item's rows in the SQLite FTS5 full-text index of `session-query-sqlite`.
- The session directory of each chat in the item, with every generation in it, which is every `session*.jsonl.zstd` file.
- The projection cache's stored document for each chat in the item, which holds the cached title, first message, plan, goal and todos of that chat, and the copy the cache moved aside when it discarded an invalid record.
- The attachments the item's chats name that no chat under the sessions root and no other trash item names: for each, the image object, the file object and the file's alias directory under `attachments/v1/`. An attachment that another chat still names is kept, and the purge reports how many it kept. The request-image cache under `attachments/v1/request-images/`, keyed by the hash of each resized variant, is not reached.
- The spill files of the item in the `spill` storage.
- The draft entries of the item in the browser that performs the purge, under every host scope, as the host-qualified keys contract sets, and under the unqualified key a page without a host id writes. A purge from `delorun trash` or at the end of the retention is performed by no browser, so it reaches no draft.

Fragments of purged content may remain in the operational logs until those logs are removed. Under the operational-log contract, each operational-log record is kept for at most 14 days. A purge states this residue. The studio's purge offers to clear every operational log of the home, current and rotated, at once, not only the item's records, and says so before the person accepts; `delorun trash purge` and `delorun trash empty` clear them only when given `--clear-logs`, and otherwise print the residue and the command that removes it. When the person accepts, the purge deletes them; a log it could not clear is reported with its failure, and the purge then states the residue rather than reporting the logs cleared. Emptying the trash clears the logs with its last purge.

<a id="consumers"></a>
## Consumers

- `delo/packages/archive/`: the export, the import, the validation and the home key's loading.
- `delo/packages/trash/`: trash, restore and purge, and the trash retention.
- `delo/packages/plugin-trash/`: the studio's "Move to trash" actions, the Trash section and its draft entries under the host-qualified keys contract, and the purge at start; `@delo/bundle-local` mounts it in every CLI profile.
- `delorun trash`, `delorun export` and `delorun import` (`delo/apps/cli/`), which print the listing, write the signed archive and print the verification report.
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
- An archive whose signature does not verify is refused. An archive signed by a key the home does not trust is refused until the person confirms the key's fingerprint, and one that carries no signature until the person accepts it in the unverified state, which the import states before it asks.
- No customisation row is applied: no plugin declaration or bundle is installed, and no preset, skill, theme or profile row is written.
- Imported chats are kept where no row of the CLI profile reads them. Imported skills starting disabled, imported presets unable to raise a permission and imported chats starting untrusted are requirements of the [imported chats design](../design/imported-chats.md), which is not built.
- An import never overwrites a workspace or chat.
- Trash keeps secrets until purged, and a purge removes the content from every store listed in this contract. A tampered trash record cannot move or read a directory outside the sessions root or another item's content. A symbolic link planted at a store's root, or at the directory that holds a versioned root, is refused rather than followed, so a purge deletes nothing outside the store it names.
- Export warns about secrets in chat history before it writes the archive, and writes nothing until the person confirms.
- A delete never moves a chat's session directory while a live writer holds its session lock.
- A restore never overwrites a session directory, and a restore that stops partway leaves no restored chat on a purge's path.
- An import prints archive-controlled text only after what Delo checked, and an archive's text cannot carry a terminal control.
- An import writes only into directories that are not symbolic links, and an interrupted import's decoded chat content is removed by the next import.
- `delorun trash`, `export` and `import` never run beside a live home process of any profile.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `archive with a !!js expression causes no evaluation or write` | A customisation row that contains `!!js` is refused before evaluation, and no file is written. |
| `archive with an insert row is refused` | A customisation row of the `insert` form is refused with `ARCHIVE_EXPRESSION_REFUSED`. |
| `archive that sets a sandbox mode, credential reference, reach row or egress is refused` | Each such row is refused with `ARCHIVE_DENIED_ROW`, and no row is applied. |
| `traversal, link, size, ratio, case, truncation, version and canary fixtures cause no write` | Each fixture is refused with its error code, and the workspace store is unchanged. |
| `unverified archive imports only with the unverified label` | An archive with no signature imports only after the person accepts it, and the import states that it is not signed before it asks. |
| `a signature that does not verify is refused` | An archive whose manifest changed after signing, or whose signature is another key's, is refused with `ARCHIVE_SIGNATURE_INVALID`, and nothing is written. |
| `an unknown signer is refused until its fingerprint is typed` | An archive signed by a key the home does not trust is refused with `ARCHIVE_SIGNER_UNTRUSTED` until the person types the key's fingerprint, and nothing is written. |
| `an import that fails partway leaves no workspace` | A publication that fails after an earlier workspace of the same import was published removes that workspace. |
| `a deleted chat leaves the session list until it is restored` | A chat in trash is absent from upstream's session list and cannot be opened; a restore returns every event. |
| `a chat a live writer holds stays pending` | A chat whose session lock is held stays at its origin until the lock is released and a start moves it into trash. |
| `import into an existing identifier never overwrites` | An import whose identifier exists writes a new workspace and leaves the existing one unchanged. |
| `canary is absent from the index and every generation after purge` | After purge, the canary text is absent from the full-text index and from every session generation of the chat. |
| `purge refuses a symbolic link at a store` | A link planted at the attachment store is refused with `TRASH_STORE_REFUSED`, and the file it points to is unchanged. |
| `purge leaves no cached title or first message on disk` | After purge, the chat's projection-cache document is absent, so no cached title, first message, plan, goal or todo of the chat remains on disk. |
| `purge with clear-logs chosen leaves no canary residue anywhere` | After purge with the clear offer accepted, the canary text is absent from every store and every log file. |
| `purge without clear-logs leaves residue only in retained process logs` | After purge without the clear offer, the canary text remains only in process logs inside their 14-day retention. |
| `export warns about secrets found in chat history` | An export of a chat with a planted secret shows a warning before it writes the archive. |
| `a restore that would overwrite a chat moves nothing back` | A restore whose later target holds a session directory moves no chat and keeps the item whole. |
| `a restored chat is never purged after a restore that failed on a later chat` | After a restore fails on its second chat, a purge of the item leaves the first, restored chat in place. |
| `a crash before the move leaves the chat at its origin, and a restore deletes nothing` | A delete that stops after writing its record leaves the chat at its origin, and a restore of that item deletes nothing. |
| `a crash after the move leaves a record a restore follows back` | A delete that stops after the move leaves a record that names where the chat is, and a restore returns it. |
| `cannot make settle move a directory outside the sessions root` | A record whose chat origin climbs out of the sessions root is damaged, and no directory moves. |
| `cannot make a restore read content from another item` | A record that names another item's content is damaged, and that content stays where it is. |
| `a damaged record is reported with its directory and never expires` | An unreadable record is listed with its directory and reason, and a retention pass leaves it. |
| `purges nothing when an item was deleted later than the clock reads` | A retention pass over an item deleted later than the clock reads purges nothing. |
| `pauses once when the clock jumps more than a year past the last pass, and resumes at the next start` | A clock that jumps more than 365 days forward purges nothing at that start. |
| `canary attachment is purged from every layout only when no other chat names it` | A purge removes the attachment's object, file object and alias directory only when no other chat or item names its digest. |
| `reports a clear that failed as not cleared, with each failure` | A log clear that fails reports each failure and does not report the logs cleared. |
| `a workspace name holding %s is refused before anything is written` | A manifest text field with an escape sequence, a carriage return, a C1 control, DEL or a bidirectional control is refused with `ARCHIVE_SCHEMA_INVALID`. |
| `a customisation target holding a control character is refused` | A customisation row whose target holds a bidirectional control is refused. |
| `is validated without scanning its directory once per entry` | An archive of 400 entries is validated and imported with a constant number of directory scans. |
| `is read again entry by entry as it is staged, not held whole before the staging root exists` | An entry's content is read for staging only after the staging root exists. |
| `is finished by a recovery that withdraws what its journal names and removes what it staged` | A crashed import's published workspace and staged chat content are removed by the recovery. |
| `never lands on an existing directory, even an empty one a rename would replace` | A publication onto an existing empty directory fails, and both directories are unchanged. |
| `refuses a staging parent that is a symbolic link, or sits in one, before it writes anything` | An import or a recovery through a linked staging parent is refused, and the link's target is unchanged. |
| `refuses a workspace store root that is a symbolic link, or sits in one` | A publication into a linked store root is refused, and the link's target is unchanged. |
| `that is unsigned imports only after the person types unverified, which a yes is not` | `delorun import` of an unsigned archive refuses `y` and `yes`, and imports only after `unverified` is typed. |
| `escapes every archive-controlled field, after the line Delo checked` | `delorun import` prints the signer line first and every archive-controlled field with its controls escaped. |
| `with an entry over the terminal's lower ceiling is refused on its declarations` | `delorun import` refuses an entry declared over 512 MiB before reading it. |
| `refuses while a profile's home process runs, runs nothing, and leaves no lock it took` | A command whose home has a running profile refuses, runs nothing and releases every lock it took. |
| `leaves a workspace to the studio, which registers it again, and moves nothing` | `delorun trash restore` of a workspace item is refused with a pointer to the studio's Trash section. |
| `are read by no row of the shipped composition` | No row of the shipped composition names `archive/`, so imported chats reach no Host plugin. |

<a id="decided-values"></a>
## Decided values

- The archive limits are 100,000 entries, 4 GiB uncompressed in total, 1 GiB per entry, and a 100:1 compression ratio per entry.
- Trash keeps each item for 30 days.
- Purged content stays in process logs for at most 14 days, the retention of the operational-log contract.
- Imported chats stay in `archive/imported/`, which no row of the CLI profile reads.
- The archive signature algorithm is Ed25519, and its key is the exporting home's key.
