/**
 * Specs of the mounted `deloCommandNetwork` service: the network each workspace's policy carries (none for `open`, so
 * stock's policy is unchanged), the store it reads and writes, the confirmation a loosening needs, a refused store
 * counting every workspace as `off`, the `web_fetch` refusal, the two routes, and the plugin's switch and validation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'
import {
  arrivedAtComputer, CommandNetwork, listKey, NETWORK_LIST_PATH, NETWORK_LOOPBACK_ONLY, NETWORK_SET_PATH, NetworkChangeError, webFetchRefusal,
  type CommandNetworkSettings,
} from '../src/command-network.ts'
import { networkStorePath, serializeNetworkStore } from '../src/network-store.ts'
import type { WorkspaceNetwork } from '../src/network.ts'

const roots: string[] = []
const originalHome = process.env['DELO_HOME']
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELO_HOME']
  else process.env['DELO_HOME'] = originalHome
})

/** One captured Fetch route. */
interface Route {
  readonly path: string
  fetch(request: Request): Promise<Response>
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
async function mounted(settings: Partial<CommandNetworkSettings> = {}, store?: (paths: { work: string, other: string }) => string): Promise<Mounted> {
  // A short prefix: the proxy's socket path under the home must stay within 107 bytes under the check runner's TMPDIR.
  const root = mkdtempSync(join(tmpdir(), 'dcn-'))
  roots.push(root)
  const home = join(root, 'home')
  const work = join(root, 'work')
  const other = join(root, 'other')
  for (const directory of [home, work, other]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (store !== undefined) {
    const path = networkStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, store({ work, other }), { mode: 0o600 })
  }
  process.env['DELO_HOME'] = home
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, Route>()
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as never)
  ctx.provide('workspaceRegistry', { list: () => [{ path: work, title: 'Work' }, { path: other, title: 'Other' }] } as never)
  await ctx.plugin(CommandNetwork, { defaultNetwork: { access: 'open', hosts: [] }, proxyConnectTimeoutMs: 1_000, ...settings })
  return { ctx, network: ctx.deloCommandNetwork, home, work, other, routes }
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
  })

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
    expect(network.reviewFetch(fetchCall(work, 'https://docs.example.org/'))).toBe(webFetchRefusal({ access: 'off', hosts: [] }, 'docs.example.org'))
    expect(network.reviewFetch(fetchCall(other, 'https://docs.example.org/x'))).toBeUndefined()
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
    for (const bad of ['not json', 'null', { path: 1 }, { path: work, confirmed: 'yes' }, { path: work, network: 1 }, { path: work, network: { access: 'x', hosts: [] } }, { path: work, network: { access: 'off', hosts: [1] } }, 'x'.repeat(70_000)]) {
      expect((await set.fetch(post(bad))).status).toBe(400)
    }
  })

  it('lets only a request on the loopback listener under a loopback Host through', () => {
    const answered: { status?: number, body?: string } = {}
    const response: ServerResponse = { writeHead: (status: number) => { answered.status = status }, end: (body: string) => { answered.body = body } } as never
    const request = (host: string): IncomingMessage => ({ headers: { host } }) as never
    const loopback = { arrivalOf: () => ({ listener: 'loopback' as const, host: undefined, source: 'unknown' as const }) }
    const reach = { arrivalOf: () => ({ listener: 'reach' as never, host: undefined, source: 'unknown' as const }) }
    expect(arrivedAtComputer(request('127.0.0.1:3080'), response, loopback as never)).toBe(true)
    expect(answered.status).toBeUndefined()
    expect(arrivedAtComputer(request('evil.example'), response, loopback as never)).toBe(false)
    expect(arrivedAtComputer(request('127.0.0.1:3080'), response, reach as never)).toBe(false)
    expect(arrivedAtComputer(request('127.0.0.1:3080'), response, undefined)).toBe(false)
    expect(answered).toEqual({ status: 403, body: expect.stringContaining(NETWORK_LOOPBACK_ONLY) as string })
  })
})

describe('the plugin\'s network configuration', () => {
  it('defaults to the parity value and an open network', () => {
    expect(Config()).toEqual({ enabled: false, network: 'open', allowedHosts: [], proxyConnectTimeoutMs: 30_000 })
  })

  it('refuses an invalid default allowlist, a zero timeout and a second resolver at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(apply(ctx, { ...Config(), enabled: true, allowedHosts: ['https://x.example'] })).rejects.toThrow('allowedHosts is refused')
    await expect(apply(ctx, { ...Config(), enabled: true, proxyConnectTimeoutMs: 0 })).rejects.toThrow('proxyConnectTimeoutMs')
    ctx.provide('sandboxNetwork', () => undefined)
    await expect(apply(ctx, { ...Config(), enabled: true })).rejects.toThrow('another plugin already provides the sandbox network resolver')
  })
})
