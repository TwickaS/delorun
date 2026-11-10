/**
 * `@delo/home-auth`'s provider of upstream's `authenticator` Service Definition (contract C4, "Authenticator").
 *
 * - **Loopback.** The loopback listener keeps upstream's admission: the provider delegates it to Connection's built-in
 *   admission unchanged.
 * - **Reach.** A reach listener is served only while a reach provider asked `homeAuth` to serve it, with the identity
 *   factor the provider declares. Its policy is the address's `Host` rule, the `https` scheme, no launch token and the
 *   pre-login routes this package answers. Every request `admit` sees is stamped with the listener before any route
 *   runs, so the routes decide its arrival from the stamp. A request on a pre-login route is `pre-login`; any other
 *   request is admitted only with a live session cookie of that listener, and is refused with C4's code otherwise.
 * - **Peers.** Each device is one Peer per listener, created on its first admitted request and disposed when the device
 *   is removed or the provider stops. Its principal is the device's `reach-device` principal, never the owner, so
 *   upstream's Gateway decides each of its calls and forwarded events from the `reach-device` policy this provider
 *   registers (`./reach-access.ts`), and refuses what C14 reserves for the home's own computer with
 *   `loopback-required: <action>`. The provider keeps each Peer's device and identity factor, which is what the home
 *   reads where it grants an action that C14 reserves for the home's own computer.
 *
 * `admit` is synchronous: it reads `homeAuth`'s in-memory copy of the stores, which refuses until the stores were read.
 *
 * @module @delo/home-auth/authenticator
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { Authenticator, LOOPBACK_LISTENER, type Admission, type ConnectionIndexRequest, type ListenerPolicy, type PreLoginRoute } from '@deepseek-ai/dsh-client-connection'
import type { RemoteEventAnswer } from '@deepseek-ai/dsh-api-gateway'
import { RemoteError, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { REACH_SESSION_COOKIE, type ReachListenerId } from '@delo/contract-admission'
import type { IdentityFactor, LoopbackRequiredAction } from '@delo/contract-oidc-passkeys'
import { stampListener } from './arrival.ts'
import { ADMISSION_REFUSAL_STATUS } from '@delo/contract-admission'
import { pathnameOf, REACH_PRE_LOGIN_ROUTES, sessionCookie } from './reach-routes.ts'
import { createReachAccessPolicy, REACH_DEVICE, reachDevicePrincipal } from './reach-access.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** C14: a session whose factor is `tailnet-membership` answered a prompt that grants an action of the home's own computer. */
    LOOPBACK_REQUIRED: { readonly action: LoopbackRequiredAction }
  }
}

/** The sentence the remote studio shows for a refused full-access grant. */
export const FULL_ACCESS_REFUSAL = 'This needs you at your computer: granting full access. Answer this prompt in the studio on the home\'s own computer'

/** What the home knows about one Peer a reach listener admitted. */
export interface ReachPeer {
  readonly deviceId: string
  readonly listener: ReachListenerId
  readonly factor: IdentityFactor
}

/**
 * Whether a request's method and path match one pre-login route, whose final `<…>` segment stands for one non-empty
 * path segment.
 * @param route - the route.
 * @param method - the request's method.
 * @param pathname - the request's path.
 * @returns whether they match.
 */
export function matchesPreLogin(route: PreLoginRoute, method: string | undefined, pathname: string): boolean {
  if (method !== route.method) return false
  const segment = /\/<[^>]+>$/.exec(route.path)
  if (segment === null) return pathname === route.path
  const base = route.path.slice(0, segment.index)
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : ''
  return rest !== '' && !rest.includes('/')
}

/**
 * A request's `Cookie` header, from either header carrier, with repeated lines joined.
 * @param request - the request.
 * @returns the header text, empty without one.
 */
export function cookieOf(request: ConnectionIndexRequest): string {
  return headerOf(request, 'cookie')
}

/**
 * One request header, from either header carrier, with repeated lines joined.
 * @param request - the request.
 * @param name - the header's lower-case name.
 * @returns the header text, empty without one.
 */
export function headerOf(request: ConnectionIndexRequest, name: string): string {
  const headers = request.headers
  if (headers instanceof Headers) return headers.get(name) ?? ''
  const value = headers[name]
  return typeof value === 'string' ? value : (value ?? []).join('; ')
}

/**
 * The session token a request's cookie header carries.
 * @param cookie - the `Cookie` header.
 * @returns the token, or undefined without one.
 */
function sessionTokenOf(cookie: string): string | undefined {
  for (const pair of cookie.split(';')) {
    const [name, ...value] = pair.trim().split('=')
    if (name === REACH_SESSION_COOKIE) return value.join('=')
  }
  return undefined
}

/** The provider. */
export class HomeAuthAuthenticator extends Authenticator {
  static inject = ['homeAuth', 'connection']

  private readonly peers = new Map<string, PeerScope>()
  private readonly reachPeers = new Map<PeerId, ReachPeer>()

