/**
 * The whole plugin's routes: while the workspace registry is present each is one exact buffered POST route, refused
 * before its body is read to any request not on the loopback listener under a loopback Host (a reach device passes on to
 * its own check), answered `ELEVATION_REQUIRED` to a reach device without an unlock, and reached by the computer.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PICKER_HOLD_ID, REACH_DEVICE, type HomeAuthService } from '@delorun/home-auth'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import {
  ADD_WORKSPACE_PATH, apply, CLONE_PATH, CLONE_STATUS_PATH, Config, CREATE_PATH, DEFAULTS_PATH, inject, MAX_QUERY_LENGTH, name, PLACES_PATH, PREVIEW_PATH,
  SEARCH_PATH, SET_DEFAULTS_PATH,
} from '../src/index.ts'

let scratch = ''
let person = ''
let projects = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-routes-'))
  person = join(scratch, 'a', 'b', 'person')
  projects = join(person, 'projects')
  await mkdir(projects, { recursive: true })
  await mkdir(join(scratch, 'delorun'), { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', join(scratch, 'delorun'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

type Listener = NonNullable<ReturnType<HomeAuthService['arrivalOf']>['listener']>

interface Route {
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly admitPeer?: (request: Request, peer: object) => boolean
}

/** The `homeAuth` service as the routes read it: the listener that admitted a request and which devices hold an unlock. */
function homeAuthOn(listener: Listener | undefined) {
  const touchUnlock = vi.fn()
  const service = {
    arrivalOf: (request: { headers: { host?: string } }) => ({ listener, host: request.headers.host, source: 'test' }),
    faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'unlock-1' } : undefined),
    pageUnlockOf: () => undefined,
    touchUnlock,
  }
  return { service, touchUnlock }
}

