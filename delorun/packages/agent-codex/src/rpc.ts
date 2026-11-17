/**
 * A small JSON-RPC client for one Codex app-server process: newline-delimited frames on the process's stdio, typed
 * requests whose results are validated against {@link RESULTS}, and validated notifications and server requests
 * handed to one owner. A frame that fails validation is reported as a {@link CodexWireError}, never passed on.
 * @module @delorun/agent-codex/rpc
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  NOTIFICATIONS, RESULTS, SERVER_REQUESTS, type ClientMethod, type ClientResult, type CodexNotification,
  type CodexServerRequest, type WireJson,
} from './protocol.ts'

/** A JSON-RPC request id. */
export type RequestId = string | number

/** Codex answered a request with a JSON-RPC error. */
export class CodexRpcError extends Error {
  /** The request's method. */
  readonly method: string
  /** The JSON-RPC error code, when Codex sent a number. */
  readonly code: number | undefined

  /**
   * @param method - the request's method.
   * @param code - the error code.
   * @param message - Codex's error message, for the person's diagnostics only.
   */
  constructor(method: string, code: number | undefined, message: string) {
    super(`${method}: ${message}`)
    this.name = 'CodexRpcError'
    this.method = method
    this.code = code
  }
}

/** Codex sent a frame the driver cannot read: invalid JSON-RPC, or a known method with fields of the wrong type. */
export class CodexWireError extends Error {
  /**
   * @param message - what was wrong, naming the method; never the frame's content.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CodexWireError'
  }
}

/** The app-server's output ended, or the client was closed, before a request was answered. */
export class CodexClosedError extends Error {
  /** @param method - the request left without an answer. */
  constructor(method: string) {
    super(`${method}: the Codex app-server closed before answering`)
    this.name = 'CodexClosedError'
  }
}

/**
 * Sees every frame, for live diagnostics only. `>` is sent, `<` received, `!` a line of the program's stderr.
 * Frames are passed as parsed; a tap that writes them anywhere redacts them first.
 */
export type WireTap = (direction: '>' | '<' | '!', frame: unknown) => void

/** The owner of one connection's incoming traffic. */
export interface CodexRpcHandlers {
  /** A validated notification the driver reads. */
  notification(notification: CodexNotification): void
  /**
   * A validated server request; the resolved value is sent as the result, a rejection as a JSON-RPC error.
   * @param id - the request's id, which `serverRequest/resolved` names when Codex withdraws it.
   */
  request(request: CodexServerRequest, id: RequestId): Promise<WireJson>
  /** A frame that failed validation. */
  violation(error: CodexWireError): void
}

interface Pending {
  readonly method: ClientMethod
  resolve(value: unknown): void
  reject(error: Error): void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number'
}

function hasKey<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key)
}

/** One JSON-RPC connection over a Codex app-server's stdio. */
export class CodexRpc {
  private nextId = 1
  private readonly pending = new Map<RequestId, Pending>()
  private handlers: CodexRpcHandlers | undefined
  private failure: Error | undefined
  private readonly endedPromise: Promise<void>
  private readonly output: Writable
  private readonly tap: WireTap | undefined

  /**
   * @param input - the app-server's stdout.
   * @param output - the app-server's stdin.
   * @param tap - sees every frame, for live diagnostics.
   */
  constructor(input: Readable, output: Writable, tap?: WireTap) {
    this.output = output
    this.tap = tap
    const ended = Promise.withResolvers<void>()
    this.endedPromise = ended.promise
    const lines = createInterface({ input, crlfDelay: Infinity })
    lines.on('line', (line) => { this.receive(line) })
    lines.on('close', () => {
      this.fail(undefined)
      ended.resolve()
    })
    // A pipe error ends the connection as a close does; the process's own exit is reported by its handle.
    input.on('error', () => { this.fail(undefined) })
    output.on('error', () => { this.fail(undefined) })
  }

  /** Resolves when the app-server's output has ended. */
  get ended(): Promise<void> {
    return this.endedPromise
  }

  /**
   * Hand incoming traffic to its owner. Frames that arrive before this call are refused as violations.
   * @param handlers - the owner.
   */
  start(handlers: CodexRpcHandlers): void {
    this.handlers = handlers
  }

