import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/exit.ts'
import { liveKeyCheck } from '../../src/setup/key-check.ts'

const KEY = 'sk-live-check-fixture-1'
const LISTING = JSON.stringify({ data: [{ id: 'deepseek-model' }] })

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
    expect(await liveKeyCheck({})(KEY)).toEqual({ ok: true })
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
    await liveKeyCheck({ DEEPSEEK_BASE_URL: 'https://gateway.example:8443/anthropic/v1' })(KEY)
    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).origin)).toEqual(['https://gateway.example:8443'])
    await liveKeyCheck({ DEEPSEEK_BASE_URL: '' })(KEY)
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).origin).toBe('https://api.deepseek.com')
  })

  it('reports a request the client refused, such as a redirect, without the key in the reason', async () => {
    stubFetch(() => Promise.reject(new TypeError('redirect mode is set to error')))
    const result = await liveKeyCheck({})(KEY)
    expect(result).toEqual({ ok: false, reason: 'could not reach https://api.deepseek.com.' })
  })

  it('reports a refused key, a server error, a slow answer and an unreadable body without the key', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 401 })))
    expect(await liveKeyCheck({})(KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not accept the key (HTTP 401).' })
    stubFetch(() => Promise.resolve(new Response('{}', { status: 403 })))
    expect(await liveKeyCheck({})(KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not accept the key (HTTP 403).' })
    stubFetch(() => Promise.resolve(new Response('{}', { status: 503 })))
    expect(await liveKeyCheck({})(KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com could not check the key (HTTP 503).' })
    stubFetch((_url, init) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) }))
    expect(await liveKeyCheck({}, 20)(KEY)).toEqual({ ok: false, reason: 'https://api.deepseek.com did not answer within 0.02 seconds.' })
    stubFetch(() => Promise.resolve(new Response('not json', { status: 200 })))
    expect(await liveKeyCheck({})(KEY)).toEqual({ ok: true })
  })

  it('fails loudly, without a request, when DEEPSEEK_BASE_URL is not a URL', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(LISTING)))
    const error = await liveKeyCheck({ DEEPSEEK_BASE_URL: 'not a url' })(KEY).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toContain('DEEPSEEK_BASE_URL is not a URL')
    expect((error as Error).message).not.toContain(KEY)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
