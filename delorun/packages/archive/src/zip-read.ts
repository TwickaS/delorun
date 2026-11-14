/**
 * The ZIP reader of contract C8's archive format v1. Opening an archive reads
 * the end-of-central-directory record and the central directory and refuses
 * anything that is not a v1 container: a record that ends early, a multi-disk
 * archive, a ZIP64 archive, an encrypted entry, a compression method the
 * format does not use, or a directory longer than the entry limit. The path,
 * entry-type and limit checks are separate calls, so the import applies them
 * in the order the contract names. Reading one entry checks the sizes the
 * local header declares and the sizes the bytes actually reach, and refuses an
 * entry whose declared size is smaller than the bytes it inflates to.
 *
 * @module @delorun/archive/zip-read
 */
import { inflateRawSync } from 'node:zlib'
import { ARCHIVE_LIMITS } from '@delorun/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { checkPathCollisions } from './paths.ts'
import {
  ZIP_CENTRAL_HEADER_SIGNATURE,
  ZIP_COMPRESSION_DEFLATE,
  ZIP_COMPRESSION_STORED,
  ZIP_END_SIGNATURE,
  ZIP_FLAG_DATA_DESCRIPTOR,
  ZIP_FLAG_ENCRYPTED,
  ZIP_LOCAL_HEADER_SIGNATURE,
  ZIP_UNIX_BLOCK_DEVICE,
  ZIP_UNIX_CHARACTER_DEVICE,
  ZIP_UNIX_DIRECTORY,
  ZIP_UNIX_FIFO,
  ZIP_UNIX_SOCKET,
  ZIP_UNIX_SYMBOLIC_LINK,
  crc32,
  isPlainFileType,
  unixFileTypeOf,
  type ZipCentralRecord,
} from './zip-format.ts'

/** The size of an end-of-central-directory record without a comment. */
const END_OF_CENTRAL_DIRECTORY_SIZE = 22

/** The size of one central-directory record before its variable fields. */
const CENTRAL_HEADER_SIZE = 46

/** The size of one local file header before its variable fields. */
const LOCAL_HEADER_SIZE = 30

/** The longest comment an end-of-central-directory record can carry. */
const MAXIMUM_COMMENT_LENGTH = 0xffff

/** The entry count that a ZIP64 archive declares, which format v1 never needs. */
const ZIP64_ENTRY_COUNT = 0xffff

/** The size or offset that a ZIP64 archive declares, which format v1 never needs. */
const ZIP64_SIZE = 0xffff_ffff

/** The entry-name decoder: format v1 writes UTF-8 names, so a name that is not UTF-8 is refused rather than guessed. */
const NAME_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * The limit an archive reader applies while it parses the central directory:
 * the entry count. Reading it first keeps a hostile directory from being
 * parsed into memory before the limit check.
 */
export interface ZipReadLimits {
  /** The most entries one archive may declare. */
  readonly maxEntries: number
}

/**
 * One archive opened for reading.
 */
export class ZipArchive {
  private readonly bytes: Uint8Array
  private readonly centralDirectoryOffset: number
  private readonly records: readonly ZipCentralRecord[]
  private readonly byName = new Map<string, ZipCentralRecord>()
  private readonly entryNames: readonly string[]

  /**
   * @param bytes - the whole archive.
   * @param centralDirectoryOffset - the offset of the central directory.
   * @param records - the records of the central directory, in archive order.
   */
  private constructor(bytes: Uint8Array, centralDirectoryOffset: number, records: readonly ZipCentralRecord[]) {
    this.bytes = bytes
    this.centralDirectoryOffset = centralDirectoryOffset
    this.records = records
    // The first record of a name is the one a read returns; a repeated name is refused by the path rules.
    for (const record of records) if (!this.byName.has(record.name)) this.byName.set(record.name, record)
    this.entryNames = records.map(record => record.name)
  }

