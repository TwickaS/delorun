// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLONE_POLL_MS, createGuide, fits, folderOf, presentConnections, type Loadable } from '../src/client/guide.ts'
import { hostApi, readReach, REACH_STATUS_PATH } from '../src/client/host-api.ts'
import { CLONE_PATH, CLONE_STATUS_PATH, KEY_TEST_PATH, READINESS_PATH, RECOMMEND_PATH, type KeyTestAnswer, type Readiness, type RecommendAnswer } from '../src/wire.ts'
import { hostFake, KEYS, READY } from './fixtures.client.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const flush = async () => { for (let n = 0; n < 6; n++) await Promise.resolve() }
const ready = <T,>(value: T): Loadable<T> => ({ status: 'ready', value })

describe('the guide\'s shared state', () => {
  it('reads readiness and the key tests once when it is created, and the keys again when asked', async () => {
    const fake = hostFake()
    const guide = createGuide(fake.host)
    expect(guide.readiness.getSnapshot()).toEqual({ status: 'loading' })
    await flush()
    expect(guide.readiness.getSnapshot()).toEqual(ready(READY))
    expect(guide.keys.getSnapshot()).toEqual(ready(KEYS))
    expect(guide.recommendations.getSnapshot()).toBeUndefined()
    guide.testKeys()
    expect(guide.keys.getSnapshot()).toEqual({ status: 'loading' })
    expect(fake.keyTest).toHaveBeenCalledTimes(2)
    expect(CLONE_POLL_MS).toBe(1000)
  })

  it('marks a read the harness could not answer as failed', async () => {
    const guide = createGuide(hostFake({ readiness: undefined, keys: undefined, recommend: undefined }).host)
    guide.recommend(true)
    await flush()
    expect([guide.readiness.getSnapshot(), guide.keys.getSnapshot(), guide.recommendations.getSnapshot()]).toEqual([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }])
  })

  it('keeps the workspace mode and choice for a step shown again', () => {
    const guide = createGuide(hostFake().host)
    expect(guide.mode.getSnapshot()).toBe('default')
    guide.setMode('clone')
    expect(guide.mode.getSnapshot()).toBe('clone')
  })

  it('starts one clone at a time, and stops asking about it once disposed', async () => {
    vi.useFakeTimers()
    const fake = hostFake({ cloneStatus: [{ state: 'running', percent: 5 }] })
    const guide = createGuide(fake.host, 100)
    const request = { url: 'https://example.com/a.git', parent: '/home/person', name: 'a' }
    guide.startClone(request)
    guide.startClone(request)
    expect(guide.clone.getSnapshot()).toEqual({ state: 'starting' })
    await flush()
    guide.startClone(request)
    expect(fake.cloneStart).toHaveBeenCalledOnce()
    expect(guide.clone.getSnapshot()).toEqual({ state: 'running' })
    await vi.advanceTimersByTimeAsync(100)
    expect(guide.clone.getSnapshot()).toEqual({ state: 'running', percent: 5 })
    guide.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.cloneStatus).toHaveBeenCalledOnce()
  })

  it('drops an answer that arrives after it was disposed', async () => {
    vi.useFakeTimers()
    const fake = hostFake({ cloneStatus: [{ state: 'failed', failure: 'network' }] })
    const guide = createGuide(fake.host, 10)
    guide.startClone({ url: 'https://example.com/a.git', parent: '/p', name: 'a' })
    guide.dispose()
    await flush()
    expect(guide.clone.getSnapshot()).toEqual({ state: 'starting' })
    const next = createGuide(fake.host, 10)
    next.startClone({ url: 'https://example.com/a.git', parent: '/p', name: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(5)
    next.dispose()
    await vi.advanceTimersByTimeAsync(10)
    expect(next.clone.getSnapshot()).toEqual({ state: 'running' })
  })

  it('drops a status that arrives after it was disposed', async () => {
    vi.useFakeTimers()
    const fake = hostFake()
    let answer: (status: { readonly state: 'failed'; readonly failure: 'network' }) => void = () => {}
    fake.cloneStatus.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const guide = createGuide(fake.host, 10)
    guide.startClone({ url: 'https://example.com/a.git', parent: '/p', name: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.cloneStatus).toHaveBeenCalledOnce()
    guide.dispose()
    answer({ state: 'failed', failure: 'network' })
    await flush()
    expect(guide.clone.getSnapshot()).toEqual({ state: 'running' })
  })

  it.each<readonly [string, Parameters<typeof hostFake>[0], unknown]>([
    ['the harness could not be asked to start it', { cloneStart: { kind: 'failed' } }, { state: 'failed', failure: 'failed' }],
    ['the harness no longer knows it', { cloneStatus: [{ state: 'unknown' }] }, { state: 'failed', failure: 'failed' }],
    ['the running clone loses its connection', { cloneStatus: [{ state: 'running' }, { state: 'failed', failure: 'network' }] }, { state: 'failed', failure: 'network' }],
  ])('marks a clone failed when %s', async (_, change, expected) => {
    vi.useFakeTimers()
    const guide = createGuide(hostFake(change).host, 10)
    guide.startClone({ url: 'https://example.com/a.git', parent: '/p', name: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(30)
    expect(guide.clone.getSnapshot()).toEqual(expected)
  })
})

describe('the connections a person has', () => {
  const readiness = (change: Partial<Readiness>): Loadable<Readiness> => ready({ ...READY, ...change })
  const keys: Loadable<KeyTestAnswer> = ready({ providers: [{ provider: 'deepseek-official', name: 'DeepSeek', result: 'rejected' }] })

  it('are each listed provider, each agent signed in, and Tailscale once installed', () => {
    expect(presentConnections(keys, readiness({ agents: { 'claude-code': 'found', 'codex': 'missing' }, tailscale: { state: 'signed-out' } })))
      .toEqual(['provider:deepseek-official', 'agent:claude-code', 'tool:tailscale'])
  })

  it.each<readonly [string, Loadable<Readiness>]>([
    ['not installed', readiness({ tailscale: { state: 'not-installed' } })],
    ['unknown', readiness({ tailscale: { state: 'unknown' } })],
  ])('leave Tailscale out while it is %s', (_, given) => {
    expect(presentConnections({ status: 'loading' }, given)).toEqual(['agent:claude-code', 'agent:codex'])
  })

  it('are none while nothing could be read', () => {
    expect(presentConnections({ status: 'failed' }, { status: 'loading' })).toEqual([])
  })
})

describe('which recommended plugins show', () => {
  const answer: RecommendAnswer = { plugins: [
    { name: 'any', connections: [], source: 'installed' },
    { name: 'codex', connections: ['agent:codex'], source: 'installed' },
    { name: 'claude', connections: ['agent:claude-code'], source: 'registry' },
  ], registry: 'reached' }

  it('puts the plugins that fit first, keeps those for any setup, and leaves out those for a connection the person lacks', () => {
    expect(fits(['any', 'codex', 'claude', 'unread'], answer, ['agent:codex'])).toEqual([
      { name: 'codex', matches: ['agent:codex'] }, { name: 'any', matches: [] }, { name: 'unread', matches: [] },
    ])
  })

  it('shows every plugin in order before their connections are read', () => {
    expect(fits(['codex', 'any'], undefined, [])).toEqual([{ name: 'codex', matches: [] }, { name: 'any', matches: [] }])
  })

  it('reads what an added folder holds, and nothing for the default workspace', () => {
    expect(folderOf({ kind: 'added', workspaceId: 'w' as never, path: '/p', folder: 'empty' })).toBe('empty')
    expect(folderOf({ kind: 'default', workspaceId: 'w' as never, path: '/p' })).toBeUndefined()
    expect(folderOf(undefined)).toBeUndefined()
  })
})

describe('the guide\'s requests', () => {
  const stub = (answer: (path: string) => Response | Promise<Response>) => {
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => answer(path))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return fetch
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('asks each route relative to the page and parses its answer', async () => {
    const fetch = stub((path) => {
      if (path === READINESS_PATH.slice(1)) return json(READY)
      if (path === KEY_TEST_PATH.slice(1)) return json(KEYS)
      if (path === RECOMMEND_PATH.slice(1)) return json({ plugins: [], registry: 'reached' })
      if (path === CLONE_PATH.slice(1)) return json({ result: 'started', job: 'job-1' })
      return json({ state: 'running', percent: 3 })
    })
    expect(await hostApi.readiness()).toEqual(READY)
    expect(fetch).toHaveBeenLastCalledWith(READINESS_PATH.slice(1), { headers: { accept: 'application/json' } })
    expect(await hostApi.keyTest()).toEqual(KEYS)
    expect(fetch.mock.lastCall?.[1]).toMatchObject({ method: 'POST', body: '{}' })
    expect(await hostApi.recommend(true)).toEqual({ plugins: [], registry: 'reached' })
    expect(fetch.mock.lastCall?.[1]).toMatchObject({ body: '{"registry":true}' })
    expect(await hostApi.cloneStart({ url: 'u', parent: '/p', name: 'n' })).toEqual({ kind: 'started', job: 'job-1' })
    expect(await hostApi.cloneStatus('job-1')).toEqual({ state: 'running', percent: 3 })
    expect(fetch).toHaveBeenLastCalledWith(CLONE_STATUS_PATH.slice(1), expect.objectContaining({ body: '{"job":"job-1"}' }))
  })

  it('reads a clone refusal, which answers 422', async () => {
    stub(() => json({ result: 'refused', problem: 'not-empty' }, 422))
    expect(await hostApi.cloneStart({ url: 'u', parent: '/p', name: 'n' })).toEqual({ kind: 'refused', problem: 'not-empty' })
  })

  it.each<readonly [string, () => Response | Promise<Response>]>([
    ['a refusal', () => json({ error: 'LOOPBACK_ONLY' }, 403)],
    ['an answer of another form', () => json({ state: 'running', extra: 1 })],
    ['a transport failure', () => Promise.reject(new TypeError('network'))],
  ])('says it could not ask on %s, and never rejects', async (_, answer) => {
    stub(answer)
    expect(await hostApi.readiness()).toBeUndefined()
    expect(await hostApi.cloneStart({ url: 'u', parent: '/p', name: 'n' })).toEqual({ kind: 'failed' })
    expect(await hostApi.cloneStatus('job-1')).toEqual({ state: 'unknown' })
  })

  it.each<readonly [string, () => Response | Promise<Response>, string]>([
    ['an option is ready', () => json({ options: [{ state: 'off' }, { state: 'ready' }] }), 'set-up'],
    ['no option is ready', () => json({ options: [{ state: 'off' }] }), 'off'],
    ['the home has no reach', () => json({}, 404), 'absent'],
    ['the summary has no options', () => json({ options: 'none' }), 'absent'],
    ['the summary cannot be read', () => Promise.reject(new TypeError('network')), 'absent'],
  ])('reads reach as set up, off or absent: when %s', async (_, answer, expected) => {
    const fetch = stub(answer)
    expect(await readReach()).toBe(expected)
    expect(fetch.mock.calls[0]?.[0]).toBe(REACH_STATUS_PATH.slice(1))
    expect(hostApi.reach).toBe(readReach)
  })
})
