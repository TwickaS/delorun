/**
 * Reach listeners over a real web server: the dispatcher refuses by the Host,
 * Origin and loopback-credential rules and admits through the authenticator
 * provider before any route, upgrade handler or the fallback runs; pre-login
 * requests reach only their listed route; the listener closes when its
 * provider goes away and never reopens by itself; loopback admission defers
 * to a loaded provider.
 */
import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  Authenticator,
  REACH_REFUSAL_STATUS,
  apply,
  inject,
  type Admission,
  type ConnectionIndexRequest,
  type ListenerPolicy,
  type PeerScope,
  type ReachListener,
} from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const LISTENER = 'reach-tailscale-private'
const ADDRESS = 'https://home.example.ts.net'
const HOST = 'home.example.ts.net'
const ORIGIN = ADDRESS
const SESSION = '__Host-delo-session=signed-in'

/** A provider that admits one session cookie and serves one reach listener. */
class TestAuthenticator extends Authenticator {
  readonly seen: ConnectionIndexRequest[] = []
  /** A pre-login route returned for every request, listed or not. */
  forcedPreLogin: ListenerPolicy['preLogin'][number] | undefined
  loopback: Admission | undefined
  served = true
  private peer: PeerScope | undefined

  constructor(ctx: Context, private readonly address = ADDRESS) {
    super(ctx)
  }

  policy(listener: string): ListenerPolicy | undefined {
    if (listener !== LISTENER || !this.served) return undefined
    return {
      listener,
      scheme: 'https',
      hostRule: { kind: 'equals-address', address: this.address },
      acceptsLaunchToken: false,
      preLogin: [{ method: 'GET', path: '/auth/sign-in' }, { method: 'GET', path: '/auth/assets/<asset>' }, { method: 'GET', path: '/auth/probe' }],
    }
  }

  admit(request: ConnectionIndexRequest, listener: string): Admission {
    this.seen.push(request)
    if (listener !== LISTENER) return this.loopback ?? { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }
    const cookie = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
    if (cookie === SESSION) {
      this.peer ??= this.ctx.connection.createPeer({ principal: { kind: 'owner' } })
      return { kind: 'admitted', peer: this.peer, deviceId: 'device', sessionId: 'session', setCookie: `${SESSION}; Path=/; Secure; HttpOnly; SameSite=Strict` }
    }
    if (this.forcedPreLogin !== undefined) return { kind: 'pre-login', route: this.forcedPreLogin }
    const path = new URL(request.url ?? '/', 'http://x').pathname
    for (const route of this.policy(LISTENER)?.preLogin ?? []) {
      const base = route.path.replace(/\/<[^>]+>$/, '')
      if (request.method === route.method && (path === route.path || (base !== route.path && path.startsWith(`${base}/`)))) {
        return { kind: 'pre-login', route }
      }
    }
    return { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }
  }
}

interface Harness {
  readonly ctx: Context
  readonly ran: string[]
  readonly provider: TestAuthenticator
  readonly providerFiber: { dispose(): Promise<unknown> }
  readonly reach: ReachListener
  readonly loopbackPort: number
}

let contexts: Context[] = []
afterEach(async () => {
  const open = contexts
  contexts = []
  await Promise.all(open.map(ctx => ctx.fiber.dispose()))
})

