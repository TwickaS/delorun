/**
 * `@delorun/home-auth`'s provider of upstream's `authenticator` Service Definition (contract C4, "Authenticator").
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
 * @module @delorun/home-auth/authenticator
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import { typedInputRenewal } from './typed-renewal.ts'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from './full-access-grants.ts'
import { passAdmitsRow } from './auth-classes.ts'
import { answerKey } from './grants.ts'
import { LOOPBACK_LISTENER } from '@deepseek-ai/dsh-client-connection/authenticator'
import { Authenticator, type Admission, type ConnectionIndexRequest, type ListenerPolicy, type PreLoginRoute } from '@deepseek-ai/dsh-client-connection'
import type { RemoteAnswerGuard, RemoteEventAnswer } from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessPolicy } from '@deepseek-ai/dsh-api-remote-access/types'
import { RemoteError, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { REACH_SESSION_COOKIE, type ReachListenerId } from '@delorun/contract-admission'
import type { IdentityFactor, LoopbackRequiredAction } from '@delorun/contract-oidc-passkeys'
import { stampListener } from '@delorun/home'
import { ADMISSION_REFUSAL_STATUS } from '@delorun/contract-admission'
import { pathnameOf, REACH_PRE_LOGIN_ROUTES, sessionCookie, signInLocation, targetOf } from './reach-routes.ts'
import { COMPUTER_ONLY_ROW_MODULES, createReachAccessPolicy, protectedPluginsIn, REACH_DEVICE, reachDevicePrincipal, type DefaultPermission, type PermissionLevel, type ReachDevicePrincipal } from './reach-access.ts'
import { reachesDevicePath } from './reach-paths.ts'
import { HOME_AUTH_HTTP_STATUS, HomeAuthError } from './errors.ts'
import { takeUnlockToken } from './unlock-token.ts'
import { TailnetPeerCache } from './tailnet-peers.ts'

/** The header `tailscaled` writes the peer's own tailnet address into on every request it proxies. */
export const FORWARDED_FOR_HEADER = 'x-forwarded-for'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** C14: a session whose factor is `tailnet-membership` answered a prompt that grants an action of the home's own computer. */
    LOOPBACK_REQUIRED: { readonly action: LoopbackRequiredAction }
  }
}

/** The sentence the remote studio shows for a full-access grant a device answered without its confirmation. */
export const FULL_ACCESS_REFUSAL = 'This needs your confirmation: granting full access. Answer again and confirm with Face ID or your PIN when asked, or answer at the home\'s own computer'

/** The sentence the remote studio shows for a workspace-management grant a device answered without its confirmation. */
export const WORKSPACE_MANAGEMENT_REFUSAL = 'This needs your confirmation: managing workspaces and their instructions. Answer again and confirm with Face ID or your PIN when asked, or answer at the home\'s own computer'

/** The sentence the remote studio shows for an external-agent start a device answered without its confirmation. */
export const EXTERNAL_AGENT_REFUSAL = 'This needs your confirmation: starting an external agent such as Claude Code or Codex, which runs outside Delorun\'s sandbox. Answer again and confirm with Face ID or your PIN when asked, or answer at the home\'s own computer'

/** The sentence the remote studio shows for a real-browser grant a device answered without its confirmation. */
export const REAL_BROWSER_REFUSAL = 'This needs your confirmation: letting the agent use your own browser, with your sign-ins, in this chat. Answer again and confirm with Face ID or your PIN when asked, or answer at the home\'s own computer'

/**
 * The `LOOPBACK_REQUIRED` refusal of each grant a reach Peer gives only with an answer grant, by the approval request's
 * `grants` marker (`ApprovalGrant` of `@deepseek-ai/dsh-user-approval`).
 */
