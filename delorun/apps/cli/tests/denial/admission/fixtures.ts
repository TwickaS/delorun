/**
 * Fixtures for the admission denial suite: a stand-in for `@delorun/home-auth`'s authenticator provider, a fixture
 * community plugin with its own route and upgrade, the three reach listeners opened over a booted studio, and clients
 * that send requests with exactly the headers a test names.
 */
import { once } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Context } from '@deepseek-ai/cordis'
import { LOOPBACK_LISTENER } from '@deepseek-ai/dsh-client-connection/authenticator'
import { Authenticator, type Admission, type ConnectionIndexRequest, type ListenerPolicy, type ReachListener } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { HOME_AUTH_PRE_LOGIN_ROUTES, REACH_SESSION_COOKIE, type PreLoginRoute, type ReachListenerId } from '@delorun/contract-admission'
import { createTestAuthority } from '@delorun/tools/src/stack/certificates.ts'

/** The studio address of each reach listener. */
export const ADDRESSES = {
  'reach-tailscale-private': 'https://home.example.ts.net',
  'reach-tailscale-funnel': 'https://home.example.ts.net:8443',
  'reach-self-hosted-relay': 'https://studio.example.org',
} as const satisfies Record<ReachListenerId, string>

/** The reach listener ids, in the order the suite opens them. */
export const REACH_LISTENERS = Object.keys(ADDRESSES) as ReachListenerId[]

/** The session token the stand-in admits on every reach listener. */
export const SESSION_TOKEN = 'stand-in-session-token'
/** The `Cookie` header carrying {@link SESSION_TOKEN}. */
export const SESSION_COOKIE = `${REACH_SESSION_COOKIE}=${SESSION_TOKEN}`

/** Configuration of the stand-in, as a profile's `home-auth` row would give it. */
export interface StandInConfig {
  /** Plugin routes the profile lists as pre-login. */
  preLoginRoutes: PreLoginRoute[]
  /** Routes plugins declare pre-login; the stand-in answers `pre-login` for them, which only a listed route survives. */
  declaredPreLogin: PreLoginRoute[]
}

function matches(route: PreLoginRoute, method: string | undefined, pathname: string): boolean {
  if (method !== route.method) return false
  const segment = /\/<[^>]+>$/.exec(route.path)
  if (segment === null) return pathname === route.path
  const base = route.path.slice(0, segment.index)
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : ''
  return rest !== '' && !rest.includes('/')
}

/**
 * A stand-in for `@delorun/home-auth`'s provider: one in-memory session admits one device Peer on every reach listener,
 * and the loopback listener delegates to Connection's built-in admission. It is a test double, not the provider.
 */
export class StandInHomeAuth extends Authenticator {
  readonly config: StandInConfig = { preLoginRoutes: [], declaredPreLogin: [] }
  /** Every request this provider was asked to admit, with its listener. */
  readonly seen: { readonly listener: string; readonly request: ConnectionIndexRequest }[] = []
  private device: PeerScope | undefined

  constructor(ctx: Context) {
    super(ctx)
  }

  policy(listener: string): ListenerPolicy | undefined {
    if (!(listener in ADDRESSES)) return undefined
    const id = listener as ReachListenerId
    return {
      listener: id,
      scheme: 'https',
      hostRule: id === 'reach-self-hosted-relay'
        ? { kind: 'equals-bound-name-and-sni', address: ADDRESSES[id] }
        : { kind: 'equals-address', address: ADDRESSES[id] },
      acceptsLaunchToken: false,
      preLogin: [...HOME_AUTH_PRE_LOGIN_ROUTES, ...this.config.preLoginRoutes],
    }
  }

  admit(request: ConnectionIndexRequest, listener: string): Admission {
    this.seen.push({ listener, request })
    if (listener === LOOPBACK_LISTENER) return this.ctx.connection.builtinAdmission(request)
    const cookie = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
    if (typeof cookie === 'string' && cookie.split(';').some(pair => pair.trim() === SESSION_COOKIE)) {
      this.device ??= this.ctx.connection.createPeer({ principal: { kind: 'owner' } })
      return { kind: 'admitted', peer: this.device, deviceId: 'stand-in-device', sessionId: 'stand-in-session' }
    }
    const pathname = new URL(request.url ?? '/', 'http://stand-in.invalid').pathname
    const route = [...HOME_AUTH_PRE_LOGIN_ROUTES, ...this.config.declaredPreLogin].find(candidate => matches(candidate, request.method, pathname))
    if (route !== undefined) return { kind: 'pre-login', route }
    return { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }
  }
}

/** What the fixture community plugin's handlers recorded. */
export interface FixturePlugin {
  /** One entry per handler that ran. */
  readonly ran: string[]
}

/**
 * A fixture community plugin: an exact route, a prefix route and an upgrade route on the web server, each recording
 * that it ran.
 * @param ctx - a Context that injects `webServer`.
 * @returns the record of handlers that ran.
 */
export function mountFixturePlugin(ctx: Context): FixturePlugin {
  const ran: string[] = []
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture-plugin/hello', handler: (_req, res) => {
    ran.push('exact')
    res.end('hello')
  } }), 'fixture plugin exact route')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/fixture-plugin/files', handler: (_req, res) => {
    ran.push('prefix')
    res.end('file')
  } }), 'fixture plugin prefix route')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/fixture-plugin/socket', handler: (_req, socket) => {
    ran.push('upgrade')
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
  } }), 'fixture plugin upgrade route')
  return { ran }
}

