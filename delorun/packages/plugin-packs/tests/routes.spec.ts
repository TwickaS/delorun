/** The packs routes: which Peers each admits (a locked phone cannot add, retry or remove) and what a body may hold. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { REACH_DEVICE } from '@delorun/home-auth'
import { registerPackRoutes } from '../src/routes.ts'
import { createPacksClient } from '../src/client.ts'
import { PACK_ELEVATED_ROUTES, PACK_ROUTES } from '../src/wire.ts'

interface Registered {
  readonly path: string
  readonly admitPeer: (request: Request, peer: { principal: { kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

function setup(home: { elevated?: boolean, page?: Record<string, boolean> } = {}) {
  const touched: string[] = []
  const routes = new Map<string, Registered>()
  const result = { ok: true as const, value: { supported: true, packs: [], queue: [] } }
  const hub = {
    snapshot: vi.fn(() => Promise.resolve(result.value)),
    enqueue: vi.fn(() => Promise.resolve(result)), cancel: vi.fn(() => Promise.resolve(result)), dismiss: vi.fn(() => Promise.resolve(result)),
    retry: vi.fn(() => Promise.resolve(result)), remove: vi.fn(() => Promise.resolve(result)),
  }
  const ctx = {
    effect: (register: () => unknown) => { register() },
    get: (name: string) => (name === 'homeAuth' ? {
      elevationOf: () => (home.elevated === true ? { id: 'e1' } : undefined),
      pageUnlockOf: (id: string) => (home.page?.[id] === true ? { id: 'p1' } : undefined),
      arrivalOf: () => ({ listener: 'reach' }), dangerousMode: () => false, pinEnabled: () => false, touchUnlock: (id: string) => { touched.push(id) },
    } : undefined),
    connection: { fetch: { register: (route: Registered) => { routes.set(route.path, route); return () => Promise.resolve() } } },
  } as unknown as Context
  registerPackRoutes(ctx, hub as never)
  return { routes, hub, touched }
}

const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
const post = (body: unknown, raw?: string) => new Request('http://x/api/delorunPacks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) })

/** Run one request through a route as the Connection does: admit the Peer, then answer it. */
async function through(route: Registered, peer: { principal: { kind: string } }, body: unknown = { name: 'a', names: ['a'] }): Promise<number | 'refused'> {
  const request = post(body)
  if (!route.admitPeer(request, peer)) return 'refused'
  return (await route.fetch(request)).status
}

describe('who may reach each route', () => {
  it('lets a locked phone read, cancel and dismiss, and answers it 403 ELEVATION_REQUIRED on the routes that add, retry or remove, before the hub is asked', async () => {
    const { routes, hub } = setup()
    for (const path of Object.values(PACK_ROUTES)) {
      const response = await through(routes.get(path)!, device())
      expect(response, path).toBe(PACK_ELEVATED_ROUTES.includes(path) ? 403 : 200)
    }
    expect(hub.enqueue).not.toHaveBeenCalled()
    expect(hub.retry).not.toHaveBeenCalled()
    expect(hub.remove).not.toHaveBeenCalled()
    const request = post({ names: ['a'] })
    const route = routes.get(PACK_ROUTES.enqueue)!
    route.admitPeer(request, device())
    const refusal = await route.fetch(request)
    expect(await refusal.json()).toMatchObject({ error: 'ELEVATION_REQUIRED' })
  })

  it('answers an unlocked phone on every route, and a page only while its own unlock runs', async () => {
    const unlocked = setup({ elevated: true })
    for (const path of Object.values(PACK_ROUTES)) expect(await through(unlocked.routes.get(path)!, device()), path).toBe(200)
    expect(unlocked.hub.enqueue).toHaveBeenCalled()
    const paged = setup({ page: { live: true, ended: false } })
    for (const path of PACK_ELEVATED_ROUTES) {
      expect(await through(paged.routes.get(path)!, device({ unlockId: 'live' })), path).toBe(200)
      expect(await through(paged.routes.get(path)!, device({ unlockId: 'ended' })), path).toBe(403)
    }
  })

  it('renews the sliding unlock on a call that adds, retries or removes, and never on a read, a cancel or a dismiss', async () => {
    const { routes, touched } = setup({ elevated: true })
    for (const path of [PACK_ROUTES.list, PACK_ROUTES.cancel, PACK_ROUTES.dismiss]) await through(routes.get(path)!, device())
    expect(touched).toEqual([])
    for (const path of PACK_ELEVATED_ROUTES) await through(routes.get(path)!, device())
    expect(touched).toEqual(['e1', 'e1', 'e1'])
  })

  it('refuses any Peer that is not a reach device, on every route', async () => {
    const { routes } = setup({ elevated: true })
    for (const path of Object.values(PACK_ROUTES)) expect(await through(routes.get(path)!, { principal: { kind: 'guest' } }), path).toBe('refused')
  })
})

