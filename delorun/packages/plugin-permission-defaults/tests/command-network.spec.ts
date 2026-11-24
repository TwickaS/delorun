/**
 * Specs of the mounted `delorunCommandNetwork` service: the network each workspace's policy carries (none for `open`, so
 * stock's policy is unchanged), the store it reads and writes, the confirmation a loosening needs, a refused store
 * counting every workspace as `off`, the `web_fetch` refusal, the two routes, and the plugin's switch and validation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { connect, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { REACH_DEVICE } from '@delorun/home-auth'
import { faceWorld } from '../../plugin-changes/tests/face-world.ts'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'
import {
  CommandNetwork, listKey, NETWORK_LIST_PATH, NETWORK_SET_PATH, NetworkChangeError,
  webFetchRefusal, type CommandNetworkSettings,
} from '../src/command-network.ts'
import { networkStorePath, serializeNetworkStore } from '../src/network-store.ts'
import type { WorkspaceNetwork } from '../src/network.ts'

const roots: string[] = []
const originalHome = process.env['DELORUN_HOME']
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELORUN_HOME']
  else process.env['DELORUN_HOME'] = originalHome
})

/** One captured Fetch route. */
interface Route {
  readonly path: string
  fetch(request: Request): Promise<Response>
  admitPeer?: (request: Request, peer: { readonly principal: object }) => boolean
}

interface Mounted {
  readonly ctx: Context
  readonly network: CommandNetwork
  readonly home: string
  readonly work: string
  readonly other: string
  readonly routes: Map<string, Route>
}

/**
 * Mount the service under a fresh home with two workspace folders, a fake Connection that captures its routes, and a
 * fake registry that lists both folders.
 */
async function mounted(settings: Partial<CommandNetworkSettings> = {}, store?: (paths: { work: string, other: string }) => string, homeName = 'home'): Promise<Mounted> {
  // A short prefix: the proxy's socket path under the home must stay within 107 bytes under the check runner's TMPDIR.
  const root = mkdtempSync(join(tmpdir(), 'dcn-'))
  roots.push(root)
  const home = join(root, homeName)
  const work = join(root, 'work')
  const other = join(root, 'other')
  for (const directory of [home, work, other]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (store !== undefined) {
    const path = networkStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, store({ work, other }), { mode: 0o600 })
  }
  process.env['DELORUN_HOME'] = home
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, Route>()
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as never)
  ctx.provide('workspaceRegistry', { list: () => [{ path: work, title: 'Work' }, { path: other, title: 'Other' }] } as never)
  await ctx.plugin(CommandNetwork, { defaultNetwork: { access: 'open', hosts: [] }, proxyConnectTimeoutMs: 1_000, proxyMaxConnections: 8, proxyIdleTimeoutMs: 60_000, ...settings })
  return { ctx, network: ctx.delorunCommandNetwork, home, work, other, routes }
}

function session(cwd: string): Session {
  const id = SessionId(`s-${cwd.length}`)
  return Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
}

function fetchCall(cwd: string | undefined, url: unknown): Readonly<ToolExecution> {
  // The guard reads the name, the arguments and the calling chat's session only.
  return { name: 'web_fetch', arguments: { url }, ...cwd === undefined ? {} : { agent: { session: session(cwd) } } } as never
}

const allowlist = (...hosts: string[]): WorkspaceNetwork => ({ access: 'allowlist', hosts })

