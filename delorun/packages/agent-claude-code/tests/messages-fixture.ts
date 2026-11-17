/**
 * A loopback Anthropic Messages server for the keyless real-program spec. Each main-loop request (one that offers
 * tools) takes the next step of a script; any other request, such as a title or helper call, gets a short text. Every
 * request is recorded. Adapted from upstream's `subagent-claude-code` test fixture.
 * @module @delorun/agent-claude-code/tests/messages-fixture
 */
import { createServer, type ServerResponse } from 'node:http'

/** One scripted answer. */
export type MessagesStep =
  | { readonly text: string }
  | { readonly tool: string; readonly input: Record<string, unknown> }
  /** Keep the request open until the client gives up. */
  | { readonly hold: true }

/** A running fixture. */
export interface MessagesFixture {
  /** The base URL to set as `ANTHROPIC_BASE_URL`. */
  readonly baseUrl: string
  /** The bodies of every main-loop request, in order. */
  readonly mainRequests: Record<string, unknown>[]
  /** Resolves at the next main-loop request. */
  nextRequest(): Promise<void>
  /** Stop the server. */
  close(): Promise<void>
}

function sse(response: ServerResponse, type: string, payload: Record<string, unknown>): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

let messageCount = 0

function answer(response: ServerResponse, model: string, step: { readonly text: string } | { readonly tool: string; readonly input: Record<string, unknown> }): void {
  messageCount += 1
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  sse(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_fixture_${messageCount}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  if ('text' in step) {
    sse(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
  } else {
    sse(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_${messageCount}`, name: step.tool, input: {} } })
    sse(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } })
  }
  sse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sse(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'text' in step ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
  sse(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

/**
 * Start the fixture on a loopback port the system picks.
 * @param script - the main-loop answers, in order; a request past the end gets the text `fixture script ended`.
 * @returns the fixture.
 */
export async function startMessagesFixture(script: readonly MessagesStep[]): Promise<MessagesFixture> {
  const steps = [...script]
  const mainRequests: Record<string, unknown>[] = []
  let waiters: (() => void)[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const path = request.url ?? ''
      if (path !== '/v1/messages' && !path.startsWith('/v1/messages?')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `unexpected path ${path}` } }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const model = typeof body.model === 'string' ? body.model : 'fixture-model'
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        answer(response, model, { text: 'fixture' })
        return
      }
      mainRequests.push(body)
      const ready = waiters
      waiters = []
      for (const resolve of ready) resolve()
      const step = steps.shift() ?? { text: 'fixture script ended' }
      if ('hold' in step) return
      answer(response, model, step)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the Messages fixture bound no TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mainRequests,
    nextRequest: () => new Promise((resolve) => { waiters.push(resolve) }),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
    },
  }
}
