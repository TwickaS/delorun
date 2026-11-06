/**
 * The writer of one surface's log: each record is redacted, keyed, serialised within C20's line limit and appended
 * to the active file, which rotates before a write would take it past 10 MiB and keeps the active file and 4
 * rotated files. A writer whose active file another process rotated, pruned or emptied continues in the file now at
 * its path.
 *
 * @module @delo/logs/writer
 */
import { ROTATE_BYTES, type LogLevel, type LogRecord } from '@delo/contract-operational-logs'
import { closeSync, fstatSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { isLogsFailure, LogsError, type LogsFailure } from './errors.ts'
import { ensureSurfaceDirectory, LAST_ROTATED_INDEX, lstatOrMissing, openForAppend, rotatedFile, rotatedIndex, type SurfaceLocation } from './files.ts'
import { serializeRecord, type LogKeys } from './record.ts'
import { safeJson, type Redactor } from './redact.ts'

/** Each level's rank; a record is written when its rank is at most the writer's level's. */
export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 }

/** The options of {@link SurfaceLog.open}. */
export interface SurfaceLogOptions {
  /** Where the surface's files are, from {@link resolveSurface}. */
  readonly location: SurfaceLocation
  /** The process's redactor, which holds every secret value the process has registered. */
  readonly redactor: Redactor
  /** The writing process id. */
  readonly pid: number
  /** The most detailed level written; the surface owner takes it from its configuration. */
  readonly level: LogLevel
  /** C1's start id, on the `home-<profile>` and `supervisor-<profile>` surfaces. */
  readonly startId?: string
  /**
   * Receives each failure to write a record, which is then dropped; the next record tries again. A writer never
   * throws from {@link SurfaceLog.write}, so a log failure never fails the operation that logged.
   */
  readonly onFailure: (error: LogsFailure) => void
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
}

/** One record before redaction and serialisation. */
export interface LogEntry {
  /** The level. */
  readonly level: LogLevel
  /** The Cordis logger name, Delo's logger name, or `stdout` or `stderr` for captured output. */
  readonly logger: string
  /** Whether Delo's logger wrote it or it was captured from upstream code's output. */
  readonly source: LogRecord['source']
  /** The message, before redaction. */
  readonly msg: string
  /** The error of an error record. */
  readonly error?: unknown
  /** The record's session, turn and workspace; when absent, the writer's key source is asked. */
  readonly keys?: LogKeys
  /** Bytes a capture already dropped from the line; serialisation adds the bytes it cuts. */
  readonly dropped?: number
}

/** Optional details of a record written through a {@link DeloLogger}. */
export interface DeloLogDetails {
  /** An error; the record carries it as `err`. */
  readonly err?: unknown
  /** Structured details, appended to the message as JSON after key-name redaction. */
  readonly data?: Readonly<Record<string, unknown>>
  /** The record's session, turn and workspace. */
  readonly keys?: LogKeys
}

/** A named logger over a surface's log, for Delo's own records. */
export interface DeloLogger {
  /** Write an `error` record. */
  error(msg: string, details?: DeloLogDetails): void
  /** Write a `warn` record. */
  warn(msg: string, details?: DeloLogDetails): void
  /** Write an `info` record. */
  info(msg: string, details?: DeloLogDetails): void
  /** Write a `debug` record. */
  debug(msg: string, details?: DeloLogDetails): void
}

/**
 * Shift a surface's rotated files up by one and move the active file to `.1`: `.3` to `.4`, `.2` to `.3`, `.1` to
 * `.2`, the active file to `.1`. The previous `.4` and any file beyond it are deleted.
 * @param location - the surface.
 */
export function rotateFiles(location: SurfaceLocation): void {
  for (const name of readdirSync(location.dir)) {
    const index = rotatedIndex(location, name)
    if (index !== undefined && index > LAST_ROTATED_INDEX) unlinkSync(rotatedFile(location, index))
  }
  for (let index = LAST_ROTATED_INDEX - 1; index >= 1; index -= 1) {
    if (lstatOrMissing(rotatedFile(location, index)) !== undefined) renameSync(rotatedFile(location, index), rotatedFile(location, index + 1))
  }
  if (lstatOrMissing(location.file) !== undefined) renameSync(location.file, rotatedFile(location, 1))
}

/** The log of one surface in one process. */
export class SurfaceLog {
  /** The surface's files. */
  readonly location: SurfaceLocation
  /** The redactor every record passes. */
  readonly redactor: Redactor
  private readonly options: SurfaceLogOptions
  private fd: number | undefined
  private keySources: (() => LogKeys | undefined)[] = []
  /** Set while a record is written, so a failure report that is itself logged is dropped instead of recursing. */
  private writing = false

  private constructor(options: SurfaceLogOptions, fd: number) {
    this.options = options
    this.location = options.location
    this.redactor = options.redactor
    this.fd = fd
  }

