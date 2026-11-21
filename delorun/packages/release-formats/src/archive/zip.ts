/**
 * The deterministic ZIP format of the Windows runtime archive, and its reader. Each entry has a local header and a
 * central directory record with no extra field, no comment and no data descriptor; names are UTF-8 (flag bit 11);
 * "version made by" is Unix 2.0 so the external attributes carry the mode; the DOS date and time are the release's
 * `SOURCE_DATE_EPOCH` in UTC, rounded down to an even second. An entry is deflated at level 9 unless that is larger
 * than the file, when it is stored. The format has no ZIP64 records, so an archive holds at most 65,534 entries: a count of 65,535 in the end record is the marker of ZIP64.
 *
 * @module @delorun/release-formats/archive/zip
 */
import { open } from 'node:fs/promises'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { DEFLATE_LEVEL } from './bytes.ts'
import { EntryOrder, MAX_ARCHIVE_BYTES, modeBits, type ArchiveEntry } from './entry.ts'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const LOCAL_LENGTH = 30
const CENTRAL_LENGTH = 46
const END_LENGTH = 22
const UTF8_FLAG = 0x0800
const VERSION_NEEDED = 20
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED
/** One below the end record's 0xffff, which the reader takes for the ZIP64 marker. */
const MAX_ENTRIES = 0xfffe
const REGULAR_FILE = 0o100000

/** One entry as read back from a ZIP archive. */
export interface ZipReadEntry {
  /** The entry name. */
  readonly path: string
  /** The mode bits from the external attributes. */
  readonly mode: number
  /** The DOS time as Unix seconds in UTC. */
  readonly mtime: number
  /** The file's bytes. */
  readonly data: Buffer
}

/**
 * The DOS date and time of a Unix time, in UTC.
 * @param seconds - Unix seconds, at or after 1980-01-01.
 * @returns the 16-bit date and time fields.
 * @throws Error before 1980 or after 2107, which DOS dates cannot hold.
 */
export function dosDateTime(seconds: number): { date: number, time: number } {
  const instant = new Date(seconds * 1000)
  const year = instant.getUTCFullYear()
  if (year < 1980 || year > 2107) throw new Error(`ZIP dates hold 1980 to 2107, not ${String(year)}`)
  return {
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
    time: (instant.getUTCHours() << 11) | (instant.getUTCMinutes() << 5) | (instant.getUTCSeconds() >> 1),
  }
}

function dosToSeconds(date: number, time: number): number {
  return Date.UTC(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2) / 1000
}

/**
 * Encode entries as the deterministic ZIP archive.
 * @param entries - regular files in byte-wise path order.
 * @param mtime - every entry's time, the release's `SOURCE_DATE_EPOCH` in seconds.
 * @returns the archive bytes, in order.
 * @throws Error when an entry is invalid or out of order, or the archive exceeds the format's limits.
 */
