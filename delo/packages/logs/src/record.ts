/**
 * C20's record line: one JSON object and a newline, at most {@link RECORD_MAX_BYTES} bytes. A longer record is cut
 * after redaction: `err.stack`, then `msg`, then `err.message` are shortened from their ends, and `truncated` states
 * the bytes removed.
 *
 * @module @delo/logs/record
 */
import { RECORD_MAX_BYTES, type LogRecord, type SessionId, type WorkspaceId } from '@delo/contract-operational-logs'

/** The keys that tie a record to upstream's session, turn and workspace. */
export interface LogKeys {
  /** Upstream's session id. */
  readonly sessionId?: SessionId
  /** The number of upstream's `turn/start` event. */
  readonly turn?: number
  /** Upstream's workspace id. */
  readonly workspaceId?: WorkspaceId
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** The fields cut from a long record, in the order they are cut. */
const CUT_ORDER = ['stack', 'msg', 'message'] as const

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function encode(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`
}

function read(record: LogRecord, field: typeof CUT_ORDER[number]): string | undefined {
  return field === 'msg' ? record.msg : record.err?.[field]
}

function write(record: LogRecord, field: typeof CUT_ORDER[number], value: string): LogRecord {
  if (field === 'msg') return { ...record, msg: value }
  // `read` returned a string for this field, so `err` is present.
  return { ...record, err: { ...record.err!, [field]: value } }
}

/**
 * The length of the longest prefix of `value` whose removed suffix costs at least `excess` bytes in the serialised
 * record. JSON escaping never makes a character cheaper than its UTF-8 bytes, so each character's escaped size is
 * counted; a surrogate pair is never split.
 */
function cutPoint(value: string, excess: number): number {
  let end = value.length
  let saved = 0
  while (end > 0 && saved < excess) {
    const low = value.charCodeAt(end - 1)
    const width = end >= 2 && low >= 0xdc00 && low <= 0xdfff && value.charCodeAt(end - 2) >= 0xd800 && value.charCodeAt(end - 2) <= 0xdbff ? 2 : 1
    saved += bytes(JSON.stringify(value.slice(end - width, end))) - 2
    end -= width
  }
  return end
}

/**
 * Serialise one redacted record as its log line, cutting it to fit C20's limit.
 * @param record - the record, already redacted; a `truncated` count it carries (bytes a capture dropped) is kept and
 *   added to.
 * @returns the line, newline included, at most {@link RECORD_MAX_BYTES} bytes.
 */
export function serializeRecord(record: LogRecord): string {
  let line = encode(record)
  if (bytes(line) <= RECORD_MAX_BYTES) return line
  let current: LogRecord = record
  let removed = record.truncated ?? 0
  // Each pass cuts the first field that still has text; the `truncated` count itself can grow by a few digits, so
  // the loop re-measures until the line fits.
  for (;;) {
    const excess = bytes(encode({ ...current, truncated: removed })) - RECORD_MAX_BYTES
    if (excess <= 0) break
    const field = CUT_ORDER.find(name => (read(current, name) ?? '').length > 0)
    if (field === undefined) {
      // Only fixed-size fields and short names remain; drop the error and cap the logger name.
      const { err: _err, ...rest } = current as Mutable<LogRecord>
      removed += bytes(current.logger) > 256 ? bytes(current.logger) - 256 : 0
      current = { ...rest, logger: Buffer.from(current.logger).subarray(0, 256).toString('utf8') }
      if (bytes(encode({ ...current, truncated: removed })) > RECORD_MAX_BYTES) {
        throw new RangeError('a log record exceeds its limit with every variable field emptied')
      }
      break
    }
    // `find` returned a field whose text is non-empty.
    const value = read(current, field)!
    const end = cutPoint(value, excess)
    removed += bytes(value.slice(end))
    current = write(current, field, value.slice(0, end))
  }
  line = encode({ ...current, truncated: removed })
  return line
}
