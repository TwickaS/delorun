/**
 * The relay data plane's core: the token endpoint, the tunnel upgrade, the one live tunnel a
 * name may have, and the routing of a browser connection to the home that registered it. A
 * browser connection reaches only the tunnel whose bound name equals the ClientHello's SNI; a
 * frame a home sends is resolved in that home's own stream map. The core takes no socket: the
 * Node adapters in `node/server.ts` and the specs' in-memory transports supply the connections.
 *
 * @module @delorun/relay/relay
 */
import { RELAY_PATHS, RELAY_SUBPROTOCOL, RELAY_LIMITS, type RelayId, type TunnelTokenClaims } from '@delorun/contract-relay-protocol'
import { randomBase64Url } from './keys.ts'
import type { RelaySettings } from './config.ts'
import { RelayError, httpStatusOf, isRelayError, type RelayErrorCode } from './errors.ts'
import { silentRelayLog, type RelayLog } from './log.ts'
import type { PeerAssertion } from './peer.ts'
import { Tunnel } from './tunnel.ts'
import { TunnelTokens } from './token.ts'
import { systemTimers, type BrowserConnection, type TimerSeam, type TunnelSocket } from './transport.ts'

/** What an upgrade request presents, as the transport reads it. */
export interface TunnelUpgrade {
  /** The `Sec-WebSocket-Protocol` value the home asked for, or `undefined`. */
  readonly subprotocol: string | undefined
  /** The `Authorization` value, which carries the tunnel token. */
  readonly authorization: string | undefined
  /** The peer facts the relay asserts for the home's connection. */
  readonly peer: PeerAssertion
}

/** The answer to an upgrade attempt. */
export type TunnelAcceptance =
  | { readonly accepted: true; readonly tunnelId: string }
  | { readonly accepted: false; readonly status: number; readonly code: RelayErrorCode; readonly detail?: string }

/** The answer to the pre-upgrade authorization step. */
export type TunnelAuthorization =
  | { readonly accepted: true; readonly claims: TunnelTokenClaims }
  | { readonly accepted: false; readonly status: number; readonly code: RelayErrorCode; readonly detail?: string }

/** What a browser connection's ClientHello earned. */
export type BrowserVerdict =
  | { readonly routed: 'opened'; readonly streamId: number }
  | { readonly routed: 'dropped'; readonly reason: 'no-live-tunnel' | 'stream-limit' }

/** The options of {@link RelayCore}. */
export interface RelayCoreOptions {
  /** The validated configuration. */
  readonly settings: RelaySettings
  /** The C20 `relay` log; a silent log by default. */
  readonly log?: RelayLog
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number
  /** The timers; the process's own by default. */
  readonly timers?: TimerSeam
  /** A tunnel id source; 16 random bytes as base64url by default. */
  readonly tunnelId?: () => string
}

/** The credential scheme of the tunnel path. */
const AUTHORIZATION_PREFIX = 'Delorun-Tunnel '

/**
 * The relay as one running process holds it. It owns the token issuer, the live tunnels by
 * name and the browser connections routed to them.
 */
export class RelayCore {
  /** The relay's id, the SHA-256 hash of its token public key. */
  readonly relayId: RelayId
  private readonly settings: RelaySettings
  private readonly log: RelayLog
  private readonly now: () => number
  private readonly timers: TimerSeam
  private readonly tunnelId: () => string
  private readonly tokens: TunnelTokens
  private readonly tunnels = new Map<string, Tunnel>()
  private readonly refusedPeers = new Map<string, PeerAssertion>()

  /**
   * @param options - the configuration, the log, the clock, the timers and the tunnel id source.
   */
  constructor(options: RelayCoreOptions) {
    this.settings = options.settings
    this.log = options.log ?? silentRelayLog
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? systemTimers
    this.tunnelId = options.tunnelId ?? (() => randomBase64Url(16))
    this.relayId = options.settings.relayId
    this.tokens = new TunnelTokens({
      tokenKey: options.settings.tokenKey,
      relayId: options.settings.relayId,
      bindings: options.settings.bindings,
      now: this.now,
      startedAt: options.settings.startedAt,
    })
  }