/** The whole plugin over a stub Connection and, unless `null`, a registry and a `homeAuth` service. */
async function mount(options: { readonly registry?: boolean; readonly homeAuth?: { readonly service: object } | null } = {}) {
  const ctx = new Context()
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: {
      register: (route: Route & { readonly path: string }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  if (options.registry !== false) ctx.provide('workspaceRegistry', { create: async (path: string) => ({ id: 'workspace-5', path }), list: () => [] } as never)
  if (options.homeAuth !== null && options.homeAuth !== undefined) ctx.provide('homeAuth', options.homeAuth.service as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, routes }
}

/** A request as the Connection's `connection/request` waterfall receives it, and the response it is answered with. */
function arrival(url: string, host: string | undefined) {
  const request = new IncomingMessage(new Socket())
  request.url = url
  if (host !== undefined) request.headers.host = host
  const response = new ServerResponse(request)
  const writeHead = vi.spyOn(response, 'writeHead').mockReturnValue(response)
  const end = vi.spyOn(response, 'end').mockReturnValue(response)
  return { request, response, writeHead, end }
}

/** One route with a request body that the computer's call answers with `status`, and whether a call renews an unlock. */
interface Case {
  readonly path: string
  readonly body: () => unknown
  readonly status: number
  readonly renews: boolean
  /** The route is class `free`: any approved device answers it with no unlock. */
  readonly free?: true
}

const CASES: readonly Case[] = [
  { path: PLACES_PATH, body: () => ({}), status: 200, renews: false },
  { path: SEARCH_PATH, body: () => ({ query: 'zzz' }), status: 200, renews: false },
  { path: PREVIEW_PATH, body: () => ({ path: projects }), status: 200, renews: false },
  { path: ADD_WORKSPACE_PATH, body: () => ({ path: projects }), status: 200, renews: true },
  { path: CREATE_PATH, body: () => ({ parent: projects, name: 'fresh', git: false }), status: 200, renews: true },
  { path: CLONE_PATH, body: () => ({ url: 'file:///etc', parent: projects, name: 'x' }), status: 422, renews: true },
  { path: CLONE_STATUS_PATH, body: () => ({ job: 'none' }), status: 200, renews: false, free: true },
  { path: DEFAULTS_PATH, body: () => ({ path: projects }), status: 200, renews: false, free: true },
  { path: SET_DEFAULTS_PATH, body: () => ({ path: projects, defaults: {} }), status: 200, renews: true },
]

/** A POST to a route. */
const post = (path: string, body: unknown): Request => new Request(`http://harness.test${path}`, { method: 'POST', body: JSON.stringify(body) })

describe('the routes of the plugin', () => {
  it('names nine routes under /api/delorunNewWorkspace', () => {
    expect(CASES.map(each => each.path).sort()).toEqual([
      '/api/delorunNewWorkspace.add', '/api/delorunNewWorkspace.clone', '/api/delorunNewWorkspace.cloneStatus', '/api/delorunNewWorkspace.create',
      '/api/delorunNewWorkspace.defaults', '/api/delorunNewWorkspace.places', '/api/delorunNewWorkspace.preview', '/api/delorunNewWorkspace.search',
      '/api/delorunNewWorkspace.setDefaults',
    ])
  })

  it('registers each as one exact buffered POST route while the workspace registry is present', async () => {
    const { routes } = await mount()
    expect([...routes.keys()].sort()).toEqual(CASES.map(each => each.path).sort())
    for (const { path } of CASES) expect([path, routes.get(path)?.methods, routes.get(path)?.requestBody]).toEqual([path, ['POST'], 'buffered'])
  })

  it('registers none of them without the workspace registry', async () => {
    expect([...(await mount({ registry: false })).routes.keys()]).toEqual([])
  })

  it('provides the browser admission, and a "no browser" choice recorded through .setDefaults closes it for the next chat and reports the running one', async () => {
    const { ctx, routes } = await mount({ homeAuth: homeAuthOn('loopback') })
    const admission = ctx.get('browserUseAdmission')
    const reported = vi.fn(async (_session: unknown) => {})
    ctx.on('browser-use/admission-changed', reported)
    const chat = { session: { header: { cwd: projects } } } as Parameters<NonNullable<typeof admission>['admitted']>[0]
    expect(admission?.admitted(chat)).toBe(true)
    expect((await routes.get(SET_DEFAULTS_PATH)!.fetch(post(SET_DEFAULTS_PATH, { path: projects, defaults: { browser: 'none' } }))).status).toBe(200)
    expect(admission?.admitted(chat)).toBe(false)
    expect(reported.mock.calls).toEqual([[chat.session]])
  })
})

describe.each(CASES)('the route $path', ({ path, body, status, renews, free }) => {
  it('refuses a request under a foreign Host on the loopback listener, before the route', async () => {
    const { ctx } = await mount({ homeAuth: homeAuthOn('loopback') })
    const { request, response, writeHead, end } = arrival(path, 'studio.example')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
    expect(JSON.parse(end.mock.calls[0]?.[0] as string)).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
  })

  it('refuses every request while no homeAuth service is mounted, before the route', async () => {
    const { ctx } = await mount()
    const { request, response, writeHead, end } = arrival(path, 'localhost:3080')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
    expect(JSON.parse(end.mock.calls[0]?.[0] as string)).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
  })

  it('answers a reach device without an unlock 403 ELEVATION_REQUIRED, and an unlocked one the route\'s own answer', async () => {
    const home = homeAuthOn('reach-tailscale-private')
    const { ctx, routes } = await mount({ homeAuth: home })
    const { request, response, writeHead } = arrival(path, 'home.example.ts.net')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
    const route = routes.get(path)!
    const asDevice = async (deviceId: string) => {
      const call = post(path, body())
      expect(route.admitPeer?.(call, { principal: { kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' } })).toBe(true)
      return route.fetch(call)
    }
    const locked = await asDevice('locked-phone')
    // A free route answers a locked device; every other route is a `face` route and refuses it.
    if (free === true) expect(locked.status).toBe(status)
    else expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect(home.touchUnlock).not.toHaveBeenCalled()
    expect((await asDevice('unlocked-phone')).status).toBe(status)
    expect(home.touchUnlock.mock.calls).toEqual(renews ? [['unlock-1']] : [])
    expect(route.admitPeer?.(post(path, body()), { principal: { kind: 'sdk' } })).toBe(false)
  })

  it('is reached by the computer', async () => {
    const { ctx, routes } = await mount({ homeAuth: homeAuthOn('loopback') })
    const { request, response, writeHead } = arrival(path, 'localhost:3080')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
    const answer = await routes.get(path)!.fetch(post(path, body()))
    expect([answer.status, answer.headers.get('content-type'), answer.headers.get('cache-control')]).toEqual([status, 'application/json', 'no-store'])
  })

  it('refuses a spelling of the path that the Connection routes to it, under a foreign Host', async () => {
    const { ctx } = await mount({ homeAuth: homeAuthOn('loopback') })
    const { request, response, writeHead } = arrival(`/api/x/%2e%2e/${path.slice('/api/'.length)}?x=1`, 'studio.example')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
  })
})

describe('under Face ID', () => {
  const FACE_CASES = CASES.filter(each => each.free !== true)
  const FREE_CASES = CASES.filter(each => each.free === true)
  const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
  const grantCall = (path: string, text: string, grant?: string) => new Request(`http://harness.test${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body: text })

  /** A `homeAuth` whose grant store exists, for a device with a passkey that holds whatever unlock `home` gives. */
  function faceHome(face: FaceWorld['fields'], home: { elevation?: { id: string, grace?: true }, page?: boolean } = {}) {
    return { service: {
      arrivalOf: () => ({ listener: 'reach' }), touchUnlock: vi.fn(), ...face,
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
    } }
  }

  /** Run one request as the Connection does: admit the Peer, then answer it. */
  async function through(route: Route, request: Request, peer: object = device()): Promise<number | 'refused'> {
    if (route.admitPeer?.(request, peer) !== true) return 'refused'
    return (await route.fetch(request)).status
  }

  it('refuses a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, on every route that adds, creates, clones, sets defaults or reads the picker', async () => {
    // Pins `gateByClass`: without the grant check the unlock of today would admit the first two, and a grace-free legacy the rest.
    for (const home of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      const { routes } = await mount({ homeAuth: faceHome(faceWorld('d1', 'reach').fields, home) })
      for (const { path, body } of FACE_CASES) {
        const route = routes.get(path)!
        const request = post(path, body())
        expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {})), path).toBe(true)
        // The routes' own answers are 200 or 422, so a 403 ELEVATION_REQUIRED means the handler did not run.
        const refusal = await route.fetch(request)
        expect([refusal.status, await refusal.json()], `${path} ${JSON.stringify(home)}`).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      }
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one folder would add another.
    const world = faceWorld('d1', 'reach')
    const { routes } = await mount({ homeAuth: faceHome(world.fields) })
    const route = routes.get(ADD_WORKSPACE_PATH)!
    const exact = JSON.stringify({ path: projects })
    const grant = world.grantFor('plugin-new-workspace/add', { path: ADD_WORKSPACE_PATH, body: exact })
    expect(await through(route, grantCall(ADD_WORKSPACE_PATH, JSON.stringify({ path: person }), grant))).toBe(403)
    expect(await through(route, grantCall(ADD_WORKSPACE_PATH, exact, grant))).toBe(200)
    // Pins the single use: without `consume` the same grant would add again.
    expect(await through(route, grantCall(ADD_WORKSPACE_PATH, exact, grant))).toBe(403)
  })

  it('answers the clone status and the defaults to a device with no unlock and no grant', async () => {
    // Pins the `free` class of these two routes.
    const { routes } = await mount({ homeAuth: faceHome(faceWorld('d1', 'reach').fields) })
    for (const { path, body, status } of FREE_CASES) expect(await through(routes.get(path)!, post(path, body())), path).toBe(status)
  })

  it('lets one grant for the places call admit the picker\'s search and preview with no new grant, and no one else', async () => {
    // Pins the `hold` option: without it each picker read would ask for its own grant; without `opens` the places grant would open no hold.
    const world = faceWorld('d1', 'reach')
    const { routes } = await mount({ homeAuth: faceHome({ ...world.fields, deviceHasPasskey: () => true }) })
    const search = routes.get(SEARCH_PATH)!
    const searchBody = JSON.stringify({ query: 'zzz' })
    expect(await through(search, grantCall(SEARCH_PATH, searchBody))).toBe(403)
    const opened = world.grantFor('plugin-new-workspace/places', { path: PLACES_PATH, body: '{}' }, { feature: 'picker', id: PICKER_HOLD_ID })
    expect(await through(routes.get(PLACES_PATH)!, grantCall(PLACES_PATH, '{}', opened))).toBe(200)
    expect(await through(search, grantCall(SEARCH_PATH, searchBody))).toBe(200)
    expect(await through(routes.get(PREVIEW_PATH)!, grantCall(PREVIEW_PATH, JSON.stringify({ path: projects })))).toBe(200)
    // The hold belongs to the device that opened it.
    expect(await through(search, grantCall(SEARCH_PATH, searchBody), { principal: { kind: REACH_DEVICE, deviceId: 'd2', listener: 'reach' } })).toBe(403)
    // A route outside the picker is not admitted by the hold.
    expect(await through(routes.get(ADD_WORKSPACE_PATH)!, grantCall(ADD_WORKSPACE_PATH, JSON.stringify({ path: projects })))).toBe(403)
  })

  it('never asks the computer: a request that skips admitPeer reaches every route', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { routes } = await mount({ homeAuth: faceHome(faceWorld('d1', 'reach').fields) })
    for (const { path, body, status } of CASES) expect((await routes.get(path)!.fetch(post(path, body()))).status, path).toBe(status)
  })
})

describe('a request to another path', () => {
  it('is left alone by the guard under a foreign Host', async () => {
    const { ctx } = await mount({ homeAuth: homeAuthOn('loopback') })
    const { request, response, writeHead } = arrival('/api/other', 'studio.example')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
  })
})

describe('the folder search route\'s request', () => {
  const search = async (body: unknown) => {
    const { routes } = await mount()
    return (await routes.get(SEARCH_PATH)!.fetch(post(SEARCH_PATH, body))).status
  }

  it('takes a query of 1 to 100 characters', async () => {
    expect(await search({ query: 'a'.repeat(MAX_QUERY_LENGTH) })).toBe(200)
    expect(await search({ query: ' padded ' })).toBe(200)
  })

  it.each([
    ['a query over the longest query', { query: 'a'.repeat(MAX_QUERY_LENGTH + 1) }],
    ['no query', {}],
    ['an empty query', { query: '' }],
    ['a blank query', { query: '   ' }],
    ['another field', { query: 'a', depth: 99 }],
    ['not JSON', '{'],
  ])('answers 400 to %s', async (_, body) => {
    const { routes } = await mount()
    const request = new Request(`http://harness.test${SEARCH_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
    expect((await routes.get(SEARCH_PATH)!.fetch(request)).status).toBe(400)
  })
})
