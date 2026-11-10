/**
 * The listener both of C1's token channels use (contract C1, "Sockets and the start token"): the update channel
 * (C19) and the Docker supervisor's socket (C9). Each is a pathname Unix socket under `run/<profile>/`, at mode 0600,
 * where each connection carries one request line that must arrive within a deadline and stay within a size limit,
 * at most a fixed number of connections are served at once, and a request is authenticated by the current start's
 * token before its schema is read. The channel's own limits, codes and schema come from its contract through
 * {@link TokenSocketOptions}.
 *
 * The socket is bound under a temporary name in the run directory, set to mode 0600 and renamed into place, so it
 * appears whole at its mode and replaces an earlier start's socket in one step; any other file at the path is
 * refused. Closing removes the path only while it is still this listener's socket, by device and inode, so a
 * listener that stops after a newer one has started leaves the newer socket in place.
 *
 * @module @delo/home/token-socket
 */
import { randomBytes } from 'node:crypto'
import { chmod, lstat, readdir, rename, unlink } from 'node:fs/promises'
import { lstatSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { PROTECTED_FILE_MODE, SOCKET_PATH_MAX_BYTES } from '@delo/contract-home-layout'
import { HomeLayoutError } from './errors.ts'
import type { StartTokenCheck } from './start-token.ts'

/** Details of one channel log record; `@delo/logs`'s `DeloLogger` satisfies {@link ChannelLogger}. */
export interface ChannelLogDetails {
  /** An error. */
  readonly err?: unknown
  /** Structured details, never a request body or a token. */
  readonly data?: Readonly<Record<string, unknown>>
}

/** Where a channel writes its records. */
export interface ChannelLogger {
  /** Write an `error` record. */
  error(msg: string, details?: ChannelLogDetails): void
  /** Write a `warn` record. */
  warn(msg: string, details?: ChannelLogDetails): void
  /** Write an `info` record. */
  info(msg: string, details?: ChannelLogDetails): void
  /** Write a `debug` record. */
  debug(msg: string, details?: ChannelLogDetails): void
}

/** A channel's limits, from its contract. */
export interface ChannelLimits {
  /** The largest request line, in bytes, without its newline. */
  readonly requestMaxBytes: number
  /** Connections served at once; a further one is answered with the `BUSY` refusal. */
  readonly maxConnections: number
  /** The time from connect to the whole request line, in milliseconds. */
  readonly requestDeadlineMs: number
  /** The time from connect to the request's first byte, and from the final response to a caller's close, in milliseconds. */
  readonly firstByteMs: number
  /** The shortest time between two records of refused authentications, in milliseconds. */
  readonly refusalLogIntervalMs: number
}

/** A refusal the channel answers with one failed response line. */
export interface ChannelRefusal {
  /** The contract's error code, for the log. */
  readonly code: string
  /** The refused value or the reason, for the log; never a secret. */
  readonly detail?: string
  /** The failed response line's fields. */
  readonly line: object
}

/**
 * Refusals the listener itself raises: a request without the current token, a full channel, a request line that
 * is late or too long, and a connection that ended before its request line.
 */
export type ListenerRefusal = 'UNAUTHENTICATED' | 'BUSY' | 'REQUEST_TIMEOUT' | 'REQUEST_TOO_LARGE' | 'REQUEST_ENDED'

/** The options of {@link listenTokenSocket}. */
export interface TokenSocketOptions<R> {
  /** The socket path under `run/<profile>/`. */
  readonly socketPath: string
  /** The current start's token check. */
  readonly check: StartTokenCheck
  /** The channel's limits. */
  readonly limits: ChannelLimits
  /** The channel's logger. */
  readonly logger: ChannelLogger
  /**
   * Check an authenticated request against the channel's closed schema.
   * @param value - the parsed request line, which carries the current token.
   * @returns the request.
   * @throws a refusal {@link refusalOf} recognises, such as the contract's `SCHEMA_VIOLATION`.
   */
  readonly decode: (value: object) => R
  /**
   * Run one request. Progress lines written after the caller has gone are dropped, and the request runs on.
   * @param request - the decoded request.
   * @param progress - writes one progress response line with `ok: true` and these fields.
   * @returns the final response line's fields after `ok: true`.
   * @throws a refusal {@link refusalOf} recognises, answered as the final line; any other error closes the
   *   connection without a final line, because the operation's outcome is unknown.
   */
  readonly handle: (request: R, progress: (fields: Readonly<Record<string, unknown>>) => void) => Promise<Readonly<Record<string, unknown>>>
  /**
   * Recognise a refusal thrown by {@link decode} or {@link handle}.
   * @param error - the thrown value.
   * @returns the refusal, or `undefined` for an unexpected error.
   */
  readonly refusalOf: (error: unknown) => ChannelRefusal | undefined
  /**
   * The channel's answer to a refusal the listener raises.
   * @param kind - the listener's refusal.
   * @returns the refusal, with the contract's code and line.
   */
  readonly refuse: (kind: ListenerRefusal) => ChannelRefusal
  /**
   * The fields a request's log record names, such as its operation; never a token or a request body.
   * @param request - the decoded request.
   * @returns the fields.
   */
  readonly describe: (request: R) => Readonly<Record<string, unknown>>
  /**
   * Called once a successful request's final line has been written, or at once when its caller has gone, so a
   * request that ends the channel, such as a stop, closes it only after its caller has the answer.
   * @param request - the decoded request.
   */
  readonly answered?: (request: R) => void
}

/** A listening token channel. */
export interface TokenSocket {
  /** The socket path. */
  readonly socketPath: string
  /**
   * Stop accepting connections, end the open ones and remove the socket while it is still this listener's.
   * @returns when the listener has closed.
   */
  close(): Promise<void>
  /**
   * Remove the socket while it is still this listener's, synchronously, so a process `exit` listener can call it.
   * The server is not closed; the process is ending.
   */
  removeSocketSync(): void
}

/**
 * Check the socket path for a file left by an earlier start. A socket there is replaced when the new one is renamed
 * over it; any other file is refused, so a listener never replaces a file it did not create.
 * @param path - the socket path.
 * @throws {Error} naming the path when something other than a socket is there.
 */
async function refuseNonSocket(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSocket()) throw new Error(`${path} exists and is not a socket; remove it before starting again`)
}

