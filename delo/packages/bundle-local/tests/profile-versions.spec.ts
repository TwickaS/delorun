/**
 * The Setup versions routes: reading answers any signed-in studio, and saving or switching is refused before the body is
 * read unless the request arrived on the loopback listener, under a loopback `Host`, from the studio's own origin.
 */
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { PROFILE_VERSION_ROUTES } from '../src/client/versions-api.ts'
import { MAX_VERSIONS_REQUEST_BYTES, ProfileVersions, registerVersionRoutes, VersionsError } from '../src/profile-versions.ts'

const NO_CHANGES = {
  plugins: [], bundles: [], exemptions: [], builds: [], patchChanged: false, homePatchChanged: false, lockfileChanged: false, disabled: [], same: true,
}

/** A service whose calls are recorded and never touch a profile. */
function stubService(): { service: ProfileVersions, calls: string[] } {
  const calls: string[] = []
  const service = {
    list: vi.fn(async () => { calls.push('list'); return { versions: [], unsaved: false } }),
    changes: vi.fn(async (id: string) => { calls.push(`changes:${id}`); return NO_CHANGES }),
    save: vi.fn(async (name: string | undefined) => { calls.push(`save:${name ?? ''}`); return { id: 'a'.repeat(40), created: true } }),
    switch: vi.fn(async (id: string) => { calls.push(`switch:${id}`); return { changes: NO_CHANGES, restartNeeded: false } }),
  }
  return { service: service as unknown as ProfileVersions, calls }
}

interface FakeConnection {
  readonly hook: (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
}

/** Register the routes on a fake Connection whose `homeAuth` places every request on one listener. */
function routesOver(service: ProfileVersions, listener: string | undefined): FakeConnection {
  let hook: FakeConnection['hook'] | undefined
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  const ctx = {
    on: (_name: string, registered: FakeConnection['hook']) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }) } : undefined),
    connection: { fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route) } } },
  }
  registerVersionRoutes(ctx as never, service)
  return {
    hook: (request, response, next) => hook!(request, response, next),
    fetch: async (path, init) => routes.get(path.split('?')[0]!)!.fetch(new Request(`http://localhost${path}`, init)),
  }
}

/** Send a request through the hook and report whether it reached the route, and the refusal it was answered with. */
async function through(routes: FakeConnection, request: { url: string, headers: Record<string, string> }): Promise<{ reached: boolean, status?: number, body?: Record<string, unknown> }> {
  const answered: { status?: number, body?: string } = {}
  const response = { writeHead: (status: number) => { answered.status = status }, end: (body: string) => { answered.body = body } }
  let reached = false
  await routes.hook(request, response as never, async () => { reached = true })
  return { reached, ...answered.status === undefined ? {} : { status: answered.status }, ...answered.body === undefined ? {} : { body: JSON.parse(answered.body) as Record<string, unknown> } }
}

const WRITES = [PROFILE_VERSION_ROUTES.save, PROFILE_VERSION_ROUTES.switch]
const READS = [PROFILE_VERSION_ROUTES.list, PROFILE_VERSION_ROUTES.changes]
const STUDIO = { host: '127.0.0.1:4500', origin: 'http://127.0.0.1:4500', 'sec-fetch-site': 'same-origin' }

