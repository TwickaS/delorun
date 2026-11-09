/**
 * The relay's operational log, C20's `relay` surface at `/var/log/delo-relay/relay.log` inside
 * its container. The data plane writes through the {@link RelayLog} interface so the core takes
 * no dependency on the logger; {@link openRelayLog} is the surface's writer, and every tunnel
 * token the relay handles is registered with C20's redactor as a `relay-key`, so a token cannot
 * reach the file even when a message carries one. A caller that captures a child process's
 * output or clears the surface needs the writer itself, which {@link RelayLogHandle} exposes.
 *
 * @module @delo/relay/log
 */
import type { LogLevel } from '@delo/contract-operational-logs'
import { Redactor, resolveSurface, SurfaceLog, type DeloLogger, type LogsFailure, type SurfaceLocation } from '@delo/logs'

/**
 * The records one running relay writes. A caller that needs no file passes a silent
 * implementation; the data plane never throws from a record.
 */
export interface RelayLog {
  /** Write an `error` record. */
  error(msg: string, data?: Readonly<Record<string, unknown>>): void
  /** Write a `warn` record. */
  warn(msg: string, data?: Readonly<Record<string, unknown>>): void
  /** Write an `info` record. */
  info(msg: string, data?: Readonly<Record<string, unknown>>): void
  /** Write a `debug` record. */
  debug(msg: string, data?: Readonly<Record<string, unknown>>): void
  /** Register a secret value, so every later record replaces it with C20's marker. */
  secret(value: string): void
}

/** The options of {@link openRelayLog}. */
export interface OpenRelayLogOptions {
  /** The surface directory; C20's container path by default. */
  readonly dir?: string
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number
  /** The writing process id. */
  readonly pid?: number
  /** The most detailed level written. */
  readonly level?: LogLevel
  /** Receives each failure to write a record, which is then dropped. */
  readonly onFailure?: (error: LogsFailure) => void
}

/** An open relay log with the writer behind it. */
export interface RelayLogHandle {
  /** The records the data plane writes. */
  readonly log: RelayLog
  /** The surface's writer, for a capture or a clear. */
  readonly writer: SurfaceLog
  /** The writer's named logger, which takes C20's full record fields. */
  readonly logger: DeloLogger
  /** The redactor every record passes, so a caller can register another secret. */
  readonly redactor: Redactor
  /** The surface's files. */
  readonly location: SurfaceLocation
  /** Close the active file. */
  close(): void
}

/** The logger name the relay's records carry. */
export const RELAY_LOGGER = 'delo-relay'

/** A log that writes nothing, for a caller that only needs the interface. */
export const silentRelayLog: RelayLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  secret: () => {},
}

/**
 * Open C20's `relay` surface and wrap it as the data plane's log.
 * @param options - the directory, clock, process id, level and failure listener.
 * @returns the log, its writer, its redactor and its disposer.
 * @throws HomeLayoutError or LogsError when C20's directory and file modes are refused.
 */
export function openRelayLog(options: OpenRelayLogOptions = {}): RelayLogHandle {
  const location: SurfaceLocation = options.dir === undefined ? resolveSurface({ kind: 'relay', home: '/' }) : { surface: 'relay', dir: options.dir, file: `${options.dir}/relay.log` }
  const redactor = new Redactor()
  const writer = SurfaceLog.open({
    location,
    redactor,
    pid: options.pid ?? process.pid,
    level: options.level ?? 'info',
    onFailure: options.onFailure ?? (() => {}),
    now: options.now ?? Date.now,
  })
  const logger = writer.logger(RELAY_LOGGER)
  return {
    log: {
      error: (msg, data) => logger.error(msg, data === undefined ? {} : { data }),
      warn: (msg, data) => logger.warn(msg, data === undefined ? {} : { data }),
      info: (msg, data) => logger.info(msg, data === undefined ? {} : { data }),
      debug: (msg, data) => logger.debug(msg, data === undefined ? {} : { data }),
      secret: value => {
        redactor.register(value, 'relay-key')
      },
    },
    writer,
    logger,
    redactor,
    location,
    close: () => {
      writer.close()
    },
  }
}