  /**
   * Send a request and wait for its validated result.
   * @param method - a client method the driver uses.
   * @param params - its parameters.
   * @param signal - abandons the wait; Codex is not told.
   * @returns the validated result.
   */
  request<M extends ClientMethod>(method: M, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ClientResult<M>> {
    if (this.failure !== undefined) return Promise.reject(this.failure instanceof CodexClosedError ? new CodexClosedError(method) : this.failure)
    if (signal.aborted) return Promise.reject(signal.reason)
    const id = this.nextId++
    const done = Promise.withResolvers<ClientResult<M>>()
    const onAbort = (): void => {
      this.pending.delete(id)
      done.reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.pending.set(id, {
      method,
      resolve: (value) => {
        signal.removeEventListener('abort', onAbort)
        const parsed = RESULTS[method].safeParse(value)
        // The table pairs each method with its schema, so the parsed value is that method's result.
        if (parsed.success) done.resolve(parsed.data as ClientResult<M>)
        else done.reject(new CodexWireError(`${method}: Codex's result has fields Delorun cannot read`))
      },
      reject: (error) => {
        signal.removeEventListener('abort', onAbort)
        done.reject(error)
      },
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return done.promise
  }

  /**
   * Send a notification.
   * @param method - the method.
   */
  notify(method: 'initialized'): void {
    this.write({ jsonrpc: '2.0', method })
  }

  /** End the app-server's input, which asks it to exit, and refuse every request still waiting. */
  close(): void {
    this.fail(undefined)
    this.output.end()
  }

  private write(frame: Record<string, unknown>): void {
    this.tap?.('>', frame)
    if (this.output.writableEnded || this.output.destroyed) return
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private fail(error: Error | undefined): void {
    if (this.failure !== undefined) return
    this.failure = error ?? new CodexClosedError('request')
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error ?? new CodexClosedError(pending.method))
  }

  private violation(message: string): void {
    this.handlers?.violation(new CodexWireError(message))
  }

  private receive(line: string): void {
    if (line.trim() === '') return
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch (_notJson) {
      // Codex writes only JSON-RPC frames on stdout; anything else is reported without its content.
      this.violation('Codex wrote a line that is not JSON')
      return
    }
    this.tap?.('<', frame)
    if (!isObject(frame)) {
      this.violation('Codex wrote a frame that is not an object')
      return
    }
    const { id, method } = frame
    if (typeof method === 'string') {
      if (isRequestId(id)) this.serverRequest(id, method, frame.params)
      else this.notification(method, frame.params)
      return
    }
    if (!isRequestId(id)) {
      this.violation('Codex wrote a frame with neither a method nor an id')
      return
    }
    const pending = this.pending.get(id)
    // An answer to an abandoned request has no one waiting for it.
    if (pending === undefined) return
    this.pending.delete(id)
    const { error } = frame
    if (isObject(error)) {
      pending.reject(new CodexRpcError(pending.method, typeof error.code === 'number' ? error.code : undefined, typeof error.message === 'string' ? error.message : 'no message'))
      return
    }
    pending.resolve(frame.result)
  }

  private notification(method: string, params: unknown): void {
    if (!hasKey(NOTIFICATIONS, method)) return
    const parsed = NOTIFICATIONS[method].safeParse(params)
    if (!parsed.success) {
      this.violation(`${method}: Codex's notification has fields Delorun cannot read`)
      return
    }
    // The table pairs each method with its schema, so the parsed value matches the method.
    this.handlers?.notification({ method, params: parsed.data } as CodexNotification)
  }

  private serverRequest(id: RequestId, method: string, params: unknown): void {
    const refuse = (code: number, message: string): void => {
      this.write({ jsonrpc: '2.0', id, error: { code, message } })
    }
    if (!hasKey(SERVER_REQUESTS, method)) {
      // Codex treats a refused request as declined, so the session goes on.
      refuse(-32601, `Delorun does not answer ${method}`)
      return
    }
    const parsed = SERVER_REQUESTS[method].safeParse(params)
    const handlers = this.handlers
    if (!parsed.success || handlers === undefined) {
      refuse(-32602, `Delorun cannot read the ${method} request`)
      this.violation(`${method}: Codex's request has fields Delorun cannot read`)
      return
    }
    // The table pairs each method with its schema, so the parsed value matches the method.
    handlers.request({ method, params: parsed.data } as CodexServerRequest, id).then(
      (result) => { this.write({ jsonrpc: '2.0', id, result }) },
      (error: unknown) => { refuse(-32603, error instanceof Error ? error.message : 'Delorun could not answer') },
    )
  }
}
