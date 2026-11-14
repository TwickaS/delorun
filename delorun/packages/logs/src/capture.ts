/**
 * Captured output: the standard output and standard error of upstream code a surface runs, split at newlines into
 * one record per line. A line is held until its newline arrives, up to 65,536 bytes; a longer line is redacted as a
 * whole at that size and the rest of it, up to the next newline, is dropped and counted in `truncated`. The lines
 * of a PEM private key block are redacted together, since each line is a record of its own.
 *
 * @module @delorun/logs/capture
 */
import { CAPTURED_LINE_MAX_BYTES, type LogLevel } from '@delorun/contract-operational-logs'
import { redactionMarker } from './redact.ts'
import type { SurfaceLog } from './writer.ts'

/** The stream a capture reads. */
export type CapturedStream = 'stdout' | 'stderr'

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/
/** A line inside a PEM block: base64 text, an encapsulated header such as `Proc-Type: 4,ENCRYPTED`, or blank. */
const PEM_BODY = /^\s*(?:[A-Za-z0-9+/=]*|[A-Za-z][A-Za-z-]*:.*)\s*$/

/** Splits one stream's output into records on a surface's log. */
export class LineCapture {
  private held: Buffer[] = []
  private heldBytes = 0
  private dropped = 0
  private inPrivateKey = false

  /** The surface's log. */
  private readonly log: SurfaceLog
  /** Which stream this capture reads; records carry it as their `logger`. */
  private readonly stream: CapturedStream
  /** The level of this stream's records. */
  private readonly level: LogLevel

  /**
   * @param log - the surface's log.
   * @param stream - which stream this capture reads; records carry it as their `logger`.
   * @param level - the level of this stream's records.
   */
  constructor(
    log: SurfaceLog,
    stream: CapturedStream,
    level: LogLevel,
  ) {
    this.log = log
    this.stream = stream
    this.level = level
  }

  /**
   * Add output. Each complete line becomes a record; a partial line is held until its newline.
   * @param chunk - the bytes, or text encoded as UTF-8.
   */
  write(chunk: Uint8Array | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let start = 0
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start)
      const end = newline === -1 ? data.length : newline
      this.hold(data.subarray(start, end))
      if (newline === -1) return
      this.emit()
      start = newline + 1
    }
  }

  /** Write the held partial line, if any, as the stream ends. */
  end(): void {
    if (this.heldBytes > 0 || this.dropped > 0) this.emit()
  }

  private hold(piece: Buffer): void {
    const room = CAPTURED_LINE_MAX_BYTES - this.heldBytes
    if (piece.length <= room) {
      if (piece.length > 0) this.held.push(piece)
      this.heldBytes += piece.length
      return
    }
    if (room > 0) this.held.push(piece.subarray(0, room))
    this.heldBytes += room
    this.dropped += piece.length - room
  }

  private emit(): void {
    let line = Buffer.concat(this.held, this.heldBytes).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const dropped = this.dropped
    this.held = []
    this.heldBytes = 0
    this.dropped = 0
    this.log.write({ level: this.level, logger: this.stream, source: 'captured', msg: this.privateKeyLine(line), dropped })
  }

  /** The line with the PEM block state applied: a line inside a block is replaced whole. */
  private privateKeyLine(line: string): string {
    if (this.inPrivateKey) {
      if (PEM_END.test(line)) {
        this.inPrivateKey = false
        return `${redactionMarker('private-key')}${line.slice(line.search(PEM_END)).replace(PEM_END, '')}`
      }
      if (PEM_BODY.test(line)) return redactionMarker('private-key')
      this.inPrivateKey = false
      return line
    }
    const begin = line.search(PEM_BEGIN)
    if (begin !== -1 && !PEM_END.test(line.slice(begin))) this.inPrivateKey = true
    return line
  }
}

/**
 * Capture a readable stream, such as a child's standard error, until it ends.
 * @param readable - the stream.
 * @param capture - the capture that splits it.
 * @returns a disposer that stops capturing and writes the held partial line.
 */
export function captureStream(readable: NodeJS.ReadableStream, capture: LineCapture): () => void {
  const onData = (chunk: Uint8Array | string): void => { capture.write(chunk) }
  const onEnd = (): void => { capture.end() }
  readable.on('data', onData)
  readable.on('end', onEnd)
  return () => {
    readable.off('data', onData)
    readable.off('end', onEnd)
    capture.end()
  }
}

/** The options of {@link interceptStdio}. */
export interface InterceptOptions {
  /** The level of standard output's records. */
  readonly stdoutLevel: LogLevel
  /** The level of standard error's records. */
  readonly stderrLevel: LogLevel
  /** Whether the output still reaches the process's own streams after it is captured. */
  readonly passThrough: boolean
}

/**
 * Capture this process's own standard output and standard error, such as the console output of an in-process Host.
 * A line written while an agent drives a turn carries that turn's keys through the log's key sources.
 * @param log - the surface's log.
 * @param options - the levels, and whether output also reaches the original streams.
 * @returns a disposer that restores both streams and writes any held partial lines.
 */
export function interceptStdio(log: SurfaceLog, options: InterceptOptions): () => void {
  const restore = (['stdout', 'stderr'] as const).map((name) => {
    const stream = process[name]
    const original = stream.write
    const capture = new LineCapture(log, name, name === 'stdout' ? options.stdoutLevel : options.stderrLevel)
    const write = function (this: NodeJS.WriteStream, chunk: Uint8Array | string, ...rest: unknown[]): boolean {
      const encoding = typeof rest[0] === 'string' ? rest[0] as BufferEncoding : undefined
      capture.write(typeof chunk === 'string' && encoding !== undefined ? Buffer.from(chunk, encoding) : chunk)
      if (options.passThrough) return Reflect.apply(original, this, [chunk, ...rest]) as boolean
      const callback = rest.find(item => typeof item === 'function') as ((error?: Error | null) => void) | undefined
      if (callback !== undefined) queueMicrotask(() => { callback() })
      return true
    }
    stream.write = write as typeof stream.write
    return () => {
      stream.write = original
      capture.end()
    }
  })
  return () => {
    for (const undo of restore) undo()
  }
}
