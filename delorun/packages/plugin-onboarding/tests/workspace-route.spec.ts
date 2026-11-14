/**
 * The route that adds the folder the person chose as a workspace: it refuses every folder Delorun never adds before the
 * registry is asked, so a refusal registers nothing, and it answers what the studio's folder choice shows.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { HomeAuthService } from '@delorun/home-auth'
import type { WorkspaceLocationProblem } from '@delorun/home'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import {
  ADD_WORKSPACE_PATH, AddWorkspaceAnswer, WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer, CLONE_PATH, CLONE_STATUS_PATH, apply, Config, inject, LOCATION_PROBLEMS, MAX_ADD_BODY_BYTES, MAX_PATH_LENGTH, name, type LocationProblem,
} from '../src/index.ts'

/** The scratch layout: the OS home three levels down with its stock home, and the Delorun home beside it. */
let scratch = ''
let person = ''
let delorunHome = ''
let stockHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-onboarding-route-'))
  person = join(scratch, 'a', 'b', 'person')
  delorunHome = join(scratch, 'delorun')
  stockHome = join(person, '.dsh')
  for (const directory of [join(person, 'projects'), stockHome, join(delorunHome, 'inside')]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** A registry that records the folders it is asked to add. */
function registryFake(quarantined: readonly string[] = []) {
  return { create: vi.fn(async (_path: string) => ({ id: 'workspace-7' })), quarantined }
}

/** The plugin over a stub Connection and, unless `null`, a registry, reached as the studio reaches the route. */
async function mount(registry: ReturnType<typeof registryFake> | null = registryFake(), homeAuth: Pick<HomeAuthService, 'arrivalOf'> | null = null) {
  const ctx = new Context()
  const routes = new Map<string, { readonly methods: readonly string[]; readonly requestBody: string; readonly fetch: (request: Request) => Promise<Response> }>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  if (registry !== null) ctx.provide('workspaceRegistry', registry as never)
  if (homeAuth !== null) ctx.provide('homeAuth', homeAuth as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const post = (body: string): Promise<Response> => {
    const route = routes.get(ADD_WORKSPACE_PATH)
    if (route === undefined) throw new Error('no route')
    return route.fetch(new Request('http://harness.test/api', { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
  }
  return { ctx, routes, registry: registry ?? registryFake(), warn, post, add: (path: string) => post(JSON.stringify({ path })) }
}

describe('the add-workspace route', () => {
  it('is one exact POST route, present only while the workspace registry is', async () => {
    const { routes } = await mount()
    expect(ADD_WORKSPACE_PATH).toBe('/api/delorunOnboarding.addWorkspace')
    const route = routes.get(ADD_WORKSPACE_PATH)
    expect([route?.methods, route?.requestBody]).toEqual([['POST'], 'buffered'])
    const without = await mount(null)
    expect(without.routes.has(ADD_WORKSPACE_PATH)).toBe(false)
  })

  it('mounts the clone routes beside it, present only while the workspace registry is', async () => {
    const { routes } = await mount()
    const ask = (path: string, body: unknown) => routes.get(path)?.fetch(new Request('http://harness.test/api', { method: 'POST', body: JSON.stringify(body) }))
    expect((await ask(CLONE_PATH, { url: 'file:///etc', parent: person, name: 'x' }))?.status).toBe(422)
    expect(await (await ask(CLONE_STATUS_PATH, { job: 'none' }))?.json()).toEqual({ state: 'unknown' })
    const without = await mount(null)
    expect([without.routes.has(CLONE_PATH), without.routes.has(CLONE_STATUS_PATH)]).toEqual([false, false])
  })

  it('adds a folder inside the home directory through the registry and answers its id', async () => {
    const { add, registry } = await mount()
    const response = await add(join(person, 'projects'))
    expect([response.status, response.headers.get('cache-control'), response.headers.get('content-type')]).toEqual([200, 'no-store', 'application/json'])
    expect(AddWorkspaceAnswer.parse(await response.json())).toEqual({ result: 'added', workspaceId: 'workspace-7', kind: 'empty' })
    expect(registry.create).toHaveBeenCalledExactlyOnceWith(join(person, 'projects'))
  })

  it.each<readonly [string, LocationProblem, () => string]>([
    ['the filesystem root', 'filesystem-root', () => '/'],
    ['the home directory itself', 'home-directory', () => person],
    ['the Delorun home', 'delorun-home', () => delorunHome],
    ['a folder inside the Delorun home', 'delorun-home', () => join(delorunHome, 'inside')],
    ['a folder that contains the Delorun home', 'contains-delorun-home', () => scratch],
    ['the stock home', 'stock-home', () => stockHome],
    ['a folder inside the stock home', 'stock-home', () => join(stockHome, 'inside')],
    ['a folder that contains the stock home', 'contains-stock-home', () => join(scratch, 'a', 'b')],
    ['a relative path', 'not-absolute', () => 'projects'],
  ])('refuses %s as %s and registers nothing', async (_, problem, path) => {
    const { add, registry } = await mount()
    const response = await add(path())
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ result: 'refused', problem })
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('refuses a link that leads to the home directory as the home directory, and registers nothing', async () => {
    const { add, registry } = await mount()
    const link = join(scratch, 'link')
    await symlink(person, link)
    expect(await (await add(link)).json()).toEqual({ result: 'refused', problem: 'home-directory' })
    expect(registry.create).not.toHaveBeenCalled()
  })

  it.each<readonly [string, () => string]>([
    ['a body that is not JSON', () => 'not json'],
    ['a body without a path', () => JSON.stringify({})],
    ['a body with another field', () => JSON.stringify({ path: '/x', title: 'X' })],
    ['an empty path', () => JSON.stringify({ path: '' })],
    ['a path over the longest path', () => JSON.stringify({ path: `/${'a'.repeat(MAX_PATH_LENGTH)}` })],
    ['a body over the largest body', () => JSON.stringify({ path: '/x', pad: ' '.repeat(MAX_ADD_BODY_BYTES) })],
  ])('answers 400 to %s and registers nothing', async (_, body) => {
    const { post, registry } = await mount()
    const response = await post(body())
    expect(response.status).toBe(400)
    expect(registry.create).not.toHaveBeenCalled()
  })

  it.each<readonly [string, unknown, string]>([
    ['with a system code', Object.assign(new Error(`ENOENT: no such file or directory, realpath '${'/secret/path'}'`), { code: 'ENOENT' }), 'ENOENT'],
    ['with a plain error', new Error('cannot create a workspace at \'/secret/path\': path is not a directory'), 'Error'],
    ['with something that is not an error', 'refused', 'unexpected failure'],
  ])('answers failed when the registry refuses the folder %s, and logs its code without the path', async (_, failure, code) => {
    const registry = registryFake()
    registry.create.mockRejectedValueOnce(failure)
    const { add, warn } = await mount(registry)
    const response = await add(join(person, 'projects'))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ result: 'failed' })
    expect(warn).toHaveBeenCalledExactlyOnceWith(`${name}: the folder could not be added as a workspace: ${code}`)
  })

  it('answers failed, and asks the registry nothing, when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    const { add, registry, warn } = await mount()
    const response = await add(join(person, 'projects'))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ result: 'failed' })
    expect(registry.create).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(`${name}: the Delorun home could not be resolved, so no folder is added: HOME_INVALID`)
  })

  it('names the same location codes as @delorun/home', () => {
    expectTypeOf<LocationProblem>().toEqualTypeOf<WorkspaceLocationProblem>()
    expect(new Set(LOCATION_PROBLEMS).size).toBe(LOCATION_PROBLEMS.length)
  })

  it('parses only the answers the route gives', () => {
    expect(() => AddWorkspaceAnswer.parse({ result: 'refused', problem: 'elsewhere' })).toThrow()
    expect(() => AddWorkspaceAnswer.parse({ result: 'added' })).toThrow()
    expect(() => AddWorkspaceAnswer.parse({ result: 'failed', reason: 'x' })).toThrow()
  })
})

