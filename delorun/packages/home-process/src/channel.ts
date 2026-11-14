/**
 * The update channel's listener (contract C19, "The update channel"): `@delorun/home`'s token channel on
 * `run/<profile>/update.sock` with C19's limits. Each connection carries one request line of at most 16,384 bytes
 * that must arrive within 5 seconds; at most 8 connections are open at once and a further one is answered `BUSY`.
 * The token is checked in constant time before the schema is read, a refused authentication is logged without the
 * presented value at most once per second, and the connection closes after the final response line. A request whose
 * caller disconnects runs on.
 *
 * @module @delorun/home-process/channel
 */
import { join } from 'node:path'
import { RUN_ENTRIES } from '@delorun/contract-home-layout'
import {
  AUTH_FAILURE_LOG_LINES_PER_SECOND,
  MAX_CONNECTIONS,
  REQUEST_DEADLINE_MS,
  REQUEST_MAX_BYTES,
  type UpdateChannelRequest,
} from '@delorun/contract-home-process'
import { listenTokenSocket, runDirectory, type ChannelLogger, type ChannelRefusal, type ListenerRefusal, type StartTokenCheck, type TokenSocket } from '@delorun/home'
import { HomeProcessError } from './errors.ts'
import { checkUpdateRequest } from './schema.ts'

/**
 * Runs one authenticated request.
 * @param request - the request.
 * @param progress - writes one progress line with `ok: true` and these fields; dropped once the caller has gone.
 * @returns the final line's fields after `ok: true`.
 * @throws {HomeProcessError} answered as the final line.
 */
export type UpdateRequestHandler = (request: UpdateChannelRequest, progress: (fields: Readonly<Record<string, unknown>>) => void) => Promise<Readonly<Record<string, unknown>>>

/** The options of {@link listenUpdateChannel}. */
export interface UpdateChannelOptions {
  /** The socket path, from {@link updateSocketPath}. */
  readonly socketPath: string
  /** The current start's token check. */
  readonly check: StartTokenCheck
  /** Runs each authenticated request. */
  readonly handle: UpdateRequestHandler
  /** The home process's logger. */
  readonly logger: ChannelLogger
  /**
   * Called once a successful request's final line has been sent, or its caller has gone.
   * @param request - the request.
   */
  readonly answered: (request: UpdateChannelRequest) => void
}

/**
 * The update channel's socket path of a profile.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/update.sock`.
 */
export function updateSocketPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.updateSocket)
}

/**
 * C19's refusal as the channel answers it.
 * @param error - the refusal.
 * @returns the channel refusal.
 */
function channelRefusal(error: HomeProcessError): ChannelRefusal {
  return { code: error.code, ...error.detail === undefined ? {} : { detail: error.detail }, line: error.toFailure() }
}

/** C19's codes for the refusals the listener raises. */
const LISTENER_REFUSALS: Readonly<Record<ListenerRefusal, () => HomeProcessError>> = {
  UNAUTHENTICATED: () => new HomeProcessError('UNAUTHENTICATED'),
  BUSY: () => new HomeProcessError('BUSY'),
  REQUEST_TIMEOUT: () => new HomeProcessError('REQUEST_TIMEOUT'),
  REQUEST_TOO_LARGE: () => new HomeProcessError('REQUEST_TOO_LARGE', `the request line exceeds ${String(REQUEST_MAX_BYTES)} bytes`),
  REQUEST_ENDED: () => new HomeProcessError('SCHEMA_VIOLATION', 'the connection ended before a request line'),
}

/**
 * Listen on the update channel, bound and replaced as `@delorun/home`'s `listenTokenSocket` states.
 * @param options - the path, token check, handler and logger.
 * @returns the listener.
 * @throws {HomeLayoutError} `SOCKET_PATH_TOO_LONG` when the path exceeds C1's limit.
 * @throws {Error} when a file other than a socket is at the path.
 */
export async function listenUpdateChannel(options: UpdateChannelOptions): Promise<TokenSocket> {
  return listenTokenSocket<UpdateChannelRequest>({
    socketPath: options.socketPath,
    check: options.check,
    logger: options.logger,
    limits: {
      requestMaxBytes: REQUEST_MAX_BYTES,
      maxConnections: MAX_CONNECTIONS,
      requestDeadlineMs: REQUEST_DEADLINE_MS,
      firstByteMs: REQUEST_DEADLINE_MS,
      refusalLogIntervalMs: 1_000 / AUTH_FAILURE_LOG_LINES_PER_SECOND,
    },
    decode: checkUpdateRequest,
    handle: options.handle,
    refusalOf: error => (error instanceof HomeProcessError ? channelRefusal(error) : undefined),
    refuse: kind => channelRefusal(LISTENER_REFUSALS[kind]()),
    describe: request => ({ op: request.op }),
    answered: options.answered,
  })
}
