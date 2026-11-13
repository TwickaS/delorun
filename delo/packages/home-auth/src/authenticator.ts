/**
 * `@delo/home-auth`'s provider of upstream's `authenticator` Service Definition (contract C4, "Authenticator").
 *
 * - **Loopback.** The loopback listener keeps upstream's admission: the provider delegates it to Connection's built-in
 *   admission unchanged.
 * - **Reach.** A reach listener is served only while a reach provider asked `homeAuth` to serve it, with the identity
 *   factor the provider declares. Its policy is the address's `Host` rule, the `https` scheme, no launch token and the
 *   pre-login routes this package answers. Every request `admit` sees is stamped with the listener before any route
 *   runs, so the routes decide its arrival from the stamp. A request on a pre-login route is `pre-login`; any other
 *   request is admitted only with a live session cookie of that listener, and is refused with C4's code otherwise; a
 *   browser that opens a page without one is sent to the sign-in page with `303`, carrying where it aimed. A
 *   request with a live session whose target is not on `REACH_DEVICE_PATHS` (`./reach-paths.ts`) is refused with
 *   `403 LOOPBACK_REQUIRED` before any route, upgrade handler or the fallback runs.
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
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './full-access-grants.ts'
import { Authenticator, LOOPBACK_LISTENER, type Admission, type ConnectionIndexRequest, type ListenerPolicy, type PreLoginRoute } from '@deepseek-ai/dsh-client-connection'
import type { RemoteAnswerGuard, RemoteEventAnswer } from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessPolicy } from '@deepseek-ai/dsh-api-remote-access/types'
import { RemoteError, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { REACH_SESSION_COOKIE, type ReachListenerId } from '@delo/contract-admission'
import type { IdentityFactor, LoopbackRequiredAction } from '@delo/contract-oidc-passkeys'
import { stampListener } from './arrival.ts'
import { ADMISSION_REFUSAL_STATUS } from '@delo/contract-admission'
import { pathnameOf, REACH_PRE_LOGIN_ROUTES, sessionCookie, signInLocation, targetOf } from './reach-routes.ts'
import { createReachAccessPolicy, REACH_DEVICE, reachDevicePrincipal, type ReachDevicePrincipal } from './reach-access.ts'
import { reachesDevicePath } from './reach-paths.ts'
import { HOME_AUTH_HTTP_STATUS } from './errors.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** C14: a session whose factor is `tailnet-membership` answered a prompt that grants an action of the home's own computer. */
    LOOPBACK_REQUIRED: { readonly action: LoopbackRequiredAction }
  }
}

/** The sentence the remote studio shows for a refused full-access grant. */
export const FULL_ACCESS_REFUSAL = 'This needs you at your computer: granting full access. Answer this prompt in the studio on the home\'s own computer'

/** The sentence the remote studio shows for a refused workspace-management grant. */
export const WORKSPACE_MANAGEMENT_REFUSAL = 'This needs you at your computer: managing workspaces and their instructions. Answer this prompt in the studio on the home\'s own computer'

/** The sentence the remote studio shows for a refused external-agent start. */
export const EXTERNAL_AGENT_REFUSAL = 'This needs you at your computer: starting an external agent such as Claude Code or Codex, which runs outside Delo\'s sandbox. Answer this prompt in the studio on the home\'s own computer'

/**
 * The `LOOPBACK_REQUIRED` refusal of each grant a reach Peer may not give, by the approval request's `grants` marker
 * (`ApprovalGrant` of `@deepseek-ai/dsh-user-approval`).
 */
const REFUSED_GRANTS: ReadonlyMap<unknown, { readonly action: LoopbackRequiredAction; readonly message: string }> = new Map([
  ['full-access', { action: 'full-access-escalation', message: FULL_ACCESS_REFUSAL }],
  ['workspace-management', { action: 'workspace-management', message: WORKSPACE_MANAGEMENT_REFUSAL }],
  ['external-agent', { action: 'external-agent', message: EXTERNAL_AGENT_REFUSAL }],
])

/** The approval outcomes that grant nothing, which a reach Peer may answer to any prompt. */
const NON_GRANTING_OUTCOMES: ReadonlySet<unknown> = new Set(['rejected', 'cancelled', 'unavailable'])

