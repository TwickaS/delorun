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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  Authenticator,
  apply,
  inject,
  type Admission,
  type ConnectionConfig,
  type ConnectionIndexRequest,
  HostConnectionService,
  type ListenerPolicy,
  type PeerScope,
  type ReachListener,
} from '../src/index.ts'
import { REACH_REFUSAL_STATUS, reachContentSecurityPolicy } from '../src/reach.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const LISTENER = 'reach-tailscale-private'
const ADDRESS = 'https://home.example.ts.net'
const HOST = 'home.example.ts.net'
const ORIGIN = ADDRESS
const SESSION = '__Host-delorun-session=signed-in'
/** A second session, of another device. */
const OTHER_SESSION = '__Host-delorun-session=other-device'

/** Identity header names a request or upgrade carried into a route, from every view of its headers. */
function identityHeadersSeen(req: { headers: object; headersDistinct: object; rawHeaders: string[] }): string[] {
  return [...Object.keys(req.headers), ...Object.keys(req.headersDistinct), ...req.rawHeaders.filter((_, at) => at % 2 === 0)]
    .filter(name => name.toLowerCase().startsWith('tailscale-'))
}

/** A provider that admits one session cookie and serves one reach listener. */
class TestAuthenticator extends Authenticator {
  readonly seen: ConnectionIndexRequest[] = []
  /** A pre-login route returned for every request, listed or not. */
  forcedPreLogin: ListenerPolicy['preLogin'][number] | undefined
  loopback: Admission | undefined
  /** The loopback listener's policy, when the test gives one. */
  loopbackPolicy: ListenerPolicy | undefined
  served = true
  /** The `location` every reach refusal names, when the test gives one. */
  refusalLocation: string | undefined
  private peer: PeerScope | undefined

  constructor(ctx: Context, private readonly address = ADDRESS) {
    super(ctx)
  }