  /** The relay's own name, which only the token and tunnel paths answer on. */
  get tunnelHost(): string {
    return this.settings.tunnelHost
  }

  /** The bound names, in configuration order. */
  get boundNames(): readonly string[] {
    return [...this.settings.bindings.keys()]
  }

  /** The paths the tunnel host serves. */
  readonly paths = RELAY_PATHS

  /**
   * Answer `POST /v1/tunnel-token`.
   * @param body - the request body.
   * @returns the token.
   * @throws RelayError the token endpoint's refusals.
   */
  tokenRequest(body: Uint8Array): { readonly token: string } {
    return this.tokens.issue(body)
  }

  /**
   * Check an upgrade request before the transport upgrades it: the subprotocol, the token's
   * signature, expiry, single use and binding. An accepted request's token id is recorded, so
   * the token cannot be presented again.
   * @param upgrade - the subprotocol and the authorization value.
   * @returns the claims, or the refusal's HTTP status and code.
   */
  authorizeTunnel(upgrade: TunnelUpgrade): TunnelAuthorization {
    const refusal = (code: RelayErrorCode, detail: string): TunnelAuthorization => {
      const status = httpStatusOf(code)
      this.log.warn('tunnel upgrade refused', { code, status: status ?? 0 })
      return status === undefined ? { accepted: false, status: 400, code, detail } : { accepted: false, status, code, detail }
    }
    if (upgrade.subprotocol !== RELAY_SUBPROTOCOL) return refusal('SUBPROTOCOL_MISSING', `the upgrade must ask for ${RELAY_SUBPROTOCOL}`)
    const presented = presentedToken(upgrade.authorization)
    if (presented === undefined) return refusal('TUNNEL_TOKEN_INVALID', `the upgrade must carry Authorization: ${AUTHORIZATION_PREFIX.trim()} <token>`)
    this.log.secret(presented)
    let claims: TunnelTokenClaims
    try {
      claims = this.tokens.verify(presented)
    } catch (error: unknown) {
      if (isRelayError(error)) return refusal(error.code, error.detail ?? error.code)
      throw error
    }
    const binding = this.settings.bindings.get(claims.name)
    if (binding === undefined) return refusal('TUNNEL_TOKEN_INVALID', `${claims.name} is not bound`)
    this.tokens.accept(claims)
    return { accepted: true, claims }
  }

  /**
   * Run the handshake on an authorized upgrade.
   * @param claims - the accepted token's claims.
   * @param peer - the peer facts the relay asserts for the home's connection.
   * @param socket - the upgraded WebSocket.
   * @returns the tunnel id.
   */
  startTunnel(claims: TunnelTokenClaims, peer: PeerAssertion, socket: TunnelSocket): string {
    const binding = this.settings.bindings.get(claims.name)
    if (binding === undefined) throw new RelayError('TUNNEL_TOKEN_INVALID', `${claims.name} is not bound`)
    const tunnelId = this.tunnelId()
    this.refusedPeers.set(tunnelId, peer)
    const tunnel = new Tunnel({
      socket,
      claims,
      homePublicKey: binding.homePublicKey,
      relayId: this.settings.relayId,
      tunnelId,
      now: this.now,
      timers: this.timers,
      log: this.log,
      liveCheck: () => this.tunnels.get(claims.name),
      onLive: live => {
        this.tunnels.set(live.name, live)
        this.log.info('tunnel live', { name: live.name, tunnel: live.tunnelId })
      },
      onGone: gone => {
        if (this.tunnels.get(gone.name) === gone) this.tunnels.delete(gone.name)
        this.refusedPeers.delete(gone.tunnelId)
        this.log.info('tunnel closed', { name: gone.name, tunnel: gone.tunnelId, ...gone.closedWith === undefined ? {} : { code: gone.closedWith } })
      },
      onSecondTunnel: live => {
        const peer = this.refusedPeers.get(tunnelId)
        live.announce('second-tunnel-refused', peer?.clientAddress ?? 'unknown', claims.jti)
        this.log.warn('a second tunnel for a live name was refused', { name: live.name, tunnel: live.tunnelId })
      },
    })
    tunnel.start()
    this.log.info('tunnel attempt accepted', { name: claims.name, tunnel: tunnelId })
    return tunnelId
  }

