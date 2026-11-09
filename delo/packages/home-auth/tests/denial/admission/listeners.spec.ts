/**
 * C4's listener and dispatch denial tests (`delo/docs/contracts/c04-admission.md#security`), over the booted web
 * composition of Delo's CLI profiles with a stand-in authenticator provider and all three reach listeners open.
 */
import { once } from 'node:events'
import { connect } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { REACH_REFUSAL_STATUS, type Admission as UpstreamAdmission, type ListenerPolicy as UpstreamPolicy, type MintedCredential, type PeerScope, type ReachListener } from '@deepseek-ai/dsh-client-connection'
import { ADMISSION_REFUSAL_STATUS, type Admission, type ListenerPolicy, type LoopbackCredentialMint } from '@delo/contract-admission'
import {
  ADDRESSES, REACH_LISTENERS, SESSION_COOKIE, StandInHomeAuth, mountFixturePlugin, relayEndpoint, relayTls, tcpEndpoint,
  type Endpoint, type FixturePlugin, type RelayEndpoint, type Reply,
} from './fixtures.ts'
import { bootStudio, type Registration, type Studio } from './studio.ts'

/** Compile-time: Delo's contract types are values of the upstream seam's types. */
type Assignable<T extends U, U> = T
export type ContractAdmissionFitsSeam = Assignable<Admission<PeerScope>, UpstreamAdmission>
export type ContractPolicyFitsSeam = Assignable<ListenerPolicy, UpstreamPolicy>
/** Compile-time: what upstream announces for a mint is a value of C4's mint type. */
export type SeamMintFitsContract = Assignable<MintedCredential, LoopbackCredentialMint>

const TAILNET_HOST = new URL(ADDRESSES['reach-tailscale-private']).host

interface Suite {
  readonly studio: Studio
  readonly provider: StandInHomeAuth
  readonly providerFiber: { dispose(): Promise<unknown> }
  readonly fixture: FixturePlugin
  readonly listeners: ReachListener[]
  readonly endpoints: Endpoint[]
  readonly relay: RelayEndpoint
  readonly loopback: Endpoint
}

let suite: Suite

/** Load the stand-in provider and the fixture plugin, and open every reach listener. */
async function openAll(studio: Studio): Promise<Omit<Suite, 'studio'>> {
  const ctx = studio.ctx
  let provider: StandInHomeAuth | undefined
  const providerFiber = ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => { provider = new StandInHomeAuth(providerCtx) } })
  await providerFiber
  let fixture: FixturePlugin | undefined
  await ctx.plugin({ inject: ['webServer'], apply: (pluginCtx: Context) => { fixture = mountFixturePlugin(pluginCtx) } })
  if (provider === undefined || fixture === undefined) throw new Error('the stand-in provider or fixture plugin did not load')
  const tls = await relayTls()
  const listeners: ReachListener[] = []
  for (const id of REACH_LISTENERS) {
    listeners.push(await ctx.connection.openReachListener({
      listener: id,
      bind: id === 'reach-self-hosted-relay' ? { kind: 'streams', tls: { cert: tls.cert, key: tls.key } } : { kind: 'loopback' },
    }))
  }
  const relayListener = listeners.find(listener => listener.listener === 'reach-self-hosted-relay')
  if (relayListener === undefined) throw new Error('the relay listener did not open')
  const relay = await relayEndpoint(relayListener, tls.ca)
  const endpoints = listeners.map(listener => listener.address === undefined
    ? relay
    : tcpEndpoint(listener.listener, listener.address.port, ADDRESSES[listener.listener as keyof typeof ADDRESSES]))
  const loopbackPort = ctx.webServer.port ?? 0
  const loopback = tcpEndpoint('loopback', loopbackPort, `http://127.0.0.1:${String(loopbackPort)}`)
  return { provider, providerFiber, fixture, listeners, endpoints, relay, loopback }
}

beforeAll(async () => {
  const studio = await bootStudio([TAILNET_HOST])
  suite = { studio, ...await openAll(studio) }
}, 120_000)

afterAll(async () => {
  await suite.relay.close()
  await suite.studio.close()
})

afterEach(() => {
  suite.provider.config.preLoginRoutes = []
  suite.provider.config.declaredPreLogin = []
})