describe('the add-workspace route on a remote session', () => {
  /** A listener id, as the `homeAuth` service names the one that admitted a request. */
type ListenerId = NonNullable<ReturnType<HomeAuthService['arrivalOf']>['listener']>

/** The `homeAuth` service's answer for a request: the listener it says admitted it, as the mounted service reads its stamp. */
  function homeAuthOn(listener: ListenerId | undefined): Pick<HomeAuthService, 'arrivalOf'> {
    return { arrivalOf: request => ({ listener, host: request.headers.host, source: 'test' }) }
  }

  /** A request as the Connection's `connection/request` waterfall receives it, and the response it is answered with. */
  function arrival(url: string | undefined, host: string | undefined) {
    const request = new IncomingMessage(new Socket())
    if (url !== undefined) request.url = url
    if (host !== undefined) request.headers.host = host
    const response = new ServerResponse(request)
    const writeHead = vi.spyOn(response, 'writeHead').mockReturnValue(response)
    const end = vi.spyOn(response, 'end').mockReturnValue(response)
    return { request, response, writeHead, end }
  }

  it.each([ADD_WORKSPACE_PATH, CLONE_PATH, CLONE_STATUS_PATH])('refuses a request to %s that a reach listener admitted with 403 LOOPBACK_ONLY, and goes no further', async (path) => {
    const { ctx } = await mount(registryFake(), homeAuthOn('reach-tailscale-private'))
    const { request, response, writeHead, end } = arrival(path, '127.0.0.1:3080')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect(next).not.toHaveBeenCalled()
    expect(writeHead).toHaveBeenCalledWith(403, expect.objectContaining({ 'content-type': 'application/json' }))
    expect(JSON.parse(end.mock.calls[0]?.[0] as string)).toMatchObject({ error: 'LOOPBACK_ONLY' })
  })

  it('refuses every spelling of the path that the Connection routes to it', async () => {
    const tail = ADD_WORKSPACE_PATH.slice('/api/'.length)
    for (const url of [`/api/x/../${tail}`, `/api/x/%2e%2e/${tail}`, `/api\\x\\..\\${tail}`]) {
      const { ctx } = await mount(registryFake(), homeAuthOn('reach-tailscale-private'))
      const { request, response, writeHead } = arrival(url, '127.0.0.1:3080')
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, response, next)
      expect({ url, calls: next.mock.calls.length, status: writeHead.mock.calls[0]?.[0] }).toEqual({ url, calls: 0, status: 403 })
    }
  })

  it('refuses a request under a Host that is no loopback address, and one the service cannot place', async () => {
    for (const [homeAuth, host] of [[homeAuthOn('loopback'), 'studio.example'], [homeAuthOn('loopback'), undefined], [homeAuthOn(undefined), '127.0.0.1:3080']] as const) {
      const { ctx } = await mount(registryFake(), homeAuth)
      const { request, response, writeHead } = arrival(`${ADD_WORKSPACE_PATH}?x=1`, host)
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, response, next)
      expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
    }
  })

  it('refuses every request while no homeAuth service is mounted', async () => {
    const { ctx } = await mount()
    const { request, response, writeHead } = arrival(ADD_WORKSPACE_PATH, 'localhost:3080')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
  })

  it('lets the loopback listener through, and leaves every other path and a request without a path alone', async () => {
    for (const [url, host, listener] of [[ADD_WORKSPACE_PATH, 'localhost:3080', 'loopback'], ['/api/other', 'studio.example', 'reach-tailscale-private'], [undefined, 'studio.example', 'reach-tailscale-private']] as const) {
      const { ctx } = await mount(registryFake(), homeAuthOn(listener))
      const { request, response, writeHead } = arrival(url, host)
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, response, next)
      expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
    }
  })
})