  /**
   * Open one archive and read its central directory.
   * @param bytes - the whole archive.
   * @param limits - the entry-count limit, by default the one contract C8 sets.
   * @returns the opened archive.
   * @throws ArchiveError `ARCHIVE_TRUNCATED` for a container that ends early or whose directory disagrees with its record, `ARCHIVE_UNSUPPORTED_VERSION` for a multi-disk, ZIP64, encrypted or non-deflate container, and `ARCHIVE_TOO_MANY_ENTRIES` for a directory over the limit.
   */
  static open(bytes: Uint8Array, limits: ZipReadLimits = ARCHIVE_LIMITS): ZipArchive {
    if (bytes.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', 'the file is shorter than an end-of-central-directory record')
    }
    const end = findEndRecord(bytes)
    const entryCount = u16(bytes, end + 10)
    const centralDirectorySize = u32(bytes, end + 12)
    const centralDirectoryOffset = u32(bytes, end + 16)
    const commentLength = u16(bytes, end + 20)
    if (end + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength > bytes.length) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', 'the end-of-central-directory record declares a comment that the file does not hold')
    }
    if (u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0 || u16(bytes, end + 8) !== entryCount) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', 'the archive spans several disks, which format v1 does not use')
    }
    if (entryCount === ZIP64_ENTRY_COUNT || centralDirectorySize === ZIP64_SIZE || centralDirectoryOffset === ZIP64_SIZE) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', 'the archive needs ZIP64 declarations, which format v1 does not use')
    }
    if (centralDirectoryOffset + centralDirectorySize > end) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', 'the central directory overlaps the end-of-central-directory record')
    }
    if (entryCount > limits.maxEntries) {
      throw new ArchiveError('ARCHIVE_TOO_MANY_ENTRIES', `the archive declares ${String(entryCount)} entries, over the limit of ${String(limits.maxEntries)}`)
    }
    return new ZipArchive(bytes, centralDirectoryOffset, readRecords(bytes, centralDirectoryOffset, entryCount))
  }

  /**
   * The records of the central directory, in archive order.
   * @returns the records.
   */
  get entries(): readonly ZipCentralRecord[] {
    return this.records
  }

  /**
   * Check every entry name against contract C8's path rules and refuse two
   * entries that collide, exactly in spelling or only in letter case.
   * @throws ArchiveError `ARCHIVE_PATH_REJECTED` and `ARCHIVE_CASE_COLLISION` from {@link checkPathCollisions}.
   */
  checkPaths(): void {
    checkPathCollisions(this.records.map(record => record.name))
  }

  /**
   * Check that every entry is a plain file that a reader may copy: no symbolic
   * link, no device, no FIFO, no socket, no directory, and no two records that
   * share one stored body, which is what a hard link looks like inside a ZIP.
   * @throws ArchiveError `ARCHIVE_LINK_REJECTED` for a link or another special file, and `ARCHIVE_PATH_REJECTED` for a directory entry.
   */
  checkEntryTypes(): void {
    const bodies = new Map<number, string>()
    for (const record of this.records) {
      const fileType = unixFileTypeOf(record)
      if (fileType === ZIP_UNIX_SYMBOLIC_LINK) {
        throw new ArchiveError('ARCHIVE_LINK_REJECTED', `the entry ${JSON.stringify(record.name)} is a symbolic link`)
      }
      if (
        fileType === ZIP_UNIX_BLOCK_DEVICE
        || fileType === ZIP_UNIX_CHARACTER_DEVICE
        || fileType === ZIP_UNIX_FIFO
        || fileType === ZIP_UNIX_SOCKET
      ) {
        throw new ArchiveError('ARCHIVE_LINK_REJECTED', `the entry ${JSON.stringify(record.name)} is a device or another special file`)
      }
      if (fileType === ZIP_UNIX_DIRECTORY) {
        throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the entry ${JSON.stringify(record.name)} is a directory, and an archive holds files only`)
      }
      if (!isPlainFileType(fileType)) {
        throw new ArchiveError('ARCHIVE_LINK_REJECTED', `the entry ${JSON.stringify(record.name)} is not a plain file`)
      }
      const previous = bodies.get(record.localHeaderOffset)
      if (previous !== undefined) {
        throw new ArchiveError(
          'ARCHIVE_LINK_REJECTED',
          `the entries ${JSON.stringify(previous)} and ${JSON.stringify(record.name)} share one stored body, which is a hard link`,
        )
      }
      bodies.set(record.localHeaderOffset, record.name)
    }
  }

  /**
   * Read one entry's bytes, checking what the local header declares against
   * what the bytes are: the header's own sizes when the record carries no data
   * descriptor, the length the bytes inflate to, and the stored checksum.
   * @param name - the entry name, exactly as the central directory spells it.
   * @returns the entry's bytes.
   * @throws ArchiveError `ARCHIVE_TRUNCATED` when the header or the data ends early, when a declared size disagrees with the bytes, when the bytes inflate past the declared size, or when the stored checksum disagrees; `ARCHIVE_PATH_REJECTED` for a name that is not UTF-8.
   */
  read(name: string): Uint8Array {
    const record = this.byName.get(name)
    if (record === undefined) throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive holds no entry named ${JSON.stringify(name)}`)
    const bytes = this.bytes
    const local = record.localHeaderOffset
    if (local + LOCAL_HEADER_SIZE > this.centralDirectoryOffset) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `the local header of ${JSON.stringify(name)} lies outside the entry area`)
    }
    if (u32(bytes, local) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `the entry ${JSON.stringify(name)} has no local file header`)
    }
    const localNameLength = u16(bytes, local + 26)
    const localExtraLength = u16(bytes, local + 28)
    const dataStart = local + LOCAL_HEADER_SIZE + localNameLength + localExtraLength
    if (dataStart > this.centralDirectoryOffset || dataStart + record.compressedSize > this.centralDirectoryOffset) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `the data of ${JSON.stringify(name)} runs past the central directory`)
    }
    const localName = decodeName(bytes.subarray(local + LOCAL_HEADER_SIZE, local + LOCAL_HEADER_SIZE + localNameLength))
    if (localName !== record.name) {
      throw new ArchiveError(
        'ARCHIVE_TRUNCATED',
        `the local header names ${JSON.stringify(localName)} where the central directory names ${JSON.stringify(record.name)}`,
      )
    }
    if ((record.flags & ZIP_FLAG_DATA_DESCRIPTOR) === 0) {
      const localCompressed = u32(bytes, local + 18)
      const localUncompressed = u32(bytes, local + 22)
      if (localCompressed !== record.compressedSize || localUncompressed !== record.uncompressedSize) {
        throw new ArchiveError(
          'ARCHIVE_TRUNCATED',
          `the local header of ${JSON.stringify(name)} declares ${String(localUncompressed)} bytes where the central directory declares ${String(record.uncompressedSize)}`,
        )
      }
    }
    const stored = bytes.subarray(dataStart, dataStart + record.compressedSize)
    const data = inflate(record, stored)
    if (data.length !== record.uncompressedSize) {
      throw new ArchiveError(
        'ARCHIVE_TRUNCATED',
        `the entry ${JSON.stringify(name)} ends after ${String(data.length)} bytes where it declares ${String(record.uncompressedSize)}`,
      )
    }
    if (crc32(data) !== record.crc32) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `the stored checksum of ${JSON.stringify(name)} does not match its bytes`)
    }
    return data
  }

  /**
   * The name the archive gives every entry, in archive order.
   * @returns the entry names.
   */
  names(): readonly string[] {
    return this.entryNames
  }

  /**
   * Whether the archive holds an entry of one name.
   * @param name - the entry name.
   * @returns true when the central directory names it.
   */
  has(name: string): boolean {
    return this.byName.has(name)
  }
}