describe('the network a workspace\'s policy carries', () => {
  it('carries none for an open workspace, so the policy is stock\'s', async () => {
    const { ctx, work } = await mounted()
    expect(ctx.sandboxNetwork({ session: session(work), workspaceRoot: work })).toBeUndefined()
  })

  it('carries the host form for an open workspace that accepted the abstract-socket risk, and not for the default alone', async () => {
    const { ctx, network, work, other } = await mounted()
    await network.set(work, { access: 'open', hosts: [], acceptAbstractSockets: true }, true)
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'host', abstractSockets: 'accepted' })
    expect(ctx.sandboxNetwork({ workspaceRoot: other })).toBeUndefined()
  })

  it('applies a default that accepts the risk to a workspace without its own setting, and only while the default is open', async () => {
    const { ctx, work } = await mounted({ defaultNetwork: { access: 'open', hosts: [], acceptAbstractSockets: true } })
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'host', abstractSockets: 'accepted' })
  })

  it('drops the acceptance when a setting is not open, and asks to confirm accepting it', async () => {
    const { network, work } = await mounted()
    await expect(network.set(work, { access: 'open', hosts: [], acceptAbstractSockets: true }, false)).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    expect(network.networkOf(work)).toEqual({ access: 'open', hosts: [] })
    await network.set(work, { access: 'open', hosts: [], acceptAbstractSockets: true }, true)
    expect(network.networkOf(work)).toEqual({ access: 'open', hosts: [], acceptAbstractSockets: true })
    expect(await network.set(work, { access: 'off', hosts: [], acceptAbstractSockets: true }, false)).toEqual({ access: 'off', hosts: [] })
    await network.set(work, { access: 'open', hosts: [], acceptAbstractSockets: true }, true)
    expect(await network.set(work, { access: 'open', hosts: [] }, false)).toEqual({ access: 'open', hosts: [] })
  })

  it('reads the acceptance from the store at start', async () => {
    const { ctx, work } = await mounted({}, paths => serializeNetworkStore(new Map([[paths.work, { access: 'open', hosts: [], acceptAbstractSockets: true }]])))
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'host', abstractSockets: 'accepted' })
  })

  it('carries `off`, and for an allowlist the socket of a proxy that already listens under the home', async () => {
    const { ctx, network, home, work, other } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    await network.set(other, allowlist('a.example'), true)
    expect(ctx.sandboxNetwork({ session: session(work), workspaceRoot: work })).toEqual({ mode: 'off' })
    const proxied = ctx.sandboxNetwork({ workspaceRoot: other })
    expect(proxied).toEqual({ mode: 'proxy', socket: join(home, 'secrets', 'permission-defaults', 'proxy', String(process.pid), `${listKey(['a.example'])}.sock`) })
  })

  it('applies the deployment default to a workspace without its own setting, and starts its proxy at start', async () => {
    const { ctx, work } = await mounted({ defaultNetwork: allowlist('a.example') })
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toMatchObject({ mode: 'proxy' })
  })

  it('gives an allowlist whose proxy cannot listen no network, never the host\'s, and records no such setting', async () => {
    const { ctx, network, work, other } = await mounted({ defaultNetwork: allowlist('a.example') }, undefined, 'h'.repeat(120))
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'off' })
    await network.set(other, { access: 'off', hosts: [] }, false)
    await expect(network.set(other, allowlist('b.example'), true)).rejects.toMatchObject({ code: 'PROXY', message: expect.stringContaining('longer than 107 bytes') as string })
    expect(ctx.sandboxNetwork({ workspaceRoot: other })).toEqual({ mode: 'off' })
    expect(network.networkOf(other)).toEqual({ access: 'off', hosts: [] })
  })

  it('reads the store at start', async () => {
    const { ctx, network, work, other } = await mounted({}, paths => serializeNetworkStore(new Map([[paths.work, { access: 'off', hosts: [] }], [paths.other, allowlist('b.example')]])))
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'off' })
    expect(ctx.sandboxNetwork({ workspaceRoot: other })).toMatchObject({ mode: 'proxy' })
    expect(network.storeProblem).toBeUndefined()
  })

  it('counts every workspace as `off` while the store is refused, and records nothing until it is fixed', async () => {
    const { ctx, network, work } = await mounted({}, () => '{"v":9}')
    expect(network.storeProblem).toContain('version is 9')
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'off' })
    await expect(network.set(work, undefined, true)).rejects.toMatchObject({ code: 'STORE' })
    expect(network.list().problem).toContain('version is 9')
  })
})

