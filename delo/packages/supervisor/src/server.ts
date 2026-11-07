/**
 * The supervisor's listener (contract C9, "The supervisor API"; C1, "Sockets and the start token"): a pathname Unix
 * socket under `run/<profile>/`, set to mode 0600 after it binds. Each connection carries one request line of at
 * most 65,536 bytes that must arrive within 5 seconds, and at most 32 connections are served at once; the 33rd is
 * answered `BUSY`. A request is authenticated by the current start's token before its schema is read, and the
 * connection closes after its response line.
 *
 * @module @delo/supervisor/server
 */
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { PROTECTED_FILE_MODE, SOCKET_PATH_MAX_BYTES } from '@delo/contract-home-layout'
import {
  SUPERVISOR_MAX_CONNECTIONS,
  SUPERVISOR_REQUEST_DEADLINE_MS,
  SUPERVISOR_REQUEST_MAX_BYTES,
  type SupervisorRequest,
} from '@delo/contract-runtime-supervisor'
import { HomeLayoutError } from '@delo/home'
import type { DeloLogger } from '@delo/logs'
import { SupervisorError } from './errors.ts'
import { decodeRequest } from './schema.ts'
import type { StartTokenCheck } from './token.ts'

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
  readonly logger: DeloLogger
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
 * Remove a socket left by an earlier supervisor of this profile. Only a socket is removed; any other file at the path
 * is refused, so the supervisor never deletes a file it did not create.
 * @param path - the socket path.
 * @throws {Error} naming the path when something other than a socket is there.
 */
async function removeStaleSocket(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSocket()) throw new Error(`${path} exists and is not a socket; remove it before starting the supervisor`)
  await unlink(path)
}

/**
 * Listen on the supervisor socket.
 * @param options - the path, token check, handler and logger.
 * @returns the listener.
 * @throws {HomeLayoutError} `SOCKET_PATH_TOO_LONG` when the path exceeds C1's limit.
 */
export async function listenSupervisor(options: ListenOptions): Promise<SupervisorListener> {
  const { socketPath, check, handle, logger } = options
  if (Buffer.byteLength(socketPath, 'utf8') > SOCKET_PATH_MAX_BYTES) {
    throw new HomeLayoutError('SOCKET_PATH_TOO_LONG', socketPath, `${socketPath} is longer than ${String(SOCKET_PATH_MAX_BYTES)} bytes; choose a shorter Delo home with DELO_HOME`)
  }
  await removeStaleSocket(socketPath)
  const sockets = new Set<Socket>()
  let served = 0

  // Input after the request line is discarded, and a peer that has not closed its side within the request deadline
  // after the response is cut off, so it cannot hold one of the connections.
  const answer = (socket: Socket, fields: Record<string, unknown>): void => {
    socket.removeAllListeners('data')
    socket.resume()
    socket.end(`${JSON.stringify(fields)}\n`)
    const linger = setTimeout(() => { socket.destroy() }, SUPERVISOR_REQUEST_DEADLINE_MS)
    linger.unref()
    socket.once('close', () => { clearTimeout(linger) })
  }

  const run = async (socket: Socket, line: string): Promise<void> => {
    let request: SupervisorRequest
    try {
      request = decodeRequest(line, check)
    } catch (error) {
      if (!(error instanceof SupervisorError)) {
        logger.error('request decoding failed', { err: error })
        socket.destroy()
        return
      }
      const refusal = error
      if (refusal.code === 'UNAUTHENTICATED') logger.warn('refused a request without the current start token')
      else logger.info('refused a request', { data: { outcome: refusal.code, detail: refusal.detail ?? '' } })
      answer(socket, { ...refusal.toFailure() })
      return
    }
    const workspaceId = workspaceOf(request)
    try {
      const result = await handle(request)
      logger.info('request', { data: { op: request.op, ...workspaceId === undefined ? {} : { workspaceId }, outcome: 'ok' } })
      answer(socket, { ok: true, ...result })
    } catch (error) {
      if (error instanceof SupervisorError) {
        logger.info('request', { data: { op: request.op, ...workspaceId === undefined ? {} : { workspaceId }, outcome: error.code, detail: error.detail ?? '' } })
        answer(socket, { ...error.toFailure() })
        return
      }
      // An unexpected failure leaves the operation's outcome unknown; the connection closes without a response line.
      logger.error('request failed', { err: error, data: { op: request.op, ...workspaceId === undefined ? {} : { workspaceId } } })
      socket.destroy()
    }
  }

  const server: Server = createServer({ allowHalfOpen: false }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('error', (error: NodeJS.ErrnoException) => { logger.debug('connection error', { data: { code: error.code ?? 'unknown' } }) })
    if (served >= SUPERVISOR_MAX_CONNECTIONS) {
      logger.warn('refused a connection: all connections are in use', { data: { outcome: 'BUSY' } })
      answer(socket, { ...new SupervisorError('BUSY').toFailure() })
      return
    }
    served += 1
    socket.once('close', () => { served -= 1 })
    let buffered = Buffer.alloc(0)
    let done = false
    const finish = (): void => {
      done = true
      clearTimeout(deadline)
      socket.removeAllListeners('data')
      socket.pause()
    }
    const deadline = setTimeout(() => {
      if (done) return
      finish()
      logger.info('refused a request', { data: { outcome: 'REQUEST_TIMEOUT' } })
      answer(socket, { ...new SupervisorError('REQUEST_TIMEOUT').toFailure() })
    }, SUPERVISOR_REQUEST_DEADLINE_MS)
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      const length = newline === -1 ? buffered.length : newline
      if (length > SUPERVISOR_REQUEST_MAX_BYTES) {
        finish()
        logger.info('refused a request', { data: { outcome: 'SCHEMA_VIOLATION', detail: 'request line too long' } })
        answer(socket, { ...new SupervisorError('SCHEMA_VIOLATION', `the request line exceeds ${String(SUPERVISOR_REQUEST_MAX_BYTES)} bytes`).toFailure() })
        return
      }
      if (newline === -1) return
      finish()
      void run(socket, buffered.subarray(0, newline).toString('utf8'))
    })
    socket.on('end', () => {
      if (done) return
      finish()
      answer(socket, { ...new SupervisorError('SCHEMA_VIOLATION', 'the connection ended before a request line').toFailure() })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(socketPath, PROTECTED_FILE_MODE)
  server.on('error', (error) => { logger.error('listener error', { err: error }) })

  return {
    socketPath,
    async close() {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      for (const socket of sockets) socket.destroy()
      await closed
      await removeStaleSocket(socketPath)
    },
  }
}
