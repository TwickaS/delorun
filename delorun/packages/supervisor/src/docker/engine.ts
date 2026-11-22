/**
 * The Docker Engine API calls the supervisor makes, over the active context's Unix socket or named pipe. Requests
 * are JSON bodies the supervisor builds from contract C9, so no value reaches the engine through a command line or
 * a flag parser. Probe commands run as detached execs whose exit code alone is read.
 *
 * @module @delorun/supervisor/docker/engine
 */
import { request, type IncomingMessage } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

/** The Engine API version the supervisor speaks; Docker Engine 25 and later serve it. */
const API = '/v1.44'

/** The largest response body the supervisor reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** The interval between reads of a running exec's state. */
const EXEC_POLL_MS = 100

/** A call the engine refused or answered with an error. */
export class EngineError extends Error {
  /** The HTTP status, such as 404 for an absent object, or 0 when the engine did not answer. */
  readonly status: number

  /**
   * @param status - the HTTP status, such as 404 for an absent object, or 0 when the engine did not answer.
   * @param reason - the engine's message.
   */
  constructor(status: number, reason: string) {
    super(`docker engine: ${reason}`)
    this.status = status
    this.name = 'EngineError'
  }
}

/** The engine at one endpoint. */
export interface Engine {
  /**
   * Make one JSON call.
   * @param method - the HTTP method.
   * @param path - the path after the API version, with its query.
   * @param body - the JSON body, if any.
   * @returns the parsed response, or `null` for an empty one.
   * @throws {EngineError} with the engine's status and message, or status 0 when the endpoint does not answer.
   */
  call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown>
  /**
   * Pull one image by digest and wait for the pull to finish.
   * @param repository - the repository, such as `ghcr.io/twickas/delorun-workspace-s2`.
   * @param digest - the `sha256:` digest; never a tag.
   * @throws {EngineError} when the engine refuses the pull or reports an error in its progress stream.
   */
  pull(repository: string, digest: string): Promise<void>
  /**
   * Run a command in a running container as a detached exec and wait for its exit code.
   * @param container - the container's id or name.
   * @param cmd - the argv.
   * @param timeoutMs - how long to wait for it to exit.
   * @returns its exit code, or `undefined` when it did not exit in time.
   */
  execExitCode(container: string, cmd: readonly string[], timeoutMs: number): Promise<number | undefined>
}

function engineError(status: number, body: string): EngineError {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (_notJson) {
    // The engine answers some failures with plain text; that text is the message.
    parsed = undefined
  }
  const message = typeof parsed === 'object' && parsed !== null && 'message' in parsed ? parsed.message : undefined
  return new EngineError(status, typeof message === 'string' ? message : body.trim().slice(0, 500) || `status ${String(status)}`)
}

/** How long the supervisor waits on the engine. */
export interface EngineTimeouts {
  /** The longest one call may take, response body included, in milliseconds. */
  readonly callMs: number
  /** The longest one pull may take, in milliseconds. */
  readonly pullMs: number
}

/** The longest line of a pull's progress stream the supervisor reads; a progress record is a few hundred bytes. */
const MAX_PROGRESS_LINE_BYTES = 64 * 1024

/**
 * Open one request and wait for its response head, within a deadline that also bounds reading the body.
 * @param socketPath - the endpoint.
 * @param method - the HTTP method.
 * @param path - the path after the API version.
 * @param body - the JSON body, if any.
 * @param timeoutMs - the deadline for the whole call.
 * @returns the response, whose body the caller reads before the signal fires, and the deadline's signal.
 */
