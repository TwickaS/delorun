/**
 * The deterministic tar format of Linux and macOS runtime archives, and its reader. Each entry is one POSIX ustar
 * header for a regular file: mode `0644` or `0755`, uid and gid 0, empty user and group names, mtime the release's
 * `SOURCE_DATE_EPOCH`. A path longer than the ustar name and prefix fields allow is carried by a pax extended header
 * holding only a `path` record. The archive ends with two zero blocks and no further padding.
 *
 * @module @delorun/release-formats/archive/tar
 */
import type { RuntimeFileMode } from '@delorun/contract-release-manifest'
import { ChunkReader } from './bytes.ts'
import { EntryOrder, modeBits, type ArchiveEntry } from './entry.ts'

const BLOCK = 512
const NAME_LENGTH = 100
const PREFIX_LENGTH = 155
const PAX_NAME = 'PaxHeader'

/** One entry as read back from an archive, with every header field the canonical form fixes. */
export interface TarReadEntry {
  /** The entry path, from the pax `path` record when present. */
  readonly path: string
  /** The mode bits of the header. */
  readonly mode: number
  /** uid, gid, user and group name, and mtime in seconds. */
  readonly uid: number
  readonly gid: number
  readonly uname: string
  readonly gname: string
  readonly mtime: number
  /** The file's bytes. */
  readonly data: Buffer
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name: Buffer, prefix: Buffer, mode: number, size: number, mtime: number, type: '0' | 'x'): Buffer {
  const block = Buffer.alloc(BLOCK)
  name.copy(block, 0)
  block.write(octal(mode, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(mtime, 12), 136, 'ascii')
  block.write('        ', 148, 'ascii')
  block.write(type, 156, 'ascii')
  block.write('ustar\u000000', 257, 'ascii')
  block.write(octal(0, 8), 329, 'ascii')
  block.write(octal(0, 8), 337, 'ascii')
  prefix.copy(block, 345)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

function padding(size: number): Buffer {
  const rest = size % BLOCK
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)
}

/**
 * Split a path into ustar name and prefix fields, taking the shortest prefix that fits.
 * @param path - the UTF-8 path bytes.
 * @returns the two fields, or `undefined` when the path needs a pax header.
 */
function splitPath(path: Buffer): { name: Buffer, prefix: Buffer } | undefined {
  if (path.byteLength <= NAME_LENGTH) return { name: path, prefix: Buffer.alloc(0) }
  for (let index = path.indexOf(0x2f); index >= 0; index = path.indexOf(0x2f, index + 1)) {
    if (index > PREFIX_LENGTH) return undefined
    if (path.byteLength - index - 1 <= NAME_LENGTH) return { name: path.subarray(index + 1), prefix: path.subarray(0, index) }
  }
  return undefined
}

function paxRecord(key: string, value: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(` ${key}=`, 'utf8'), value, Buffer.from('\n', 'utf8')])
  let length = body.byteLength + 1
  while (String(length).length + body.byteLength !== length) length = String(length).length + body.byteLength
  return Buffer.concat([Buffer.from(String(length), 'ascii'), body])
}

/**
 * Encode entries as the deterministic tar stream.
 * @param entries - regular files in byte-wise path order.
 * @param mtime - every entry's mtime, the release's `SOURCE_DATE_EPOCH` in seconds.
 * @returns the tar bytes, in order.
 * @throws Error when an entry path is invalid or out of order.
 */
export async function* tarStream(entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>, mtime: number): AsyncGenerator<Buffer> {
  const order = new EntryOrder()
  for await (const entry of entries) {
    order.accept(entry.path)
    const mode = modeBits(entry.mode)
    const path = Buffer.from(entry.path, 'utf8')
    const fields = splitPath(path)
    if (fields === undefined) {
      const records = paxRecord('path', path)
      yield header(Buffer.from(PAX_NAME, 'ascii'), Buffer.alloc(0), mode, records.byteLength, mtime, 'x')
      yield records
      yield padding(records.byteLength)
      yield header(path.subarray(0, NAME_LENGTH), Buffer.alloc(0), mode, entry.data.byteLength, mtime, '0')
    } else {
      yield header(fields.name, fields.prefix, mode, entry.data.byteLength, mtime, '0')
    }
    yield entry.data
    yield padding(entry.data.byteLength)
  }
  yield Buffer.alloc(BLOCK * 2)
}