  /**
   * Open a surface's log: create its directory at 0700 and its active file at 0600, or check the existing ones.
   * @param options - the surface, the redactor and the writer's settings.
   * @returns the open log.
   * @throws {HomeLayoutError} `HOME_MODE` or `SECRET_FILE_MODE` when C1's refusal rule refuses the directory or the file, so a
   *   surface fails at its start instead of running without its log.
   */
  static open(options: SurfaceLogOptions): SurfaceLog {
    ensureSurfaceDirectory(options.location)
    return new SurfaceLog(options, openForAppend(options.location.file))
  }

  /**
   * Add a source of ambient keys, asked for a record that names none; the most recently added source that returns
   * keys wins.
   * @param source - returns the keys of the code running now, such as the turn an agent is driving.
   * @returns a disposer that removes the source.
   */
  useKeys(source: () => LogKeys | undefined): () => void {
    this.keySources = [...this.keySources, source]
    return () => {
      this.keySources = this.keySources.filter(item => item !== source)
    }
  }

  /**
   * The ambient keys of the code running now.
   * @returns the keys from the newest source that has any.
   */
  currentKeys(): LogKeys | undefined {
    for (let index = this.keySources.length - 1; index >= 0; index -= 1) {
      const keys = this.keySources[index]?.()
      if (keys !== undefined) return keys
    }
    return undefined
  }

  /** The most detailed level this log writes. */
  get level(): LogLevel {
    return this.options.level
  }

  /**
   * Whether a record of a level is written.
   * @param level - the level.
   * @returns whether the writer's level includes it.
   */
  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.options.level]
  }

  /**
   * Redact, key, serialise and append one record. A failure is reported to `onFailure` and the record is dropped.
   * @param entry - the record before redaction.
   */
  write(entry: LogEntry): void {
    if (!this.enabled(entry.level) || this.writing) return
    this.writing = true
    try {
      this.append(serializeRecord(this.record(entry)))
    } catch (error: unknown) {
      const failure = isLogsFailure(error) ? error : new LogsError('LOG_WRITE_FAILED', `a record could not be written to ${this.location.file}`, this.location.file, { cause: error })
      this.options.onFailure(failure)
    } finally {
      this.writing = false
    }
  }

  /**
   * A named logger for Delo's own records, whose `source` is `delo`.
   * @param name - the logger name the records carry.
   * @returns the logger.
   */
  logger(name: string): DeloLogger {
    const at = (level: LogLevel) => (msg: string, details: DeloLogDetails = {}): void => {
      if (!this.enabled(level)) return
      const data = details.data === undefined ? '' : ` ${safeJson(this.redactor.fields(details.data))}`
      this.write({
        level,
        logger: name,
        source: 'delo',
        msg: `${msg}${data}`,
        ...details.err === undefined ? {} : { error: details.err },
        ...details.keys === undefined ? {} : { keys: details.keys },
      })
    }
    return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
  }

  /** Close the active file; later writes reopen it. */
  close(): void {
    if (this.fd === undefined) return
    const fd = this.fd
    this.fd = undefined
    closeSync(fd)
  }

  private record(entry: LogEntry): LogRecord {
    const keys = entry.keys ?? this.currentKeys() ?? {}
    return {
      ts: new Date(this.options.now()).toISOString(),
      level: entry.level,
      surface: this.location.surface,
      pid: this.options.pid,
      ...this.options.startId === undefined ? {} : { startId: this.options.startId },
      logger: this.redactor.text(entry.logger),
      source: entry.source,
      msg: this.redactor.text(entry.msg),
      ...keys.sessionId === undefined ? {} : { sessionId: keys.sessionId },
      ...keys.turn === undefined ? {} : { turn: keys.turn },
      ...keys.workspaceId === undefined ? {} : { workspaceId: keys.workspaceId },
      ...entry.error === undefined ? {} : { err: this.redactor.error(entry.error) },
      ...entry.dropped === undefined || entry.dropped === 0 ? {} : { truncated: entry.dropped },
    }
  }

  /** The descriptor of the file now at the active path, reopened when the path was rotated, pruned or removed. */
  private current(): number {
    const atPath = lstatOrMissing(this.location.file)
    if (this.fd !== undefined && atPath !== undefined) {
      const open = fstatSync(this.fd)
      if (open.ino === atPath.ino && open.dev === atPath.dev) return this.fd
    }
    this.close()
    ensureSurfaceDirectory(this.location)
    this.fd = openForAppend(this.location.file)
    return this.fd
  }

  private append(line: string): void {
    const data = Buffer.from(line, 'utf8')
    let fd = this.current()
    const size = fstatSync(fd).size
    if (size > 0 && size + data.length > ROTATE_BYTES) {
      this.close()
      rotateFiles(this.location)
      fd = this.current()
    }
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
  }
}