  /**
   * Accept or refuse a tunnel upgrade, then run the handshake on the accepted socket: the whole
   * path a transport without a pre-upgrade authorization step needs.
   * @param upgrade - the subprotocol, the authorization value and the home's peer facts.
   * @param socket - the upgraded WebSocket.
   * @returns the acceptance, or the refusal's HTTP status and code; a refused upgrade leaves the
   *   socket unupgraded, so the caller answers the request with that status.
   */
  acceptTunnel(upgrade: TunnelUpgrade, socket: TunnelSocket): TunnelAcceptance {
    const authorization = this.authorizeTunnel(upgrade)
    if (!authorization.accepted) return authorization
    return { accepted: true, tunnelId: this.startTunnel(authorization.claims, upgrade.peer, socket) }
  }

  /**
   * Route a browser connection whose ClientHello named `name` to the home that registered it.
   * @param name - the SNI name of the ClientHello, in lowercase.
   * @param clientHello - the bytes of the ClientHello, which the stream's first `DATA` carries.
   * @param browser - the browser connection.
   * @returns the verdict, with the stream id when the connection was routed.
   */
  openBrowser(name: string, clientHello: Uint8Array, browser: BrowserConnection): BrowserVerdict {
    const tunnel = this.tunnels.get(name)
    if (tunnel === undefined) {
      this.log.info('browser connection dropped: no live tunnel', { name, clientAddress: browser.peer.clientAddress })
      browser.destroy()
      return { routed: 'dropped', reason: 'no-live-tunnel' }
    }
    const stream = tunnel.openStream(browser, clientHello)
    if (stream === 'limit') {
      this.log.warn('browser connection dropped: the home has 64 open streams', { name, clientAddress: browser.peer.clientAddress })
      browser.destroy()
      return { routed: 'dropped', reason: 'stream-limit' }
    }
    this.log.info('browser connection routed', { name, stream: stream.streamId, clientAddress: browser.peer.clientAddress, clientPort: browser.peer.clientPort })
    return { routed: 'opened', streamId: stream.streamId }
  }

  /**
   * The open streams of the live tunnel for a name.
   * @param name - the bound name.
   * @returns the count, or 0 when no tunnel is live for it.
   */
  streamCount(name: string): number {
    return this.tunnels.get(name)?.openStreams ?? 0
  }

  /**
   * Whether a name has a live tunnel.
   * @param name - the bound name.
   * @returns true when a tunnel completed its handshake and has not closed.
   */
  isLive(name: string): boolean {
    return this.tunnels.has(name)
  }

  /**
   * The concurrent stream limit the relay applies to each home.
   * @returns C6's limit, which a spec reads instead of repeating it.
   */
  get streamLimit(): number {
    return RELAY_LIMITS.concurrentStreamsPerHome
  }

  /** End every tunnel and its streams, as the relay's shutdown does. */
  dispose(): void {
    for (const tunnel of [...this.tunnels.values()]) tunnel.dispose(undefined)
    this.tunnels.clear()
    this.refusedPeers.clear()
  }
}

/**
 * The HTTP status and code a token endpoint refusal answers with.
 * @param error - the refusal.
 * @returns the status and the code, or `undefined` for a value that is no refusal.
 */
export function tokenRefusal(error: unknown): { readonly status: number; readonly code: RelayErrorCode; readonly detail?: string } | undefined {
  if (!isRelayError(error)) return undefined
  const status = httpStatusOf(error.code)
  if (status === undefined) return undefined
  return error.detail === undefined ? { status, code: error.code } : { status, code: error.code, detail: error.detail }
}

/**
 * The token a request must present, from an `Authorization` value.
 * @param authorization - the value.
 * @returns the token, or `undefined` when the value carries none.
 */
export function presentedToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith(AUTHORIZATION_PREFIX)) return undefined
  const token = authorization.slice(AUTHORIZATION_PREFIX.length).trim()
  return token.length === 0 ? undefined : token
}

/** Re-exported so a caller that builds a refusal needs no second import. */
export { RelayError }
