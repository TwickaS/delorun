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

/**
 * Open the `home-<profile>` log.
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
  return { log, redactor, logger: log.logger(HOME_LOGGER) }
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