  policy(listener: string): ListenerPolicy | undefined {
    if (listener === 'loopback') return this.loopbackPolicy
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
    if (listener !== LISTENER) return this.loopback ?? this.ctx.connection.builtinAdmission(request)
    const cookie = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
    if (cookie === SESSION) {
      this.peer ??= this.ctx.connection.createPeer({ principal: { kind: 'owner' } })
      return { kind: 'admitted', peer: this.peer, deviceId: 'device', sessionId: 'session', setCookie: `${SESSION}; Path=/; Secure; HttpOnly; SameSite=Strict` }
    }
    if (cookie === OTHER_SESSION) {
      this.peer ??= this.ctx.connection.createPeer({ principal: { kind: 'owner' } })
      return { kind: 'admitted', peer: this.peer, deviceId: 'other-device', sessionId: 'other-session' }
    }
    if (this.forcedPreLogin !== undefined) return { kind: 'pre-login', route: this.forcedPreLogin }
    const path = new URL(request.url ?? '/', 'http://x').pathname
    for (const route of this.policy(LISTENER)?.preLogin ?? []) {
      const base = route.path.replace(/\/<[^>]+>$/, '')
      if (request.method === route.method && (path === route.path || (base !== route.path && path.startsWith(`${base}/`)))) {
        return { kind: 'pre-login', route }
      }
    }
    return { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN', ...this.refusalLocation === undefined ? {} : { location: this.refusalLocation } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly ran: string[]
  /** Identity header names the `/socket` upgrade handler saw. */
  readonly identity: string[]
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
async function start(address = ADDRESS, config: ConnectionConfig = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ inject: [...inject], apply }, config)
  const ran: string[] = []
  const identity: string[] = []
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
  ctx.webServer.registerUpgrade({ path: '/socket', handler: (req, socket) => {
    ran.push('upgrade')
    identity.push(...identityHeadersSeen(req))
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
  } })
  // An upgrade and a response that stay open, as an event stream and a WebSocket do.
  ctx.webServer.registerUpgrade({ path: '/held-socket', handler: (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
  } })
  ctx.webServer.register({ kind: 'exact', path: '/stream', handler: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: open\n\n')
  } })
  ctx.webServer.register({ kind: 'exact', path: '/index-probe', handler: (req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) res.end('index')
  } })
  ctx.webServer.register({ kind: 'exact', path: '/headers', handler: (req, res) => {
    res.end(JSON.stringify(identityHeadersSeen(req)))
  } })
  ctx.webServer.registerFallback((_req, res) => { ran.push('fallback'); res.end('fallback') })
  let provider: TestAuthenticator | undefined
  const providerFiber = ctx.plugin({ inject: ['connection'], apply: (providerCtx: Context) => { provider = new TestAuthenticator(providerCtx, address) } })
  await providerFiber
  if (provider === undefined) throw new Error('provider did not load')
  const reach = await ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
  return { ctx, ran, identity, provider, providerFiber, reach, loopbackPort: ctx.webServer.port ?? 0 }
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

  it('answers a refusal that names a same-origin location with 303 to a GET or HEAD request, and with JSON otherwise', async () => {
    const harness = await start()
    const port = reachPort(harness)
    harness.provider.refusalLocation = '/auth/sign-in?next=%2Fchat'
    for (const method of ['GET', 'HEAD']) {
      const reply = await send(port, '/chat', {}, method)
      expect({ status: reply.status, location: reply.headers.location, body: reply.body }).toEqual({ status: 303, location: '/auth/sign-in?next=%2Fchat', body: '' })
      expect(reply.headers['strict-transport-security']).toBe('max-age=31536000')
    }
    // Pins the method rule: a state change, and an upgrade, keep the JSON refusal a script reads.
    expectRefusal(await send(port, '/chat', { origin: ORIGIN }, 'POST'), 'NOT_SIGNED_IN')
    expect(await upgrade(port, { origin: ORIGIN })).toMatch(/^HTTP\/1\.1 401 /)
    // Pins the same-origin rule: a location another authority could be read from keeps the JSON refusal.
    for (const location of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', '/a b', '/a\u0000b', 'auth/sign-in', '']) {
      harness.provider.refusalLocation = location
      expectRefusal(await send(port, '/chat'), 'NOT_SIGNED_IN')
    }
    expect(harness.ran).toEqual([])
  })

  it('dispatches an admitted request with the provider\'s Peer and its rolled cookie', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const exact = await send(port, '/exact', { cookie: SESSION })
    expect(exact.body).toBe('exact')
    expect(exact.headers['set-cookie']?.[0]).toMatch(/^__Host-delorun-session=signed-in;/)
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

  it('consumes a one-time launch token it refuses, so the loopback listener refuses it too', async () => {
    const harness = await start(ADDRESS, { oneTimeLaunchTokens: true })
    expect(harness.ctx.connection.oneTimeLaunchTokens).toBe(true)
    const loopback = { host: `127.0.0.1:${String(harness.loopbackPort)}` }
    const mint = (): string => new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.loopbackPort)}/`)).search
    const presented = mint()
    expectRefusal(await send(reachPort(harness), `/${presented}`), 'LAUNCH_TOKEN_REFUSED')
    expect((await send(harness.loopbackPort, `/connect${presented}`, loopback)).status).toBe(401)
    expect((await send(harness.loopbackPort, `/connect${mint()}`, loopback)).status).toBe(302)
  })

  it('consumes a one-time launch token wherever a loopback request presents it and is refused', async () => {
    const harness = await start(ADDRESS, { oneTimeLaunchTokens: true })
    const loopback = { host: `127.0.0.1:${String(harness.loopbackPort)}` }
    const mint = (): string => new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.loopbackPort)}/`)).search
    const spentBy = async (path: string, headers: Record<string, string>, before?: () => void): Promise<number> => {
      const token = mint()
      before?.()
      const refused = await send(harness.loopbackPort, `${path}${token}`, headers)
      harness.provider.loopbackPolicy = undefined
      expect((await send(harness.loopbackPort, `/connect${token}`, loopback)).status).toBe(401)
      return refused.status
    }
    // The trust fence, a provider policy that refuses launch tokens, an asset path, `/api` and an index route.
    expect(await spentBy('/connect', { host: 'evil.example' })).toBe(403)
    const refusing = (): void => { harness.provider.loopbackPolicy = { listener: 'loopback', scheme: 'http', hostRule: { kind: 'upstream-fence' }, acceptsLaunchToken: false, preLogin: [] } }
    expect(await spentBy('/connect', loopback, refusing)).toBe(401)
    expect(await spentBy('/index-probe', loopback, refusing)).toBe(401)
    expect(await spentBy('/index-probe', loopback)).toBe(401)
    expect(await spentBy('/plugins/x/client.js', loopback)).toBe(200)
    expect(await spentBy(`${API_PATH}/session.list`, loopback)).toBe(401)
    expect(await spentBy('/exact', loopback)).toBe(200)
    expect((await send(harness.loopbackPort, `/connect${mint()}`, loopback)).status).toBe(302)
    expect(() => { (harness.ctx.connection as HostConnectionService).consumeStrayLaunchTokens({ url: 'http://[', headers: {} }) }).not.toThrow()
  })

  it('subscribes to webserver/request only with one-time launch tokens on', async () => {
    const stray = vi.spyOn(HostConnectionService.prototype, 'consumeStrayLaunchTokens')
    const parity = await start(ADDRESS)
    expect((await send(parity.loopbackPort, '/exact?token=x', { host: `127.0.0.1:${String(parity.loopbackPort)}` })).status).toBe(200)
    expect(stray).not.toHaveBeenCalled()
    const delorun = await start(ADDRESS, { oneTimeLaunchTokens: true })
    expect((await send(delorun.loopbackPort, '/exact?token=x', { host: `127.0.0.1:${String(delorun.loopbackPort)}` })).status).toBe(200)
    expect(stray).toHaveBeenCalledOnce()
    stray.mockRestore()
  })

  it('refuses a reach request with more than four token values without reading them', async () => {
    const harness = await start(ADDRESS, { oneTimeLaunchTokens: true })
    const token = new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.loopbackPort)}/`)).searchParams.get('token') ?? ''
    expectRefusal(await send(reachPort(harness), `/?${['a', 'b', 'c', 'd', token].map(value => `token=${value}`).join('&')}`), 'LAUNCH_TOKEN_REFUSED')
    expect((await send(harness.loopbackPort, `/connect?token=${token}`, { host: `127.0.0.1:${String(harness.loopbackPort)}` })).status).toBe(302)
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

/** A raw request on a new connection; resolves with the first bytes of the reply and the open socket. */
/** One raw exchange: the reply's first bytes, the still-open socket, and its close. */
interface RawExchange {
  readonly reply: string
  readonly socket: ReturnType<typeof connect>
  readonly closed: Promise<unknown>
}

async function raw(port: number, text: string): Promise<RawExchange> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  const closed = new Promise((resolve) => { socket.once('close', resolve) })
  await once(socket, 'connect')
  socket.write(text)
  const [data] = await once(socket, 'data') as [Buffer]
  return { reply: String(data), socket, closed }
}

describe('reach dispatch hardening', () => {
  it('removes identity headers from every view before a route or an upgrade handler reads them', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const forged = { 'Tailscale-User-Login': 'owner@example.com', 'tailscale-user-name': 'Owner' }
    const reply = await send(port, '/headers', { cookie: SESSION, ...forged })
    expect({ status: reply.status, body: reply.body }).toEqual({ status: 200, body: '[]' })
    expect(await upgrade(port, { cookie: SESSION, origin: ORIGIN, ...forged })).toMatch(/^HTTP\/1\.1 101 /)
    expect(harness.identity).toEqual([])
    expect(harness.ran).toEqual(['upgrade'])
  })

  it('refuses an absolute or scheme-relative request target and a second Host header', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const tail = `Host: ${HOST}\r\nCookie: ${SESSION}\r\nConnection: close\r\n\r\n`
    for (const line of ['GET http://evil.example/exact HTTP/1.1', `GET https://${HOST}/exact HTTP/1.1`, 'GET //evil.example/exact HTTP/1.1']) {
      expect((await raw(port, `${line}\r\n${tail}`)).reply).toMatch(/^HTTP\/1\.1 421 [\s\S]*HOST_MISMATCH/)
    }
    // The webserver answers a repeated Host line 400 before the reach gate runs.
    expect((await raw(port, `GET /exact HTTP/1.1\r\nHost: ${HOST}\r\nHost: evil.example\r\nCookie: ${SESSION}\r\nConnection: close\r\n\r\n`)).reply)
      .toMatch(/^HTTP\/1\.1 400 [\s\S]*repeated Host header/)
    expect(harness.ran).toEqual([])
  })

  it.each([
    ['announced while the listener binds', true, false],
    ['made without an announcement before the listener is bound', false, false],
    ['announced while the listener binds, even when restored before it is bound', true, true],
  ])('opens no listener when the provider withdraws the policy, %s', async (_name, announce, restore) => {
    const harness = await start()
    await harness.reach.close()
    const server = harness.ctx.webServer
    const openListener = server.openListener.bind(server)
    server.openListener = async (options) => {
      harness.provider.served = false
      if (announce) harness.ctx.emit('authenticator/policy', LISTENER)
      if (restore) harness.provider.served = true
      return openListener(options)
    }
    await expect(harness.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })).rejects.toThrow(/lost its policy|not served/)
    server.openListener = openListener
    harness.provider.served = true
    // Nothing kept the id: the owner can open the listener again.
    const reopened = await harness.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
    expect((await send(reopened.address?.port ?? 0, '/exact', { cookie: SESSION })).body).toBe('exact')
  })

  it('closes the open streams and upgraded sockets admitted for a session or a device, and no others', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const stream = await raw(port, `GET /stream HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${SESSION}\r\n\r\n`)
    const socket = await raw(port, `GET /held-socket HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nCookie: ${SESSION}\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n`)
    const other = await raw(port, `GET /stream HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${OTHER_SESSION}\r\n\r\n`)
    expect([stream.reply, socket.reply, other.reply].map(reply => reply.split('\r\n')[0])).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 101 Switching Protocols', 'HTTP/1.1 200 OK'])
    expect(harness.ctx.connection.closeReachConnections({ sessionId: 'session' })).toBe(2)
    await Promise.all([stream.closed, socket.closed])
    expect(other.socket.destroyed).toBe(false)
    expect(harness.ctx.connection.closeReachConnections({ sessionId: 'session' })).toBe(0)
    expect(harness.ctx.connection.closeReachConnections({ deviceId: 'other-device' })).toBe(1)
    await other.closed
  })
})

