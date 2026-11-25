/**
 * Reach listeners: additional web server listeners that admit every request
 * and upgrade request through `ctx.authenticator` before any route, upgrade
 * handler or the fallback runs. The dispatcher applies, in order, identity
 * header removal, the `Host` rule, the SNI rule, the `Origin` rule, the
 * refusal of the loopback listener's credentials, and admission.
 * @module @deepseek-ai/dsh-client-connection/src/reach
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import { BlockList } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import type { Context } from '@deepseek-ai/cordis'
import type { WebGateDecision, WebGateRefusal, WebListener, WebListenerBind, WebRouteKind } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { LOOPBACK_LISTENER, type Admission, type Authenticator, type ListenerPolicy, type PreLoginRoute } from './authenticator.ts'
import type { ConnectionTrustRequest, HostConnectionHandle } from './rpc.ts'
import { CONNECT_PATH } from './connect-protocol.ts'
import { isLoopbackHostname } from './loopback-hostname.ts'

/** Refusal codes a reach listener's dispatcher answers with, and their statuses. */
export const REACH_REFUSAL_STATUS = {
  HOST_MISMATCH: 421,
  SNI_MISMATCH: 421,
  ORIGIN_MISMATCH: 403,
  LAUNCH_TOKEN_REFUSED: 401,
  CONNECT_REFUSED: 401,
  UPSTREAM_COOKIE_REFUSED: 401,
  NOT_SIGNED_IN: 401,
} as const

/** One refusal code of {@link REACH_REFUSAL_STATUS}. */
export type ReachRefusalCode = keyof typeof REACH_REFUSAL_STATUS

/** Bytes of randomness in a reach response's Content Security Policy nonce. */
const NONCE_BYTES = 16

/**
 * The Content Security Policy of one reach response. It keeps every request
 * the page makes on its own origin, images to the origin, `data:` and `blob:`
 * URLs, media to the origin and `data:` URLs, and inline elements to those
 * carrying the response's nonce. It never allows string evaluation, and it
 * enforces Trusted Types with the two policies C4 names: `default`, whose
 * `createHTML` sanitises the markup upstream components and community client
 * plugins assign to `innerHTML`, and `delorun-plugin-loader`, which the client
 * module loader assigns `script.src` through.
 * @param nonce - the response's nonce, base64url.
 * @returns the header value.
 */
export function reachContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
    'trusted-types default delorun-plugin-loader delorun-blob-worker',
  ].join('; ')
}

/** The headers every reach response carries, with a fresh nonce; `no-store` also on `/auth/` and `/api` paths. */
function reachHeaders(pathname: string): { readonly nonce: string; readonly headers: OutgoingHttpHeaders } {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url')
  const headers: OutgoingHttpHeaders = {
    'content-security-policy': reachContentSecurityPolicy(nonce),
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  }
  if (pathname.startsWith('/auth/') || pathname === '/api' || pathname.startsWith('/api/')) headers['cache-control'] = 'no-store'
  return { nonce, headers }
}

/** Prefix of the request headers a reach listener removes before admission, compared in lower case. */
const IDENTITY_HEADER_PREFIX = 'tailscale-'
/** Prefix of the loopback listener's cookie names, refused on every reach listener. */
const UPSTREAM_COOKIE_PREFIX = 'dsh-auth-'
/** Query parameter carrying the loopback listener's launch token. */
const TOKEN_QUERY = 'token'

/** Options of {@link HostConnectionAdmission.openReachListener}. */
export interface ReachListenerOptions {
  /** A reach listener id, which the provider's {@link Authenticator.policy} serves; never `loopback`. */
  readonly listener: string
  /**
   * `loopback` for a listener whose `Host` rule is `equals-address`, `streams`
   * for one whose rule is `equals-bound-name-and-sni`.
   */
  readonly bind: WebListenerBind
}

/** An open reach listener. */
export interface ReachListener {
  readonly listener: string
  /** The bound address of a `loopback` binding; `undefined` for `streams`. */
  readonly address: WebListener['address']
  /**
   * Hand one accepted byte stream to a `streams` binding, which ends TLS on it.
   * @param stream - a connected duplex stream carrying TLS records.
   */
  accept(stream: Duplex): void
  /**
   * Settles once the listener has stopped and every connection it accepted has
   * closed: after {@link close}, when the Context that opened it is disposed,
   * when its authenticator provider is removed or replaced, or when the provider
   * stops serving it.
   */
  readonly closed: Promise<void>
  /**
   * Stop the listener.
   * @returns {@link closed}.
   */
  close(): Promise<void>
}

