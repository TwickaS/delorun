/**
 * Byte sinks the archive writers write to, one awaited chunk at a time, so a writer holds at most one entry in
 * memory: a file opened by exclusive creation, and a SHA-256 hash for the canonical-form check.
 *
 * @module @delorun/release-formats/archive/sink
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/** Where an archive writer puts its bytes. */
export interface ByteSink {
  /**
   * Append bytes.
   * @param chunk - the bytes, which the sink does not keep after the promise settles.
   */
  write(chunk: Uint8Array): Promise<void>
  /** Bytes written so far. */
  readonly length: number
}

/** A sink that writes a new file. */
export class FileSink implements ByteSink {
  length = 0

  private readonly handle: FileHandle
  private readonly limit: number

  private constructor(handle: FileHandle, limit: number) {
    this.handle = handle
    this.limit = limit
  }

  /**
   * Create the file; an existing file is never replaced.
   * @param path - the new file.
   * @param limit - the most bytes the file may hold; a write past it fails.
   * @returns the open sink.
   */
  static async create(path: string, limit: number): Promise<FileSink> {
    return new FileSink(await open(path, 'wx', 0o644), limit)
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.length + chunk.byteLength > this.limit) throw new Error(`archive exceeds its limit of ${String(this.limit)} bytes`)
    let offset = 0
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset)
      offset += bytesWritten
    }
    this.length += chunk.byteLength
  }

  /** Flush the file to disk and close it. */
  async close(): Promise<void> {
    try {
      await this.handle.sync()
    } finally {
      await this.handle.close()
    }
  }
}

/** A sink that only hashes what it receives. */
export class HashSink implements ByteSink {
  length = 0
  private readonly hash: Hash = createHash('sha256')

  async write(chunk: Uint8Array): Promise<void> {
    this.hash.update(chunk)
    this.length += chunk.byteLength
  }

  /**
   * The SHA-256 of everything written.
   * @returns lowercase hex.
   */
  digest(): string {
    return this.hash.digest('hex')
  }
}

/**
 * The length and SHA-256 of a file, read as a stream.
 * @param path - the file.
 * @returns its length in bytes and its lowercase hex SHA-256.
 */
export async function fileDigest(path: string): Promise<{ length: number, sha256: string }> {
  const hash = createHash('sha256')
  let length = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    length += chunk.byteLength
  }
  return { length, sha256: hash.digest('hex') }
}