/** The prefix of the temporary name a socket is bound under before it is renamed into place. */
const TEMPORARY_PREFIX = '.s-'

/**
 * Remove sockets left under a temporary name by a listener that stopped before renaming its socket into place.
 * Only sockets whose name is a temporary name are removed.
 * @param directory - the run directory.
 */
async function removeStaleTemporaries(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!/^\.s-[0-9a-f]{8}$/.test(name)) continue
    const path = join(directory, name)
    if ((await lstat(path)).isSocket()) await unlink(path)
  }
}

/** The refusals of requests without the current token, logged at most once per interval with a count. */
class RefusalLog {
  private suppressed = 0
  private last = Number.NEGATIVE_INFINITY

  private readonly logger: ChannelLogger
  private readonly intervalMs: number

  /**
   * @param logger - the channel's logger.
   * @param intervalMs - the shortest time between two records.
   */
  constructor(logger: ChannelLogger, intervalMs: number) {
    this.logger = logger
    this.intervalMs = intervalMs
  }

  /** Count one refusal and write a record when the interval has passed since the last one. */
  refused(): void {
    const now = Date.now()
    if (now - this.last < this.intervalMs) {
      this.suppressed += 1
      return
    }
    this.logger.warn('refused a request without the current start token', this.suppressed === 0 ? undefined : { data: { alsoRefusedSinceLastRecord: this.suppressed } })
    this.last = now
    this.suppressed = 0
  }
}

/**
 * Read a request line's `token` field without trusting anything else in it.
 * @param line - the request line, without its newline.
 * @returns the parsed object and its `token`, or `undefined` when the line is not a JSON object.
 */