/** Host `ctx.connection`: the transport handle with the members for admission providers and reach listeners. */
export interface HostConnectionAdmission extends HostConnectionHandle {
  /**
   * Connection's built-in loopback admission, which applies while no
   * `authenticator` provider is loaded and which a provider may delegate its
   * loopback decisions to: a valid signed browser cookie admits the shared
   * owner Peer, a valid API cookie admits its live API Peer, and anything else
   * is refused 401. It applies no Host or Origin fence; Connection applies the
   * fence before it calls the provider.
   * @param request - the loopback request's headers.
   * @returns the admission.
   */
  builtinAdmission(request: ConnectionTrustRequest): Admission

  /**
   * Destroy every open reach connection that carried a request the provider
   * admitted for this session or device, streams and upgraded sockets
   * included, as a session's revocation or a device's removal requires.
   * @param match - a session id, a device id, or both.
   * @returns how many connections were destroyed.
   */
  closeReachConnections(match: { readonly sessionId?: string; readonly deviceId?: string }): number
  /**
   * Open one reach listener, owned by the Context that read `ctx.connection`.
   * It needs a loaded `authenticator` provider that serves the listener, and
   * stops when that provider is removed or replaced.
   * @param options - the reach listener id and its binding.
   * @returns the open listener.
   */
  openReachListener(options: ReachListenerOptions): Promise<ReachListener>
}

/** A validated reach policy with the values the dispatcher compares. */
interface ReachRule {
  readonly policy: ListenerPolicy
  /** Lower-case `Host` the rule accepts: the address's host, with its port when not 443. */
  readonly host: string
  /** Lower-case hostname the SNI must equal, for `equals-bound-name-and-sni`. */
  readonly sni: string | undefined
  /** The address's origin, which an `Origin` header must equal. */
  readonly origin: string
}

const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

/** Whether a WHATWG hostname names this machine: a loopback name or any loopback address. */
function isLoopbackName(hostname: string): boolean {
  if (isLoopbackHostname(hostname) || hostname.endsWith('.localhost')) return true
  if (hostname.startsWith('[') && hostname.endsWith(']')) return LOOPBACK_ADDRESSES.check(hostname.slice(1, -1), 'ipv6')
  return false
}

/** A pre-login path pattern split into its static part and whether a final `<…>` segment follows. */
function preLoginPattern(path: string): { readonly base: string; readonly segment: boolean } | undefined {
  if (!path.startsWith('/') || path.endsWith('/')) return undefined
  const segments = path.slice(1).split('/')
  const last = segments.at(-1) ?? ''
  const segment = /^<[^<>/]+>$/.test(last)
  const fixed = segment ? segments.slice(0, -1) : segments
  if (fixed.length === 0 || fixed.some(part => part === '' || part.includes('<') || part.includes('>'))) return undefined
  return { base: `/${fixed.join('/')}`, segment }
}

/**
 * Validate one reach listener's policy and binding.
 * @param id - the reach listener id.
 * @param bind - the binding it opens with.
 * @param policy - the provider's policy for `id`.
 * @returns the rule the dispatcher applies.
 * @throws when the provider does not serve `id`, or its policy is not a reach policy for this binding.
 */
