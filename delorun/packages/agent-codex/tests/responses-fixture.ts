/**
 * A loopback Responses API stand-in for the real Codex program: each model request takes the next scripted step and
 * is answered as the server-sent events Codex 0.153.4 reads. Modelled on upstream's own Codex fixture
 * (`packages/subagent/subagent-codex/tests/responses-fixture.ts`), which Delorun specs may not import.
 * @module @delorun/agent-codex/tests/responses-fixture
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** One scripted model step. */
export type ResponsesStep =
  | { readonly kind: 'text'; readonly text: string }
  /** A call of the first named function Codex advertised, with the arguments given for that name. */
  | { readonly kind: 'call'; readonly choices: Readonly<Record<string, Readonly<Record<string, unknown>>>> }
  /** A call of the first advertised function whose name matches, such as an MCP tool under a random server name. */
  | { readonly kind: 'call-matching'; readonly pattern: RegExp; readonly args: Readonly<Record<string, unknown>> }
  /** Open the stream and never answer. */
  | { readonly kind: 'hold' }

/** A running fixture. */
export interface ResponsesFixture {
  readonly baseUrl: string
  /** Every model request body, in order. */
  readonly requests: Record<string, unknown>[]
  close(): Promise<void>
}

const USAGE = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 }

function response(output: readonly Record<string, unknown>[], status: string): Record<string, unknown> {
  return {
    id: 'resp_fixture', object: 'response', created_at: 1, status, error: null, incomplete_details: null, model: 'fixture-model',
    output, parallel_tool_calls: false, store: false, tool_choice: 'auto', tools: [], usage: USAGE, metadata: {},
  }
}

/** The event sequence for one finished output item. */
function itemEvents(item: Record<string, unknown>, deltas: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
    ...deltas,
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: response([item], 'completed') },
  ]
}

function textEvents(text: string): Record<string, unknown>[] {
  const part = { type: 'output_text', annotations: [], logprobs: [], text }
  const item = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [part] }
  const at = { item_id: 'msg_fixture', output_index: 0, content_index: 0 }
  return itemEvents(item, [
    { type: 'response.content_part.added', ...at, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', ...at, delta: text, logprobs: [] },
    { type: 'response.output_text.done', ...at, text, logprobs: [] },
    { type: 'response.content_part.done', ...at, part },
  ])
}

function callEvents(qualified: string, args: Readonly<Record<string, unknown>>, index: number): Record<string, unknown>[] {
  const argumentsText = JSON.stringify(args)
  const [namespace, name] = qualified.includes('/') ? qualified.split('/', 2) : [undefined, qualified]
  const item = {
    id: `fc_fixture_${index}`, type: 'function_call', status: 'completed', name, ...namespace === undefined ? {} : { namespace },
    arguments: argumentsText, call_id: `call_fixture_${index}`,
  }
  return itemEvents(item, [
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: argumentsText },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: argumentsText },
  ])
}

/** The function names a request advertises; a function inside a namespace, such as an MCP server's, as `namespace/name`. */
function advertised(body: Record<string, unknown>): string[] {
  const names = (tools: unknown, prefix: string): string[] => (Array.isArray(tools) ? tools : []).flatMap((tool: unknown) => {
    if (typeof tool !== 'object' || tool === null || !('name' in tool) || typeof tool.name !== 'string') return []
    if ('type' in tool && tool.type === 'namespace' && 'tools' in tool) return names(tool.tools, `${tool.name}/`)
    return [`${prefix}${tool.name}`]
  })
  return names(body.tools, '')
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { resolve(body) })
    request.on('error', reject)
  })
}

/**
 * Start the fixture on a loopback port the system picks.
 * @param script - one step per model request, in order.
 * @returns the running fixture.
 */
export async function startResponsesFixture(script: readonly ResponsesStep[]): Promise<ResponsesFixture> {
  const steps = [...script]
  const requests: Record<string, unknown>[] = []
  const open = new Set<ServerResponse>()
  let calls = 0
  const server = createServer((request, reply) => {
    open.add(reply)
    reply.on('close', () => { open.delete(reply) })
    void readBody(request).then((text) => {
      // Codex also asks for the model catalogue; only model requests carry a body and take a step.
      if (request.method !== 'POST' || text === '') {
        reply.writeHead(404).end()
        return
      }
      const body = JSON.parse(text) as Record<string, unknown>
      requests.push(body)
      const step = steps.shift()
      if (step === undefined) {
        reply.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture script exhausted' } }))
        return
      }
      reply.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'req_fixture' })
      if (step.kind === 'hold') return
      let events: Record<string, unknown>[]
      if (step.kind === 'text') {
        events = textEvents(step.text)
      } else {
        const name = step.kind === 'call'
          ? advertised(body).find(candidate => Object.hasOwn(step.choices, candidate))
          : advertised(body).find(candidate => step.pattern.test(candidate))
        if (name === undefined) {
          reply.end(`data: ${JSON.stringify({ type: 'error', message: `none of the scripted functions was advertised: ${advertised(body).join(', ')}` })}\n\n`)
          return
        }
        calls += 1
        events = callEvents(name, step.kind === 'call' ? step.choices[name] ?? {} : step.args, calls)
      }
      for (const event of events) reply.write(`data: ${JSON.stringify(event)}\n\n`)
      reply.end('data: [DONE]\n\n')
    }, (error: unknown) => { reply.destroy(error instanceof Error ? error : new Error('unreadable request')) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the Responses fixture has no TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => {
      for (const reply of open) reply.destroy()
      server.closeAllConnections()
      return new Promise((resolve) => { server.close(() => resolve()) })
    },
  }
}