function parseLine(line: string): { readonly value: object, readonly token: unknown } | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (_notJson) {
    // A line that is not JSON carries no token.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return { value, token: Object.hasOwn(value, 'token') ? (value as { readonly token: unknown }).token : undefined }
}

/**
 * Authenticate one request line by its `token` alone: a line that is not a JSON object, or whose `token` is not the
 * current start's, is refused before anything else in it is read.
 * @param line - the request line, without its newline.
 * @param check - the current start's token check.
 * @returns the parsed object, or `undefined` when the line is not authenticated.
 */
export function authenticateLine(line: string, check: StartTokenCheck): object | undefined {
  const parsed = parseLine(line)
  return parsed !== undefined && check.accepts(parsed.token) ? parsed.value : undefined
}

/**
 * Listen on a token channel's socket.
 * @param options - the path, token check, limits, logger, schema, handler and the channel's refusals.
 * @returns the listener.
 * @throws {HomeLayoutError} `SOCKET_PATH_TOO_LONG` when the path exceeds C1's limit.
 * @throws {Error} when a file other than a socket is at the path.
 */
export async function listenTokenSocket<R>(options: TokenSocketOptions<R>): Promise<TokenSocket> {
  const { socketPath, check, logger, limits } = options
  if (Buffer.byteLength(socketPath, 'utf8') > SOCKET_PATH_MAX_BYTES) {
    throw new HomeLayoutError('SOCKET_PATH_TOO_LONG', socketPath, `${socketPath} is longer than ${String(SOCKET_PATH_MAX_BYTES)} bytes; choose a shorter Delo home with DELO_HOME`)
  }
  await removeStaleTemporaries(dirname(socketPath))
  const refusals = new RefusalLog(logger, limits.refusalLogIntervalMs)
  const sockets = new Set<Socket>()
  let served = 0

  // The final line ends the connection's slot once it is flushed. A caller that has not closed its side by the
  // first-byte deadline afterwards is cut off.
  const answer = (socket: Socket, fields: object, after?: () => void): void => {
    if (socket.destroyed || !socket.writable) {
      socket.emit('released')
      after?.()
      return
    }
    socket.end(`${JSON.stringify(fields)}\n`, () => {
      socket.emit('released')
      after?.()
      const cutOff = setTimeout(() => { socket.destroy() }, limits.firstByteMs)
      cutOff.unref()
      socket.once('close', () => { clearTimeout(cutOff) })
    })
  }
  const refuse = (socket: Socket, refusal: ChannelRefusal): void => { answer(socket, refusal.line) }
  const progressOf = (socket: Socket) => (fields: Readonly<Record<string, unknown>>): void => {
    if (socket.destroyed || !socket.writable) return
    socket.write(`${JSON.stringify({ ok: true, ...fields })}\n`)
  }

  const run = async (socket: Socket, line: string): Promise<void> => {
    const value = authenticateLine(line, check)
    if (value === undefined) {
      refusals.refused()
      refuse(socket, options.refuse('UNAUTHENTICATED'))
      return
    }
    let request: R
    try {
      request = options.decode(value)
    } catch (error) {
      const refusal = options.refusalOf(error)
      if (refusal === undefined) {
        logger.error('request decoding failed', { err: error })
        socket.destroy()
        return
      }
      logger.info('refused a request', { data: { outcome: refusal.code, detail: refusal.detail ?? '' } })
      refuse(socket, refusal)
      return
    }
    const described = options.describe(request)
    try {
      const result = await options.handle(request, progressOf(socket))
      logger.info('request', { data: { ...described, outcome: 'ok' } })
      const answered = options.answered
      answer(socket, { ok: true, ...result }, answered === undefined ? undefined : () => { answered(request) })
    } catch (error) {
      const refusal = options.refusalOf(error)
      if (refusal !== undefined) {
        logger.info('request', { data: { ...described, outcome: refusal.code, detail: refusal.detail ?? '' } })
        refuse(socket, refusal)
        return
      }
      // An unexpected failure leaves the operation's outcome unknown; the connection closes without a final line.
      logger.error('request failed', { err: error, data: described })
      socket.destroy()
    }
  }

  // Half-open connections are kept, so a caller that closes its side after its request line still receives the
  // response, and a caller that has gone is seen at once.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('error', (error: NodeJS.ErrnoException) => { logger.debug('connection error', { data: { code: error.code ?? 'unknown' } }) })
    if (served >= limits.maxConnections) {
      logger.warn('refused a connection: all connections are in use', { data: { outcome: 'BUSY' } })
      refuse(socket, options.refuse('BUSY'))
      return
    }
    served += 1
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      served -= 1
    }
    socket.once('released', release)
    socket.once('close', release)
    let buffered = Buffer.alloc(0)
    let done = false
    // After the request line, further input is read and discarded, so the caller's close is seen and never resets
    // the connection before it has the response; a caller that has closed its side no longer holds a slot.
    const finish = (): void => {
      done = true
      clearTimeout(deadline)
      socket.removeAllListeners('data')
      socket.resume()
    }
    const timeOut = (): void => {
      if (done) return
      finish()
      const refusal = options.refuse('REQUEST_TIMEOUT')
      logger.info('refused a request', { data: { outcome: refusal.code } })
      refuse(socket, refusal)
    }
    // A caller that sends nothing is cut off at the first-byte deadline; one that has started has the whole deadline.
    const connectedAt = Date.now()
    let deadline = setTimeout(timeOut, limits.firstByteMs)
    let started = false
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      if (!started) {
        started = true
        clearTimeout(deadline)
        deadline = setTimeout(timeOut, limits.requestDeadlineMs - (Date.now() - connectedAt))
      }
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      const length = newline === -1 ? buffered.length : newline
      if (length > limits.requestMaxBytes) {
        finish()
        const refusal = options.refuse('REQUEST_TOO_LARGE')
        logger.info('refused a request', { data: { outcome: refusal.code, detail: 'request line too long' } })
        refuse(socket, refusal)
        return
      }
      if (newline === -1) return
      finish()
      void run(socket, buffered.subarray(0, newline).toString('utf8'))
    })
    socket.on('end', () => {
      if (done) {
        release()
        return
      }
      finish()
      refuse(socket, options.refuse('REQUEST_ENDED'))
    })
  })

  const temporary = join(dirname(socketPath), `${TEMPORARY_PREFIX}${randomBytes(4).toString('hex')}`)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(temporary, () => {
      server.off('error', reject)
      resolve()
    })
  })
  let bound: BigIntStats
  try {
    await chmod(temporary, PROTECTED_FILE_MODE)
    await refuseNonSocket(socketPath)
    await rename(temporary, socketPath)
    bound = await lstat(socketPath, { bigint: true })
  } catch (error) {
    // Nothing listens on a socket that never took its place, and its temporary name is removed.
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await unlink(temporary).catch((cleanupError: unknown) => {
      // ENOENT: the close or the rename already removed it; any other failure is reported with the start's own error.
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], `could not start the socket or remove ${temporary}`)
    })
    throw error
  }
  server.on('error', (error) => { logger.error('listener error', { err: error }) })

  const isOurs = (current: BigIntStats): boolean => current.dev === bound.dev && current.ino === bound.ino
  return {
    socketPath,
    async close() {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      for (const socket of sockets) socket.destroy()
      await closed
      let current
      try {
        current = await lstat(socketPath, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (isOurs(current)) await unlink(socketPath).catch((cleanupError: unknown) => {
        // ENOENT: the successor's adoption or a concurrent cleanup removed it between the lstat and the unlink; any
        // other failure keeps its own report.
        if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') return
        throw cleanupError
      })
    },
    removeSocketSync() {
      let current
      try {
        current = lstatSync(socketPath, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (isOurs(current)) {
        try {
          unlinkSync(socketPath)
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
        }
      }
    },
  }
}
