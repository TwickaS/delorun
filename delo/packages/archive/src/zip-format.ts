/**
 * The constants and the pure helpers of the ZIP container that contract C8's
 * archive format v1 uses. Nothing here reads a file: {@link crc32} and
 * {@link unixModeOf} are the two computations that both the reader and the
 * writer share, so an entry's checksum and its file type mean the same thing
 * on the way in and on the way out.
 *
 * @module @delo/archive/zip-format
 */

/** The signature that begins a local file header. */
export const ZIP_LOCAL_HEADER_SIGNATURE = 0x0403_4b50

/** The signature that begins a central-directory record. */
export const ZIP_CENTRAL_HEADER_SIGNATURE = 0x0201_4b50

/** The signature that begins the end-of-central-directory record. */
export const ZIP_END_SIGNATURE = 0x0605_4b50

/** The compression method of an entry that stores its bytes. */
export const ZIP_COMPRESSION_STORED = 0

/** The compression method of an entry that deflates its bytes. */
export const ZIP_COMPRESSION_DEFLATE = 8

/** The general-purpose flag that marks an encrypted entry. */
export const ZIP_FLAG_ENCRYPTED = 0x0001

/** The general-purpose flag that moves the sizes and the checksum into a data descriptor after the data. */
export const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008

/** The general-purpose flag that declares the entry name in UTF-8. */
export const ZIP_FLAG_UTF8_NAME = 0x0800

/** The byte that holds the host system when masked out of the version-made-by word. */
export const ZIP_HOST_MASK = 0xff00

/** The host-system value of a Unix writer, the only one whose external attributes carry a file mode. */
export const ZIP_HOST_UNIX = 3

/** The mask of the file-type bits of a Unix mode. */
export const ZIP_UNIX_TYPE_MASK = 0o170000

/** The file type of a Unix regular file. */
export const ZIP_UNIX_REGULAR_FILE = 0o100000

/** The file type of a Unix directory. */
export const ZIP_UNIX_DIRECTORY = 0o040000

/** The file type of a Unix symbolic link. */
export const ZIP_UNIX_SYMBOLIC_LINK = 0o120000

/** The file type of a Unix block device. */
export const ZIP_UNIX_BLOCK_DEVICE = 0o060000

/** The file type of a Unix character device. */
export const ZIP_UNIX_CHARACTER_DEVICE = 0o020000

/** The file type of a Unix FIFO. */
export const ZIP_UNIX_FIFO = 0o010000

/** The file type of a Unix socket. */
export const ZIP_UNIX_SOCKET = 0o140000

/** The mode a writer gives a regular file entry: `-rw-r--r--`. */
export const ZIP_REGULAR_FILE_MODE = 0o100644

/** One record of the ZIP central directory, with the fields format v1 reads. */
export interface ZipCentralRecord {
  /** The entry name, decoded from UTF-8. */
  readonly name: string
  /** The high byte of the version-made-by word: the host system that wrote the entry. */
  readonly versionMadeBy: number
  /** The general-purpose bit flags. */
  readonly flags: number
  /** The compression method: stored or deflate, and nothing else in format v1. */
  readonly method: number
  /** The CRC-32 the writer declared for the entry's uncompressed bytes. */
  readonly crc32: number
  /** The size of the entry's bytes as they are stored in the archive. */
  readonly compressedSize: number
  /** The size of the entry's bytes as the writer declared them before compression. */
  readonly uncompressedSize: number
  /** The external file attributes, whose high 16 bits are the Unix mode for a Unix writer. */
  readonly externalAttributes: number
  /** The offset of the entry's local file header. */
  readonly localHeaderOffset: number
}

/** The CRC-32 table, built once from the reflected polynomial that ZIP specifies. */
const CRC_TABLE = buildCrcTable()

/**
 * Build the CRC-32 lookup table of the ZIP specification.
 * @returns the 256-entry table.
 */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

/**
 * The CRC-32 of a byte sequence, as the ZIP specification computes it: the
 * reflected polynomial `0xedb88320` over every byte, inverted at the end.
 * @param bytes - the bytes to check.
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ 0xffff_ffff) >>> 0
}

/**
 * The Unix mode that a central-directory record declares, when its writer was
 * a Unix system. A record from another host declares none, and a reader treats
 * such an entry as it treats a regular file.
 * @param record - the central-directory record.
 * @returns the mode, or `undefined` when the writer was not a Unix system.
 */
export function unixModeOf(record: ZipCentralRecord): number | undefined {
  if ((record.versionMadeBy & ZIP_HOST_MASK) >> 8 !== ZIP_HOST_UNIX) return undefined
  return (record.externalAttributes >>> 16) & 0xffff
}

/**
 * The file type that a central-directory record declares.
 * @param record - the central-directory record.
 * @returns the type bits of the mode, or `undefined` when the writer declared no Unix mode.
 */
export function unixFileTypeOf(record: ZipCentralRecord): number | undefined {
  const mode = unixModeOf(record)
  return mode === undefined ? undefined : mode & ZIP_UNIX_TYPE_MASK
}

/**
 * Whether a file type names a file that a reader copies byte for byte: a
 * regular file, or a record whose writer declared no Unix type at all.
 * @param fileType - the type bits from {@link unixFileTypeOf}.
 * @returns true when the entry is a plain file.
 */
export function isPlainFileType(fileType: number | undefined): boolean {
  return fileType === undefined || fileType === ZIP_UNIX_REGULAR_FILE || fileType === 0
}
