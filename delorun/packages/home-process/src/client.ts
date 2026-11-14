/**
 * The update channel's client side (contract C19, "The update channel"), for `delorun` and specs: it reads the
 * token file when it sends a request, sends one request line and reads every response line until the home process
 * closes the connection. A `BUSY` answer is retried, because under Landlock a confined command can hold
 * connections up to the channel's limit.
 *
 * @module @delorun/home-process/client
 */
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { HOME_STATUS_TIMEOUT_MS, type HomeLockRecord } from '@delorun/contract-home-layout'
import { UPDATE_PROTOCOL_VERSION, type HomeStatus, type UpdateChannelRequest } from '@delorun/contract-home-process'
import { readStartTokenFile, startTokenFile, type HolderProbe } from '@delorun/home'
import { updateSocketPath } from './channel.ts'

/** One response line as the client reads it; callers ignore fields they do not know. */
export type ResponseLine = Readonly<Record<string, unknown>> & { readonly ok: boolean }

/** A request without its token, which {@link sendHomeRequest} attaches from the token file. */
export type UnsignedRequest = UpdateChannelRequest extends infer R ? R extends unknown ? Omit<R, 'token' | 'v'> : never : never

/** The options of {@link exchangeLines}. */
export interface ExchangeOptions {
  /** Receives each line as it arrives. */
  readonly onLine?: (line: ResponseLine) => void
  /** Gives up after this many milliseconds without the connection closing; no limit when omitted. */
  readonly timeoutMs?: number
}

/**
 * Send one request line and read the response lines until the connection closes.
 * @param socketPath - the update channel's socket.
 * @param line - the request line, without its newline; any text, so specs can send what the schema refuses.
 * @param options - a line listener and a deadline.
 * @returns every response line.
 * @throws the connection's error, such as `ENOENT` or `ECONNREFUSED` when no home process listens, or an `Error` on
 *   the deadline or a line that is not JSON.
 */
export function exchangeLines(socketPath: string, line: string, options: ExchangeOptions = {}): Promise<ResponseLine[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const lines: ResponseLine[] = []
    let buffered = ''
    let failed = false
    const fail = (error: Error): void => {
      if (failed) return
      failed = true
      socket.destroy()
      reject(error)
    }
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { fail(new Error(`the home process did not answer within ${String(options.timeoutMs)} ms`)) }, options.timeoutMs)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffered += chunk
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        const text = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let parsed: ResponseLine
        try {
          parsed = JSON.parse(text) as ResponseLine
        } catch (error) {
          fail(new Error('the home process sent a line that is not JSON', { cause: error }))
          return
        }
        lines.push(parsed)
        options.onLine?.(parsed)
      }
    })
    socket.on('error', fail)
    socket.on('close', () => {
      clearTimeout(timer)
      if (!failed) resolve(lines)
    })
    socket.write(`${line}\n`)
  })
}

/** How often, and how long apart, a `BUSY` answer is retried. */
const BUSY_RETRIES = 5
const BUSY_RETRY_MS = 200

/**
 * Send a request to a profile's home process with the token read from the token file, retrying a `BUSY` answer.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param request - the request without `v` and `token`.
 * @param options - a line listener and a deadline.
 * @returns every response line.
 * @throws the token file's or the connection's error when no home process runs.
 */
export async function sendHomeRequest(home: string, profile: string, request: UnsignedRequest, options: ExchangeOptions = {}): Promise<ResponseLine[]> {
  for (let attempt = 0; ; attempt += 1) {
    const token = await readStartTokenFile(startTokenFile(home, profile))
    const lines = await exchangeLines(updateSocketPath(home, profile), JSON.stringify({ v: UPDATE_PROTOCOL_VERSION, token, ...request }), options)
    if (lines.length !== 1 || lines[0]?.ok !== false || lines[0].error !== 'BUSY' || attempt >= BUSY_RETRIES) return lines
    await sleep(BUSY_RETRY_MS)
  }
}

/**
 * Ask a profile's home process for its status.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param timeoutMs - the deadline.
 * @returns the status, or the failed line when the home process refused the request.
 * @throws when no home process answers.
 */
export async function queryHomeStatus(home: string, profile: string, timeoutMs: number): Promise<HomeStatus | ResponseLine> {
  const [line] = await sendHomeRequest(home, profile, { op: 'status' }, { timeoutMs })
  if (line === undefined) throw new Error('the home process closed the connection without an answer')
  return line.ok && typeof line.status === 'object' && line.status !== null ? line.status as HomeStatus : line
}

/**
 * The holder probe C1's lock uses: a live holder answers when its update channel sends any response line to a
 * `status` request within 2 seconds.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the probe.
 */
export function updateChannelProbe(home: string, profile: string): HolderProbe {
  return async (_record: HomeLockRecord) => {
    try {
      await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
      return 'answered'
    } catch (_silent) {
      // No token file, no socket, a refused connection or no line in time: the holder did not answer.
      return 'silent'
    }
  }
}