describe('changing a workspace\'s network', () => {
  it('applies a tightening at once and writes it to the store', async () => {
    const { network, home, work } = await mounted()
    expect(await network.set(work, { access: 'off', hosts: [] }, false)).toEqual({ access: 'off', hosts: [] })
    expect(JSON.parse(readFileSync(networkStorePath(home), 'utf8'))).toEqual({ v: 1, workspaces: { [work]: { access: 'off', hosts: [] } } })
  })

  it('refuses an unconfirmed loosening and records nothing, then applies it confirmed', async () => {
    const { ctx, network, work } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    await expect(network.set(work, allowlist('a.example'), false)).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    expect(ctx.sandboxNetwork({ workspaceRoot: work })).toEqual({ mode: 'off' })
    await network.set(work, allowlist('a.example'), true)
    await expect(network.set(work, allowlist('a.example', 'b.example'), false)).rejects.toBeInstanceOf(NetworkChangeError)
    await network.set(work, allowlist(), false)
    await expect(network.set(work, undefined, false)).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    await network.set(work, undefined, true)
    expect(network.list().workspaces.find(entry => entry.path === work)).toEqual({ path: work, title: 'Work', network: { access: 'open', hosts: [] }, own: false })
  }, 30_000)

  it('refuses an invalid host and a setting without a workspace', async () => {
    const { network, work } = await mounted()
    await expect(network.set(work, allowlist('http://x'), true)).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('"http://x"') as string })
    await expect(network.set('', allowlist('a.example'), true)).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('closes a proxy no setting names any more, and keeps one a setting still names', async () => {
    const { ctx, network, work, other } = await mounted()
    await network.set(work, allowlist('a.example'), true)
    await network.set(other, allowlist('a.example'), true)
    const shared = ctx.sandboxNetwork({ workspaceRoot: work })
    await network.set(work, { access: 'off', hosts: [] }, false)
    expect(ctx.sandboxNetwork({ workspaceRoot: other })).toEqual(shared)
    await network.set(other, allowlist(), false)
    expect(ctx.sandboxNetwork({ workspaceRoot: other })).not.toEqual(shared)
    if (shared?.mode !== 'proxy') throw new Error('the shared list resolves to a proxy')
    const reached = await new Promise<string>((resolve) => {
      connect(shared.socket).on('connect', function (this: Socket) { this.destroy(); resolve('connected') }).on('error', (error: NodeJS.ErrnoException) => { resolve(error.code ?? 'error') })
    })
    expect(reached).toBe('ENOENT')
  })
})

describe('web_fetch', () => {
  it('leaves every call of an open workspace and every other tool alone', async () => {
    const { network, work } = await mounted()
    expect(network.reviewFetch(fetchCall(work, 'https://anything.example/'))).toBeUndefined()
    await network.set(work, { access: 'off', hosts: [] }, false)
    expect(network.reviewFetch({ ...fetchCall(work, 'x'), name: 'bash' })).toBeUndefined()
  })

  it('refuses every fetch of an `off` workspace and every unlisted or unreadable URL of an allowlist one', async () => {
    const { network, work, other } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    await network.set(other, allowlist('*.example.org'), true)
    expect(network.reviewFetch(fetchCall(work, 'https://docs.example.org/'))).toBe(webFetchRefusal({ access: 'off', hosts: [] }, { host: 'docs.example.org', port: 443 }))
    expect(network.reviewFetch(fetchCall(other, 'https://docs.example.org/x'))).toBeUndefined()
    expect(network.reviewFetch(fetchCall(other, 'http://docs.example.org/x'))).toBeUndefined()
    expect(network.reviewFetch(fetchCall(other, 'https://docs.example.org:8443/x'))).toContain('"docs.example.org" is on this workspace\'s network allowlist for ports 80 and 443 only, unless an entry names port 8443')
    expect(network.reviewFetch(fetchCall(other, 'https://example.com/'))).toContain('"example.com" is not on this workspace\'s network allowlist')
    expect(network.reviewFetch(fetchCall(other, 'not a url'))).toContain('the URL could not be read')
    expect(network.reviewFetch(fetchCall(other, 7))).toContain('the URL could not be read')
  })

  it('uses the default for a call with no chat', async () => {
    const { network } = await mounted({ defaultNetwork: { access: 'off', hosts: [] } })
    expect(network.reviewFetch(fetchCall(undefined, 'https://a.example/'))).toContain('network is off')
  })
})