describe('what a request may hold', () => {
  it('passes a name or names to the hub and answers its result', async () => {
    const { routes, hub } = setup()
    expect((await routes.get(PACK_ROUTES.cancel)!.fetch(post({ name: 'a' }))).status).toBe(200)
    expect(hub.cancel).toHaveBeenCalledWith('a')
    expect((await routes.get(PACK_ROUTES.enqueue)!.fetch(post({ names: ['a', 'b'] }))).status).toBe(200)
    expect(hub.enqueue).toHaveBeenCalledWith(['a', 'b'])
    expect((await routes.get(PACK_ROUTES.list)!.fetch(post({}))).status).toBe(200)
  })

  it('refuses a body that is not the small JSON object the route reads, before the hub is asked', async () => {
    const { routes, hub } = setup()
    const bad: Array<[string, Request]> = [
      ['not JSON', post(undefined, 'nope')],
      ['an array', post(['a'])],
      ['no name', post({})],
      ['an empty name', post({ name: '' })],
      ['a long name', post({ name: 'x'.repeat(215) })],
      ['a number name', post({ name: 3 })],
      ['too many bytes', post({ name: 'a', pad: 'x'.repeat(9000) })],
    ]
    for (const [label, request] of bad) expect((await routes.get(PACK_ROUTES.cancel)!.fetch(request)).status, label).toBe(400)
    for (const names of [[], ['a', 1], Array.from({ length: 33 }, () => 'a'), 'a']) {
      expect((await routes.get(PACK_ROUTES.enqueue)!.fetch(post({ names }))).status, JSON.stringify(names).slice(0, 20)).toBe(400)
    }
    expect(hub.cancel).not.toHaveBeenCalled()
    expect(hub.enqueue).not.toHaveBeenCalled()
  })
})

describe('the studio client and the Host agree on the routes', () => {
  it('asks only routes the Host registers, and every route it registers is one the client asks', async () => {
    const { routes } = setup()
    const asked: string[] = []
    const client = createPacksClient((input) => {
      asked.push(`/${input}`)
      return Promise.resolve(Response.json({ ok: true, value: { supported: true, packs: [], queue: [] } }))
    })
    await client.list()
    await client.enqueue({ names: ['a'] })
    await client.cancel({ name: 'a' })
    await client.dismiss({ name: 'a' })
    await client.retry({ name: 'a' })
    await client.remove({ name: 'a' })
    expect(asked.sort()).toEqual([...routes.keys()].sort())
  })

  it('turns a 403 on an unlock route into the unlock dialog\'s refusal, and any other refusal into a plain failure', async () => {
    const refusing = (status: number) => createPacksClient(() => Promise.resolve(new Response('forbidden', { status })))
    await expect(refusing(403).enqueue({ names: ['a'] })).rejects.toMatchObject({ status: 403, details: { reason: 'elevation-required: packs/enqueue' } })
    await expect(refusing(403).retry({ name: 'a' })).rejects.toMatchObject({ details: { reason: 'elevation-required: packs/retry' } })
    await expect(refusing(403).cancel({ name: 'a' })).rejects.toMatchObject({ status: 403, details: undefined })
    await expect(refusing(500).list()).rejects.toMatchObject({ status: 500 })
    await expect(createPacksClient(() => Promise.reject(new Error('offline'))).list()).rejects.toMatchObject({ status: 0 })
  })
})