/**
 * Locate the end-of-central-directory record, which is the last record of the
 * file and may be followed by a comment of up to 65535 bytes.
 * @param bytes - the whole archive.
 * @returns the offset of the record.
 * @throws ArchiveError `ARCHIVE_TRUNCATED` when no record is present.
 */
function findEndRecord(bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAXIMUM_COMMENT_LENGTH)
  for (let offset = bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= lowest; offset--) {
    if (u32(bytes, offset) === ZIP_END_SIGNATURE) return offset
  }
  throw new ArchiveError('ARCHIVE_TRUNCATED', 'the file holds no end-of-central-directory record')
}

/**
 * Read the records of the central directory.
 * @param bytes - the whole archive.
 * @param offset - the offset of the first record.
 * @param count - the number of records the end record declares.
 * @returns the records, in archive order.
 * @throws ArchiveError `ARCHIVE_TRUNCATED` when a record ends early or the directory does not hold the declared count, and `ARCHIVE_UNSUPPORTED_VERSION` for an encrypted entry or a compression method format v1 does not use.
 */
function readRecords(bytes: Uint8Array, offset: number, count: number): ZipCentralRecord[] {
  const records: ZipCentralRecord[] = []
  let cursor = offset
  for (let index = 0; index < count; index++) {
    if (cursor + CENTRAL_HEADER_SIZE > bytes.length) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `the central directory ends after ${String(index)} of the ${String(count)} records it declares`)
    }
    if (u32(bytes, cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `record ${String(index + 1)} of the central directory is not a central-directory record`)
    }
    const nameLength = u16(bytes, cursor + 28)
    const extraLength = u16(bytes, cursor + 30)
    const commentLength = u16(bytes, cursor + 32)
    const next = cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
    if (next > bytes.length) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', `record ${String(index + 1)} of the central directory ends early`)
    }
    const flags = u16(bytes, cursor + 8)
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', 'the archive holds an encrypted entry, which format v1 does not use')
    }
    const method = u16(bytes, cursor + 10)
    if (method !== ZIP_COMPRESSION_STORED && method !== ZIP_COMPRESSION_DEFLATE) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `the archive uses compression method ${String(method)}, which format v1 does not use`)
    }
    records.push({
      name: decodeName(bytes.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)),
      versionMadeBy: u16(bytes, cursor + 4),
      flags,
      method,
      crc32: u32(bytes, cursor + 16),
      compressedSize: u32(bytes, cursor + 20),
      uncompressedSize: u32(bytes, cursor + 24),
      externalAttributes: u32(bytes, cursor + 38),
      localHeaderOffset: u32(bytes, cursor + 42),
    })
    cursor = next
  }
  return records
}