describe('the routes', () => {
  const post = (body: unknown): Request => new Request('http://127.0.0.1/', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

  it('lists the default and each workspace with the setting it has', async () => {
    const { routes, network, work } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    const answer = await (await (routes.get(NETWORK_LIST_PATH) as Route).fetch(new Request('http://127.0.0.1/'))).json()
    expect(answer).toMatchObject({ default: { access: 'open', hosts: [] }, workspaces: [{ title: 'Work', own: true, network: { access: 'off' } }, { title: 'Other', own: false }] })
  })

  it('answers each change with its status', async () => {
    const { routes, work } = await mounted()
    const set = routes.get(NETWORK_SET_PATH) as Route
    expect((await set.fetch(post({ path: work, network: { access: 'off', hosts: [] } }))).status).toBe(200)
    const unconfirmed = await set.fetch(post({ path: work, network: { access: 'open', hosts: [] } }))
    expect({ status: unconfirmed.status, body: await unconfirmed.json() }).toMatchObject({ status: 409, body: { error: 'NETWORK_UNCONFIRMED' } })
    expect((await set.fetch(post({ path: work, network: { access: 'allowlist', hosts: ['10.0.0.1'] }, confirmed: true }))).status).toBe(422)
    expect((await set.fetch(post({ path: work, confirmed: true }))).status).toBe(200)
    expect((await set.fetch(post({ path: work, network: { access: 'open', hosts: [], acceptAbstractSockets: true }, confirmed: true }))).status).toBe(200)
    expect((await set.fetch(post({ path: work, network: { access: 'open', hosts: [], acceptAbstractSockets: false } }))).status).toBe(200)
    for (const bad of [{ path: work, network: { access: 'open', hosts: [], acceptAbstractSockets: 'yes' } }, 'not json', 'null', { path: 1 }, { path: work, confirmed: 'yes' }, { path: work, network: 1 }, { path: work, network: { access: 'x', hosts: [] } }, { path: work, network: { access: 'off', hosts: [1] } }, 'x'.repeat(70_000)]) {
      expect((await set.fetch(post(bad))).status).toBe(400)
    }
  })
})

describe('under Face ID', () => {
  const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })

  /** The service with a `homeAuth` whose grant store exists for device `d1`, which holds a passkey and whatever unlock the options give. */
  async function underFace(home: { elevation?: { id: string, grace?: true }, page?: boolean } = {}) {
    const result = await mounted()
    const world = faceWorld('d1', 'reach')
    result.ctx.provide('homeAuth', {
      arrivalOf: () => ({ listener: 'reach' }), dangerousMode: () => false, unlockModeEnabled: () => false, touchUnlock: () => {},
      ...world.fields,
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
    } as never)
    return { ...result, world, set: result.routes.get(NETWORK_SET_PATH)!, list: result.routes.get(NETWORK_LIST_PATH)! }
  }
  const setCall = (body: string, grant?: string) => new Request(`http://x${NETWORK_SET_PATH}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body })

  it('refuses a change to a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, and changes nothing', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two.
    for (const home of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      const { set, network, work } = await underFace(home)
      const request = setCall(JSON.stringify({ path: work, network: { access: 'off', hosts: [] } }))
      expect(set.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}))).toBe(true)
      const refusal = await set.fetch(request)
      expect([refusal.status, await refusal.json()], JSON.stringify(home)).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect(network.networkOf(work)).toEqual({ access: 'open', hosts: [] })
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one change would apply another.
    const { set, world, network, work, other } = await underFace()
    const body = JSON.stringify({ path: work, network: { access: 'off', hosts: [] } })
    const grant = world.grantFor('plugin-permission-defaults/network-set', { path: NETWORK_SET_PATH, body })
    const wrong = setCall(JSON.stringify({ path: other, network: { access: 'off', hosts: [] } }), grant)
    set.admitPeer!(wrong, device())
    expect((await set.fetch(wrong)).status).toBe(403)
    expect(network.networkOf(other)).toEqual({ access: 'open', hosts: [] })
    const exact = setCall(body, grant)
    set.admitPeer!(exact, device())
    expect((await set.fetch(exact)).status).toBe(200)
    expect(network.networkOf(work)).toEqual({ access: 'off', hosts: [] })
    // Pins the single use: without `consume` the same grant would change the network again.
    const replay = setCall(body, grant)
    set.admitPeer!(replay, device())
    expect((await set.fetch(replay)).status).toBe(403)
  })

  it('answers the list to a device with no unlock and no grant', async () => {
    // Pins the `free` class of the list.
    const { list } = await underFace()
    const request = new Request(`http://x${NETWORK_LIST_PATH}`)
    expect(list.admitPeer!(request, device())).toBe(true)
    expect((await list.fetch(request)).status).toBe(200)
  })

  it('never asks the owner: a request that skips admitPeer changes the network', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { set, network, work } = await underFace()
    expect((await set.fetch(setCall(JSON.stringify({ path: work, network: { access: 'off', hosts: [] } })))).status).toBe(200)
    expect(network.networkOf(work)).toEqual({ access: 'off', hosts: [] })
  })
})

