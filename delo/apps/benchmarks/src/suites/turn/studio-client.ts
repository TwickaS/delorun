/**
 * A client of the studio's Web API that does what the studio's page does for one chat, without a browser: it opens the
 * start link for the auth cookie, calls `session/create` and `session/prompt` as unary RPCs (`POST /api/<endpoint>`
 * with a `client-request` envelope), and follows the chat on the Gateway's `/api/remote.mux` WebSocket with
 * `session/follow` (`activate: true, assistantStream: true`), as the studio's transport opens it. Every follow frame is
 * timed when it arrives, so a {@link TurnRecorder} reads what the person sees: the first text of the answer, each tool
 * call and result, and the turn's end.
 *
 * @module @delo/benchmarks/suites/turn/studio-client
 */
import { randomUUID } from 'node:crypto'

/** How long the opening snapshot of a followed chat may take. */
const FOLLOW_TIMEOUT_MS = 60_000

/** A JSON object. */
type JsonRecord = Readonly<Record<string, unknown>>

/**
 * Whether a value is a JSON object.
 * @param value - the value.
 * @returns whether it is a non-array object.
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The browser auth cookie among a response's `set-cookie` values, as the `cookie` header sends it back.
 * @param setCookies - the response's `set-cookie` values.
 * @returns `dsh-auth-…=<value>`.
 * @throws {Error} when no value sets a `dsh-auth-` cookie.
 */
export function authCookie(setCookies: readonly string[]): string {
  const pair = setCookies.map(value => value.split(';', 1)[0]!.trim()).find(value => value.startsWith('dsh-auth-'))
  if (pair === undefined) throw new Error('the start link set no dsh-auth cookie')
  return pair
}

/**
 * The body of one unary RPC: the `client-request` envelope with the method's one `request` argument.
 * @param method - the endpoint, such as `session/create`.
 * @param request - the method's request.
 * @param rpcId - the call's id.
 * @returns the body.
 */
export function rpcBody(method: string, request: JsonRecord, rpcId: string): JsonRecord {
  return { type: 'client-request', rpcId, method, payload: { args: { request } } }
}

/**
 * The value of one unary RPC's response.
 * @param method - the endpoint, for the message.
 * @param rpcId - the call's id.
 * @param response - the parsed response body.
 * @returns the result's value.
 * @throws {Error} when the response is not the call's `server-response` or carries an error.
 */