function reachRule(id: string, bind: WebListenerBind, policy: ListenerPolicy | undefined): ReachRule {
  const fail = (reason: string): never => {
    throw new Error(`connection: reach listener ${JSON.stringify(id)} ${reason}`)
  }
  if (policy === undefined) return fail('is not served by the authenticator provider')
  if (policy.listener !== id) fail(`received the policy of ${JSON.stringify(policy.listener)}`)
  if (policy.scheme !== 'https') fail('must declare the https scheme')
  if (policy.acceptsLaunchToken) fail('must not accept the launch token')
  const rule = policy.hostRule
  if (rule.kind === 'upstream-fence') return fail('must not use the loopback listener\'s Host fence')
  const expectedBind = rule.kind === 'equals-address' ? 'loopback' : 'streams'
  if (bind.kind !== expectedBind) fail(`with Host rule ${rule.kind} must bind ${expectedBind}`)
  let address: URL
  try {
    address = new URL(rule.address)
  } catch {
    return fail(`has an address that is not a URL: ${JSON.stringify(rule.address)}`)
  }
  if (address.protocol !== 'https:' || address.origin !== rule.address.toLowerCase()) {
    fail(`has an address that is not an https origin: ${JSON.stringify(rule.address)}`)
  }
  if (isLoopbackName(address.hostname)) fail(`has a loopback address: ${JSON.stringify(rule.address)}`)
  for (const route of policy.preLogin) {
    if (preLoginPattern(route.path) === undefined) {
      fail(`has a malformed pre-login route: ${route.method} ${JSON.stringify(route.path)}`)
    }
  }
  return {
    policy,
    host: address.host,
    sni: rule.kind === 'equals-bound-name-and-sni' ? address.hostname : undefined,
    origin: address.origin,
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : value?.join(', ')
}

/**
 * Remove every identity header from every view of a request's headers. Both
 * parsed views are read first, so node:http has cached them before the raw
 * list shrinks; a view computed later from a shorter raw list throws.
 */
function removeIdentityHeaders(request: IncomingMessage): void {
  const views = [request.headers, request.headersDistinct]
  for (const view of views) {
    for (const name of Object.keys(view)) {
      if (name.startsWith(IDENTITY_HEADER_PREFIX)) Reflect.deleteProperty(view, name)
    }
  }
  const raw = request.rawHeaders
  for (let at = raw.length - 2; at >= 0; at -= 2) {
    if (raw[at]?.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX) === true) raw.splice(at, 2)
  }
}

function carriesUpstreamCookie(request: IncomingMessage): boolean {
  const cookie = header(request, 'cookie')
  if (cookie === undefined) return false
  return cookie.split(';').some(pair => pair.trimStart().toLowerCase().startsWith(UPSTREAM_COOKIE_PREFIX))
}

/** The webserver route a request matching `route` may reach, or `undefined` when it does not match. */
function preLoginTarget(
  route: PreLoginRoute,
  method: string | undefined,
  pathname: string,
): { readonly kind: WebRouteKind; readonly path: string } | undefined {
  const pattern = preLoginPattern(route.path)
  if (pattern === undefined || method !== route.method) return undefined
  if (!pattern.segment) return pathname === pattern.base ? { kind: 'exact', path: pattern.base } : undefined
  const rest = pathname.startsWith(`${pattern.base}/`) ? pathname.slice(pattern.base.length + 1) : ''
  return rest !== '' && !rest.includes('/') ? { kind: 'prefix', path: pattern.base } : undefined
}

/**
 * A path on the listener's own origin that a refused admission may redirect a browser to: one leading `/` not followed by
 * `/` or `\`, and no `\`, control character or space anywhere, so no browser reads it as another authority.
 */
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\\\u0000-\u0020\u007f]*$/u

function refusalBody(code: string): string {
  return JSON.stringify({ error: code })
}

