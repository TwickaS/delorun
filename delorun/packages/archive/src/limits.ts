/**
 * The size limits of contract C8. The same function checks the sizes an
 * archive's central directory declares and the sizes its manifest declares, so
 * an archive cannot pass a limit by declaring a small size in one place and a
 * large one in the other. The entry count, the per-entry size, the total size
 * and the compression ratio each have their own refusal. The central
 * directory's declarations are checked before an archive reads any entry, so a
 * bomb is refused on what it declares rather than inflated into memory and
 * refused afterwards.
 *
 * @module @delorun/archive/limits
 */
import type { ArchiveManifest } from '@delorun/contract-archive-and-trash'
import { ARCHIVE_LIMITS } from '@delorun/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import type { ZipArchive } from './zip-read.ts'

/** The sizes one entry declares. */
export interface DeclaredEntrySize {
  /** The entry's path or name, which the refusal quotes. */
  readonly path: string
  /** The size in bytes before compression. */
  readonly uncompressedSize: number
  /** The size in bytes as stored, and `undefined` where only the uncompressed size is known. */
  readonly compressedSize?: number | undefined
}

/** The limits one check applies, which default to the ones contract C8 sets. */
export type ArchiveSizeLimits = { readonly [Limit in keyof typeof ARCHIVE_LIMITS]: number }

/**
 * Check one archive's entry count, per-entry size, total size and compression
 * ratio.
 * @param entries - every entry the archive declares, in archive order.
 * @param limits - the limits to apply, by default the ones contract C8 sets.
 * @throws ArchiveError `ARCHIVE_TOO_MANY_ENTRIES`, `ARCHIVE_ENTRY_TOO_LARGE`, `ARCHIVE_TOTAL_TOO_LARGE` or `ARCHIVE_RATIO_EXCEEDED`, naming the entry or the count that passed the limit.
 */
export function checkEntrySizes(entries: readonly DeclaredEntrySize[], limits: ArchiveSizeLimits = ARCHIVE_LIMITS): void {
  if (entries.length > limits.maxEntries) {
    throw new ArchiveError(
      'ARCHIVE_TOO_MANY_ENTRIES',
      `the archive holds ${String(entries.length)} entries, over the limit of ${String(limits.maxEntries)}`,
    )
  }
  let total = 0
  for (const entry of entries) {
    if (!Number.isInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new ArchiveError('ARCHIVE_ENTRY_TOO_LARGE', `the entry ${JSON.stringify(entry.path)} declares no whole byte size`)
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new ArchiveError(
        'ARCHIVE_ENTRY_TOO_LARGE',
        `the entry ${JSON.stringify(entry.path)} declares ${String(entry.uncompressedSize)} bytes, over the limit of ${String(limits.maxEntryBytes)}`,
      )
    }
    total += entry.uncompressedSize
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError(
        'ARCHIVE_TOTAL_TOO_LARGE',
        `the archive declares more than ${String(limits.maxTotalBytes)} bytes across its entries`,
      )
    }
    if (entry.compressedSize === undefined) continue
    const stored = entry.compressedSize
    if (entry.uncompressedSize > 0 && stored === 0) {
      throw new ArchiveError('ARCHIVE_RATIO_EXCEEDED', `the entry ${JSON.stringify(entry.path)} stores no bytes for ${String(entry.uncompressedSize)} bytes`)
    }
    if (stored > 0 && entry.uncompressedSize / stored > limits.maxCompressionRatio) {
      throw new ArchiveError(
        'ARCHIVE_RATIO_EXCEEDED',
        `the entry ${JSON.stringify(entry.path)} expands ${String(entry.uncompressedSize)} bytes from ${String(stored)}, over the ratio limit of ${String(limits.maxCompressionRatio)}`,
      )
    }
  }
}

/**
 * Check the sizes one open archive's central directory declares, before any
 * entry is read. A read allocates what its record declares, so an archive that
 * breaks the per-entry, total or ratio limit on its declarations is refused
 * here rather than after the bytes it declares exist in memory.
 * @param archive - the open archive, whose central directory declares each entry's stored and uncompressed size.
 * @param limits - the limits to apply, by default the ones contract C8 sets.
 * @throws ArchiveError `ARCHIVE_TOO_MANY_ENTRIES`, `ARCHIVE_ENTRY_TOO_LARGE`, `ARCHIVE_TOTAL_TOO_LARGE` or `ARCHIVE_RATIO_EXCEEDED` from {@link checkEntrySizes}.
 */
export function checkContainerDeclarations(archive: ZipArchive, limits: ArchiveSizeLimits = ARCHIVE_LIMITS): void {
  checkEntrySizes(archive.entries.map(record => ({
    path: record.name,
    uncompressedSize: record.uncompressedSize,
    compressedSize: record.compressedSize,
  }) satisfies DeclaredEntrySize), limits)
}

/**
 * Check the sizes one manifest declares for its entries. An import runs it as
 * part of its limits step, beside the central directory's declarations, so an
 * archive cannot pass a limit in one place and break it in the other.
 * @param manifest - the validated manifest, whose entries declare each document's size.
 * @param limits - the limits to apply, by default the ones contract C8 sets.
 * @throws ArchiveError `ARCHIVE_TOO_MANY_ENTRIES`, `ARCHIVE_ENTRY_TOO_LARGE` or `ARCHIVE_TOTAL_TOO_LARGE` from {@link checkEntrySizes}.
 */
export function checkManifestDeclarations(manifest: ArchiveManifest, limits: ArchiveSizeLimits = ARCHIVE_LIMITS): void {
  checkEntrySizes(manifest.entries.map(entry => ({ path: entry.path, uncompressedSize: entry.size })), limits)
}