function field(block: Buffer, offset: number, length: number): Buffer {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return end < 0 ? raw : raw.subarray(0, end)
}

function octalField(block: Buffer, offset: number, length: number, name: string): number {
  const text = field(block, offset, length).toString('ascii').trim()
  if (!/^[0-7]+$/u.test(text)) throw new Error(`tar header ${name} is not an octal number`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error(`tar header ${name} is out of range`)
  return value
}

function checksumMatches(block: Buffer): boolean {
  let sum = 0
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!
  return octalField(block, 148, 8, 'checksum') === sum
}

function parsePax(records: Buffer): Buffer {
  let path: Buffer | undefined
  let offset = 0
  while (offset < records.byteLength) {
    const space = records.indexOf(0x20, offset)
    if (space < 0) throw new Error('pax record has no length')
    const length = Number.parseInt(records.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > records.byteLength) throw new Error('pax record length is invalid')
    const record = records.subarray(space + 1, offset + length - 1)
    const equals = record.indexOf(0x3d)
    if (equals < 0 || records[offset + length - 1] !== 0x0a) throw new Error('pax record is malformed')
    const key = record.subarray(0, equals).toString('utf8')
    if (key !== 'path') throw new Error(`pax record ${JSON.stringify(key)} is not allowed`)
    path = record.subarray(equals + 1)
    offset += length
  }
  if (path === undefined) throw new Error('pax header has no path record')
  return path
}

/**
 * Read a tar stream's entries. Only regular files and pax headers with a `path` record are accepted; a link,
 * directory, device or any other entry type fails the read.
 * @param source - the uncompressed tar bytes.
 * @param maxEntryBytes - the largest entry the reader accepts.
 * @returns each entry with its header fields and bytes, in archive order.
 * @throws Error on a malformed header, a bad checksum, a refused entry type or a truncated stream.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>, maxEntryBytes: number): AsyncGenerator<TarReadEntry> {
  const reader = new ChunkReader(source)
  let paxPath: Buffer | undefined
  for (;;) {
    const block = await reader.read(BLOCK)
    if (block.byteLength < BLOCK) throw new Error('tar stream ends inside a header')
    if (block.every(byte => byte === 0)) {
      const second = await reader.read(BLOCK)
      if (second.byteLength < BLOCK || !second.every(byte => byte === 0)) throw new Error('tar stream has one zero block where two end it')
      if (paxPath !== undefined) throw new Error('tar stream ends after a pax header')
      if (!(await reader.atEnd())) throw new Error('tar stream has bytes after its end blocks')
      return
    }
    if (!checksumMatches(block)) throw new Error('tar header checksum does not match')
    const type = String.fromCharCode(block[156]!)
    const size = octalField(block, 124, 12, 'size')
    if (size > maxEntryBytes) throw new Error(`tar entry of ${String(size)} bytes exceeds the limit`)
    const data = await reader.read(size)
    if (data.byteLength < size) throw new Error('tar stream ends inside an entry')
    const pad = (BLOCK - (size % BLOCK)) % BLOCK
    if ((await reader.read(pad)).byteLength < pad) throw new Error('tar stream ends inside padding')
    if (type === 'x') {
      if (paxPath !== undefined) throw new Error('tar stream has two pax headers in a row')
      paxPath = parsePax(data)
      continue
    }
    if (type !== '0' && type !== '\0') throw new Error(`tar entry type ${JSON.stringify(type)} is not a regular file`)
    const prefix = field(block, 345, PREFIX_LENGTH)
    const name = field(block, 0, NAME_LENGTH)
    const path = paxPath ?? (prefix.byteLength > 0 ? Buffer.concat([prefix, Buffer.from('/'), name]) : name)
    paxPath = undefined
    yield {
      path: path.toString('utf8'),
      mode: octalField(block, 100, 8, 'mode'),
      uid: octalField(block, 108, 8, 'uid'),
      gid: octalField(block, 116, 8, 'gid'),
      uname: field(block, 265, 32).toString('utf8'),
      gname: field(block, 297, 32).toString('utf8'),
      mtime: octalField(block, 136, 12, 'mtime'),
      data,
    }
  }
}

/**
 * The C2 mode string of read mode bits.
 * @param mode - the header's mode bits.
 * @returns `0644` or `0755`, or `undefined` for any other mode.
 */
export function runtimeMode(mode: number): RuntimeFileMode | undefined {
  if (mode === 0o644) return '0644'
  if (mode === 0o755) return '0755'
  return undefined
}