export async function* zipStream(entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>, mtime: number): AsyncGenerator<Buffer> {
  const order = new EntryOrder()
  let stamp: { date: number, time: number } | undefined
  const central: Buffer[] = []
  let offset = 0
  for await (const entry of entries) {
    order.accept(entry.path)
    stamp ??= dosDateTime(mtime)
    const { date, time } = stamp
    if (central.length / 2 === MAX_ENTRIES) throw new Error(`ZIP archive exceeds ${String(MAX_ENTRIES)} entries`)
    const name = Buffer.from(entry.path, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: DEFLATE_LEVEL })
    const stored = deflated.byteLength >= entry.data.byteLength
    const body = stored ? entry.data : deflated
    const checksum = crc32(entry.data) >>> 0
    const local = Buffer.alloc(LOCAL_LENGTH)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.byteLength, 18)
    local.writeUInt32LE(entry.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)
    const record = Buffer.alloc(CENTRAL_LENGTH)
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    record.writeUInt16LE(VERSION_MADE_BY, 4)
    local.copy(record, 6, 4, 30)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(((REGULAR_FILE | modeBits(entry.mode)) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    yield local
    yield name
    yield body
    offset += LOCAL_LENGTH + name.byteLength + body.byteLength
    if (offset > MAX_ARCHIVE_BYTES) throw new Error(`ZIP archive exceeds ${String(MAX_ARCHIVE_BYTES)} bytes`)
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(END_LENGTH)
  end.writeUInt32LE(END_SIGNATURE, 0)
  end.writeUInt16LE(central.length / 2, 8)
  end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  yield directory
  yield end
}

/**
 * Read a ZIP archive's entries through its central directory, in directory order. Each entry's local header must
 * agree with its directory record; ZIP64, encryption, data descriptors and methods other than stored and deflate fail
 * the read, as does an entry that is not a regular file.
 * @param path - the archive file.
 * @param maxEntryBytes - the largest entry the reader accepts.
 * @returns each entry, in directory order.
 * @throws Error on a malformed or refused archive.
 */
export async function* readZip(path: string, maxEntryBytes: number): AsyncGenerator<ZipReadEntry> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size < END_LENGTH) throw new Error('ZIP archive is shorter than its end record')
    const tail = Buffer.alloc(Math.min(size, END_LENGTH + 0xffff))
    await handle.read(tail, 0, tail.byteLength, size - tail.byteLength)
    const endAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (endAt < 0 || endAt + END_LENGTH > tail.byteLength) throw new Error('ZIP archive has no end record')
    const end = tail.subarray(endAt, endAt + END_LENGTH)
    const count = end.readUInt16LE(10)
    const directorySize = end.readUInt32LE(12)
    const directoryOffset = end.readUInt32LE(16)
    if (end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0 || end.readUInt16LE(8) !== count) throw new Error('ZIP archive spans disks')
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are refused')
    if (directoryOffset + directorySize > size) throw new Error('ZIP central directory lies outside the file')
    const directory = Buffer.alloc(directorySize)
    await handle.read(directory, 0, directorySize, directoryOffset)
    let cursor = 0
    for (let index = 0; index < count; index++) {
      if (cursor + CENTRAL_LENGTH > directory.byteLength || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('ZIP central directory record is malformed')
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const time = directory.readUInt16LE(cursor + 12)
      const date = directory.readUInt16LE(cursor + 14)
      const checksum = directory.readUInt32LE(cursor + 16)
      const compressed = directory.readUInt32LE(cursor + 20)
      const uncompressed = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      const external = directory.readUInt32LE(cursor + 38)
      const localOffset = directory.readUInt32LE(cursor + 42)
      const recordEnd = cursor + CENTRAL_LENGTH + nameLength + extraLength + commentLength
      if (recordEnd > directory.byteLength) throw new Error('ZIP central directory record overruns the directory')
      const name = directory.subarray(cursor + CENTRAL_LENGTH, cursor + CENTRAL_LENGTH + nameLength)
      cursor = recordEnd
      if ((flags & 0x0009) !== 0) throw new Error('ZIP entry is encrypted or uses a data descriptor')
      if (method !== 0 && method !== 8) throw new Error(`ZIP entry method ${String(method)} is refused`)
      if (uncompressed > maxEntryBytes || compressed > maxEntryBytes) throw new Error('ZIP entry exceeds the limit')
      if (((external >>> 16) & 0o170000) !== REGULAR_FILE) throw new Error('ZIP entry is not a regular file')
      const local = Buffer.alloc(LOCAL_LENGTH)
      if (localOffset + LOCAL_LENGTH > size) throw new Error('ZIP local header lies outside the file')
      await handle.read(local, 0, LOCAL_LENGTH, localOffset)
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error('ZIP local header is malformed')
      const dataOffset = localOffset + LOCAL_LENGTH + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (dataOffset + compressed > size) throw new Error('ZIP entry data lies outside the file')
      const body = Buffer.alloc(compressed)
      await handle.read(body, 0, compressed, dataOffset)
      const data = method === 0 ? body : inflateRawSync(body, { maxOutputLength: Math.max(1, uncompressed) })
      if (data.byteLength !== uncompressed || (crc32(data) >>> 0) !== checksum) throw new Error('ZIP entry does not match its size or CRC-32')
      yield { path: name.toString('utf8'), mode: (external >>> 16) & 0o7777, mtime: dosToSeconds(date, time), data }
    }
  } finally {
    await handle.close()
  }
}
