/**
 * The turn suite's model: a loopback server that speaks the DeepSeek Messages wire the shipped DeepSeek adapter reads
 * (`POST <base>/v1/messages`, server-sent events ending in `message_stop`), and answers from a script instead of a
 * model. The installed Host reaches it through `DEEPSEEK_BASE_URL`, so the measured path keeps the shipped provider
 * adapter, its request assembly and its stream parsing, and changes no product file.
 *
 * A request that carries tool definitions belongs to the turn and takes the script's next reply; any other request,
 * such as the title of a new chat, is a side request and gets {@link SIDE_TEXT}. The server records when each request
 * arrived, when its first text delta and its last byte left, and the tool results it carried, so the suite reads the
 * Host's time between a tool call leaving the model and the next request arriving without asking the Host.
 *
 * @module @delo/benchmarks/suites/turn/model-stub
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The text of a side request's answer: a chat title. */
export const SIDE_TEXT = 'Benchmark chat'

/** One scripted reply of a turn request. */
export type ScriptedReply =
  | { readonly kind: 'tool', readonly id: string, readonly name: string, readonly input: string }
  | { readonly kind: 'text', readonly chunks: readonly string[] }

/** One Messages stream event. */
export interface MessageStreamEvent {
  readonly type: string
  readonly [field: string]: unknown
}

/** What the stub saw of one request and sent back. */
export interface StubExchange {
  /** Whether the request belonged to the turn. */
  readonly turn: boolean
  /** When the request's headers arrived, in epoch milliseconds. */
  readonly arrivedAt: number
  /** When the first text delta was written, for a text reply. */
  firstTextAt: number | undefined
  /** When the response ended. */
  endedAt: number | undefined
  /** The reply it took, for a turn request. */
  readonly reply: ScriptedReply | undefined
  /** The tool results the request carried, by tool call id. */
  readonly toolResults: readonly ToolResult[]
}

/** One tool result a request carried back to the model. */
export interface ToolResult {
  /** The tool call's id. */
  readonly id: string
  /** Whether the Host reported the call as failed or refused. */
  readonly isError: boolean
}

/** The tool a scripted turn calls. */
export interface ScriptedTool {
  /** The tool's name, as the model calls it. */
  readonly name: string
  /**
   * The arguments of one call.
   * @param call - the call's number, from 1.
   * @returns the arguments as JSON text.
   */
  input(call: number): string
}

/**
 * The replies of a turn with a number of tool calls: one tool call per reply, then a text answer.
 * @param toolCalls - how many tool calls.
 * @param tool - the tool and the arguments of each call.
 * @param answer - the answer's text chunks.
 * @param prefix - makes the tool call ids unique across the turns of one server.
 * @returns the replies, in order.
 */
export function turnScript(toolCalls: number, tool: ScriptedTool, answer: readonly string[], prefix: string): readonly ScriptedReply[] {
  const calls = Array.from({ length: toolCalls }, (_, index): ScriptedReply => ({ kind: 'tool', id: `toolu_${prefix}_${String(index + 1)}`, name: tool.name, input: tool.input(index + 1) }))
  return [...calls, { kind: 'text', chunks: answer }]
}

/**
 * The stream events of one reply, from `message_start` to `message_stop`.
 * @param reply - the reply.
 * @returns the events.
 */
export function replyEvents(reply: ScriptedReply): readonly MessageStreamEvent[] {
  const start: MessageStreamEvent = { type: 'message_start', message: { id: 'msg_benchmark', type: 'message', role: 'assistant', model: 'benchmark-stub', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }
  const end = (reason: string, tokens: number): readonly MessageStreamEvent[] => [
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: tokens } },
    { type: 'message_stop' },
  ]
  if (reply.kind === 'tool') {
    return [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: reply.id, name: reply.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: reply.input } },
      ...end('tool_use', 1),
    ]
  }
  return [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...reply.chunks.map((text): MessageStreamEvent => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    ...end('end_turn', reply.chunks.length),
  ]
}

/**
 * One event as server-sent-event text.
 * @param event - the event.
 * @returns its `event:` and `data:` lines and the blank line after them.
 */
export function sseFrame(event: MessageStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** A JSON object, as the request body's parts are read. */
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
 * Whether a Messages request belongs to the turn: the agent's requests carry its tools, a side request carries none.
 * @param body - the parsed request body.
 * @returns whether it has a non-empty `tools` list.
 */
export function isTurnRequest(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.tools) && body.tools.length > 0
}

/**
 * The tool results the last message of a Messages request carries.
 * @param body - the parsed request body.
 * @returns each `tool_result` block's call id and error flag.
 */
export function toolResultsOf(body: unknown): readonly ToolResult[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return []
  const last: unknown = body.messages.at(-1)
  if (!isRecord(last) || !Array.isArray(last.content)) return []
  return last.content.filter(isRecord).filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map(block => ({ id: block.tool_use_id as string, isError: block.is_error === true }))
}

/** A running stub. */
export interface ModelStub {
  /** The value for `DEEPSEEK_BASE_URL`: the origin, to which the adapter adds `/v1/messages`. */
  readonly baseURL: string
  /** Every request, in arrival order. */
  readonly exchanges: readonly StubExchange[]
  /**
   * Queue the replies of the next turn; turn requests take them in order.
   * @param replies - the replies.
   */
  script(replies: readonly ScriptedReply[]): void
  /** The turn requests that found no reply left: each was answered with an HTTP 500. */
  readonly unscripted: number
  /**
   * Stop the server and close open connections.
   * @returns when it stopped.
   */
  close(): Promise<void>
}

/**
 * Read a request's body as JSON.
 * @param request - the request.
 * @returns the parsed body, or `undefined` when it is empty or not JSON.
 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (_notJson) {
    // The stub answers a body it cannot read as a side request; the Host never sends one.
    return undefined
  }
}

/**
 * Start the stub on a loopback port the system assigns.
 * @returns the running stub.
 */
export async function startModelStub(): Promise<ModelStub> {
  const queue: ScriptedReply[] = []
  const exchanges: StubExchange[] = []
  let unscripted = 0
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const arrivedAt = Date.now()
    const path = request.url ?? ''
    if (request.method !== 'POST' || !path.endsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"type":"not_found_error","message":"the benchmark stub answers POST /v1/messages only"}}')
      return
    }
    const body = await readBody(request)
    const turn = isTurnRequest(body)
    const reply = turn ? queue.shift() : { kind: 'text', chunks: [SIDE_TEXT] } as const
    const exchange: StubExchange = { turn, arrivedAt, firstTextAt: undefined, endedAt: undefined, reply: turn ? reply : undefined, toolResults: toolResultsOf(body) }
    exchanges.push(exchange)
    if (reply === undefined) {
      unscripted++
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"type":"api_error","message":"the benchmark stub has no reply left for this turn"}}')
      exchange.endedAt = Date.now()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    for (const event of replyEvents(reply)) {
      if (event.type === 'content_block_delta' && exchange.firstTextAt === undefined && reply.kind === 'text') exchange.firstTextAt = Date.now()
      response.write(sseFrame(event))
    }
    response.end()
    exchange.endedAt = Date.now()
  }
  const server = createServer((request, response) => {
    answer(request, response).catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    exchanges,
    script(replies) { queue.push(...replies) },
    get unscripted() { return unscripted },
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    }),
  }
}