  /**
   * @param ctx - the plugin context, which injects `homeAuth` and `connection`.
   */
  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => () => {
      for (const peer of this.peers.values()) void peer.dispose()
      this.peers.clear()
      this.reachPeers.clear()
    }, 'home-auth reach peers')
    ctx.effect(() => ctx.homeAuth.onDeviceRemoved((deviceId) => { this.disposeDevice(deviceId) }), 'home-auth peer removal')
    ctx.effect(() => ctx.provide('remoteAnswerGuard', { check: (answer: RemoteEventAnswer) => { this.checkAnswer(answer) } }), 'home-auth full-access grant guard')
    // Without remote access no Gateway is mounted, so no reach Peer's call is dispatched at all.
    ctx.inject(['remoteAccess'], (access) => {
      access.remoteAccess.registerPolicy(REACH_DEVICE, createReachAccessPolicy({
        admitted: deviceId => [...this.reachPeers.values()].some(peer => peer.deviceId === deviceId),
        workspaces: () => access.get('workspaceRegistry')?.list() ?? [],
        liveSessions: () => (access.get('sessions')?.list() ?? []).map(session => session.id),
      }))
      // A device's snapshot lists the Sessions and Workspaces it may reach, so it is recomputed when they change.
      const invalidate = (): void => {
        for (const deviceId of new Set([...this.reachPeers.values()].map(peer => peer.deviceId))) {
          access.remoteAccess.invalidate(reachDevicePrincipal(deviceId))
        }
      }
      access.on('session/created', invalidate)
      access.on('session/disposed', invalidate)
      access.on('domain/changed', (change) => { if (change.domain === 'workspace') invalidate() })
    })
  }

  /**
   * Refuse a full-access grant answered by a reach Peer, whose session's factor is `tailnet-membership` (C14,
   * `LOOPBACK_REQUIRED`): an escalation to `danger-full-access`, `plugin_manager`'s included, and a workspace's
   * full-access consent. Every other answer, a refusal of the same prompt included, applies.
   * @param answer - the answer and the Peer that gave it.
   * @throws {RemoteError} `LOOPBACK_REQUIRED` for a refused grant.
   */
  checkAnswer(answer: RemoteEventAnswer): void {
    if (answer.event !== 'approval/request' || answer.value !== 'allowed-once') return
    if (Reflect.get(answer.request, 'grants') !== 'full-access') return
    // This provider creates every reach Peer, and every reach session this home builds has the factor
    // `tailnet-membership`.
    if (!this.reachPeers.has(answer.peer.id)) return
    throw new RemoteError('LOOPBACK_REQUIRED', FULL_ACCESS_REFUSAL, { action: 'full-access-escalation' })
  }

  /** @inheritdoc */
  policy(listener: string): ListenerPolicy | undefined {
    const served = this.ctx.homeAuth.servedListener(listener)
    if (served === undefined) return undefined
    return {
      listener: served.listener,
      scheme: 'https',
      hostRule: { kind: 'equals-address', address: served.address },
      acceptsLaunchToken: false,
      preLogin: REACH_PRE_LOGIN_ROUTES,
    }
  }

  /** @inheritdoc */
  admit(request: ConnectionIndexRequest, listener: string): Admission {
    if (listener === LOOPBACK_LISTENER) return this.ctx.connection.builtinAdmission(request)
    const served = this.ctx.homeAuth.servedListener(listener)
    if (served === undefined) return refused('NOT_SIGNED_IN')
    stampListener(request, served.listener)
    const pathname = pathnameOf(request)
    const route = REACH_PRE_LOGIN_ROUTES.find(candidate => matchesPreLogin(candidate, request.method, pathname))
    if (route !== undefined) return { kind: 'pre-login', route }
    const token = sessionTokenOf(cookieOf(request))
    if (token === undefined) return refused('NOT_SIGNED_IN')
    // A 101 response is written by the upgrade handler, so a session rolls only on a request without `Upgrade`.
    const admission = this.ctx.homeAuth.admitToken(token, served.listener, { roll: headerOf(request, 'upgrade') === '' })
    if (admission.kind === 'refused') return refused(admission.code)
    const { session, sessionId } = admission
    const key = `${served.listener}\u0000${session.deviceId}`
    let peer = this.peers.get(key)
    if (peer === undefined) {
      peer = this.ctx.connection.createPeer({ principal: reachDevicePrincipal(session.deviceId) })
      this.peers.set(key, peer)
      this.reachPeers.set(peer.id, { deviceId: session.deviceId, listener: served.listener, factor: session.factor })
    }
    const rolled = admission.rolled
    return {
      kind: 'admitted', peer, deviceId: session.deviceId, sessionId,
      ...(rolled === undefined ? {} : { setCookie: sessionCookie(rolled.token, rolled.expiresAt, Date.now()) }),
    }
  }

  /**
   * The device, listener and identity factor of a Peer a reach listener admitted.
   * @param peer - the Peer id.
   * @returns what the home knows of it, or undefined for a Peer no reach listener admitted.
   */
  reachPeer(peer: PeerId): ReachPeer | undefined {
    return this.reachPeers.get(peer)
  }

  /**
   * Dispose every Peer of a removed device, which ends the streams that speak for it.
   * @param deviceId - the device.
   */
  private disposeDevice(deviceId: string): void {
    for (const [key, peer] of this.peers) {
      if (!key.endsWith(`\u0000${deviceId}`)) continue
      this.peers.delete(key)
      this.reachPeers.delete(peer.id)
      void peer.dispose()
    }
  }
}

/**
 * A refusal with C4's status for its code.
 * @param code - the code.
 * @returns the admission.
 */
function refused(code: 'NOT_SIGNED_IN' | 'SESSION_EXPIRED' | 'ROTATION_REQUIRED'): Admission {
  return { kind: 'refused', status: ADMISSION_REFUSAL_STATUS[code], code }
}

export default HomeAuthAuthenticator