describe('loopback admission with a provider, beyond the fence', () => {
  it('adds the provider\'s rolled credential to /api and index responses', async () => {
    const harness = await start()
    const loopback = { host: `127.0.0.1:${String(harness.loopbackPort)}` }
    // A browser attaches Origin to every non-GET request; the fence requires it of a state-changing /api call.
    const loopbackPost = { ...loopback, origin: `http://127.0.0.1:${String(harness.loopbackPort)}` }
    harness.provider.loopback = { kind: 'admitted', peer: harness.ctx.connection.browserPeer, setCookie: 'dsh-auth-rolled=1; Path=/; HttpOnly' }
    expect((await send(harness.loopbackPort, `${API_PATH}/session.list`, loopbackPost, 'POST')).headers['set-cookie']).toEqual(['dsh-auth-rolled=1; Path=/; HttpOnly'])
    const index = await send(harness.loopbackPort, '/index-probe', loopback)
    expect({ body: index.body, cookie: index.headers['set-cookie'] }).toEqual({ body: 'index', cookie: ['dsh-auth-rolled=1; Path=/; HttpOnly'] })
  })

  it('admits loopback index requests through the provider, and exchanges the launch token only while its policy accepts it', async () => {
    const harness = await start()
    const loopback = { host: `127.0.0.1:${String(harness.loopbackPort)}` }
    harness.provider.loopback = { kind: 'refused', status: 401, code: 'SESSION_EXPIRED' }
    expect((await send(harness.loopbackPort, '/index-probe', loopback)).status).toBe(401)
    harness.provider.loopback = { kind: 'admitted', peer: harness.ctx.connection.browserPeer }
    expect((await send(harness.loopbackPort, '/index-probe', loopback)).body).toBe('index')
    const token = new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.loopbackPort)}/`)).search
    harness.provider.loopbackPolicy = { listener: 'loopback', scheme: 'http', hostRule: { kind: 'upstream-fence' }, acceptsLaunchToken: false, preLogin: [] }
    const refusedConnect = await send(harness.loopbackPort, `/connect${token}`, loopback)
    expect({ status: refusedConnect.status, cookie: refusedConnect.headers['set-cookie'] }).toEqual({ status: 401, cookie: undefined })
    harness.provider.loopbackPolicy = { listener: 'loopback', scheme: 'http', hostRule: { kind: 'upstream-fence' }, acceptsLaunchToken: true, preLogin: [] }
    expect((await send(harness.loopbackPort, `/connect${token}`, loopback)).status).toBe(302)
  })
})

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

/** The nonce a reach response's policy names, after checking the policy's other directives. */
function policyNonce(reply: Reply): string {
  const policy = String(reply.headers['content-security-policy'])
  const nonce = /'nonce-([A-Za-z0-9_-]{22})'/.exec(policy)?.[1] ?? ''
  expect(policy).toBe([
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' data:", "font-src 'self' data:",
    "connect-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'", "frame-src 'self' blob:", "frame-ancestors 'none'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    "require-trusted-types-for 'script'", 'trusted-types default delorun-plugin-loader delorun-blob-worker',
  ].join('; '))
  expect(reachContentSecurityPolicy(nonce)).toBe(policy)
  return nonce
}

describe('reach response headers', () => {
  it('sends the security headers and a fresh nonce on every response, admitted, pre-login or refused', async () => {
    const harness = await start()
    const port = reachPort(harness)
    const replies = [
      await send(port, '/exact', { cookie: SESSION }),
      await send(port, '/auth/sign-in'),
      await send(port, '/exact'),
      await send(port, '/exact', { host: 'evil.example' }),
    ]
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 401, 421])
    for (const reply of replies) expect(reply.headers).toMatchObject(SECURITY_HEADERS)
    const nonces = replies.map(policyNonce)
    expect(new Set(nonces).size).toBe(nonces.length)
    expect(await upgrade(port, {})).toMatch(/content-security-policy: default-src 'self'[\s\S]*strict-transport-security: max-age=31536000/)
  })

  it('marks /auth/ and /api responses no-store', async () => {
    const harness = await start()
    const port = reachPort(harness)
    expect((await send(port, '/auth/sign-in')).headers['cache-control']).toBe('no-store')
    expect((await send(port, `${API_PATH}/session.list`, { cookie: SESSION })).headers['cache-control']).toBe('no-store')
    expect((await send(port, '/exact', { cookie: SESSION })).headers['cache-control']).toBeUndefined()
  })

  it('declares placeholders for remote media only on pages rendered for a Peer a reach listener admitted', async () => {
    const harness = await start()
    harness.ctx.webServer.register({ kind: 'exact', path: '/page', resource: (_request, peer) => Promise.resolve(new Response(
      harness.ctx.webServer.renderIndex('<html><head></head><body></body></html>', peer ?? harness.ctx.connection.browserPeer),
    )) })
    const page = await send(reachPort(harness), '/page', { cookie: SESSION })
    const nonce = policyNonce(page)
    expect(page.body).toContain(`<script nonce="${nonce}">globalThis["__DSH_REMOTE_MEDIA__"] = "placeholder"</script>`)
    expect(page.body).not.toMatch(/<script>/)
    const loopback = await send(harness.loopbackPort, '/page', { host: `127.0.0.1:${String(harness.loopbackPort)}` })
    expect(loopback.status).toBe(200)
    expect(loopback.body).not.toContain('__DSH_REMOTE_MEDIA__')
    expect(loopback.headers['content-security-policy']).toBeUndefined()
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
