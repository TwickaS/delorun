/**
 * The Docker Engine API calls the supervisor makes, over the active context's Unix socket or named pipe. Requests
 * are JSON bodies the supervisor builds from contract C9, so no value reaches the engine through a command line or
 * a flag parser. Probe commands run as detached execs whose exit code alone is read.
 *
 * @module @delo/supervisor/docker/engine
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
  /**
   * @param status - the HTTP status, such as 404 for an absent object, or 0 when the engine did not answer.
   * @param reason - the engine's message.
   */
  constructor(readonly status: number, reason: string) {
    super(`docker engine: ${reason}`)
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
   * @param repository - the repository, such as `ghcr.io/delo-run/delo-workspace-s2`.
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

async function readBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new EngineError(response.statusCode ?? 0, 'the response is too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
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

/**
 * The engine at a socket or pipe.
 * @param socketPath - the endpoint's Unix socket path or Windows pipe name.
 * @returns its client.
 */
export function engineAt(socketPath: string): Engine {
  const send = async (method: string, path: string, body?: unknown): Promise<{ readonly status: number, readonly text: string }> => {
    const call = request({ socketPath, method, path: `${API}${path}`, headers: body === undefined ? {} : { 'content-type': 'application/json' } })
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      call.once('response', resolve)
      call.once('error', (error: NodeJS.ErrnoException) => { reject(new EngineError(0, `${socketPath} does not answer (${error.code ?? error.message})`)) })
      call.end(body === undefined ? undefined : JSON.stringify(body))
    })
    return { status: response.statusCode ?? 0, text: await readBody(response) }
  }
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> => {
    const { status, text } = await send(method, path, body)
    if (status >= 400) throw engineError(status, text)
    return text.length === 0 ? null : JSON.parse(text) as unknown
  }
  return {
    call,
    async pull(repository, digest) {
      const { status, text } = await send('POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`)
      if (status >= 400) throw engineError(status, text)
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const progress = JSON.parse(line) as { readonly error?: unknown, readonly errorDetail?: { readonly message?: unknown } }
        if (progress.error !== undefined) throw new EngineError(status, typeof progress.errorDetail?.message === 'string' ? progress.errorDetail.message : String(progress.error))
      }
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