/** One reply as the client received it. */
export interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  /** The raw status line and headers of an upgrade reply. */
  readonly raw: string
}

/** A way to reach one listener. */
export interface Endpoint {
  readonly listener: string
  /** The `Host` its rule accepts. */
  readonly host: string
  /** The origin its rule accepts. */
  readonly origin: string
  /**
   * Send one request with exactly these headers; `host` defaults to {@link host}.
   * @param path - request target.
   * @param headers - request headers.
   * @param options - the method, an upgrade instead of a request, and the SNI on a TLS endpoint.
   */
  send(path: string, headers?: Record<string, string>, options?: { method?: string; upgrade?: boolean; servername?: string }): Promise<Reply>
}

/** Parse one HTTP/1.1 response read from a socket until it closed. */
function parseReply(text: string): Reply {
  const split = text.indexOf('\r\n\r\n')
  const head = split === -1 ? text : text.slice(0, split)
  const [statusLine = '', ...lines] = head.split('\r\n')
  const headers: IncomingHttpHeaders = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon !== -1) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  let body = split === -1 ? '' : text.slice(split + 4)
  if (headers['transfer-encoding'] === 'chunked') {
    let decoded = ''
    for (let rest = body; rest.length > 0;) {
      const end = rest.indexOf('\r\n')
      const size = Number.parseInt(rest.slice(0, end), 16)
      if (!(size > 0)) break
      decoded += rest.slice(end + 2, end + 2 + size)
      rest = rest.slice(end + 4 + size)
    }
    body = decoded
  }
  return { status: Number(statusLine.split(' ')[1] ?? 0), headers, body, raw: head }
}

/** Write one request on a connected socket and read until the server closes it. */
async function exchange(socket: TLSSocket | ReturnType<typeof connect>, method: string, path: string, headers: Record<string, string>, upgrade: boolean): Promise<Reply> {
  let received = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => { received += chunk })
  socket.on('error', () => {})
  const closed = new Promise((resolve) => { socket.once('close', resolve) })
  const all = { ...headers, connection: upgrade ? 'Upgrade' : 'close', ...(upgrade ? { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}) }
  const lines = Object.entries(all).map(([name, value]) => `${name}: ${value}`)
  socket.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
  if (upgrade) {
    // An accepted upgrade keeps the socket open; its status line is the answer.
    await Promise.race([closed, new Promise((resolve) => { socket.once('data', resolve) })])
    socket.destroy()
  } else {
    await closed
  }
  return parseReply(received)
}

/**
 * An endpoint for a TCP listener on `127.0.0.1`.
 * @param listener - the listener id.
 * @param port - its bound port.
 * @param address - the studio address its rule accepts.
 * @returns the endpoint.
 */
export function tcpEndpoint(listener: string, port: number, address: string): Endpoint {
  const url = new URL(address)
  return {
    listener,
    host: url.host,
    origin: url.origin,
    send: async (path, headers = {}, options = {}) => {
      const socket = connect(port, '127.0.0.1')
      await once(socket, 'connect')
      return exchange(socket, options.method ?? 'GET', path, { host: url.host, ...headers }, options.upgrade === true)
    },
  }
}

/** The relay listener's endpoint and the TCP server that hands its connections to the listener. */
export interface RelayEndpoint extends Endpoint {
  readonly close: () => Promise<void>
}

/**
 * Hand the relay listener streams from a TCP server on `127.0.0.1`, as the relay client hands it the relay's streams,
 * with a certificate for its studio address and for one other name from a test authority.
 * @param listener - the open relay listener.
 * @param ca - the test authority's certificate, which the client trusts.
 * @returns the endpoint.
 */
export async function relayEndpoint(listener: ReachListener, ca: string): Promise<RelayEndpoint> {
  const url = new URL(ADDRESSES['reach-self-hosted-relay'])
  const server: Server = createServer((socket) => {
    try {
      listener.accept(socket)
    } catch {
      // A stopped listener takes no stream, so the relay client drops it.
      socket.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    listener: listener.listener,
    host: url.host,
    origin: url.origin,
    send: async (path, headers = {}, options = {}) => {
      const socket = tlsConnect({ host: '127.0.0.1', port, servername: options.servername ?? url.hostname, ca })
      socket.on('error', () => {})
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('close', () => { reject(new Error('the relay stream closed before TLS completed')) })
      })
      return exchange(socket, options.method ?? 'GET', path, { host: url.host, ...headers }, options.upgrade === true)
    },
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}

/**
 * Certificate and key for the relay listener: its studio address and `other.example.org`.
 * @returns the PEM pair and the authority certificate a client trusts.
 */
export async function relayTls(): Promise<{ readonly cert: string; readonly key: string; readonly ca: string }> {
  const authority = await createTestAuthority('Delorun admission suite')
  const issued = await authority.issue({ dnsNames: [new URL(ADDRESSES['reach-self-hosted-relay']).hostname, 'other.example.org'] })
  if (issued.keyPem === undefined) throw new Error('the test authority returned no key')
  return { cert: issued.pem, key: issued.keyPem, ca: authority.certificate.pem }
}