describe('the Setup versions routes', () => {
  it('refuse a reach session saving or switching with LOOPBACK_REQUIRED before any route runs', async () => {
    const routes = routesOver(stubService().service, 'reach-tailscale-private')
    for (const path of WRITES) {
      const outcome = await through(routes, { url: path, headers: { host: 'home.example.ts.net', origin: 'https://home.example.ts.net' } })
      expect(outcome).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    }
  })

  it('refuse a request the home cannot place on a listener', async () => {
    const routes = routesOver(stubService().service, undefined)
    for (const path of WRITES) expect(await through(routes, { url: path, headers: STUDIO })).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
  })

  it('refuse a loopback request whose Host is not a loopback name, as a DNS-rebinding page sends', async () => {
    const routes = routesOver(stubService().service, 'loopback')
    for (const path of WRITES) {
      const outcome = await through(routes, { url: path, headers: { host: 'attacker.example:4500', origin: 'http://attacker.example:4500' } })
      expect(outcome).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    }
  })

  it('refuse a loopback request from another origin, a foreign fetch site, or a sandboxed frame', async () => {
    const routes = routesOver(stubService().service, 'loopback')
    for (const path of WRITES) {
      for (const headers of [
        { ...STUDIO, origin: 'https://evil.example' },
        { ...STUDIO, origin: 'null' },
        { ...STUDIO, 'sec-fetch-site': 'cross-site' },
        { ...STUDIO, 'sec-fetch-site': 'same-site' },
      ]) {
        expect(await through(routes, { url: path, headers })).toMatchObject({ reached: false, status: 403, body: { error: 'FOREIGN_ORIGIN' } })
      }
    }
  })

  it('refuse a spelling of the target that reaches the route as the exact path does', async () => {
    const routes = routesOver(stubService().service, 'reach-tailscale-private')
    for (const url of ['/api/x/../deloVersions.switch', '/api/%2e%2e/api/deloVersions.save', '/api\\deloVersions.switch?x=1']) {
      expect(await through(routes, { url, headers: { host: 'home.example.ts.net' } })).toMatchObject({ reached: false, status: 403 })
    }
  })

  it('let the computer\'s own studio through, and let any session read', async () => {
    for (const listener of ['reach-tailscale-private', 'loopback'] as const) {
      const routes = routesOver(stubService().service, listener)
      for (const path of READS) {
        expect(await through(routes, { url: path, headers: { host: 'home.example.ts.net' } })).toEqual({ reached: true })
      }
    }
    const routes = routesOver(stubService().service, 'loopback')
    for (const path of WRITES) expect(await through(routes, { url: path, headers: STUDIO })).toEqual({ reached: true })
    expect(await through(routes, { url: WRITES[0]!, headers: { host: '127.0.0.1:4500' } })).toEqual({ reached: true })
  })

  it('do not call the service for a refused request', async () => {
    const { service, calls } = stubService()
    const routes = routesOver(service, 'reach-tailscale-private')
    await through(routes, { url: PROFILE_VERSION_ROUTES.switch, headers: { host: 'home.example.ts.net' } })
    expect(calls).toEqual([])
  })

  it('answer the reads and the writes of the computer, and refuse a malformed body', async () => {
    const { service, calls } = stubService()
    const routes = routesOver(service, 'loopback')
    const post = (path: string, body: unknown) => routes.fetch(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
    expect((await routes.fetch(PROFILE_VERSION_ROUTES.list)).status).toBe(200)
    expect(await (await routes.fetch(`${PROFILE_VERSION_ROUTES.changes}?version=${'b'.repeat(40)}`)).json()).toEqual({ changes: NO_CHANGES })
    expect((await post(PROFILE_VERSION_ROUTES.save, { name: 'Work' })).status).toBe(200)
    expect((await post(PROFILE_VERSION_ROUTES.switch, { version: 'c'.repeat(40) })).status).toBe(200)
    expect(calls).toEqual(['list', `changes:${'b'.repeat(40)}`, 'save:Work', `switch:${'c'.repeat(40)}`])
    for (const bad of ['not json', { extra: 1, version: 'x' }, '[]', 'x'.repeat(MAX_VERSIONS_REQUEST_BYTES + 1)]) {
      expect((await post(PROFILE_VERSION_ROUTES.switch, bad)).status).toBe(400)
    }
    expect((await post(PROFILE_VERSION_ROUTES.save, { name: 3 })).status).toBe(400)
    expect(calls).toHaveLength(4)
  })

  it('turn a refusal of the service into its status and let any other failure through', async () => {
    const { service } = stubService()
    vi.spyOn(service, 'switch').mockRejectedValueOnce(new VersionsError('UNKNOWN_VERSION', 'That version is not in this profile\'s history.'))
    vi.spyOn(service, 'list').mockRejectedValueOnce(new Error('boom'))
    const routes = routesOver(service, 'loopback')
    const refused = await routes.fetch(PROFILE_VERSION_ROUTES.switch, { method: 'POST', body: JSON.stringify({ version: 'd'.repeat(40) }) })
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 404, body: { error: 'UNKNOWN_VERSION' } })
    await expect(routes.fetch(PROFILE_VERSION_ROUTES.list)).rejects.toThrow('boom')
  })
})