/**
 * Inflate or copy one entry's stored bytes, refusing output that passes the
 * size the entry declared: a deflate stream that expands past its declared
 * size is refused as it expands, never buffered whole first.
 * @param record - the central-directory record of the entry.
 * @param stored - the entry's stored bytes.
 * @returns the uncompressed bytes.
 * @throws ArchiveError `ARCHIVE_TRUNCATED` when a stored entry's two sizes disagree or the bytes expand past the declared size.
 */
function inflate(record: ZipCentralRecord, stored: Uint8Array): Uint8Array {
  if (record.method === ZIP_COMPRESSION_STORED) {
    if (record.compressedSize !== record.uncompressedSize) {
      throw new ArchiveError(
        'ARCHIVE_TRUNCATED',
        `the stored entry ${JSON.stringify(record.name)} declares ${String(record.compressedSize)} stored bytes for ${String(record.uncompressedSize)} bytes`,
      )
    }
    return stored
  }
  try {
    return inflateRawSync(stored, { maxOutputLength: Math.max(record.uncompressedSize, 1) })
  } catch (error: unknown) {
    // Every inflate failure, a stream past its declared size included, is the same refusal; the cause is not shown to the person.
    void error
    throw new ArchiveError(
      'ARCHIVE_TRUNCATED',
      `the entry ${JSON.stringify(record.name)} expands past the ${String(record.uncompressedSize)} bytes it declares, or is not a deflate stream`,
    )
  }
}

/**
 * Decode one entry name, which format v1 declares in UTF-8.
 * @param raw - the name's bytes.
 * @returns the decoded name.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` when the bytes are not UTF-8.
 */
function decodeName(raw: Uint8Array): string {
  try {
    return NAME_DECODER.decode(raw)
  } catch {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', 'an archive entry name is not UTF-8')
  }
}

/**
 * Read a little-endian 16-bit word.
 * @param bytes - the buffer.
 * @param offset - the word's offset, which the caller has bounds-checked.
 * @returns the value.
 */
function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

/**
 * Read a little-endian 32-bit word.
 * @param bytes - the buffer.
 * @param offset - the word's offset, which the caller has bounds-checked.
 * @returns the value as an unsigned number.
 */
function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}
