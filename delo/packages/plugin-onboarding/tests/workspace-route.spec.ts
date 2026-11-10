/**
 * The route that adds the folder the person chose as a workspace: it refuses every folder Delo never adds before the
 * registry is asked, so a refusal registers nothing, and it answers what the studio's folder choice shows.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { REQUEST_LISTENER } from '@delo/home-auth'
import type { WorkspaceLocationProblem } from '@delo/home'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import {
  ADD_WORKSPACE_PATH, AddWorkspaceAnswer, apply, inject, LOCATION_PROBLEMS, MAX_ADD_BODY_BYTES, MAX_PATH_LENGTH, name, type LocationProblem,
} from '../src/index.ts'

/** The scratch layout: the OS home three levels down with its stock home, and the Delo home beside it. */
let scratch = ''
let person = ''
let deloHome = ''
let stockHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delo-onboarding-route-'))
  person = join(scratch, 'a', 'b', 'person')
  deloHome = join(scratch, 'delo')
  stockHome = join(person, '.dsh')
  for (const directory of [join(person, 'projects'), stockHome, join(deloHome, 'inside')]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELO_HOME', deloHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** A registry that records the folders it is asked to add. */
function registryFake() {
  return { create: vi.fn(async (_path: string) => ({ id: 'workspace-7' })) }
}

/** The plugin over a stub Connection and, unless `null`, a registry, reached as the studio reaches the route. */
async function mount(registry: ReturnType<typeof registryFake> | null = registryFake()) {
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
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], apply })
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
    expect(ADD_WORKSPACE_PATH).toBe('/api/deloOnboarding.addWorkspace')
    const route = routes.get(ADD_WORKSPACE_PATH)
    expect([route?.methods, route?.requestBody]).toEqual([['POST'], 'buffered'])
    const without = await mount(null)
    expect(without.routes.has(ADD_WORKSPACE_PATH)).toBe(false)
  })

  it('adds a folder inside the home directory through the registry and answers its id', async () => {
    const { add, registry } = await mount()
    const response = await add(join(person, 'projects'))
    expect([response.status, response.headers.get('cache-control'), response.headers.get('content-type')]).toEqual([200, 'no-store', 'application/json'])
    expect(AddWorkspaceAnswer.parse(await response.json())).toEqual({ result: 'added', workspaceId: 'workspace-7' })
    expect(registry.create).toHaveBeenCalledExactlyOnceWith(join(person, 'projects'))
  })

  it.each<readonly [string, LocationProblem, () => string]>([
    ['the filesystem root', 'filesystem-root', () => '/'],
    ['the home directory itself', 'home-directory', () => person],
    ['the Delo home', 'delo-home', () => deloHome],
    ['a folder inside the Delo home', 'delo-home', () => join(deloHome, 'inside')],
    ['a folder that contains the Delo home', 'contains-delo-home', () => scratch],
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

  it('answers failed, and asks the registry nothing, when the Delo home cannot be resolved', async () => {
    vi.stubEnv('DELO_HOME', 'relative/home')
    const { add, registry, warn } = await mount()
    const response = await add(join(person, 'projects'))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ result: 'failed' })
    expect(registry.create).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(`${name}: the Delo home could not be resolved, so no folder is added: HOME_INVALID`)
  })

  it('names the same location codes as @delo/home', () => {
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
  /** A request as the Connection's `connection/request` waterfall receives it, and the response it is answered with. */
  function arrival(url: string | undefined, host: string | undefined, listener?: string) {
    const request = { url, headers: { host }, socket: {}, ...(listener === undefined ? {} : { [REQUEST_LISTENER]: listener }) } as unknown as IncomingMessage
    const response = { writeHead: vi.fn(), end: vi.fn() }
    return { request, response, served: response as unknown as ServerResponse }
  }

  it('refuses a request that a reach listener forwarded with 403 LOOPBACK_ONLY, and goes no further', async () => {
    const { ctx } = await mount()
    const { request, response, served } = arrival(ADD_WORKSPACE_PATH, '127.0.0.1:3080', 'tailnet')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, served, next)
    expect(next).not.toHaveBeenCalled()
    expect(response.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({ 'content-type': 'application/json' }))
    expect(JSON.parse(response.end.mock.calls[0]?.[0] as string)).toMatchObject({ error: 'LOOPBACK_ONLY' })
  })

  it('refuses a request under a Host that is no loopback address, also when no listener stamped it', async () => {
    const { ctx } = await mount()
    for (const host of ['studio.example', undefined]) {
      const { request, response, served } = arrival(`${ADD_WORKSPACE_PATH}?x=1`, host)
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, served, next)
      expect([next.mock.calls.length, response.writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
    }
  })

  it('lets the loopback listener through, and leaves every other path and a request without a path alone', async () => {
    const { ctx } = await mount()
    for (const [url, host, listener] of [[ADD_WORKSPACE_PATH, 'localhost:3080', undefined], ['/api/other', 'studio.example', 'tailnet'], [undefined, 'studio.example', 'tailnet']] as const) {
      const { request, response, served } = arrival(url, host, listener)
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, served, next)
      expect([next.mock.calls.length, response.writeHead.mock.calls.length]).toEqual([1, 0])
    }
  })
})
