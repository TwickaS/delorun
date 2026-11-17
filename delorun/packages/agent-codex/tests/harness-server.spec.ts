import { request as httpRequest } from 'node:http'
import type { JsonValue, ProgramHarnessTool } from '@delorun/external-agents/contract'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startHarnessServer, type HarnessServer } from '../src/harness-server.ts'

const servers: HarnessServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const Entry = z.object({ url: z.string(), http_headers: z.object({ Authorization: z.string() }), tool_timeout_sec: z.number() })

function entry(server: HarnessServer): z.infer<typeof Entry> {
  return Entry.parse(server.mcpServers[server.name])
}

const echo: ProgramHarnessTool = {
  name: 'harness_echo',
  description: 'Echo the text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  call: (input: JsonValue) => Promise.resolve({ output: `echo: ${JSON.stringify(input)}`, isError: false }),
}

async function start(tools: readonly ProgramHarnessTool[] = [echo], toolTimeoutSeconds = 900, late: string[] = []): Promise<HarnessServer> {
  const server = await startHarnessServer({ tools, toolTimeoutSeconds, onLateResult: (tool) => { late.push(tool) } })
  servers.push(server)
  return server
}

/** POST one JSON-RPC request; `headers` replace the defaults, so a test can drop or change the token and Host. */
function post(url: string, body: JsonValue, headers: Readonly<Record<string, string | undefined>>): Promise<{ readonly status: number; readonly json?: JsonValue }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: target.host, ...headers }).filter((pair): pair is [string, string] => pair[1] !== undefined)),
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => {
        const data = text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).at(-1) ?? text
        resolve({ status: response.statusCode ?? 0, ...data.trim() === '' ? {} : { json: JSON.parse(data) as JsonValue } })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(body))
  })
}

const call = (name: string, args: JsonValue): JsonValue => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('the harness MCP server (D14)', () => {
  it('has a random per-thread name and is named only by its thread config entry', async () => {
    const first = await start()
    const second = await start()
    expect(first.name).toMatch(/^delorun_[0-9a-f]{12}$/)
    expect(second.name).not.toBe(first.name)
    expect(entry(first)).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), tool_timeout_sec: 900 })
    expect(entry(first).http_headers.Authorization).not.toBe(entry(second).http_headers.Authorization)
    expect([...first.toolNames]).toEqual(['harness_echo'])
  })

  it('runs an offered tool for a request with the thread\'s token', async () => {
    const server = await start()
    const { url, http_headers: headers } = entry(server)
    const reply = await post(url, call('harness_echo', { text: 'hi' }), { authorization: headers.Authorization })
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ result: { content: [{ type: 'text', text: 'echo: {"text":"hi"}' }] } })
  })

  it.each([
    ['no token', undefined],
    ['another token', 'Bearer not-the-token'],
    ['the token without its scheme', 'raw'],
  ])('refuses a call with %s', async (_name, authorization) => {
    const server = await start()
    const { url, http_headers: headers } = entry(server)
    const value = authorization === 'raw' ? headers.Authorization.slice('Bearer '.length) : authorization
    expect((await post(url, call('harness_echo', { text: 'hi' }), { authorization: value })).status).toBe(401)
  })

  it('refuses another thread\'s token', async () => {
    const mine = await start()
    const theirs = await start()
    expect((await post(entry(mine).url, call('harness_echo', { text: 'hi' }), { authorization: entry(theirs).http_headers.Authorization })).status).toBe(401)
  })

  it('refuses a request whose Host is not the loopback address it listens on', async () => {
    const server = await start()
    const { url, http_headers: headers } = entry(server)
    expect((await post(url, call('harness_echo', { text: 'hi' }), { authorization: headers.Authorization, host: 'attacker.example' })).status).toBe(401)
  })

  it('stops answering once closed, so the token is useless after the program exits', async () => {
    const server = await start()
    const { url, http_headers: headers } = entry(server)
    await server.close()
    await expect(post(url, call('harness_echo', { text: 'hi' }), { authorization: headers.Authorization })).rejects.toThrow()
  })

  it('aborts a call at the time limit Codex is given, and drops and reports its late result (L38)', async () => {
    const late: string[] = []
    let aborted = false
    const slow: ProgramHarnessTool = {
      ...echo,
      name: 'harness_slow',
      call: (_input, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve({ output: 'finished late', isError: false })
        }, { once: true })
      }),
    }
    const server = await start([slow], 1, late)
    const { url, http_headers: headers } = entry(server)
    const reply = await post(url, call('harness_slow', { text: 'wait' }), { authorization: headers.Authorization })
    expect(aborted).toBe(true)
    expect(late).toEqual(['harness_slow'])
    expect(JSON.stringify(reply.json)).not.toContain('finished late')
  })
})
