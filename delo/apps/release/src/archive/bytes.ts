/**
 * Byte-stream helpers for the archive writers and readers: draining a chunk generator into a sink, gzip framing with
 * a fixed header, and exact-length reads from a chunk stream.
 *
 * @module @delo/release/archive/bytes
 */
import { Readable } from 'node:stream'
import { createDeflateRaw, crc32 } from 'node:zlib'
import type { ByteSink } from './sink.ts'

/**
 * The gzip header of every runtime archive: deflate, no flags, mtime 0, no extra flags and operating system 255
 * (unknown), so the bytes do not depend on the building machine's zlib build.
 */
export const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])

/** The deflate level of every runtime archive. */
export const DEFLATE_LEVEL = 9

/**
 * Write every chunk of a generator to a sink, awaiting each write.
 * @param chunks - the bytes to write.
 * @param sink - the destination.
 */
export async function drain(chunks: AsyncIterable<Uint8Array>, sink: ByteSink): Promise<void> {
  for await (const chunk of chunks) await sink.write(chunk)
}

/**
 * Gzip a byte stream with {@link GZIP_HEADER} and raw deflate at {@link DEFLATE_LEVEL}.
 * @param source - the uncompressed bytes.
 * @returns the gzip member's bytes, in order: header, deflate stream, then CRC-32 and length trailer.
 */
export async function* gzip(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  yield GZIP_HEADER
  let crc = 0
  let size = 0
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      crc = crc32(chunk, crc)
      size += chunk.byteLength
      yield chunk
    }
  }
  const deflate = createDeflateRaw({ level: DEFLATE_LEVEL })
  const input = Readable.from(counted())
  input.once('error', error => deflate.destroy(error))
  input.pipe(deflate)
  for await (const chunk of deflate as AsyncIterable<Buffer>) yield chunk
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc >>> 0, 0)
  trailer.writeUInt32LE(size % 0x1_0000_0000, 4)
  yield trailer
}

/** Reads exact byte counts from a chunk stream. */
export class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private buffered: Buffer[] = []
  private available = 0
  private ended = false

  /**
   * @param source - the stream to read.
   */
  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  /**
   * Read exactly `length` bytes.
   * @param length - how many bytes.
   * @returns the bytes, or fewer when the stream ends first.
   */
  async read(length: number): Promise<Buffer> {
    while (this.available < length && !this.ended) {
      const next = await this.iterator.next()
      if (next.done === true) {
        this.ended = true
        break
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      this.buffered.push(chunk)
      this.available += chunk.byteLength
    }
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered, this.available)
    const taken = all.subarray(0, Math.min(length, all.byteLength))
    const rest = all.subarray(taken.byteLength)
    this.buffered = rest.byteLength > 0 ? [rest] : []
    this.available = rest.byteLength
    return taken
  }

  /**
   * Whether the stream has no more bytes.
   * @returns true at the end.
   */
  async atEnd(): Promise<boolean> {
    if (this.available > 0) return false
    const probe = await this.read(1)
    if (probe.byteLength === 0) return true
    this.buffered.unshift(probe)
    this.available += probe.byteLength
    return false
  }
}
