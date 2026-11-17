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
import type { HomeAuthService } from '@delorun/home-auth'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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
    elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'unlock-1' } : undefined),
    pageUnlockOf: () => undefined,
    touchUnlock,
  }
  return { service, touchUnlock }
}

/** The whole plugin over a stub Connection and, unless `null`, a registry and a `homeAuth` service. */
async function mount(options: { readonly registry?: boolean; readonly homeAuth?: ReturnType<typeof homeAuthOn> | null } = {}) {
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
}

const CASES: readonly Case[] = [
  { path: PLACES_PATH, body: () => ({}), status: 200, renews: false },
  { path: SEARCH_PATH, body: () => ({ query: 'zzz' }), status: 200, renews: false },
  { path: PREVIEW_PATH, body: () => ({ path: projects }), status: 200, renews: false },
  { path: ADD_WORKSPACE_PATH, body: () => ({ path: projects }), status: 200, renews: true },
  { path: CREATE_PATH, body: () => ({ parent: projects, name: 'fresh', git: false }), status: 200, renews: true },
  { path: CLONE_PATH, body: () => ({ url: 'file:///etc', parent: projects, name: 'x' }), status: 422, renews: true },
  { path: CLONE_STATUS_PATH, body: () => ({ job: 'none' }), status: 200, renews: false },
  { path: DEFAULTS_PATH, body: () => ({ path: projects }), status: 200, renews: false },
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

describe.each(CASES)('the route $path', ({ path, body, status, renews }) => {
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
    expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
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