function expectRefused(reply: Reply, code: keyof typeof REACH_REFUSAL_STATUS): void {
  expect({ status: reply.status, body: reply.body }).toEqual({ status: REACH_REFUSAL_STATUS[code], body: JSON.stringify({ error: code }) })
  expect(reply.headers['set-cookie']).toBeUndefined()
}

/** A request target that reaches one registration, and whether it is an upgrade. */
function targetOf(registration: Registration): { readonly path: string; readonly upgrade: boolean } {
  switch (registration.kind) {
    case 'exact': return { path: registration.path, upgrade: false }
    case 'prefix': return { path: `${registration.path}/admission-probe`, upgrade: false }
    case 'upgrade': return { path: registration.path, upgrade: true }
    case 'fallback': return { path: '/admission-probe-fallback', upgrade: false }
    default: {
      const unknown: never = registration
      throw new Error(`unknown registration ${JSON.stringify(unknown)}`)
    }
  }
}

describe('C4 listener and dispatch denials', () => {
  it('the dispatcher refuses with the contract\'s codes and statuses', () => {
    for (const [code, status] of Object.entries(REACH_REFUSAL_STATUS)) {
      expect(ADMISSION_REFUSAL_STATUS[code as keyof typeof ADMISSION_REFUSAL_STATUS]).toBe(status)
    }
  })

  it('every route and upgrade answers 401 before sign-in on each reach listener', async () => {
    const shipped = suite.studio.registrations
    // The shipped composition's registrations, so a route a later upstream merge adds is reached here too.
    expect(shipped).toEqual(expect.arrayContaining([
      { kind: 'prefix', path: '/api' }, { kind: 'prefix', path: '/plugins' }, { kind: 'exact', path: '/plugins/events' },
      { kind: 'exact', path: '/connect' }, { kind: 'upgrade', path: '/api/remote.mux' }, { kind: 'fallback' },
    ]))
    const fixture: Registration[] = [
      { kind: 'exact', path: '/fixture-plugin/hello' }, { kind: 'prefix', path: '/fixture-plugin/files' }, { kind: 'upgrade', path: '/fixture-plugin/socket' },
    ]
    for (const endpoint of suite.endpoints) {
      for (const registration of [...shipped, ...fixture]) {
        const { path, upgrade } = targetOf(registration)
        const reply = await endpoint.send(path, { origin: endpoint.origin }, { upgrade })
        // `/connect` is refused one step earlier, by its own code.
        expect.soft({ listener: endpoint.listener, registration, status: reply.status }).toEqual({ listener: endpoint.listener, registration, status: 401 })
      }
    }
    expect(suite.fixture.ran).toEqual([])
    // The same fixture route runs once a session is admitted, so the refusals above are the dispatcher's.
    for (const endpoint of suite.endpoints) {
      expect((await endpoint.send('/fixture-plugin/hello', { cookie: SESSION_COOKIE })).body).toBe('hello')
      expect((await endpoint.send('/fixture-plugin/socket', { cookie: SESSION_COOKIE, origin: endpoint.origin }, { upgrade: true })).status).toBe(101)
    }
    expect(suite.fixture.ran).toEqual(['exact', 'upgrade', 'exact', 'upgrade', 'exact', 'upgrade'])
    suite.fixture.ran.length = 0
  })

  it('a plugin route is pre-login only when the profile lists it', async () => {
    const route = { method: 'GET', path: '/fixture-plugin/hello' } as const
    suite.provider.config.declaredPreLogin = [route]
    for (const endpoint of suite.endpoints) expectRefused(await endpoint.send(route.path), 'NOT_SIGNED_IN')
    expect(suite.fixture.ran).toEqual([])
    suite.provider.config.preLoginRoutes = [route]
    suite.studio.ctx.emit('authenticator/policy', 'reach-tailscale-private')
    const [privateEndpoint] = suite.endpoints
    expect((await privateEndpoint?.send(route.path))?.body).toBe('hello')
    expect(suite.fixture.ran).toEqual(['exact'])
    suite.fixture.ran.length = 0
    suite.provider.config.preLoginRoutes = []
    suite.studio.ctx.emit('authenticator/policy', 'reach-tailscale-private')
    expectRefused(await suite.endpoints[0]!.send(route.path), 'NOT_SIGNED_IN')
  })

  it('a pre-login request never reaches the fallback or another route', async () => {
    // No sign-in route is registered in this composition, so the allowlisted paths would otherwise reach the fallback.
    for (const endpoint of suite.endpoints) {
      for (const path of ['/auth/sign-in', '/auth/assets/app.js', '/auth/device/request/abc']) {
        expectRefused(await endpoint.send(path), 'NOT_SIGNED_IN')
      }
    }
  })

  it('a cookie minted with upstream\'s secret is refused on a reach listener', async () => {
    // Upstream's launch-token exchange on the loopback listener, for the reach listener's own authority.
    const launch = new URL(suite.studio.ctx.connection.authenticatedUrl(`http://${TAILNET_HOST}/`))
    const minted = await suite.loopback.send(`/connect${launch.search}`, { host: TAILNET_HOST })
    const cookie = String(minted.headers['set-cookie']).split(';')[0] ?? ''
    expect(cookie).toMatch(/^dsh-auth-/)
    // The cookie is valid where upstream minted it.
    expect((await suite.loopback.send('/api/remote.mux', { host: TAILNET_HOST, cookie })).status).not.toBe(401)
    for (const endpoint of suite.endpoints) {
      expectRefused(await endpoint.send('/', { cookie }), 'UPSTREAM_COOKIE_REFUSED')
      const upgrade = await endpoint.send('/api/remote.mux', { cookie: `${SESSION_COOKIE}; ${cookie}`, origin: endpoint.origin }, { upgrade: true })
      expect({ status: upgrade.status, body: upgrade.body }).toEqual({ status: 401, body: JSON.stringify({ error: 'UPSTREAM_COOKIE_REFUSED' }) })
      expectRefused(await endpoint.send('/fixture-plugin/hello', { cookie: `${SESSION_COOKIE}; ${cookie}` }), 'UPSTREAM_COOKIE_REFUSED')
    }
    expect(suite.fixture.ran).toEqual([])
  })

  it('launch tokens and /connect are refused on a reach listener', async () => {
    const token = new URL(suite.studio.ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token') ?? ''
    expect(token).not.toBe('')
    for (const endpoint of suite.endpoints) {
      expectRefused(await endpoint.send(`/?token=${token}`), 'LAUNCH_TOKEN_REFUSED')
      expectRefused(await endpoint.send(`/connect?token=${token}&interactions=answer`), 'LAUNCH_TOKEN_REFUSED')
      expectRefused(await endpoint.send('/connect'), 'CONNECT_REFUSED')
      expectRefused(await endpoint.send('/connect', { cookie: SESSION_COOKIE }), 'CONNECT_REFUSED')
      const upgrade = await endpoint.send(`/api/remote.mux?token=${token}`, { cookie: SESSION_COOKIE, origin: endpoint.origin }, { upgrade: true })
      expect({ status: upgrade.status, body: upgrade.body }).toEqual({ status: 401, body: JSON.stringify({ error: 'LAUNCH_TOKEN_REFUSED' }) })
    }
  })

  it('a loopback Host is refused on a reach listener', async () => {
    for (const endpoint of suite.endpoints) {
      for (const host of ['localhost', '127.0.0.1', '[::1]', `localhost:${String(suite.studio.ctx.webServer.port)}`]) {
        expectRefused(await endpoint.send('/fixture-plugin/hello', { host, cookie: SESSION_COOKIE }), 'HOST_MISMATCH')
        const upgrade = await endpoint.send('/fixture-plugin/socket', { host, cookie: SESSION_COOKIE, origin: endpoint.origin }, { upgrade: true })
        expect({ status: upgrade.status, body: upgrade.body }).toEqual({ status: 421, body: JSON.stringify({ error: 'HOST_MISMATCH' }) })
      }
    }
    expect(suite.fixture.ran).toEqual([])
  })

  it('each listener refuses a Host its rule does not allow', async () => {
    const hosts = Object.values(ADDRESSES).map(address => new URL(address).host)
    for (const endpoint of suite.endpoints) {
      for (const host of [...hosts.filter(host => host !== endpoint.host), 'evil.example', `${endpoint.host}.`]) {
        expectRefused(await endpoint.send('/fixture-plugin/hello', { host, cookie: SESSION_COOKIE }), 'HOST_MISMATCH')
      }
    }
    // On the relay listener, a Host equal to the bound name over a connection whose SNI names another is refused.
    expectRefused(await suite.relay.send('/fixture-plugin/hello', { cookie: SESSION_COOKIE }, { servername: 'other.example.org' }), 'SNI_MISMATCH')
    // The loopback listener keeps upstream's fence: a foreign Host is refused, a loopback one is not.
    expect((await suite.loopback.send('/api/session.list', { host: 'evil.example' }, { method: 'POST' })).status).toBe(403)
    expect((await suite.loopback.send('/api/session.list', { origin: suite.loopback.origin }, { method: 'POST' })).status).toBe(401)
    expect(suite.fixture.ran).toEqual([])
  })

  it('an upgrade with a foreign or absent Origin is refused', async () => {
    for (const endpoint of suite.endpoints) {
      for (const headers of [{ cookie: SESSION_COOKIE }, { cookie: SESSION_COOKIE, origin: 'https://evil.example' }, { cookie: SESSION_COOKIE, origin: 'null' }]) {
        const reply = await endpoint.send('/api/remote.mux', headers, { upgrade: true })
        expect({ listener: endpoint.listener, status: reply.status }).toEqual({ listener: endpoint.listener, status: 403 })
        expect(reply.body).toBe(JSON.stringify({ error: 'ORIGIN_MISMATCH' }))
      }
      // The listener's own origin reaches the upgrade handler.
      expect((await endpoint.send('/api/remote.mux', { cookie: SESSION_COOKIE, origin: endpoint.origin }, { upgrade: true })).status).toBe(101)
    }
  })

  it('removes Tailscale identity headers before admission', async () => {
    suite.provider.seen.length = 0
    const forged = { 'Tailscale-User-Login': 'owner@example.com', 'TAILSCALE-USER-NAME': 'Owner' }
    for (const endpoint of suite.endpoints) {
      await endpoint.send('/fixture-plugin/hello', { cookie: SESSION_COOKIE, ...forged })
      // The Gateway's WebSocket still accepts an upgrade whose identity headers were removed.
      expect((await endpoint.send('/api/remote.mux', { cookie: SESSION_COOKIE, origin: endpoint.origin, ...forged }, { upgrade: true })).status).toBe(101)
    }
    expect(suite.provider.seen.map(entry => entry.listener)).toEqual(REACH_LISTENERS.flatMap(id => [id, id]))
    for (const { request } of suite.provider.seen) {
      expect(JSON.stringify(request.headers).toLowerCase()).not.toContain('tailscale-')
    }
    suite.fixture.ran.length = 0
  })

  // Last: it stops every reach listener of the shared studio.
  it('no reach listener runs without home-auth', async () => {
    const ctx = suite.studio.ctx
    // An open connection to each TCP reach listener closes with it.
    const open = await Promise.all(suite.listeners.flatMap(listener => listener.address === undefined ? [] : [(async () => {
      const socket = connect(listener.address?.port ?? 0, '127.0.0.1')
      socket.on('error', () => {})
      await once(socket, 'connect')
      return { closed: new Promise((resolve) => { socket.once('close', resolve) }) }
    })()]))
    await suite.providerFiber.dispose()
    await Promise.all(suite.listeners.map(listener => listener.closed))
    await Promise.all(open.map(socket => socket.closed))
    for (const endpoint of suite.endpoints) {
      await expect(endpoint.send('/fixture-plugin/hello', { cookie: SESSION_COOKIE })).rejects.toThrow()
    }
    // Without a provider no reach listener opens, and the loopback listener admits as upstream does.
    await expect(ctx.connection.openReachListener({ listener: 'reach-tailscale-private', bind: { kind: 'loopback' } })).rejects.toThrow(/needs an authenticator provider/)
    expect((await suite.loopback.send('/api/session.list', { origin: suite.loopback.origin }, { method: 'POST' })).status).toBe(401)
    // A replacement that does not serve reach listeners leaves them all closed.
    await ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => {
      const replacement = new StandInHomeAuth(providerCtx)
      replacement.policy = () => undefined
    } })
    await expect(ctx.connection.openReachListener({ listener: 'reach-tailscale-private', bind: { kind: 'loopback' } })).rejects.toThrow(/not served/)
    for (const endpoint of suite.endpoints) {
      await expect(endpoint.send('/fixture-plugin/hello', { cookie: SESSION_COOKIE })).rejects.toThrow()
    }
  })
})