const REFUSED_GRANTS: ReadonlyMap<unknown, { readonly action: LoopbackRequiredAction; readonly message: string }> = new Map([
  ['full-access', { action: 'full-access-escalation', message: FULL_ACCESS_REFUSAL }],
  ['workspace-management', { action: 'workspace-management', message: WORKSPACE_MANAGEMENT_REFUSAL }],
  ['external-agent', { action: 'external-agent', message: EXTERNAL_AGENT_REFUSAL }],
  ['real-browser', { action: 'real-browser', message: REAL_BROWSER_REFUSAL }],
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
  /** The PIN mode page unlock this Peer, one page's, was admitted under; none for a locked page. */
  readonly unlockId?: string
  /** Whether the connection was shown to come from a device of the home's own tailnet (A666, A667). */
  readonly tailnetPeer?: true
}

/**
 * The peer address `tailscaled` forwarded, from the `X-Forwarded-For` header it overwrites on every request it proxies.
 * @param request - the request.
 * @returns the address, or undefined when the header names none.
 */
export function forwardedPeerOf(request: ConnectionIndexRequest): string | undefined {
  const value = headerOf(request, FORWARDED_FOR_HEADER).split(',')[0]?.trim() ?? ''
  return value === '' ? undefined : value
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

/** The module of upstream's plugin manager, whose row's `protectedPlugins` names the rows plugin management keeps. */
const PLUGIN_MANAGER_MODULE = '@deepseek-ai/dsh-plugin-manager'

/**
 * The Loader entry ids of the rows whose module a `plugin-manager` row's `protectedPlugins` names, read from the Loader
 * when asked, so the profile's own list is the only one.
 * @param ctx - a context of the running profile.
 * @returns the ids, none without a Loader or a `plugin-manager` row, or undefined when a row's list cannot be read.
 */
export function protectedEntryIdsOf(ctx: Context): ReadonlySet<string> | undefined {
  const entries = [...ctx.get('loader')?.entries() ?? []]
  const modules = new Set<string>()
  for (const entry of entries.filter(row => row.options.name === PLUGIN_MANAGER_MODULE)) {
    const listed = protectedPluginsIn(entry.options.config)
    if (listed === undefined) return undefined
    for (const name of listed) modules.add(name)
  }
  return new Set(entries.filter(row => modules.has(row.options.name)).flatMap(row => typeof row.options.id === 'string' ? [row.id, row.options.id] : [row.id]))
}

/**
 * The Loader entry ids of the rows whose module is in {@link COMPUTER_ONLY_ROW_MODULES}, and each such row's own `id`
 * option, which names its settings namespace (a row `id: sandbox` has the entry id `include:sandbox`).
 * @param ctx - a context of the running profile.
 * @returns the ids and namespaces, none without a Loader.
 */
export function computerOnlyEntryIdsOf(ctx: Context): ReadonlySet<string> {
  const rows = [...ctx.get('loader')?.entries() ?? []].filter(row => Object.hasOwn(COMPUTER_ONLY_ROW_MODULES, row.options.name))
  return new Set(rows.flatMap(row => typeof row.options.id === 'string' ? [row.id, row.options.id] : [row.id]))
}

/** What {@link keyRefsOf} reads of the model provider directory. */
interface ProviderDirectoryView {
  listConfigurableProviders(): readonly { readonly provider: string; readonly settingsNs: string; readonly settingsPath: readonly string[]; readonly nativeAuth?: { readonly env: readonly string[] } }[]
}

/** What {@link keyRefsOf} reads of the settings service. */
interface SettingsValuesView {
  describe(): readonly { readonly ns: string; readonly value: unknown }[]
}

/**
 * The credential references the model providers declare, which a device's key action may name: each configurable
 * provider's conventional reference (the provider route in upper case, non-alphanumerics as `_`, then `_API_KEY`, as the
 * models page derives it), the environment variables its authentication reads, and the `apiKeyEnv` its profile names.
 * @param ctx - a context of the running profile.
 * @returns the references, none without a model provider directory.
 */
export function keyRefsOf(ctx: Context): ReadonlySet<string> {
  const directory: ProviderDirectoryView | undefined = ctx.get('llm')
  const settings: SettingsValuesView | undefined = ctx.get('settings')
  const refs = new Set<string>()
  for (const entry of directory?.listConfigurableProviders() ?? []) {
    refs.add(`${entry.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
    for (const name of entry.nativeAuth?.env ?? []) refs.add(name)
    let profile: unknown = settings?.describe().find(row => row.ns === entry.settingsNs)?.value
    for (const key of entry.settingsPath) profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    const named = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'apiKeyEnv') : undefined
    if (typeof named === 'string' && named.length > 0) refs.add(named)
  }
  return refs
}

/** The module of upstream's permission presets, whose rows' `defaultPreset` names the permission new chats start in. */
const PERMISSION_PRESETS_MODULE = '@deepseek-ai/dsh-permission-presets'

/**
 * The permission new chats start in, read from the running permission presets when asked.
 * @param ctx - a context of the running profile.
 * @returns it, or undefined while no `permissionPresets` service runs.
 */
export function defaultPermissionOf(ctx: Context): DefaultPermission | undefined {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return undefined
  const levelOf = (name: string): PermissionLevel | undefined => {
    try {
      return presets.resolve(name)
    } catch (_unknownPreset) {
      // `resolve` throws for a name the presets do not hold, which the policy refuses.
      return undefined
    }
  }
  let current: PermissionLevel | undefined
  try {
    current = levelOf(presets.defaultPreset)
  } catch (_unreadable) {
    // A default preset the presets do not hold cannot be read; the policy refuses every change of it.
    current = undefined
  }
  const rows = [...ctx.get('loader')?.entries() ?? []].filter(entry => entry.options.name === PERMISSION_PRESETS_MODULE)
  return { namespaces: new Set(rows.map(entry => entry.options.id)), current, levelOf }
}

/** The provider. */
export class HomeAuthAuthenticator extends Authenticator {
  static inject = ['homeAuth', 'connection']

  private readonly peers = new Map<string, PeerScope>()
  private readonly reachPeers = new Map<PeerId, ReachPeer>()
  /** The corroborated tailnet peers, by forwarded address; empty until a provider supplies the check. */
  private readonly tailnetPeers: TailnetPeerCache

  /**
   * @param ctx - the plugin context, which injects `homeAuth` and `connection`.
   */
  constructor(ctx: Context) {
    super(ctx)
    // The check is supplied by the reach provider that serves the listener, which owns the Tailscale dependency; without
    // one no address is ever corroborated, so every device keeps today's behaviour.
    this.tailnetPeers = new TailnetPeerCache(address => ctx.homeAuth.checkTailnetPeer(address))
    ctx.effect(() => () => {
      for (const peer of this.peers.values()) void peer.dispose()
      this.peers.clear()
      this.reachPeers.clear()
    }, 'home-auth reach peers')
    // The Peer of an ended page unlock goes with it, with or without remote access: the page's next request carries no
    // valid token and is refused.
    ctx.effect(() => ctx.homeAuth.onElevationChange((change) => {
      if (change.kind === 'ended' && change.elevation.page === true) this.disposePageUnlock(change.elevation.id)
    }), 'home-auth page unlock peers')
    // The person typing in an attached terminal keeps the device's sliding unlock alive: its end closes the stream.
    const renewTyping = typedInputRenewal({ reachPeer: id => this.reachPeers.get(id as PeerId), touchDevice: (deviceId, listener) => { ctx.homeAuth.touchDeviceUnlock(deviceId, listener) }, now: () => Date.now() })
    ctx.inject(['terminalController'], (scope) => { scope.effect(() => scope.terminalController.onTyped((peer) => { renewTyping(peer) }), 'home-auth typed terminal input') })
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
        delorunHome: ctx.homeAuth.delorunHome,
        elevationOf: (deviceId, listener) => ctx.homeAuth.elevationOf(deviceId, listener),
        touchUnlock: id => { ctx.homeAuth.touchUnlock(id) },
        pageUnlockOf: unlockId => ctx.homeAuth.pageUnlockOf(unlockId),
        unlockModeEnabled: () => ctx.homeAuth.unlockModeEnabled(),
        faceGrants: () => {
          const grants = ctx.homeAuth.faceGrants()
          return grants === undefined ? undefined : { grants, deviceHasPasskey: deviceId => ctx.homeAuth.deviceHasPasskey(deviceId), passAdmits: (holder, row) => passAdmitsRow(grants, holder, row) }
        },
        keyRefs: () => keyRefsOf(access),
        logElevated: (line) => { ctx.logger.info(line) },
        liftedSettings: lifts => ctx.homeAuth.recordLifts(lifts),
        computerOnlySwitches: () => ctx.homeAuth.computerOnlySwitches(),
        protectedEntryIds: () => protectedEntryIdsOf(ctx),
        computerOnlyEntryIds: () => computerOnlyEntryIdsOf(ctx),
        defaultPermission: () => defaultPermissionOf(access),
        dangerousMode: () => ctx.homeAuth.dangerousMode(),
      }))
      // A device's snapshot lists the Sessions and Workspaces it may reach, so it is recomputed when they change.
      const invalidate = (): void => {
        for (const peer of this.reachPeers.values()) access.remoteAccess.invalidate(reachDevicePrincipal(peer.deviceId, peer.listener, peer.unlockId))
      }
      access.on('session/created', invalidate)
      access.on('session/disposed', invalidate)
      access.on('domain/changed', (change) => { if (change.domain === 'workspace') invalidate() })
      // A device's snapshot on one listener lists its elevated actions while it holds an unlock there, so it is
      // recomputed when one starts or ends.
      access.effect(() => ctx.homeAuth.onElevationChange((change) => {
        const { deviceId, listener, id, page } = change.elevation
        access.remoteAccess.invalidate(reachDevicePrincipal(deviceId, listener, page === true ? id : undefined))
      }), 'home-auth elevation snapshots')
    })
  }

  /**
   * Refuse a granting answer from a reach Peer, whose session's factor is `tailnet-membership` (C14,
   * `LOOPBACK_REQUIRED`), to an approval prompt whose `grants` marker names a grant the home's own computer keeps:
   * `full-access` (an escalation to `danger-full-access`, `plugin_manager`'s included, and a workspace's full-access
   * consent) and `workspace-management` (creating, cloning, trashing or restoring a workspace, changing an
   * instruction-layer file, and the main chat's commands and writes) and `external-agent` (starting an external
   * agent program, such as Claude Code or Codex, outside the sandbox) and `real-browser` (the person's own browser for
   * one chat). Once the grant store exists, a device's granting answer is admitted only by the answer grant the person
   * made for exactly this prompt (its Session, call id and grants marker) and this value, with Face ID or, on a device
   * with no passkey, its PIN; the grant is used up here, or by the live Face ID pass of the Peer that answers (A499). No PIN page unlock, code from the computer, approval grace or
   * dangerous mode stands in for it (A483); before the store starts, nothing admits it. Any answer but `rejected`, `cancelled` and `unavailable` counts as granting, a seat's `allowed-for-run` included, and needs a grant or a live pass. Every other answer, a
   * refusal of the same prompt included, applies.
   * @param answer - the answer and the Peer that gave it.
   * @throws {RemoteError} `LOOPBACK_REQUIRED` naming the action for a refused grant.
   */
  checkAnswer(answer: RemoteEventAnswer): void {
    if (answer.event !== 'approval/request' || NON_GRANTING_OUTCOMES.has(answer.value)) return
    const marker: unknown = Reflect.get(answer.request, 'grants')
    const refusal = REFUSED_GRANTS.get(marker)
    if (refusal === undefined) return
    // This provider creates every reach Peer, and every reach session this home builds has the factor
    // `tailnet-membership`.
    const reach = this.reachPeers.get(answer.peer.id)
    if (reach === undefined) return
    // The grant the person made for exactly this prompt and this answer admits it, and is used up here. Every device, with
    // a passkey or without, is admitted by that grant alone: no PIN page unlock, code, approval grace or dangerous mode
    // admits it (A483). Before the service starts there is no grant store, and nothing is admitted.
    const grants = this.ctx.homeAuth.faceGrants()
    // The grant names the prompt by its Session, call id and grants marker: one call can raise two prompts, and call ids repeat across chats.
    const callId: unknown = Reflect.get(answer.request, 'callId')
    const agent: unknown = Reflect.get(answer.request, 'agent')
    const agentId: unknown = typeof agent === 'object' && agent !== null ? Reflect.get(agent, 'id') : undefined
    if (grants !== undefined && typeof callId === 'string' && typeof agentId === 'string' && typeof marker === 'string' && typeof answer.value === 'string'
      && grants.consumeAnswer({ deviceId: reach.deviceId, listener: reach.listener }, answerKey({ agent: agentId, callId, grants: marker }), answer.value) !== undefined) return
    // The device's live Face ID pass on this listener admits a granting answer whose row allows it (A499); a full-access answer is always-ask (F48).
    if (grants !== undefined && typeof marker === 'string' && passAdmitsRow(grants, { deviceId: reach.deviceId, listener: reach.listener, unlockId: reach.unlockId }, `answer:${marker}`)) {
      this.ctx.logger.info(`home-auth: pass.used device=${reach.deviceId} listener=${reach.listener} answer=${answer.value} grants=${marker}`)
      return
    }
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
    // The token is stripped here, before any route, upgrade handler or plugin can read it.
    const presented = takeUnlockToken(request)
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
    // With PIN mode off the token is ignored; with it on, a token that does not name this page's unlock is refused and
    // burned, so the page learns it is locked.
    let unlockId: string | undefined
    if (this.ctx.homeAuth.unlockModeEnabled() && (presented.token !== undefined || presented.ambiguous)) {
      try {
        if (presented.ambiguous || presented.token === undefined) throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
        unlockId = this.ctx.homeAuth.resolvePageUnlock(presented.token, { deviceId: session.deviceId, listener: served.listener, sessionId })
      } catch (_invalid) {
        // `resolvePageUnlock` ended the unlock when it moved between devices, listeners or sessions.
        return refused('UNLOCK_INVALID')
      }
    }
    // A666, A667: whether this connection was shown to come from a device of the home's own tailnet. The answer is read
    // from memory, because admission is synchronous; a miss asks the daemon for the next request from that address and
    // leaves this one with today's behaviour, so a Tailscale that cannot answer never widens what a device may do.
    const forwarded = forwardedPeerOf(request)
    const tailnetPeer = forwarded === undefined ? undefined : this.tailnetPeers.peerOf(forwarded)
    if (forwarded !== undefined && tailnetPeer === undefined) void this.tailnetPeers.refresh(forwarded)
    const key = `${served.listener}\u0000${session.deviceId}\u0000${unlockId ?? ''}\u0000${tailnetPeer === undefined ? '' : 'tailnet'}`
    let peer = this.peers.get(key)
    if (peer === undefined) {
      peer = this.ctx.connection.createPeer({ principal: reachDevicePrincipal(session.deviceId, served.listener, unlockId, tailnetPeer === undefined ? undefined : true) })
      this.peers.set(key, peer)
      // The holds a Peer's grants opened end with the Peer.
      const holder = { deviceId: session.deviceId, listener: served.listener, unlockId }
      peer.signal.addEventListener('abort', () => { this.ctx.homeAuth.faceGrants()?.endPeer(holder) }, { once: true })
      this.reachPeers.set(peer.id, { deviceId: session.deviceId, listener: served.listener, factor: session.factor, ...unlockId === undefined ? {} : { unlockId }, ...tailnetPeer === undefined ? {} : { tailnetPeer: true } })
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
      if (key.split('\u0000')[1] !== deviceId) continue
      this.peers.delete(key)
      this.reachPeers.delete(peer.id)
      void peer.dispose()
    }
  }

  /**
   * Dispose the Peer of an ended page unlock.
   * @param unlockId - the unlock.
   */
  private disposePageUnlock(unlockId: string): void {
    for (const [key, peer] of this.peers) {
      if (this.reachPeers.get(peer.id)?.unlockId !== unlockId) continue
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
function refused(code: 'NOT_SIGNED_IN' | 'SESSION_EXPIRED' | 'ROTATION_REQUIRED' | 'UNLOCK_INVALID'): Extract<Admission, { readonly kind: 'refused' }> {
  return { kind: 'refused', status: code === 'UNLOCK_INVALID' ? HOME_AUTH_HTTP_STATUS.UNLOCK_INVALID : ADMISSION_REFUSAL_STATUS[code], code }
}

export default HomeAuthAuthenticator
