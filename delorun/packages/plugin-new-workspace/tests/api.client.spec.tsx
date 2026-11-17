// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/client/api.ts'
import { ADD_WORKSPACE_PATH, PLACES_PATH, SEARCH_PATH } from '../src/wire.ts'
import { PLACES } from './fixtures.client.ts'

afterEach(() => { vi.restoreAllMocks() })

/** A client over a `fetch` that answers once with the given response. */
function clientAnswering(response: Response | Error) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })
  const unlockNeeded = vi.fn()
  return { api: createApi({ fetch, unlockNeeded }), fetch, unlockNeeded }
}

describe('a route that answers', () => {
  it('posts JSON to the route relative to the document and parses the answer', async () => {
    const { api, fetch } = clientAnswering(Response.json(PLACES))
    const result = await api.places()
    expect(result).toEqual({ ok: true, value: PLACES })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(PLACES_PATH.slice(1), {
      method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: '{}',
    })
    expect(PLACES_PATH.startsWith('/')).toBe(true)
  })

  it('sends a search with the cancellation signal', async () => {
    const { api, fetch } = clientAnswering(Response.json({ results: [{ path: '/home/person/src', name: 'src' }], stopped: 'limit' }))
    const controller = new AbortController()
    const result = await api.search('src', controller.signal)
    expect(result).toEqual({ ok: true, value: { results: [{ path: '/home/person/src', name: 'src' }], stopped: 'limit' } })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(SEARCH_PATH.slice(1), expect.objectContaining({ body: '{"query":"src"}', signal: controller.signal }))
  })

  it('takes a refusal the route answers with a status other than 200, since it is part of the answer', async () => {
    const { api } = clientAnswering(Response.json({ result: 'refused', problem: 'home-directory' }, { status: 422 }))
    expect(await api.add('/home/person')).toEqual({ ok: true, value: { result: 'refused', problem: 'home-directory' } })
  })
})

describe('a route that does not answer well', () => {
  it('fails an answer the schema does not take, and warns once with the route name only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = clientAnswering(Response.json({ home: 5 }))
    expect(await api.places()).toEqual({ ok: false, reason: 'failed' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('delorun new workspace: places failed (failed)')
  })

  it('fails a body that is not JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = clientAnswering(new Response('<html>', { status: 502 }))
    expect(await api.add('/x')).toEqual({ ok: false, reason: 'failed' })
  })

  it('fails when the page cannot ask, without throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = clientAnswering(new TypeError('network'))
    expect(await api.places()).toEqual({ ok: false, reason: 'failed' })
  })

  it('does not warn about a request the caller cancelled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
    const { api } = clientAnswering(new DOMException('aborted', 'AbortError'))
    expect(await api.preview('/x', controller.signal)).toEqual({ ok: false, reason: 'failed' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('a route that refuses the arrival', () => {
  it('reports ELEVATION_REQUIRED as locked and asks the studio for the unlock, naming the route', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, unlockNeeded } = clientAnswering(Response.json({ error: 'ELEVATION_REQUIRED' }, { status: 403 }))
    expect(await api.create({ parent: '/home/person/Projects', name: 'a', git: true })).toEqual({ ok: false, reason: 'locked' })
    expect(unlockNeeded).toHaveBeenCalledExactlyOnceWith('create')
  })

  it('reports LOOPBACK_REQUIRED as refused-arrival, without asking for an unlock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, unlockNeeded } = clientAnswering(Response.json({ error: 'LOOPBACK_REQUIRED' }, { status: 403 }))
    expect(await api.clone({ url: 'https://example.com/a.git', parent: '/home/person', name: 'a' })).toEqual({ ok: false, reason: 'refused-arrival' })
    expect(unlockNeeded).not.toHaveBeenCalled()
  })

  it('treats any other 403 as a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, unlockNeeded } = clientAnswering(new Response('no', { status: 403 }))
    expect(await api.cloneStatus('job-1')).toEqual({ ok: false, reason: 'failed' })
    expect(unlockNeeded).not.toHaveBeenCalled()
  })
})

describe('the defaults routes', () => {
  it('read and record a workspace\'s defaults', async () => {
    const answer = { result: 'defaults', defaults: { browser: 'none' } }
    const { api, fetch } = clientAnswering(Response.json(answer))
    expect(await api.setDefaults('/home/person/src/site', { browser: 'none' })).toEqual({ ok: true, value: answer })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ path: '/home/person/src/site', defaults: { browser: 'none' } })
    expect(ADD_WORKSPACE_PATH.endsWith('.add')).toBe(true)
  })
})