/** A web server with Connection, a provider, routes that record running, and one open reach listener. */
async function start(address = ADDRESS): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ inject: [...inject], apply })
  const ran: string[] = []
  ctx.webServer.register({ kind: 'exact', path: '/exact', handler: (_req, res) => { ran.push('exact'); res.end('exact') } })
  ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: (_req, res) => { ran.push('prefix'); res.end('prefix') } })
  ctx.webServer.register({ kind: 'exact', path: '/auth/sign-in', handler: (_req, res) => { ran.push('sign-in'); res.end('sign-in') } })
  ctx.webServer.register({ kind: 'prefix', path: '/auth/assets', handler: (_req, res) => { ran.push('assets'); res.end('assets') } })
  ctx.webServer.register({ kind: 'exact', path: '/auth/assets/shadow.js', handler: (_req, res) => { ran.push('shadow'); res.end('shadow') } })
  ctx.webServer.register({ kind: 'exact', path: '/peer', handler: (req, res) => {
    ran.push('peer')
    const admission = ctx.connection.admit(req)
    res.end('peer' in admission ? 'admitted' : String(admission.rejection))
  } })
  ctx.webServer.register({ kind: 'exact', path: '/auth/probe', handler: (req, res) => {
    ran.push('probe')
    const rejection = ctx.connection.requestRejection(req)
    const socket = ctx.connection.admitConnection(req)
    if (!ctx.connection.authorizeIndex(req, res)) return
    res.end(`index rejection=${String(rejection)} socket=${'peer' in socket ? 'peer' : String(socket.rejection)}`)
  } })
  ctx.webServer.registerUpgrade({ path: '/socket', handler: (_req, socket) => {
    ran.push('upgrade')
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
  } })
  ctx.webServer.registerFallback((_req, res) => { ran.push('fallback'); res.end('fallback') })
  let provider: TestAuthenticator | undefined
  const providerFiber = ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => { provider = new TestAuthenticator(providerCtx, address) } })
  await providerFiber
  if (provider === undefined) throw new Error('provider did not load')
  const reach = await ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
  return { ctx, ran, provider, providerFiber, reach, loopbackPort: ctx.webServer.port ?? 0 }
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** One HTTP request with exactly the given headers, Host included. */
function send(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>()
  const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: HOST, ...headers }, setHost: false }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { body += chunk })
    response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body }) })
  })
  request.on('error', reject)
  request.end()
  return promise
}

/** One raw upgrade request; resolves with everything written before the server closed or answered 101. */
async function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  let received = ''
  socket.setEncoding('utf8')
  const done = new Promise<string>((resolve) => {
    socket.on('data', (chunk: string) => { received += chunk })
    socket.once('close', () => { resolve(received) })
  })
  const lines = Object.entries({ host: HOST, ...headers }).map(([name, value]) => `${name}: ${value}`)
  socket.write(`GET /socket HTTP/1.1\r\n${lines.join('\r\n')}\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n`)
  return done
}

function reachPort(harness: Harness): number {
  return harness.reach.address?.port ?? 0
}

function expectRefusal(reply: Reply, code: keyof typeof REACH_REFUSAL_STATUS): void {
  expect(reply.status).toBe(REACH_REFUSAL_STATUS[code])
  expect(JSON.parse(reply.body)).toEqual({ error: code })
  expect(reply.headers['set-cookie']).toBeUndefined()
}

