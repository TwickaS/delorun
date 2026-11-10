/**
 * The home process's operational log, the `home-<profile>` surface of contract C20, written through `@delo/logs`.
 * The start token is registered with the log's redactor before it can reach a record, and the process's standard
 * output and standard error are captured into the same log.
 *
 * @module @delo/home-process/log
 */
import type { StartId } from '@delo/contract-home-layout'
import type { LogLevel } from '@delo/contract-operational-logs'
import { interceptStdio, Redactor, resolveSurface, SurfaceLog, type DeloLogger, type LogsFailure } from '@delo/logs'

/** The home process's log and the redactor its secrets are registered with. */
export interface HomeLog {
  /** The surface's log. */
  readonly log: SurfaceLog
  /** The process's redactor. */
  readonly redactor: Redactor
  /** The home process's logger. */
  readonly logger: DeloLogger
}

/** The options of {@link openHomeLog}. */
export interface HomeLogOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's start id of this home-process start, which every record carries. */
  readonly startId: StartId
  /** The most detailed level written. */
  readonly level: LogLevel
  /** Receives each record the writer could not write. */
  readonly onFailure: (error: LogsFailure) => void
}

/** The name of the home process's logger in its records. */
export const HOME_LOGGER = 'home-process'

/** The home log this process opened, with its profile. */
export interface OpenedHomeLog {
  /** The log. */
  readonly homeLog: HomeLog
  /** The CLI profile whose `home-<profile>` surface it is. */
  readonly profile: string
}

/**
 * The home log this process opened last. A process opens at most one, as the home process of one profile; the
 * last-resort report of `delorun` writes a fatal failure's full detail to it.
 */
let opened: OpenedHomeLog | undefined

/**
 * Open the `home-<profile>` log, which becomes this process's {@link openedHomeLog}.
 * @param options - the home, profile, start id, level and failure sink.
 * @returns the log, its redactor and the home process's logger.
 * @throws {HomeLayoutError} when the log directory or file is laxer than C1 allows.
 */
export function openHomeLog(options: HomeLogOptions): HomeLog {
  const redactor = new Redactor()
  const log = SurfaceLog.open({
    location: resolveSurface({ kind: 'home', home: options.home, profile: options.profile }),
    redactor,
    pid: process.pid,
    level: options.level,
    startId: options.startId,
    onFailure: options.onFailure,
    now: Date.now,
  })
  const homeLog = { log, redactor, logger: log.logger(HOME_LOGGER) }
  opened = { homeLog, profile: options.profile }
  return homeLog
}

/**
 * The home log this process opened, which a closed log still is: a write after {@link SurfaceLog.close} reopens its
 * file.
 * @returns the log and its profile, or `undefined` when this process opened none.
 */
export function openedHomeLog(): OpenedHomeLog | undefined {
  return opened
}

/**
 * Capture the home process's standard output and standard error into its log.
 * @param log - the home process's log.
 * @param passThrough - whether the output also reaches the original streams, as in `delorun start --foreground`.
 * @returns the disposer that restores both streams.
 */
export function captureHomeOutput(log: SurfaceLog, passThrough: boolean): () => void {
  return interceptStdio(log, { stdoutLevel: 'info', stderrLevel: 'warn', passThrough })
}