describe('the route hook', () => {
  /** A request as the Connection's `connection/request` waterfall receives it, and the response it is answered with. */
  function arrival(url: string, host: string): { request: IncomingMessage, response: ServerResponse, writeHead: ReturnType<typeof vi.spyOn>, end: ReturnType<typeof vi.spyOn> } {
    const request = new IncomingMessage(new Socket())
    request.url = url
    request.headers.host = host
    const response = new ServerResponse(request)
    const writeHead = vi.spyOn(response, 'writeHead').mockReturnValue(response)
    const end = vi.spyOn(response, 'end').mockReturnValue(response)
    return { request, response, writeHead, end }
  }

  /** The service mounted with a `homeAuth` that places every request on one listener and reports dangerous mode. */
  async function withListener(listener: string, dangerous = false): Promise<Context> {
    const { ctx } = await mounted()
    ctx.provide('homeAuth', { arrivalOf: (request: IncomingMessage) => ({ listener, host: request.headers.host, source: 'test' }), dangerousMode: () => dangerous, unlockModeEnabled: () => false, faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined) } as never)
    return ctx
  }

  it('lets a reach device through the hook, reads for any approved device, and answers a locked device ELEVATION_REQUIRED on the change, in either dangerous mode', async () => {
    const { ctx, routes } = await mounted()
    let dangerous = false
    ctx.provide('homeAuth', { arrivalOf: (request: IncomingMessage) => ({ listener: 'reach-tailscale-private', host: request.headers.host, source: 'test' }), dangerousMode: () => dangerous, unlockModeEnabled: () => false, faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined) } as never)
    const device = (deviceId: string) => ({ principal: { kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' } })
    for (const mode of [false, true]) {
      dangerous = mode
      for (const url of [NETWORK_LIST_PATH, NETWORK_SET_PATH]) {
        const { request, response, writeHead } = arrival(url, 'home.example.ts.net')
        const next = vi.fn(async () => {})
        await ctx.waterfall('connection/request', request, response, next)
        expect([url, next.mock.calls.length, writeHead.mock.calls.length]).toEqual([url, 1, 0])
        expect(routes.get(url)?.admitPeer?.(new Request(`http://localhost${url}`), { principal: { kind: 'anonymous' } })).toBe(false)
      }
      // Reading is for any approved device.
      expect(routes.get(NETWORK_LIST_PATH)?.admitPeer?.(new Request(`http://localhost${NETWORK_LIST_PATH}`), device('locked-phone'))).toBe(true)
      // Pins the unlock check: the change is admitted to the route and refused by it for a locked device.
      const set = routes.get(NETWORK_SET_PATH)!
      const asked = (deviceId: string) => {
        const call = new Request(`http://localhost${NETWORK_SET_PATH}`, { method: 'POST', body: '{}' })
        return set.admitPeer?.(call, device(deviceId)) === true ? set.fetch(call) : Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      const locked = await asked('locked-phone')
      expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect((await asked('unlocked-phone')).status).not.toBe(403)
    }
  })

  it('refuses a request under another Host for either route with LOOPBACK_REQUIRED, however its path is spelled', async () => {
    const spellings = [NETWORK_LIST_PATH, `${NETWORK_SET_PATH}?confirmed=1`, '/x/../api/delorunNetwork.list', '/api/x/%2e%2e/delorunNetwork.set', '/api\\delorunNetwork.list', 'http://127.0.0.1:3080/api/delorunNetwork.list']
    for (const [listener, host] of [['loopback', 'evil.example']] as const) {
      const ctx = await withListener(listener)
      for (const url of spellings) {
        const { request, response, writeHead, end } = arrival(url, host)
        const next = vi.fn(async () => {})
        await ctx.waterfall('connection/request', request, response, next)
        expect([url, next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([url, 0, 403])
        expect(JSON.parse(end.mock.calls[0]?.[0] as string)).toMatchObject({ error: 'LOOPBACK_REQUIRED', message: expect.stringContaining('Reading or changing a workspace\'s network') as string })
      }
    }
  })

  it('refuses either route while no homeAuth places the request', async () => {
    const { ctx } = await mounted()
    const { request, response, writeHead } = arrival(NETWORK_SET_PATH, '127.0.0.1:3080')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
  })

  it('passes no target the router cannot read on to a route', async () => {
    const ctx = await withListener('reach-tailscale-private')
    const { request, response } = arrival('http://[bad', '127.0.0.1:3080')
    const next = vi.fn(async () => {})
    await expect(ctx.waterfall('connection/request', request, response, next)).rejects.toThrow()
    expect(next).not.toHaveBeenCalled()
  })

  it('lets the home\'s own computer through, and leaves a device\'s request for another path alone', async () => {
    for (const [listener, url] of [['loopback', NETWORK_LIST_PATH], ['reach-tailscale-private', '/api/other']] as const) {
      const ctx = await withListener(listener)
      const { request, response, writeHead } = arrival(url, '127.0.0.1:3080')
      const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', request, response, next)
      expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
    }
  })
})

describe('the plugin\'s network configuration', () => {
  it('defaults to the parity value and an open network', () => {
    expect(Config()).toEqual({ enabled: false, fullAccessEverywhere: false, network: 'open', allowedHosts: [], proxyConnectTimeoutMs: 30_000, proxyMaxConnections: 256, proxyIdleTimeoutMs: 300_000, acceptAbstractSockets: false })
  })

  it('refuses an invalid default allowlist, a zero timeout and a second resolver at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(apply(ctx, { ...Config(), enabled: true, allowedHosts: ['https://x.example'] })).rejects.toThrow('allowedHosts is refused')
    await expect(apply(ctx, { ...Config(), enabled: true, proxyConnectTimeoutMs: 0 })).rejects.toThrow('proxyConnectTimeoutMs')
    await expect(apply(ctx, { ...Config(), enabled: true, proxyMaxConnections: 0 })).rejects.toThrow('proxyMaxConnections must be a positive number')
    await expect(apply(ctx, { ...Config(), enabled: true, proxyIdleTimeoutMs: 0 })).rejects.toThrow('proxyIdleTimeoutMs must be a positive number')
    // A failed start mounts a stand-in resolver on the root, so the other plugin's resolver is provided on a fresh root.
    const other = new Context()
    contexts.push(other)
    other.provide('sandboxNetwork', () => undefined)
    await expect(apply(other, { ...Config(), enabled: true })).rejects.toThrow('another plugin already provides the sandbox network resolver')
  })
})

describe('a directory inside a registered workspace', () => {
  it('inherits the workspace network rather than the deployment default', async () => {
    const { network, work } = await mounted()
    // The deployment default is open; the workspace is set to off.
    await network.set(work, { access: 'off', hosts: [] }, false)
    expect(network.networkOf(work)).toEqual({ access: 'off', hosts: [] })
    // A session whose cwd is a scratch subdirectory of the workspace resolves the workspace's setting, not the default.
    const scratch = join(work, 'audit', 'role-1')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    expect(network.networkOf(scratch)).toEqual({ access: 'off', hosts: [] })
  })

  it('keeps a nested workspace on its own setting', async () => {
    const { ctx, network, work } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    const nested = join(work, 'nested')
    mkdirSync(nested, { recursive: true, mode: 0o700 })
    // The registry lists the nested folder as a workspace of its own, which is what makes it the nearest one.
    const registry = ctx.get('workspaceRegistry') as { list: () => { path: string, title: string }[] }
    const listed = registry.list()
    registry.list = () => [...listed, { path: nested, title: 'Nested' }]
    // Opening the nested workspace loosens what it inherits from its parent, so the person confirms it first.
    await network.set(nested, { access: 'open', hosts: [] }, true)
    // The nearest containing workspace wins, so the nested one is open while its parent stays off.
    expect(network.networkOf(nested)).toEqual({ access: 'open', hosts: [] })
    expect(network.networkOf(join(nested, 'deeper'))).toEqual({ access: 'open', hosts: [] })
    expect(network.networkOf(join(work, 'sibling'))).toEqual({ access: 'off', hosts: [] })
  })

  it('falls back to the default for a directory in no workspace', async () => {
    const { network } = await mounted()
    const outside = mkdtempSync(join(tmpdir(), 'dcn-outside-'))
    roots.push(outside)
    expect(network.networkOf(outside)).toEqual({ access: 'open', hosts: [] })
  })

  it('does not treat a sibling whose name starts with the workspace path as inside it', async () => {
    const { network, work } = await mounted()
    await network.set(work, { access: 'off', hosts: [] }, false)
    // /…/work-elsewhere must not inherit /…/work's setting.
    const sibling = `${work}-elsewhere`
    mkdirSync(sibling, { recursive: true, mode: 0o700 })
    roots.push(sibling)
    expect(network.networkOf(sibling)).toEqual({ access: 'open', hosts: [] })
  })
})
