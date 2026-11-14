/**
 * Archive format v1, its manifest and customisation types, the denied row kinds, the
 * error codes, the limits and the trash retention, as specified by
 * `delorun/docs/contracts/c08-archive-and-trash.md`. This module holds readonly constants
 * and types only.
 *
 * @module @delorun/contract-archive-and-trash
 */

/** Archive format version. Readers refuse any other value. */
export const ARCHIVE_FORMAT_VERSION = 1 as const

/** Customisation document schema version. */
export const ARCHIVE_CUSTOMISATION_SCHEMA_VERSION = 1 as const

/** Algorithm of the archive signature. */
export const ARCHIVE_SIGNATURE_ALGORITHM = 'ed25519' as const

/** Kinds of entries in an archive manifest. */
export const ARCHIVE_ENTRY_KINDS = ['chat-generation', 'attachment', 'workspace-entity', 'customisation'] as const

/** One entry kind of {@link ARCHIVE_ENTRY_KINDS}. */
export type ArchiveEntryKind = (typeof ARCHIVE_ENTRY_KINDS)[number]

/** Row kinds that the customisation schema admits. */
export const ARCHIVE_ROW_KINDS = ['bundle', 'profile-row', 'preset', 'skill', 'theme', 'plugin-declaration'] as const

/** One row kind of {@link ARCHIVE_ROW_KINDS}. */
export type ArchiveRowKind = (typeof ARCHIVE_ROW_KINDS)[number]

/** Row kinds that an archive must never contain. A row of one of these kinds is refused. */
export const ARCHIVE_DENIED_ROW_KINDS = ['sandbox-mode', 'credential-reference', 'reach-row', 'egress'] as const

/** Limits applied to every archive at import. */
export const ARCHIVE_LIMITS = {
  /** Entries in one archive. */
  maxEntries: 100_000,
  /** Uncompressed size of the whole archive, in bytes: 4 GiB. */
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  /** Uncompressed size of one entry, in bytes: 1 GiB. */
  maxEntryBytes: 1024 * 1024 * 1024,
  /** Ratio of uncompressed to compressed size of one entry. */
  maxCompressionRatio: 100,
} as const

/** Days that a trashed chat or workspace is kept before it is purged. */
export const TRASH_RETENTION_DAYS = 30 as const

/** Days that operational-log records can keep purged content, under the operational-log contract. */
export const PURGE_RESIDUE_MAX_DAYS = 14 as const

/** Error codes of an archive refusal. A refusal writes nothing. */
export const ARCHIVE_ERROR_CODES = [
  'ARCHIVE_UNSUPPORTED_VERSION',
  'ARCHIVE_TRUNCATED',
  'ARCHIVE_CHECKSUM_MISMATCH',
  'ARCHIVE_PATH_REJECTED',
  'ARCHIVE_LINK_REJECTED',
  'ARCHIVE_CASE_COLLISION',
  'ARCHIVE_TOO_MANY_ENTRIES',
  'ARCHIVE_ENTRY_TOO_LARGE',
  'ARCHIVE_TOTAL_TOO_LARGE',
  'ARCHIVE_RATIO_EXCEEDED',
  'ARCHIVE_SCHEMA_INVALID',
  'ARCHIVE_EXPRESSION_REFUSED',
  'ARCHIVE_DENIED_ROW',
  'ARCHIVE_SIGNATURE_INVALID',
  'ARCHIVE_SIGNER_UNTRUSTED',
  'ARCHIVE_STAGING_FAILED',
] as const

/** One error code of {@link ARCHIVE_ERROR_CODES}. */
export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number]

/** The exporting home's key, which the manifest presents. */
export interface ArchiveOrigin {
  /** Identifier of the home key, as the home's key contract defines it. */
  readonly homeKeyId: string
  /** Base64url public key. */
  readonly publicKey: string
}

/** One object or document of the archive. */
export interface ArchiveEntry {
  /** Normalised relative path. It never contains `..`, an absolute prefix or a backslash. */
  readonly path: string
  /** Lowercase hexadecimal SHA-256 of the entry's bytes. */
  readonly sha256: string
  /** Uncompressed size in bytes. */
  readonly size: number
  readonly kind: ArchiveEntryKind
}

/** One workspace of the archive, with the entries that belong to it. */
export interface ArchiveWorkspace {
  /** Identifier as the archive names it. An import that finds it taken assigns a new one. */
  readonly id: string
  readonly name: string
  readonly chats: readonly string[]
  readonly attachments: readonly string[]
  readonly objects: readonly string[]
}

/** The archive manifest, `manifest.json`. */
export interface ArchiveManifest {
  readonly formatVersion: typeof ARCHIVE_FORMAT_VERSION
  /** Delorun version that wrote the archive. Informational only. */
  readonly createdBy: string
  /** RFC 3339 time in UTC at which the export finished. */
  readonly exportedAt: string
  readonly origin: ArchiveOrigin
  readonly workspaces: readonly ArchiveWorkspace[]
  readonly entries: readonly ArchiveEntry[]
}

/** One row of the customisation document. */
export interface ArchiveCustomisationRow {
  readonly kind: ArchiveRowKind
  /** Identifier of the row's target: a bundle package name, a profile row id, a preset, a skill, a theme or a plugin. */
  readonly target: string
  /** Plain configuration values. Expressions and `insert` rows are never admitted. */
  readonly values: Readonly<Record<string, string | number | boolean | null>>
}

/** The customisation document, `customisation.json`. */
export interface ArchiveCustomisation {
  readonly schemaVersion: typeof ARCHIVE_CUSTOMISATION_SCHEMA_VERSION
  readonly rows: readonly ArchiveCustomisationRow[]
}

/** The archive signature, `signature.json`. Covers the exact bytes of `manifest.json`. */
export interface ArchiveSignature {
  readonly algorithm: typeof ARCHIVE_SIGNATURE_ALGORITHM
  readonly homeKeyId: string
  /** Base64url signature. */
  readonly signature: string
}