function refusal(status: number, code: string, security: OutgoingHttpHeaders): WebGateRefusal {
  return {
    status,
    headers: { ...security, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: refusalBody(code),
  }
}

/** Which sessions and devices one open reach connection was admitted for. */
interface ReachConnection {
  readonly sessions: Set<string>
  readonly devices: Set<string>
}

/** What every reach listener of one Connection records, which Connection's admission reads. */
export class ReachState {
  /**
   * @param consumeLaunchTokens - consumes the one-time launch tokens a reach request presents, which no reach
   *   listener exchanges.
   */
  constructor(readonly consumeLaunchTokens: (presented: readonly string[]) => void) {}

  /** Requests a reach listener dispatched, with the Peer each was admitted for, or `undefined` for pre-login. */
  readonly requests = new WeakMap<object, PeerScope | undefined>()
  /** Peers a reach dispatcher admitted. */
  readonly peers = new WeakSet<PeerScope>()
  /** Open connections that carried an admitted request, with what they were admitted for. */
  readonly connections = new Map<Duplex, ReachConnection>()

  /**
   * Destroy every open reach connection that carried a request admitted for the session or the device.
   * @param match - a session id, a device id, or both.
   * @returns how many connections were destroyed.
   */
  closeConnections(match: { readonly sessionId?: string; readonly deviceId?: string }): number {
    let closed = 0
    for (const [socket, connection] of this.connections) {
      const session = match.sessionId !== undefined && connection.sessions.has(match.sessionId)
      const device = match.deviceId !== undefined && connection.devices.has(match.deviceId)
      if (!session && !device) continue
      this.connections.delete(socket)
      socket.destroy()
      closed += 1
    }
    return closed
  }

  /**
   * Record that a connection carried a request admitted for a session and a device.
   * @param socket - the connection that carried the request.
   * @param admission - the session id and the device id the request was admitted for, when it named them.
   */
  admitted(socket: Duplex, admission: { readonly sessionId?: string; readonly deviceId?: string }): void {
    let connection = this.connections.get(socket)
    if (connection === undefined) {
      connection = { sessions: new Set(), devices: new Set() }
      this.connections.set(socket, connection)
      socket.once('close', () => { this.connections.delete(socket) })
    }
    if (admission.sessionId !== undefined) connection.sessions.add(admission.sessionId)
    if (admission.deviceId !== undefined) connection.devices.add(admission.deviceId)
  }
}

/** The dispatcher of one reach listener: the gate the web server calls before any route. */
class ReachDispatcher {
  private stopped = false

  constructor(
    private readonly id: string,
    private readonly authenticator: Authenticator,
    private rule: ReachRule,
    private readonly state: ReachState,
  ) {}

  /** Refuse every later request; the listener is closing. */
  stop(): void {
    this.stopped = true
  }

  /** Whether the dispatcher refuses every request because its listener is closing. */
  get isStopped(): boolean {
    return this.stopped
  }

  /** Replace the rule after the provider announced a policy change. */
  update(rule: ReachRule): void {
    this.rule = rule
  }

  gate(request: IncomingMessage, kind: 'request' | 'upgrade'): WebGateDecision {
    /* v8 ignore next -- node:http always sets url on server requests. */
    const target = new URL(request.url ?? '/', 'http://reach.invalid')
    const { nonce, headers: security } = reachHeaders(target.pathname)
    const refuse = (code: ReachRefusalCode): WebGateDecision => ({ kind: 'refuse', ...refusal(REACH_REFUSAL_STATUS[code], code, security) })
    const presented = target.searchParams.getAll(TOKEN_QUERY)
    if (presented.length > 0) this.state.consumeLaunchTokens(presented)
    if (this.stopped) return refuse('NOT_SIGNED_IN')
    removeIdentityHeaders(request)
    const rule = this.rule
    // Only an origin-form target: an absolute or scheme-relative one names an authority the Host rule did not check.
    const raw = request.url ?? '/'
    if (!raw.startsWith('/') || raw.startsWith('//')) return refuse('HOST_MISMATCH')
    const host = header(request, 'host')?.toLowerCase()
    // A repeated Host line never reaches the gate: the web server answers it 400 first.
    if (host !== rule.host) return refuse('HOST_MISMATCH')
    if (rule.sni !== undefined) {
      const servername = (request.socket as Partial<TLSSocket>).servername
      if (typeof servername !== 'string' || servername.toLowerCase() !== rule.sni) return refuse('SNI_MISMATCH')
    }
    const origin = header(request, 'origin')
    if (origin === undefined ? kind === 'upgrade' : origin !== rule.origin) return refuse('ORIGIN_MISMATCH')
    if (header(request, 'sec-fetch-site') === 'cross-site') return refuse('ORIGIN_MISMATCH')
    if (target.searchParams.has(TOKEN_QUERY)) return refuse('LAUNCH_TOKEN_REFUSED')
    if (target.pathname === CONNECT_PATH) return refuse('CONNECT_REFUSED')
    if (carriesUpstreamCookie(request)) return refuse('UPSTREAM_COOKIE_REFUSED')
    const admission = this.authenticator.admit(request, this.id)
    switch (admission.kind) {
      case 'admitted': {
        this.state.requests.set(request, admission.peer)
        this.state.peers.add(admission.peer)
        this.state.admitted(request.socket, admission)
        // A 101 response is written by the upgrade handler, so a rolled cookie waits for the next HTTP request.
        if (admission.setCookie === undefined || kind === 'upgrade') return { kind: 'pass', peer: admission.peer, nonce, headers: security }
        return { kind: 'pass', peer: admission.peer, nonce, headers: { ...security, 'set-cookie': admission.setCookie } }
      }
      case 'pre-login': {
        const listed = rule.policy.preLogin.some(route => route.method === admission.route.method && route.path === admission.route.path)
        const route = listed && kind === 'request' ? preLoginTarget(admission.route, request.method, target.pathname) : undefined
        if (route === undefined) return refuse('NOT_SIGNED_IN')
        this.state.requests.set(request, undefined)
        return { kind: 'pass', nonce, headers: security, only: { route, refusal: refusal(REACH_REFUSAL_STATUS.NOT_SIGNED_IN, 'NOT_SIGNED_IN', security) } }
      }
      case 'refused':
        if (admission.location !== undefined && kind === 'request' && (request.method === 'GET' || request.method === 'HEAD') && SAME_ORIGIN_PATH.test(admission.location)) {
          return { kind: 'refuse', status: 303, headers: { ...security, location: admission.location, 'cache-control': 'no-store' }, body: '' }
        }
        return { kind: 'refuse', ...refusal(admission.status, admission.code, security) }
      default: {
        const unknown: never = admission
        throw new Error(`connection: unknown admission ${JSON.stringify(unknown)}`)
      }
    }
  }
}

/**
 * Open one reach listener for the Context `owner`. The listener lives in a
 * child fiber that injects `authenticator` and `webServer`, so it closes before
 * either provider is removed or replaced, and it never reopens by itself.
 * @param owner - the Context the listener belongs to.
 * @param reach - what every reach listener of this Connection records.
 * @param options - the listener id and binding.
 * @returns the open listener.
 * @throws when no authenticator is provided, the id is `loopback`, or the policy is not a valid reach policy.
 */
export async function openReachListener(owner: Context, reach: ReachState, options: ReachListenerOptions): Promise<ReachListener> {
  const id = options.listener
  if (id === LOOPBACK_LISTENER) throw new Error('connection: the loopback listener is not a reach listener')
  const opened = Promise.withResolvers<ReachListener>()
  const closed = Promise.withResolvers<undefined>()
  // A record, not a local flag, because the callback below sets it and TypeScript does not see that write.
  const state = { started: false }
  const fiber = owner.inject(['authenticator', 'webServer'], async (ctx) => {
    // A replacement provider never reopens this listener; its owner opens a new one.
    if (state.started) {
      queueMicrotask(() => { void fiber.dispose() })
      return
    }
    state.started = true
    try {
      const rule = reachRule(id, options.bind, ctx.authenticator.policy(id))
      const dispatcher = new ReachDispatcher(id, ctx.authenticator, rule, reach)
      // Subscribed before the bind, so a policy change while it binds is not missed.
      ctx.on('authenticator/policy', (changed) => {
        if (changed !== id) return
        try {
          dispatcher.update(reachRule(id, options.bind, ctx.authenticator.policy(id)))
        } catch (error) {
          dispatcher.stop()
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          void fiber.dispose()
        }
      })
      let web: WebListener | undefined
      await ctx.effect(async () => {
        const open = await ctx.webServer.openListener({
          id,
          bind: options.bind,
          gate: (request, kind) => dispatcher.gate(request, kind),
        })
        web = open
        return async () => {
          dispatcher.stop()
          await open.close()
          closed.resolve(undefined)
        }
      }, `client-connection: reach listener ${id}`)
      /* v8 ignore next -- the effect above assigns it or throws. */
      if (web === undefined) throw new Error(`connection: reach listener ${JSON.stringify(id)} did not open`)
      const bound = web
      // The policy as it stands once bound; a provider that stopped serving it meanwhile gets no listener.
      if (dispatcher.isStopped) throw new Error(`connection: reach listener ${JSON.stringify(id)} lost its policy while it opened`)
      dispatcher.update(reachRule(id, options.bind, ctx.authenticator.policy(id)))
      opened.resolve({
        listener: id,
        address: bound.address,
        accept: (stream) => { bound.accept(stream) },
        closed: closed.promise,
        close: async () => {
          await fiber.dispose()
          return closed.promise
        },
      })
    } catch (error) {
      // The caller receives the failure; the fiber that held the attempt ends.
      opened.reject(error)
      closed.resolve(undefined)
      queueMicrotask(() => { void fiber.dispose() })
    }
  })
  await fiber
  // A fiber whose services are missing stays pending without running its callback.
  if (!state.started) {
    await fiber.dispose()
    throw new Error(`connection: reach listener ${JSON.stringify(id)} needs an authenticator provider, and none is loaded`)
  }
  return opened.promise
}