/** The remote access registry's member that {@link registerReachPolicy} calls. */
export type ReachPolicyRegistry = Pick<Context['remoteAccess'], 'registerPolicy'>

/**
 * Register the `reach-device` policy. The policy lets a device answer `event:approval/request`, and only the answer
 * guard keeps that answer from granting what the home's computer reserves, so the policy is registered only while a
 * guard is mounted.
 * @param guard - the mounted `remoteAnswerGuard`, or undefined while none is.
 * @param registry - remote access, which holds the policies.
 * @param policy - the `reach-device` policy.
 * @returns the policy's disposer.
 * @throws Error when no guard is mounted; nothing is registered, so a device is refused every call and event.
 */
export function registerReachPolicy(guard: RemoteAnswerGuard | undefined, registry: ReachPolicyRegistry, policy: RemoteAccessPolicy<ReachDevicePrincipal>): () => void {
  if (guard === undefined) {
    throw new Error('home-auth: no remoteAnswerGuard is mounted, so the reach-device policy, which lets a device answer approval prompts, is not registered')
  }
  return registry.registerPolicy(REACH_DEVICE, policy)
}

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
    ctx.effect(() => ctx.provide('remoteAnswerGuard', { check: (answer: RemoteEventAnswer) => { this.checkAnswer(answer) } }), 'home-auth reserved grant guard')
    // Without remote access no Gateway is mounted, so no reach Peer's call is dispatched at all. The policy lives in
    // a scope that also needs the answer guard, which becomes visible once this fiber is active and takes the policy
    // with it when it goes.
    ctx.inject(['remoteAccess', 'remoteAnswerGuard'], (access) => {
      registerReachPolicy(access.get('remoteAnswerGuard'), access.remoteAccess, createReachAccessPolicy({
        admitted: (deviceId, listener) => [...this.reachPeers.values()].some(peer => peer.deviceId === deviceId && peer.listener === listener),
        workspaces: () => access.get('workspaceRegistry')?.list() ?? [],
        liveSessions: () => (access.get('sessions')?.list() ?? []).map(session => session.id),
        workspaceRootOf: (sessionId) => {
          const live = access.get('sessions')?.get(sessionId)?.header
          if (live !== undefined) return live.cwd
          return access.get('workspaceRegistry')?.list().find(workspace => workspace.sessionIds.includes(sessionId))?.path
        },
        deloHome: ctx.homeAuth.deloHome,
        elevationOf: (deviceId, listener) => ctx.homeAuth.elevationOf(deviceId, listener),
        logElevated: (line) => { ctx.logger.info(line) },
        terminalFoldersOf: (sessionId) => {
          // A terminal opens in the Session's current directory, or in its original folder when that one is gone.
          const session = access.get('sessions')?.get(sessionId)
          const current = session === undefined ? undefined : access.get('workingDirectory')?.get(session)
          const original = session?.header.cwd
          return current === undefined || original === undefined ? undefined : [current, original]
        },
        grantedFolders: () => access.get('reachFullAccessGrants')?.grantedFolders() ?? [],
        terminalWithoutUnlock: () => ctx.homeAuth.terminalWithoutUnlock(),
        computerOnlySwitches: () => ctx.homeAuth.computerOnlySwitches(),
      }))
      // A device's snapshot lists the Sessions and Workspaces it may reach, so it is recomputed when they change.
      const invalidate = (): void => {
        for (const peer of this.reachPeers.values()) access.remoteAccess.invalidate(reachDevicePrincipal(peer.deviceId, peer.listener))
      }
      access.on('session/created', invalidate)
      access.on('session/disposed', invalidate)
      access.on('domain/changed', (change) => { if (change.domain === 'workspace') invalidate() })
      // A device's snapshot on one listener lists its elevated actions while it holds an unlock there, so it is
      // recomputed when one starts or ends.
      access.effect(() => ctx.homeAuth.onElevationChange((change) => {
        access.remoteAccess.invalidate(reachDevicePrincipal(change.elevation.deviceId, change.elevation.listener))
      }), 'home-auth elevation snapshots')
      // A device's snapshot lists the terminal actions it may take without an unlock, so the switch recomputes it.
      access.effect(() => ctx.homeAuth.onTerminalSwitchChange(invalidate), 'home-auth terminal switch snapshots')
    })
  }

  /**
   * Refuse a granting answer from a reach Peer, whose session's factor is `tailnet-membership` (C14,
   * `LOOPBACK_REQUIRED`), to an approval prompt whose `grants` marker names a grant the home's own computer keeps:
   * `full-access` (an escalation to `danger-full-access`, `plugin_manager`'s included, and a workspace's full-access
   * consent) and `workspace-management` (creating, cloning, trashing or restoring a workspace, changing an
   * instruction-layer file, and the main chat's commands and writes) and `external-agent` (starting an external
   * agent program, such as Claude Code or Codex, outside the sandbox). Any answer but `rejected`, `cancelled` and
   * `unavailable` counts as granting. Every other answer, a refusal of the same prompt included, applies.
   * @param answer - the answer and the Peer that gave it.
   * @throws {RemoteError} `LOOPBACK_REQUIRED` naming the action for a refused grant.
   */
  checkAnswer(answer: RemoteEventAnswer): void {
    if (answer.event !== 'approval/request' || NON_GRANTING_OUTCOMES.has(answer.value)) return
    const refusal = REFUSED_GRANTS.get(Reflect.get(answer.request, 'grants'))
    if (refusal === undefined) return
    // This provider creates every reach Peer, and every reach session this home builds has the factor
    // `tailnet-membership`.
    if (!this.reachPeers.has(answer.peer.id)) return
    throw new RemoteError('LOOPBACK_REQUIRED', refusal.message, { action: refusal.action })
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
    if (token === undefined) return signedOut(request, 'NOT_SIGNED_IN')
    // A signed-in device reaches only the listed paths (`./reach-paths.ts`); any other target, or none, is refused
    // after the session is checked, so an expired or rotated session still answers with its own code.
    const reachable = reachesDevicePath(request.url ?? '')
    // A 101 response is written by the upgrade handler, so a session rolls only on a request without `Upgrade`, and
    // never on a refused one, whose response would carry no cookie.
    const admission = this.ctx.homeAuth.admitToken(token, served.listener, { roll: reachable && headerOf(request, 'upgrade') === '' })
    if (admission.kind === 'refused') return signedOut(request, admission.code)
    if (!reachable) return { kind: 'refused', status: HOME_AUTH_HTTP_STATUS.LOOPBACK_REQUIRED, code: 'LOOPBACK_REQUIRED' }
    const { session, sessionId } = admission
    const key = `${served.listener}\u0000${session.deviceId}`
    let peer = this.peers.get(key)
    if (peer === undefined) {
      peer = this.ctx.connection.createPeer({ principal: reachDevicePrincipal(session.deviceId, served.listener) })
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
 * Whether a request is a browser opening a page rather than a script reading a resource: a `GET` or `HEAD` that
 * `Sec-Fetch-Mode` names a navigation, or, from a browser that sends no fetch metadata, that accepts HTML.
 * @param request - the request.
 * @returns whether it is a navigation.
 */
export function isNavigation(request: ConnectionIndexRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const mode = headerOf(request, 'sec-fetch-mode')
  if (mode !== '') return mode === 'navigate'
  return headerOf(request, 'accept').toLowerCase().includes('text/html')
}

/**
 * The refusal of a reach request without a live session: a navigation is sent to the sign-in page with where it aimed
 * (C4), and any other request, a script's included, is answered C4's code as JSON.
 * @param request - the request.
 * @param code - C4's code.
 * @returns the admission.
 */
function signedOut(request: ConnectionIndexRequest, code: 'NOT_SIGNED_IN' | 'SESSION_EXPIRED' | 'ROTATION_REQUIRED'): Admission {
  const refusal = refused(code)
  return isNavigation(request) ? { ...refusal, location: signInLocation(targetOf(request)) } : refusal
}

/**
 * A refusal with C4's status for its code.
 * @param code - the code.
 * @returns the admission.
 */
function refused(code: 'NOT_SIGNED_IN' | 'SESSION_EXPIRED' | 'ROTATION_REQUIRED'): Extract<Admission, { readonly kind: 'refused' }> {
  return { kind: 'refused', status: ADMISSION_REFUSAL_STATUS[code], code }
}

export default HomeAuthAuthenticator