describe('the workspace notice route', () => {
  const get = async (registry: ReturnType<typeof registryFake>) => {
    const { routes } = await mount(registry)
    const route = routes.get(WORKSPACE_NOTICE_PATH)
    return { route, response: await route?.fetch(new Request('http://harness.test/api')) }
  }

  it('is one exact GET route, present only while the workspace registry is', async () => {
    expect(WORKSPACE_NOTICE_PATH).toBe('/api/delorunOnboarding.workspaceNotice')
    const { route } = await get(registryFake())
    expect([route?.methods, route?.requestBody]).toEqual([['GET'], 'buffered'])
    expect((await mount(null)).routes.has(WORKSPACE_NOTICE_PATH)).toBe(false)
  })

  it('exposes the quarantine by file name, not path, oldest first', async () => {
    const { response } = await get(registryFake(['/home/p/.delorun/workspaces.json.quarantined-1.json', '/home/p/.delorun/workspaces.json.quarantined-2.json']))
    expect([response?.status, response?.headers.get('cache-control')]).toEqual([200, 'no-store'])
    expect(WorkspaceNoticeAnswer.parse(await response?.json())).toEqual({ setAside: ['workspaces.json.quarantined-1.json', 'workspaces.json.quarantined-2.json'] })
  })

  it('answers an empty list when nothing was set aside', async () => {
    const { response } = await get(registryFake())
    expect(await response?.json()).toEqual({ setAside: [] })
  })
})
