/**
 * The supervisor's operational log, the `supervisor-<profile>` surface of contract C20, written through
 * `@delo/logs`. The supervisor registers every secret it holds with the log's redactor before the value can reach a
 * record, writes one record per request naming the operation, the workspace and the outcome, never a request body,
 * a credential or an environment value, and captures its own process's standard output and standard error into the
 * same log.
 *
 * @module @delo/supervisor/log
 */
import type { LogLevel } from '@delo/contract-operational-logs'
import { interceptStdio, Redactor, resolveSurface, SurfaceLog, type DeloLogger, type LogsFailure } from '@delo/logs'

/** The supervisor's log and the redactor its secrets are registered with. */
export interface SupervisorLog {
  /** The surface's log. */
  readonly log: SurfaceLog
  /** The process's redactor. */
  readonly redactor: Redactor
  /** The supervisor's logger. */
  readonly logger: DeloLogger
}

/** The options of {@link openSupervisorLog}. */
export interface SupervisorLogOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's start id of the home-process start the supervisor belongs to. */
  readonly startId: string
  /** The most detailed level written. */
  readonly level: LogLevel
  /** Receives each record the writer could not write. */
  readonly onFailure: (error: LogsFailure) => void
}

/** The name of the supervisor's logger in its records. */
export const SUPERVISOR_LOGGER = 'supervisor'

/**
 * Open the `supervisor-<profile>` log.
 * @param options - the home, profile, start id, level and failure sink.
 * @returns the log, its redactor and the supervisor's logger.
 * @throws {HomeLayoutError} when the log directory or file is laxer than C1 allows.
 */
export function openSupervisorLog(options: SupervisorLogOptions): SupervisorLog {
  const redactor = new Redactor()
  const log = SurfaceLog.open({
    location: resolveSurface({ kind: 'supervisor', home: options.home, profile: options.profile }),
    redactor,
    pid: process.pid,
    level: options.level,
    startId: options.startId,
    onFailure: options.onFailure,
    now: Date.now,
  })
  return { log, redactor, logger: log.logger(SUPERVISOR_LOGGER) }
}

/**
 * Capture the supervisor process's standard output and standard error into its log; nothing reaches the original
 * streams, whose reader is the home process.
 * @param log - the supervisor's log.
 * @returns the disposer that restores both streams.
 */
export function captureSupervisorOutput(log: SurfaceLog): () => void {
  return interceptStdio(log, { stdoutLevel: 'info', stderrLevel: 'warn', passThrough: false })
}