export function rpcValue(method: string, rpcId: string, response: unknown): unknown {
  if (!isRecord(response) || response.type !== 'server-response' || response.rpcId !== rpcId || !isRecord(response.result)) throw new Error(`${method} answered no server-response for its call: ${JSON.stringify(response)}`)
  if (response.result.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(response.result.error)}`)
  return response.result.value
}

/**
 * The chat id of a `session/create` value.
 * @param value - the value.
 * @returns its `sessionId`.
 * @throws {Error} when it has none.
 */
export function sessionIdOf(value: unknown): string {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') throw new Error(`session/create answered no session id: ${JSON.stringify(value)}`)
  return value.sessionId
}

/**
 * The uplink frame that opens one logical stream.
 * @param streamId - the stream's id.
 * @param endpoint - the stream endpoint.
 * @param request - the method's request.
 * @returns the frame's text.
 */
export function openFrame(streamId: string, endpoint: string, request: JsonRecord): string {
  return JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: { request } } })
}

/** One downlink frame of the mux. */
export type Downlink =
  | { readonly type: 'item', readonly streamId: string, readonly value: unknown }
  | { readonly type: 'end', readonly streamId: string }
  | { readonly type: 'error', readonly streamId: string, readonly error: unknown }

/**
 * Read one downlink frame.
 * @param text - the WebSocket message's text.
 * @returns the frame.
 * @throws {Error} when it is not an `item`, `end` or `error` frame of a stream.
 */
export function parseDownlink(text: string): Downlink {
  const frame: unknown = JSON.parse(text)
  if (isRecord(frame) && typeof frame.streamId === 'string') {
    if (frame.type === 'item') return { type: 'item', streamId: frame.streamId, value: frame.value }
    if (frame.type === 'end') return { type: 'end', streamId: frame.streamId }
    if (frame.type === 'error') return { type: 'error', streamId: frame.streamId, error: frame.error }
  }
  throw new Error(`the mux sent a frame that is not a stream frame: ${text.slice(0, 200)}`)
}

/** The times of one turn as the client saw them, in epoch milliseconds. */
export interface TurnTimes {
  /** The first `text-delta` chunk of the answer. */
  readonly firstText: number | undefined
  /** The `turn/end` event. */
  readonly end: number | undefined
  /** The `turn/end` reason's kind. */
  readonly endReason: string | undefined
  /** Each tool call's `tool/call` and `tool/result` arrival, in call order. */
  readonly tools: readonly { readonly callId: string, readonly call: number, readonly result: number | undefined, readonly isError: boolean }[]
}

/** Reads one turn's moments from the follow frames that arrive after its prompt was sent. */
export class TurnRecorder {
  private firstText: number | undefined
  private end: number | undefined
  private endReason: string | undefined
  private readonly tools: { callId: string, call: number, result: number | undefined, isError: boolean }[] = []
  private settle: ((error?: Error) => void) | undefined

  /** Resolves when the turn's `turn/end` arrives, and rejects when {@link TurnRecorder.fail} is called first. */
  readonly ended: Promise<void> = new Promise((resolve, reject) => {
    this.settle = error => (error === undefined ? resolve() : reject(error))
  })

  constructor() {
    // A turn that nobody awaits yet may fail; the rejection stays observable through `ended`.
    this.ended.catch(() => {})
  }

  /**
   * End the wait for the turn with an error: the follow stream failed or the WebSocket closed.
   * @param reason - what happened.
   */
  fail(reason: string): void {
    this.settle?.(new Error(reason))
  }

  /**
   * Take one follow frame.
   * @param frame - the frame, a `session/follow` item.
   * @param at - when it arrived.
   */
  take(frame: unknown, at: number): void {
    if (!isRecord(frame)) return
    if (frame.type === 'assistant-stream') {
      const stream = frame.frame
      if (this.firstText === undefined && isRecord(stream) && stream.type === 'chunk' && isRecord(stream.chunk) && stream.chunk.type === 'text-delta') this.firstText = at
      return
    }
    if (frame.type !== 'event' || !isRecord(frame.event) || !isRecord(frame.event.data)) return
    const { type } = frame.event
    const data = frame.event.data
    if (type === 'tool/call' && typeof data.callId === 'string') this.tools.push({ callId: data.callId, call: at, result: undefined, isError: false })
    else if (type === 'tool/result' && isRecord(data.message)) {
      const message = data.message
      const tool = this.tools.find(candidate => candidate.callId === message.toolCallId)
      if (tool !== undefined) {
        tool.result = at
        tool.isError = message.isError === true || data.error !== undefined
      }
    } else if (type === 'turn/end' && this.end === undefined) {
      this.end = at
      this.endReason = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : undefined
      this.settle?.()
    }
  }

  /**
   * What the recorder has seen.
   * @returns the turn's times.
   */
  times(): TurnTimes {
    return { firstText: this.firstText, end: this.end, endReason: this.endReason, tools: this.tools.map(tool => ({ ...tool })) }
  }
}

/**
 * Wait for a promise, but no longer than a deadline.
 * @param promise - the promise.
 * @param timeoutMs - the deadline.
 * @param what - what it waits for, for the message.
 * @returns its value.
 * @throws {Error} when the deadline passes first, or the promise's own error.
 */
export async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`${what} did not happen within ${String(timeoutMs / 1000)} seconds`)) }, timeoutMs) })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A signed-in client of one studio. */
export interface StudioClient {
  /**
   * Call one unary endpoint.
   * @param method - the endpoint.
   * @param request - its request.
   * @returns the result's value.
   */
  call(method: string, request: JsonRecord): Promise<unknown>
  /**
   * Follow a chat; each frame goes to the current recorder.
   * @param sessionId - the chat.
   * @returns when the opening snapshot arrived.
   */
  follow(sessionId: string): Promise<void>
  /**
   * Send a prompt to the followed chat and wait for its turn to end.
   * @param sessionId - the chat.
   * @param text - the prompt.
   * @param timeoutMs - the longest the turn may take.
   * @returns when the prompt left and what the client saw of the turn.
   */
  turn(sessionId: string, text: string, timeoutMs: number): Promise<{ readonly sentAt: number, readonly times: TurnTimes }>
  /** Close the WebSocket. */
  close(): void
}

/**
 * Sign in to a studio with its start link and open the mux.
 * @param link - the start link the Host printed.
 * @returns the client.
 */
export async function openStudio(link: string): Promise<StudioClient> {
  const origin = new URL(link).origin
  const opened = await fetch(link, { redirect: 'manual' })
  await opened.body?.cancel()
  const cookie = authCookie(opened.headers.getSetCookie())
  // Node's WebSocket takes a `headers` init that the DOM typing of this program's library does not declare.
  const socket: WebSocket = Reflect.construct(WebSocket, [`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { cookie } }])
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() }, { once: true })
    socket.addEventListener('error', () => { reject(new Error('the studio refused the mux WebSocket')) }, { once: true })
  })
  let recorder = new TurnRecorder()
  const ready = new Map<string, { readonly resolve: () => void, readonly reject: (error: Error) => void }>()
  const fail = (reason: string): void => {
    for (const waiting of ready.values()) waiting.reject(new Error(reason))
    ready.clear()
    recorder.fail(reason)
  }
  socket.addEventListener('message', (message: MessageEvent<string>) => {
    const at = Date.now()
    const frame = parseDownlink(message.data)
    if (frame.type === 'error') fail(`session/follow failed: ${JSON.stringify(frame.error)}`)
    else if (frame.type === 'end') fail('session/follow ended')
    else {
      if (isRecord(frame.value) && frame.value.type === 'snapshot') ready.get(frame.streamId)?.resolve()
      recorder.take(frame.value, at)
    }
  })
  socket.addEventListener('close', () => { fail('the studio closed the mux WebSocket') })
  const call = async (method: string, request: JsonRecord): Promise<unknown> => {
    const rpcId = randomUUID()
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(rpcBody(method, request, rpcId)) })
    if (!response.ok) throw new Error(`${method} answered HTTP ${String(response.status)}: ${await response.text()}`)
    return rpcValue(method, rpcId, await response.json())
  }
  return {
    call,
    async follow(sessionId) {
      const streamId = randomUUID()
      const opened = new Promise<void>((resolve, reject) => { ready.set(streamId, { resolve, reject }) })
      socket.send(openFrame(streamId, 'session/follow', { address: { kind: 'session', sessionId }, activate: true, assistantStream: true }))
      await within(opened, FOLLOW_TIMEOUT_MS, 'the chat\'s opening snapshot')
    },
    async turn(sessionId, text, timeoutMs) {
      recorder = new TurnRecorder()
      const current = recorder
      const sentAt = Date.now()
      await call('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
      await within(current.ended, timeoutMs, 'the turn\'s end')
      return { sentAt, times: current.times() }
    },
    close() {
      recorder = new TurnRecorder()
      socket.close()
    },
  }
}
