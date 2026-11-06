/**
 * Reading a surface's records, for `delorun logs`: the last records across the rotated and active files, and new
 * records as they are written, across rotations. Each file passes C1's refusal rule before it is read; readers
 * ignore unknown fields.
 *
 * @module @delo/logs/reader
 */
import type { LogLevel, LogRecord } from '@delo/contract-operational-logs'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { checkLogFile, lstatOrMissing, type SurfaceLocation } from './files.ts'
import { surfaceFiles } from './retention.ts'

/** One stored line and its record, when the line is one. */
export interface StoredLine {
  /** The line as stored, without its newline. */
  readonly line: string
  /** The record, or `undefined` for a line that is not a C20 record. */
  readonly record: LogRecord | undefined
}

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Parse one stored line, checking the fields every record carries; other fields are kept as stored.
 * @param line - the line without its newline.
 * @returns the record, or `undefined` when the line is not one.
 */
export function parseRecord(line: string): LogRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (_error: unknown) {
    // A line that is not JSON is not a record; the caller counts it.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const ok = typeof record['ts'] === 'string'
    && LEVELS.includes(record['level'] as LogLevel)
    && typeof record['surface'] === 'string'
    && typeof record['pid'] === 'number'
    && typeof record['logger'] === 'string'
    && (record['source'] === 'delo' || record['source'] === 'captured')
    && typeof record['msg'] === 'string'
    && (record['sessionId'] === undefined || typeof record['sessionId'] === 'string')
    && (record['turn'] === undefined || typeof record['turn'] === 'number')
  return ok ? value as LogRecord : undefined
}

function readWhole(path: string): string {
  const stats = lstatOrMissing(path)
  if (stats === undefined) return ''
  checkLogFile(path, stats)
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function completeLines(text: string): string[] {
  const end = text.lastIndexOf('\n')
  return end === -1 ? [] : text.slice(0, end).split('\n')
}

/**
 * The last stored lines of a surface that match a filter, oldest first, read from the newest file backwards so only
 * the files needed are read.
 * @param location - the surface.
 * @param limit - how many lines at most.
 * @param keep - which lines to keep; a line that is not a record reaches it with `record` undefined.
 * @returns the lines.
 * @throws LogsError `HOME_MODE` or `SECRET_FILE_MODE` when C1's refusal rule refuses the directory or a file.
 */
export function readLines(location: SurfaceLocation, limit: number, keep: (line: StoredLine) => boolean): StoredLine[] {
  const files = surfaceFiles(location)
  const newestFirst = [...files.active === undefined ? [] : [files.active], ...files.rotated.map(file => file.path)]
  const kept: StoredLine[] = []
  for (const path of newestFirst) {
    const lines = completeLines(readWhole(path))
    for (let index = lines.length - 1; index >= 0 && kept.length < limit; index -= 1) {
      // `index` lies within `lines`.
      const line = lines[index]!
      const stored = { line, record: parseRecord(line) }
      if (keep(stored)) kept.push(stored)
    }
    if (kept.length >= limit) break
  }
  return kept.reverse()
}

/** The options of {@link followLines}. */
export interface FollowOptions {
  /** Receives each new complete line, in order. */
  readonly onLine: (line: StoredLine) => void
  /** Ends following. */
  readonly signal: AbortSignal
  /** How often the active file is checked, in milliseconds. */
  readonly intervalMs: number
}

/**
 * Follow a surface's active file from its current end: each line written after the call reaches `onLine`, including
 * the rest of a file that rotates away and the lines of the new active file. A file emptied in place is followed from
 * its start when a check finds it shorter than the part already read; lines written into it before that check up to
 * that length are not delivered.
 * @param location - the surface.
 * @param options - the line sink, the signal and the interval.
 * @returns when the signal aborts.
 * @throws LogsError `SECRET_FILE_MODE` when C1's refusal rule refuses the active file.
 */
export async function followLines(location: SurfaceLocation, options: FollowOptions): Promise<void> {
  let fd: number | undefined
  let offset = 0
  let pending = ''
  const open = (fromEnd: boolean): void => {
    const stats = lstatOrMissing(location.file)
    if (stats === undefined) return
    checkLogFile(location.file, stats)
    fd = openSync(location.file, constants.O_RDONLY | NO_FOLLOW)
    offset = fromEnd ? fstatSync(fd).size : 0
  }
  const drain = (): void => {
    if (fd === undefined) return
    const size = fstatSync(fd).size
    if (size < offset) {
      // Emptied in place: follow from its start.
      offset = 0
      pending = ''
    }
    if (size === offset) return
    const buffer = Buffer.alloc(size - offset)
    const read = readSync(fd, buffer, 0, buffer.length, offset)
    offset += read
    const text = pending + buffer.subarray(0, read).toString('utf8')
    const end = text.lastIndexOf('\n')
    pending = end === -1 ? text : text.slice(end + 1)
    if (end === -1) return
    for (const line of text.slice(0, end).split('\n')) options.onLine({ line, record: parseRecord(line) })
  }
  const close = (): void => {
    if (fd !== undefined) closeSync(fd)
    fd = undefined
  }
  open(true)
  try {
    while (!options.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          options.signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, options.intervalMs)
        options.signal.addEventListener('abort', done, { once: true })
      })
      drain()
      const atPath = lstatOrMissing(location.file)
      const current = fd === undefined ? undefined : fstatSync(fd)
      if (atPath !== undefined && (current === undefined || current.ino !== atPath.ino || current.dev !== atPath.dev)) {
        // The file rotated away (its rest was drained above) or appeared: continue in the file now at the path.
        close()
        pending = ''
        open(false)
        drain()
      }
    }
  } finally {
    close()
  }
}
