---
description: "Types-only package holding the archive format v1 types, the customisation row kinds, the error codes, the limits and the trash retention, as specified by contract C8."
---

# @delo/contract-archive-and-trash

English | [中文](README.zh.md)

## Summary

This types-only package exports the archive format v1: the manifest and customisation types, the row kinds that the schema admits and denies, the error codes, the limits and the trash retention. The archive, trash and import code and the studio's trash screen import these definitions, so each limit and each error code has one definition. The specification is [contract C8](../../docs/contracts/c08-archive-and-trash.md).

## Exports

- `ARCHIVE_FORMAT_VERSION`, `ARCHIVE_CUSTOMISATION_SCHEMA_VERSION` and `ARCHIVE_SIGNATURE_ALGORITHM`: the format version, the schema version and the signature algorithm.
- `ARCHIVE_LIMITS`, `TRASH_RETENTION_DAYS` and `PURGE_RESIDUE_MAX_DAYS`: the archive limits, the trash retention and the bound on process-log residue.
- `ARCHIVE_ENTRY_KINDS`, `ARCHIVE_ROW_KINDS`, `ARCHIVE_DENIED_ROW_KINDS` and `ARCHIVE_ERROR_CODES`, with the union types derived from each.
- `ArchiveManifest`, `ArchiveCustomisation`, `ArchiveCustomisationRow`, `ArchiveSignature`, `ArchiveOrigin`, `ArchiveEntry` and `ArchiveWorkspace`: the document types.

## Limits

The package has no runtime code and no dependencies. A change to a limit or an error code follows the compatibility section of the contract.