async function open(socketPath: string, method: string, path: string, body: unknown, timeoutMs: number): Promise<{ readonly response: IncomingMessage, readonly signal: AbortSignal }> {
  const signal = AbortSignal.timeout(timeoutMs)
  const call = request({ socketPath, method, path: `${API}${path}`, signal, headers: body === undefined ? {} : { 'content-type': 'application/json' } })
  return new Promise((resolve, reject) => {
    call.once('response', (response) => { resolve({ response, signal }) })
    call.once('error', (error: NodeJS.ErrnoException) => {
      reject(new EngineError(0, signal.aborted ? `${socketPath} did not answer within ${String(timeoutMs)} ms` : `${socketPath} does not answer (${error.code ?? error.message})`))
    })
    call.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

/**
 * Read a response's body, reporting a deadline that passes while it arrives as an engine that does not answer.
 * @param opened - the response and its deadline's signal.
 * @param each - receives each chunk; it may throw to stop reading.
 * @param timeoutMs - the call's deadline, for the message.
 */
async function consume(opened: { readonly response: IncomingMessage, readonly signal: AbortSignal }, each: (chunk: Buffer) => void, timeoutMs: number): Promise<void> {
  try {
    for await (const chunk of opened.response) each(chunk as Buffer)
  } catch (error) {
    if (!opened.signal.aborted) throw error
    throw new EngineError(0, `the engine's response did not finish within ${String(timeoutMs)} ms`)
  }
}

/**
 * The engine at a socket or pipe.
 * @param socketPath - the endpoint's Unix socket path or Windows pipe name.
 * @param timeouts - the deadlines of calls and pulls.
 * @returns its client.
 */
export function engineAt(socketPath: string, timeouts: EngineTimeouts): Engine {
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> => {
    const opened = await open(socketPath, method, path, body, timeouts.callMs)
    const status = opened.response.statusCode ?? 0
    const chunks: Buffer[] = []
    let size = 0
    await consume(opened, (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new EngineError(status, 'the response is too large')
      chunks.push(chunk)
    }, timeouts.callMs)
    const text = Buffer.concat(chunks).toString('utf8')
    if (status >= 400) throw engineError(status, text)
    if (text.length === 0) return null
    const value: unknown = JSON.parse(text)
    return value
  }
  return {
    call,
    async pull(repository, digest) {
      const opened = await open(socketPath, 'POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`, undefined, timeouts.pullMs)
      const status = opened.response.statusCode ?? 0
      let pending = Buffer.alloc(0)
      const line = (bytes: Buffer): void => {
        const text = bytes.toString('utf8').trim()
        if (text === '') return
        if (status >= 400) throw engineError(status, text)
        const progress = JSON.parse(text) as { readonly error?: unknown, readonly errorDetail?: { readonly message?: unknown } }
        if (progress.error !== undefined) throw new EngineError(status, typeof progress.errorDetail?.message === 'string' ? progress.errorDetail.message : String(progress.error))
      }
      await consume(opened, (chunk) => {
        pending = Buffer.concat([pending, chunk])
        for (let newline = pending.indexOf(0x0a); newline !== -1; newline = pending.indexOf(0x0a)) {
          line(pending.subarray(0, newline))
          pending = pending.subarray(newline + 1)
        }
        if (pending.length > MAX_PROGRESS_LINE_BYTES) throw new EngineError(status, 'a pull progress line is too large')
      }, timeouts.pullMs)
      line(pending)
      if (status >= 400) throw engineError(status, `status ${String(status)}`)
    },
    async execExitCode(container, cmd, timeoutMs) {
      const created = await call('POST', `/containers/${encodeURIComponent(container)}/exec`, { Cmd: cmd, AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false }) as { readonly Id: string }
      await call('POST', `/exec/${encodeURIComponent(created.Id)}/start`, { Detach: true, Tty: false })
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const state = await call('GET', `/exec/${encodeURIComponent(created.Id)}/json`) as { readonly Running: boolean, readonly ExitCode: number | null }
        if (!state.Running && state.ExitCode !== null) return state.ExitCode
        if (Date.now() >= deadline) return undefined
        await sleep(EXEC_POLL_MS)
      }
    },
  }
}

/**
 * Whether an engine error means the object does not exist.
 * @param error - a thrown value.
 * @returns true for an {@link EngineError} with status 404.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404
}
