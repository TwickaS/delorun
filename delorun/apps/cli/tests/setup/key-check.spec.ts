import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETUP_PROVIDER_IDS, type SetupProviderId } from '@delorun/contract-setup-answers'
import { CliError } from '../../src/exit.ts'
import { liveKeyCheck, type KeyTarget } from '../../src/setup/key-check.ts'
import { installedCatalog, SETUP_PROVIDERS } from '../../src/setup/providers.ts'

const KEY = 'sk-live-check-fixture-1'
const LISTING = JSON.stringify({ data: [{ id: 'deepseek-model' }] })
const DEEPSEEK: KeyTarget = { provider: SETUP_PROVIDERS['deepseek-official'], baseURL: undefined }

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Replace the global fetch.
 * @param answer - what a request answers with.
 * @returns the mock, to read the requests from.
 */
function stubFetch(answer: (url: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string | URL, init: RequestInit) => answer(String(url), init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('the live key check', () => {
  it('sends the key once, in the key header, to the DeepSeek API origin only, and refuses redirects', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(LISTING, { status: 200 })))
    expect(await liveKeyCheck({})(DEEPSEEK, KEY)).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).origin).toBe('https://api.deepseek.com')
    expect(url).toBe('https://api.deepseek.com/models')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY)
    expect(url).not.toContain(KEY)
    expect(JSON.stringify(Object.entries(init.headers as Record<string, string>).filter(([name]) => name !== 'x-api-key'))).not.toContain(KEY)
  })

  it('sends the key to the origin of DEEPSEEK_BASE_URL and to no other', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(LISTING, { status: 200 })))
    await liveKeyCheck({ DEEPSEEK_BASE_URL: 'https://gateway.example:8443/anthropic/v1' })(DEEPSEEK, KEY)
    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).origin)).toEqual(['https://gateway.example:8443'])
    await liveKeyCheck({ DEEPSEEK_BASE_URL: '' })(DEEPSEEK, KEY)
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).origin).toBe('https://api.deepseek.com')
  })

  it('reports a request the client refused, such as a redirect, without the key in the reason', async () => {
    stubFetch(() => Promise.reject(new TypeError('redirect mode is set to error')))
    const result = await liveKeyCheck({})(DEEPSEEK, KEY)
    expect(result).toEqual({ ok: false, reason: 'could not reach https://api.deepseek.com.' })
  })

  it('reports a refused key, a server error, a slow answer and an unreadable body without the key', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 401 })))
    expect(await liveKeyCheck({})(DEEPSEEK, KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not accept the key (HTTP 401).' })
    stubFetch(() => Promise.resolve(new Response('{}', { status: 403 })))
    expect(await liveKeyCheck({})(DEEPSEEK, KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not accept the key (HTTP 403).' })
    stubFetch(() => Promise.resolve(new Response('{}', { status: 503 })))
    expect(await liveKeyCheck({})(DEEPSEEK, KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com could not check the key (HTTP 503).' })
    stubFetch((_url, init) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) }))
    expect(await liveKeyCheck({}, 20)(DEEPSEEK, KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not answer within 0.02 seconds.' })
    stubFetch(() => Promise.resolve(new Response('not json', { status: 200 })))
    expect(await liveKeyCheck({})(DEEPSEEK, KEY)).toEqual({ ok: true })
  })

  it('fails loudly, without a request, when DEEPSEEK_BASE_URL is not a URL', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(LISTING)))
    const error = await liveKeyCheck({ DEEPSEEK_BASE_URL: 'not a url' })(DEEPSEEK, KEY).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toContain('DEEPSEEK_BASE_URL is not a URL')
    expect((error as Error).message).not.toContain(KEY)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/** What each provider's check sends: the URL of pi-ai's installed catalog endpoint, and the header that carries the key. */
const EXPECTED_CHECKS: readonly { readonly id: SetupProviderId, readonly url: string, readonly header: string, readonly value: string, readonly extra?: Readonly<Record<string, string>> }[] = [
  { id: 'anthropic', url: 'https://api.anthropic.com/v1/models?limit=1', header: 'x-api-key', value: KEY, extra: { 'anthropic-version': '2023-06-01' } },
  { id: 'google', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', header: 'x-goog-api-key', value: KEY },
  { id: 'groq', url: 'https://api.groq.com/openai/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'mistral', url: 'https://api.mistral.ai/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'moonshotai', url: 'https://api.moonshot.ai/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'openai', url: 'https://api.openai.com/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/key', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'together', url: 'https://api.together.ai/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
  { id: 'xai', url: 'https://api.x.ai/v1/models', header: 'authorization', value: `Bearer ${KEY}` },
]

describe('the live key check of the other providers', () => {
  it('covers every provider setup offers but DeepSeek and the custom endpoint', () => {
    expect(EXPECTED_CHECKS.map(check => check.id).sort()).toEqual(SETUP_PROVIDER_IDS.filter(id => SETUP_PROVIDERS[id].adapter === 'catalog'))
  })

  it.each(EXPECTED_CHECKS)('sends a $id key once, in its header, to the catalog endpoint\'s origin only, and refuses redirects', async ({ id, url, header, value, extra }) => {
    const catalog = await installedCatalog()
    const fetchMock = stubFetch(() => Promise.resolve(new Response('{"data":[]}', { status: 200 })))
    expect(await liveKeyCheck({})({ provider: SETUP_PROVIDERS[id], baseURL: catalog.baseURL(id) }, KEY)).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [sent, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(sent).toBe(url)
    expect(sent).not.toContain(KEY)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers[header]).toBe(value)
    for (const [name, expected] of Object.entries(extra ?? {})) expect(headers[name]).toBe(expected)
    expect(JSON.stringify(Object.entries(headers).filter(([name]) => name !== header))).not.toContain(KEY)
  })

  it('reports a refused key, an endpoint that cannot check it, a slow answer and an unreachable host, never with the key or the body', async () => {
    const target: KeyTarget = { provider: SETUP_PROVIDERS.anthropic, baseURL: 'https://api.anthropic.com' }
    stubFetch(() => Promise.resolve(new Response(`{"error":"${KEY}"}`, { status: 401 })))
    expect(await liveKeyCheck({})(target, KEY)).toEqual({ ok: false, reason: 'https://api.anthropic.com did not accept the key (HTTP 401).' })
    stubFetch(() => Promise.resolve(new Response('{}', { status: 404 })))
    expect(await liveKeyCheck({})(target, KEY)).toEqual({ ok: false, reason: 'https://api.anthropic.com could not check the key (HTTP 404).' })
    stubFetch((_url, init) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }) }))
    expect(await liveKeyCheck({}, 20)(target, KEY)).toEqual({ ok: false, reason: 'https://api.anthropic.com did not answer within 0.02 seconds.' })
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(await liveKeyCheck({})(target, KEY)).toEqual({ ok: false, reason: 'could not reach https://api.anthropic.com.' })
  })

  it('refuses, without a request, a custom endpoint whose base URL is not an http or https URL', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response('{}')))
    const custom = SETUP_PROVIDERS['openai-compatible']
    for (const baseURL of ['not a url', 'file:///etc', undefined]) {
      const error = await liveKeyCheck({})({ provider: custom, baseURL }, KEY).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(CliError)
      expect((error as Error).message).toContain('the base URL of OpenAI-compatible endpoint is not')
      expect((error as Error).message).not.toContain(KEY)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the live key check of an OpenAI-compatible endpoint', () => {
  let servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve) })))
    servers = []
  })

  /**
   * Start a loopback server standing in for an endpoint.
   * @param handler - how it answers.
   * @returns its origin.
   */
  async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  }

  it('lists the models at the base URL with the key as a bearer token', async () => {
    const seen: { url: string | undefined, authorization: string | undefined }[] = []
    const origin = await endpoint((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      response.writeHead(request.headers.authorization === `Bearer ${KEY}` ? 200 : 401).end('{"data":[]}')
    })
    const check = liveKeyCheck({})
    expect(await check({ provider: SETUP_PROVIDERS['openai-compatible'], baseURL: `${origin}/v1/` }, KEY)).toEqual({ ok: true })
    expect(await check({ provider: SETUP_PROVIDERS['openai-compatible'], baseURL: `${origin}/v1` }, 'another-key')).toEqual({ ok: false, reason: `${origin} did not accept the key (HTTP 401).` })
    expect(seen).toEqual([{ url: '/v1/models', authorization: `Bearer ${KEY}` }, { url: '/v1/models', authorization: 'Bearer another-key' }])
  })

  it('settles on the status alone: an endpoint that sends its headers and then holds the body does not keep the check waiting', async () => {
    const origin = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      // The body starts and never ends, as from a server that streams or stalls.
      response.write('{"data":[')
    })
    const started = Date.now()
    expect(await liveKeyCheck({}, 5_000)({ provider: SETUP_PROVIDERS['openai-compatible'], baseURL: `${origin}/v1` }, KEY)).toEqual({ ok: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('live key check sends the key to the provider origin only: a redirect to another origin fails, and that origin receives nothing', async () => {
    const elsewhere: (string | undefined)[] = []
    const other = await endpoint((request, response) => {
      elsewhere.push(request.headers.authorization)
      response.writeHead(200).end('{"data":[]}')
    })
    const origin = await endpoint((_request, response) => { response.writeHead(302, { location: `${other}/v1/models` }).end() })
    const result = await liveKeyCheck({})({ provider: SETUP_PROVIDERS['openai-compatible'], baseURL: `${origin}/v1` }, KEY)
    expect(result).toEqual({ ok: false, reason: `could not reach ${origin}.` })
    expect(elsewhere).toEqual([])
  })
})
