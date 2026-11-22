/**
 * What the import reads inside a chat's log before it carries the chat: the
 * header's Session identifier and working directory, and whether the log ends
 * inside a turn. The newest generation is a sequence of Zstandard frames
 * holding one JSON record per line, the header first, as upstream's JSONL
 * store writes it. It is decompressed as a stream while the import hashes the
 * same bytes, so no log is held in memory whole, and decompression stops at
 * contract C8's ratio of 100 to one, so a small file cannot expand without
 * bound.
 *
 * A log that ends inside a turn is one upstream closes on resume with
 * synthetic tool results that suggest retrying the unfinished calls, and a
 * call from another installation must never be offered for retry here, so the
 * plan leaves such a chat behind.
 *
 * @module @delorun/archive/dsh-import/chats
 */
import { isAbsolute } from 'node:path'
import { createZstdDecompress, type ZstdDecompress } from 'node:zlib'
import { ARCHIVE_LIMITS } from '@delorun/contract-archive-and-trash'

/** What the import read in one chat's log. */
export interface ChatLog {
  /** The Session identifier the header names. */
  readonly id: string
  /** The working directory the header names, or `undefined` for a chat without one. */
  readonly cwd: string | undefined
  /** Whether the log ends after a `turn/start` without its `turn/end`. */
  readonly openTurn: boolean
}

/** The longest line the scan reads: one record of the log. */
const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Reads one log as its bytes arrive. */
export class ChatLogScan {
  private readonly decoder: ZstdDecompress
  private readonly limit: number
  private produced = 0
  private pending = ''
  private header: { readonly id: string, readonly cwd: string | undefined } | undefined
  private openTurn = false
  private failure: string | undefined

  /**
   * @param compressedBytes - the log's size, which bounds what it may decompress to.
   */
  constructor(compressedBytes: number) {
    this.limit = Math.max(compressedBytes, 1) * ARCHIVE_LIMITS.maxCompressionRatio
    this.decoder = createZstdDecompress()
    this.decoder.on('data', (chunk: Buffer) => { this.take(chunk) })
    // An error ends the scan; finish() reports it.
    this.decoder.on('error', (error: Error) => { this.fail(`it does not decompress (${error.message})`) })
  }

  /**
   * Feed the next compressed bytes.
   * @param chunk - the bytes, which the scan copies.
   */
  async feed(chunk: Uint8Array): Promise<void> {
    if (this.failure !== undefined) return
    if (!this.decoder.write(Buffer.from(chunk))) await this.event('drain')
  }

  /**
   * End the log and read what the scan found.
   * @returns the header and whether a turn is open, or why the log cannot be read.
   */
  async finish(): Promise<ChatLog | string> {
    if (this.failure === undefined) {
      this.decoder.end()
      await this.event('close')
    }
    if (this.failure === undefined && this.pending !== '') this.line(this.pending)
    if (this.failure !== undefined) return this.failure
    if (this.header === undefined) return 'it holds no header'
    return { ...this.header, openTurn: this.openTurn }
  }

  /**
   * Take decompressed bytes, line by line.
   * @param chunk - the bytes.
   */
  private take(chunk: Buffer): void {
    this.produced += chunk.length
    if (this.produced > this.limit) return this.fail('it decompresses to more than a hundred times its size')
    this.pending += chunk.toString('utf8')
    let newline = this.pending.indexOf('\n')
    while (newline !== -1 && this.failure === undefined) {
      this.line(this.pending.slice(0, newline))
      this.pending = this.pending.slice(newline + 1)
      newline = this.pending.indexOf('\n')
    }
    if (this.failure === undefined && Buffer.byteLength(this.pending) > MAX_LINE_BYTES) this.fail('one of its records is too long')
  }

  /**
   * Read one record: the header first, then each event's type.
   * @param text - the record without its newline.
   */
  private line(text: string): void {
    if (text === '') return
    let record: unknown
    try {
      record = JSON.parse(text)
    } catch {
      // The record's text is the chat's content, which a reason never quotes.
      return this.fail('one of its records is not JSON')
    }
    const fields = typeof record === 'object' && record !== null && !Array.isArray(record) ? record as Record<string, unknown> : {}
    if (this.header === undefined) {
      const { id, cwd } = fields
      if (fields['type'] !== 'session' || typeof id !== 'string' || (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd)))) return this.fail('its header is not a Session header')
      this.header = { id, cwd }
      return
    }
    if (fields['type'] === 'turn/start') this.openTurn = true
    else if (fields['type'] === 'turn/end') this.openTurn = false
  }

  /**
   * Wait for the decoder to emit an event or to close, whichever comes first; an error closes it too.
   * @param name - the event.
   * @returns when either happened.
   */
  private event(name: 'drain' | 'close'): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.decoder.off(name, done)
        this.decoder.off('close', done)
        resolve()
      }
      this.decoder.on(name, done)
      this.decoder.on('close', done)
    })
  }

  /**
   * Stop the scan with a reason.
   * @param reason - why the log cannot be read.
   */
  private fail(reason: string): void {
    this.failure = reason
    this.decoder.destroy()
  }
}
