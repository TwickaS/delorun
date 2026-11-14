/**
 * The supervisor's listener (contract C9, "The supervisor API"; C1, "Sockets and the start token"): `@delorun/home`'s
 * token channel on `run/<profile>/supervisor.sock` with C9's limits. Each connection carries one request line of at
 * most 65,536 bytes that must arrive within 5 seconds, and at most 32 connections are served at once; the 33rd is
 * answered `BUSY`. A request is authenticated by the current start's token before its schema is read, and the
 * connection closes after its response line.
 *
 * @module @delorun/supervisor/server
 */
import {
  SUPERVISOR_MAX_CONNECTIONS,
  SUPERVISOR_REQUEST_DEADLINE_MS,
  SUPERVISOR_REQUEST_MAX_BYTES,
  type SupervisorRequest,
} from '@delorun/contract-runtime-supervisor'
import { listenTokenSocket, type ChannelRefusal, type ListenerRefusal, type StartTokenCheck } from '@delorun/home'
import type { DelorunLogger } from '@delorun/logs'
import { SupervisorError } from './errors.ts'
import { checkRequest } from './schema.ts'

/** Runs one authenticated request and returns the response line's fields after `ok`. */
export type RequestHandler = (request: SupervisorRequest) => Promise<Record<string, unknown>>

/** The options of {@link listenSupervisor}. */
export interface ListenOptions {
  /** The socket path, `run/<profile>/supervisor.sock`. */
  readonly socketPath: string
  /** The current start's token check. */
  readonly check: StartTokenCheck
  /** Runs each authenticated request. */
  readonly handle: RequestHandler
  /** The supervisor's logger. */
  readonly logger: DelorunLogger
  /** The time from connect to the request's first byte, in milliseconds, within C9's 5 seconds for the whole line. */
  readonly firstByteMs: number
  /** The shortest time between two records of refused authentications, in milliseconds. */
  readonly refusalLogIntervalMs: number
}

/** A listening supervisor socket. */
export interface SupervisorListener {
  /** The socket path. */
  readonly socketPath: string
  /**
   * Stop accepting connections, end the open ones and remove the socket.
   * @returns when the listener has closed.
   */
  close(): Promise<void>
}

/**
 * The workspace a request names, for its log record.
 * @param request - the request.
 * @returns the workspace id, or `undefined`.
 */
function workspaceOf(request: SupervisorRequest): string | undefined {
  return 'args' in request && 'workspaceId' in request.args ? request.args.workspaceId : undefined
}

/**
 * The supervisor's refusal as the channel answers it.
 * @param error - the refusal.
 * @returns the channel refusal.
 */
function channelRefusal(error: SupervisorError): ChannelRefusal {
  return { code: error.code, ...error.detail === undefined ? {} : { detail: error.detail }, line: error.toFailure() }
}

/** C9's codes for the refusals the listener raises; C9 has no code of its own for a long line or an early end. */
const LISTENER_REFUSALS: Readonly<Record<ListenerRefusal, () => SupervisorError>> = {
  UNAUTHENTICATED: () => new SupervisorError('UNAUTHENTICATED'),
  BUSY: () => new SupervisorError('BUSY'),
  REQUEST_TIMEOUT: () => new SupervisorError('REQUEST_TIMEOUT'),
  REQUEST_TOO_LARGE: () => new SupervisorError('SCHEMA_VIOLATION', `the request line exceeds ${String(SUPERVISOR_REQUEST_MAX_BYTES)} bytes`),
  REQUEST_ENDED: () => new SupervisorError('SCHEMA_VIOLATION', 'the connection ended before a request line'),
}

/**
 * Listen on the supervisor socket, bound and replaced as `@delorun/home`'s `listenTokenSocket` states.
 * @param options - the path, token check, handler, logger and timing.
 * @returns the listener.
 * @throws {HomeLayoutError} `SOCKET_PATH_TOO_LONG` when the path exceeds C1's limit.
 * @throws {Error} when a file other than a socket is at the path.
 */
export async function listenSupervisor(options: ListenOptions): Promise<SupervisorListener> {
  const socket = await listenTokenSocket<SupervisorRequest>({
    socketPath: options.socketPath,
    check: options.check,
    logger: options.logger,
    limits: {
      requestMaxBytes: SUPERVISOR_REQUEST_MAX_BYTES,
      maxConnections: SUPERVISOR_MAX_CONNECTIONS,
      requestDeadlineMs: SUPERVISOR_REQUEST_DEADLINE_MS,
      firstByteMs: options.firstByteMs,
      refusalLogIntervalMs: options.refusalLogIntervalMs,
    },
    decode: checkRequest,
    handle: async request => options.handle(request),
    refusalOf: error => (error instanceof SupervisorError ? channelRefusal(error) : undefined),
    refuse: kind => channelRefusal(LISTENER_REFUSALS[kind]()),
    describe: (request) => {
      const workspaceId = workspaceOf(request)
      return { op: request.op, ...workspaceId === undefined ? {} : { workspaceId } }
    },
  })
  return { socketPath: socket.socketPath, close: async () => socket.close() }
}
