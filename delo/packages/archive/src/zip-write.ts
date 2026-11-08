/**
 * The ZIP writer of contract C8's archive format v1. It writes stored and
 * deflated entries, records each entry's Unix mode so a reader can tell a
 * plain file from a link, and finishes with the central directory and the
 * end-of-central-directory record in one buffer. A writer in this package
 * declares every size it actually writes; the declared-size and mode options
 * exist so a spec can build the malformed archive that a refusal must catch.
 *
 * @module @delo/archive/zip-write
 */
import { deflateRawSync } from 'node:zlib'
import {
  ZIP_CENTRAL_HEADER_SIGNATURE,
  ZIP_COMPRESSION_DEFLATE,
  ZIP_COMPRESSION_STORED,
  ZIP_END_SIGNATURE,
  ZIP_FLAG_UTF8_NAME,
  ZIP_HOST_UNIX,
  ZIP_LOCAL_HEADER_SIGNATURE,
  ZIP_REGULAR_FILE_MODE,
  crc32,
} from './zip-format.ts'

/** The version a writer declares: ZIP 2.0, which is what a stored or deflated entry needs. */
const VERSION = 20

/** The MS-DOS time and date a format v1 archive stamps on every entry: no time, no date, so two exports of one content are byte-identical. */
const DOS_TIME = 0

/** The MS-DOS date of 1980-01-01, the earliest representable value. */
const DOS_DATE = 0x0021

/** One entry a writer adds. */
export interface ZipEntryInput {
  /** The entry name, written as UTF-8 and never normalised by the writer. */
  readonly name: string
  /** The entry's uncompressed bytes. */
  readonly bytes: Uint8Array
  /** The compression to use; by default the writer deflates and keeps whichever form is smaller. */
  readonly method?: 'store' | 'deflate'
  /** The full Unix mode to record, including its file-type bits; a regular file by default. */
  readonly unixMode?: number
  /**
   * The uncompressed size to declare instead of the real one. No caller in
   * this package passes it: it exists so a spec can build an archive whose
   * declared size disagrees with its bytes, which a reader must refuse.
   */
  readonly declaredUncompressedSize?: number
  /**
   * The stored size to declare instead of the real one, for the same reason as
   * {@link ZipEntryInput.declaredUncompressedSize}.
   */
  readonly declaredCompressedSize?: number
}

/** One entry as it was written, which the central directory is built from. */
interface WrittenEntry {
  readonly name: Uint8Array
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly declaredCompressedSize: number
  readonly declaredUncompressedSize: number
  readonly unixMode: number
  readonly localHeaderOffset: number
  readonly data: Uint8Array
}

/** A growable byte sink, so the writer never concatenates large buffers. */
class ByteSink {
  private chunks: Uint8Array[] = []
  private length = 0

  /** The bytes written so far. @returns the length in bytes. */
  get size(): number {
    return this.length
  }

  /**
   * Append bytes.
   * @param bytes - the bytes to append.
   */
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  /**
   * Append one little-endian 16-bit word.
   * @param value - the value to append.
   */
  pushU16(value: number): void {
    this.push(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff))
  }

  /**
   * Append one little-endian 32-bit word.
   * @param value - the value to append.
   */
  pushU32(value: number): void {
    this.push(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff))
  }

  /**
   * Build one buffer that holds everything appended.
   * @returns the concatenated bytes.
   */
  build(): Uint8Array {
    const out = new Uint8Array(this.length)
    let cursor = 0
    for (const chunk of this.chunks) {
      out.set(chunk, cursor)
      cursor += chunk.length
    }
    return out
  }
}

/**
 * A writer for one archive. Entries are added in the order they should appear,
 * and {@link ZipWriter.finish} writes the central directory once.
 */
export class ZipWriter {
  private readonly entries: WrittenEntry[] = []
  private readonly taken = new Set<string>()
  private readonly sink = new ByteSink()

  /**
   * Add one entry.
   * @param entry - the entry's name, bytes and optional declarations.
   * @throws Error when a second entry carries a name an earlier one already took.
   */
  add(entry: ZipEntryInput): void {
    if (this.taken.has(entry.name)) throw new Error(`the writer holds the entry ${JSON.stringify(entry.name)} already`)
    this.taken.add(entry.name)
    const name = new TextEncoder().encode(entry.name)
    const deflated = entry.method === 'store' ? undefined : new Uint8Array(deflateRawSync(entry.bytes))
    const method = deflated !== undefined && deflated.length < entry.bytes.length ? ZIP_COMPRESSION_DEFLATE : ZIP_COMPRESSION_STORED
    const data = method === ZIP_COMPRESSION_DEFLATE ? deflated! : entry.bytes
    const localHeaderOffset = this.sink.size
    const crc = crc32(entry.bytes)
    const flags = ZIP_FLAG_UTF8_NAME
    this.sink.pushU32(ZIP_LOCAL_HEADER_SIGNATURE)
    this.sink.pushU16(VERSION)
    this.sink.pushU16(flags)
    this.sink.pushU16(method)
    this.sink.pushU16(DOS_TIME)
    this.sink.pushU16(DOS_DATE)
    this.sink.pushU32(crc)
    this.sink.pushU32(entry.declaredCompressedSize ?? data.length)
    this.sink.pushU32(entry.declaredUncompressedSize ?? entry.bytes.length)
    this.sink.pushU16(name.length)
    this.sink.pushU16(0)
    this.sink.push(name)
    this.sink.push(data)
    this.entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize: data.length,
      declaredCompressedSize: entry.declaredCompressedSize ?? data.length,
      declaredUncompressedSize: entry.declaredUncompressedSize ?? entry.bytes.length,
      unixMode: entry.unixMode ?? ZIP_REGULAR_FILE_MODE,
      localHeaderOffset,
      data,
    })
  }

  /**
   * Write the central directory and the end-of-central-directory record.
   * @returns the whole archive.
   */
  finish(): Uint8Array {
    const directoryOffset = this.sink.size
    for (const written of this.entries) {
      this.sink.pushU32(ZIP_CENTRAL_HEADER_SIGNATURE)
      this.sink.pushU16((ZIP_HOST_UNIX << 8) | VERSION)
      this.sink.pushU16(VERSION)
      this.sink.pushU16(written.flags)
      this.sink.pushU16(written.method)
      this.sink.pushU16(DOS_TIME)
      this.sink.pushU16(DOS_DATE)
      this.sink.pushU32(written.crc)
      this.sink.pushU32(written.declaredCompressedSize)
      this.sink.pushU32(written.declaredUncompressedSize)
      this.sink.pushU16(written.name.length)
      this.sink.pushU16(0)
      this.sink.pushU16(0)
      this.sink.pushU16(0)
      this.sink.pushU16(0)
      this.sink.pushU32((written.unixMode & 0xffff) << 16)
      this.sink.pushU32(written.localHeaderOffset)
      this.sink.push(written.name)
    }
    const directorySize = this.sink.size - directoryOffset
    this.sink.pushU32(ZIP_END_SIGNATURE)
    this.sink.pushU16(0)
    this.sink.pushU16(0)
    this.sink.pushU16(this.entries.length)
    this.sink.pushU16(this.entries.length)
    this.sink.pushU32(directorySize)
    this.sink.pushU32(directoryOffset)
    this.sink.pushU16(0)
    return this.sink.build()
  }
}