describe('reach listener dispatch', () => {
  it('answers 401 for every route, prefix route, upgrade, /api and the fallback before sign-in, and runs none of them', async () => {
    const harness = await start()
    const port = reachPort(harness)
    for (const path of ['/exact', '/plugins/x/client.js', '/peer', `${API_PATH}/session.list`, '/', '/missing']) {
      expectRefusal(await send(port, path), 'NOT_SIGNED_IN')
    }
    expect(await upgrade(port, { origin: ORIGIN })).toMatch(/^HTTP\/1\.1 401 /)
    expect(harness.ran).toEqual([])
  })

  it('dispatches an admitted request with the provider\'s Peer and its rolled cookie', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const exact = await send(port, '/exact', { cookie: SESSION })
    expect(exact.body).toBe('exact')
    expect(exact.headers['set-cookie']?.[0]).toMatch(/^__Host-delo-session=signed-in;/)
    expect((await send(port, '/peer', { cookie: SESSION })).body).toBe('admitted')
    expect(await upgrade(port, { origin: ORIGIN, cookie: SESSION })).toMatch(/^HTTP\/1\.1 101 /)
    expect(harness.ran).toEqual(['exact', 'peer', 'upgrade'])
  })

  it('refuses a Host other than the address, a loopback Host, a foreign Origin, a cross-site fetch and an upgrade without Origin', async () => {
    const harness = await start()
    const port = reachPort(harness)
    for (const host of ['other.example', 'localhost', '127.0.0.1', '[::1]', `${HOST}:443`, `${HOST}.`]) {
      expectRefusal(await send(port, '/exact', { host, cookie: SESSION }), 'HOST_MISMATCH')
    }
    expectRefusal(await send(port, '/exact', { origin: 'https://evil.example', cookie: SESSION }), 'ORIGIN_MISMATCH')
    expectRefusal(await send(port, '/exact', { origin: 'null', cookie: SESSION }), 'ORIGIN_MISMATCH')
    expectRefusal(await send(port, '/exact', { 'sec-fetch-site': 'cross-site', cookie: SESSION }), 'ORIGIN_MISMATCH')
    expect(await upgrade(port, { cookie: SESSION })).toMatch(/^HTTP\/1\.1 403 [\s\S]*ORIGIN_MISMATCH/)
    expect(await upgrade(port, { origin: 'https://evil.example', cookie: SESSION })).toMatch(/^HTTP\/1\.1 403 /)
    expect(harness.ran).toEqual([])
    expect(harness.provider.seen).toEqual([])
  })

  it('refuses the launch token, /connect and a cookie minted with the loopback secret, even beside a session', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const launchUrl = new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.loopbackPort)}/`))
    const minted = await send(harness.loopbackPort, `/connect${launchUrl.search}`, { host: `127.0.0.1:${String(harness.loopbackPort)}` })
    const loopbackCookie = minted.headers['set-cookie']?.[0]?.split(';')[0]
    expect(loopbackCookie).toMatch(/^dsh-auth-/)
    expectRefusal(await send(port, `/${launchUrl.search}`), 'LAUNCH_TOKEN_REFUSED')
    expectRefusal(await send(port, `/connect${launchUrl.search}`), 'LAUNCH_TOKEN_REFUSED')
    expectRefusal(await send(port, '/connect', { cookie: SESSION }), 'CONNECT_REFUSED')
    expectRefusal(await send(port, '/exact', { cookie: `${SESSION}; ${String(loopbackCookie)}` }), 'UPSTREAM_COOKIE_REFUSED')
    expect(harness.ran).toEqual([])
  })

  it('removes Tailscale identity headers before admission', async () => {
    const harness = await start()
    await send(reachPort(harness), '/exact', { cookie: SESSION, 'Tailscale-User-Login': 'owner@example.com', 'tailscale-user-name': 'Owner' })
    const seen = harness.provider.seen.at(-1)
    expect(Object.keys(seen?.headers ?? {}).filter(name => name.startsWith('tailscale-'))).toEqual([])
    expect((seen as { rawHeaders?: string[] } | undefined)?.rawHeaders?.some(name => name.toLowerCase().startsWith('tailscale-'))).toBe(false)
  })

  it('sends a pre-login request only to its listed route, and refuses one the policy does not list or an upgrade', async () => {
    const harness = await start()
    const port = reachPort(harness)
    expect((await send(port, '/auth/sign-in')).body).toBe('sign-in')
    expect((await send(port, '/auth/assets/app.js')).body).toBe('assets')
    // An exact route under the pattern's prefix is not the listed route.
    expectRefusal(await send(port, '/auth/assets/shadow.js'), 'NOT_SIGNED_IN')
    expectRefusal(await send(port, '/auth/assets/a/b.js'), 'NOT_SIGNED_IN')
    expectRefusal(await send(port, '/auth/sign-in', {}, 'POST'), 'NOT_SIGNED_IN')
    harness.provider.forcedPreLogin = { method: 'GET', path: '/exact' }
    expectRefusal(await send(port, '/exact'), 'NOT_SIGNED_IN')
    harness.provider.forcedPreLogin = { method: 'GET', path: '/auth/sign-in' }
    expectRefusal(await send(port, '/exact'), 'NOT_SIGNED_IN')
    expect(await upgrade(port, { origin: ORIGIN })).toMatch(/^HTTP\/1\.1 401 /)
    expect(harness.ran).toEqual(['sign-in', 'assets'])
  })

  it('answers Connection\'s admission reads for a dispatched request by its dispatcher\'s result', async () => {
    const harness = await start()
    const port = reachPort(harness)
    expect((await send(port, '/auth/probe', { cookie: SESSION })).body).toBe('index rejection=undefined socket=peer')
    // A pre-login request reaches its listed route, where every admission read refuses it.
    expectRefusal(await send(port, '/auth/probe'), 'NOT_SIGNED_IN')
    expect(harness.ran).toEqual(['probe', 'probe'])
  })
})

describe('reach listener lifetime', () => {
  it('does not open without an authenticator provider, for loopback, or for a listener the provider does not serve', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    provideBrowserCredentials(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin({ inject: [...inject], apply })
    await expect(ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })).rejects.toThrow(/needs an authenticator provider/)
    await ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => { new TestAuthenticator(providerCtx) } })
    await expect(ctx.connection.openReachListener({ listener: 'loopback', bind: { kind: 'loopback' } })).rejects.toThrow(/not a reach listener/)
    await expect(ctx.connection.openReachListener({ listener: 'reach-tailscale-funnel', bind: { kind: 'loopback' } })).rejects.toThrow(/not served/)
    const streams = { kind: 'streams', tls: { cert: '', key: '' } } as const
    await expect(ctx.connection.openReachListener({ listener: LISTENER, bind: streams })).rejects.toThrow(/must bind loopback/)
  })

  it.each([
    ['https://localhost', 'loopback address'],
    ['https://127.0.0.2:8443', 'loopback address'],
    ['https://[::1]', 'loopback address'],
    ['http://home.example.ts.net', 'not an https origin'],
    ['https://home.example.ts.net/path', 'not an https origin'],
  ])('refuses a policy whose address is %s', async (address, reason) => {
    await expect(start(address)).rejects.toThrow(reason)
  })

  it('closes, and stays closed, when its provider is removed or replaced', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const held = connect(port, '127.0.0.1')
    held.on('error', () => {})
    await once(held, 'connect')
    const heldClosed = new Promise((resolve) => { held.once('close', resolve) })
    await harness.providerFiber.dispose()
    await harness.reach.closed
    await heldClosed
    await expect(send(port, '/exact', { cookie: SESSION })).rejects.toThrow(/ECONNREFUSED/)
    await expect(harness.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })).rejects.toThrow(/needs an authenticator provider/)
    await harness.ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => { new TestAuthenticator(providerCtx) } })
    await expect(send(port, '/exact', { cookie: SESSION })).rejects.toThrow(/ECONNREFUSED/)
    // Nothing reopened the listener on another port: its id is still free for its owner to open again.
    const reopened = await harness.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
    expect(reopened.address?.port).not.toBe(port)
    expect(harness.ran).toEqual([])
  })

  it('stops when the provider announces it no longer serves the listener', async () => {
    const harness = await start()
    harness.provider.served = false
    harness.ctx.emit('authenticator/policy', LISTENER)
    await harness.reach.closed
    await expect(send(reachPort(harness), '/exact', { cookie: SESSION })).rejects.toThrow(/ECONNREFUSED/)
  })

  it('closes on request and with the Context that opened it', async () => {
    const harness = await start()
    await harness.reach.close()
    const second = await harness.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
    expect((await send(second.address?.port ?? 0, '/exact', { cookie: SESSION })).body).toBe('exact')
    await harness.ctx.fiber.dispose()
    await second.closed
  })
})

describe('loopback admission with a provider', () => {
  it('keeps the fence, then lets the provider decide', async () => {
    const harness = await start()
    const loopback = { host: `127.0.0.1:${String(harness.loopbackPort)}` }
    expect((await send(harness.loopbackPort, '/peer', loopback)).body).toBe('401')
    harness.provider.loopback = { kind: 'refused', status: 403, code: 'ORIGIN_MISMATCH' }
    expect((await send(harness.loopbackPort, '/peer', loopback)).body).toBe('403')
    harness.provider.loopback = { kind: 'admitted', peer: harness.ctx.connection.browserPeer }
    expect((await send(harness.loopbackPort, '/peer', loopback)).body).toBe('admitted')
    // A foreign Host never reaches the provider.
    const seen = harness.provider.seen.length
    expect((await send(harness.loopbackPort, '/peer', { host: 'evil.example' })).body).toBe('403')
    expect(harness.provider.seen.length).toBe(seen)
  })
})
