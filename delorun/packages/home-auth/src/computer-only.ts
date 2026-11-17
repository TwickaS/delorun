/**
 * The refusal of a Delorun route that only the person at the home's own computer may use, such as turning on a
 * workspace's full access or accepting an MCP server command (C14, "Tailnet membership"). A route of another Delorun plugin
 * calls {@link requireComputer} from its `connection/request` listener, before the body is read, so a reach session, or
 * any request the home cannot place on the loopback listener, is answered `403 LOOPBACK_REQUIRED` naming the action and
 * reaches no route. The listener matches the request with {@link routedPathname}, the pathname upstream's Connection
 * routes an exact Fetch route by, so no spelling of the target (`/x/../`, `%2e%2e`, `\`) reaches the route without the
 * check.
 *
 * @module @delorun/home-auth/computer-only
 */
import type { ServerResponse } from 'node:http'
import { isLoopbackHost } from '@delorun/home'
import { refusalBody } from './errors.ts'
import { REACH_DEVICE, type ReachDevicePrincipal } from './reach-access.ts'
import type { HomeAuthService } from './service.ts'

/** What {@link requireComputer} reads of a request: its headers and what the home's arrival check reads. */
export type ComputerRequest = Parameters<HomeAuthService['arrivalOf']>[0]

/**
 * Let a request through only when it arrived on the loopback listener under a loopback `Host`; answer any other request
 * `403 LOOPBACK_REQUIRED` with the sentence that names the action. Without a mounted `homeAuth` nothing places the
 * request, so it is refused too.
 * @param request - the request the Connection received.
 * @param response - the response, answered with the refusal when the request is refused.
 * @param homeAuth - the mounted `homeAuth` service, or `undefined` while none is mounted.
 * @param action - the action's name as the refusal states it, in sentence case, such as `Turning on full access`.
 * @returns whether the request may go on to the route.
 */
export function requireComputer(request: ComputerRequest, response: ServerResponse, homeAuth: Pick<HomeAuthService, 'arrivalOf'> | undefined, action: string): boolean {
  if (homeAuth?.arrivalOf(request).listener === 'loopback' && isLoopbackHost(request.headers.host)) return true
  response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(refusalBody('LOOPBACK_REQUIRED', `${action} needs you at your computer: open the studio on the home's own computer`))
  return false
}

/** What {@link requireComputerOrDevice}, {@link unlockOf} and {@link gateByUnlock} read of the home. */
export type DangerousModeHome = Pick<HomeAuthService, 'arrivalOf' | 'dangerousMode' | 'elevationOf' | 'pageUnlockOf' | 'pinEnabled'> & Partial<Pick<HomeAuthService, 'touchUnlock'>>

/**
 * The running unlock a reach device's Peer holds: its page's unlock when the Peer carries one (PIN mode), otherwise the
 * unlock the device holds on its listener (a code the person typed at the computer, or a grace after approval). Every
 * route and policy check that asks "is this device unlocked" asks here.
 * @param home - the mounted `homeAuth` service.
 * @param principal - the device Peer's principal.
 * @returns the unlock, or undefined while the device is locked.
 */
export function unlockOf(home: Pick<DangerousModeHome, 'elevationOf' | 'pageUnlockOf'>, principal: ReachDevicePrincipal): { readonly id: string; readonly grace?: true } | undefined {
  return principal.unlockId === undefined ? home.elevationOf(principal.deviceId, principal.listener) : home.pageUnlockOf(principal.unlockId)
}

/**
 * {@link requireComputer} for a route a reach device may also use: a request that arrived on a reach listener passes the
 * hook, and the route's `admitPeer` ({@link admitApprovedDevice} for a route any approved device reads,
 * {@link gateByUnlock} for one that needs an unlock) decides which device. Every other request is decided as
 * {@link requireComputer} decides it, so a request the home cannot place, or that names a foreign `Host` on the
 * loopback listener, is refused. A computer-only route keeps {@link requireComputer}.
 * @param request - the request the Connection received.
 * @param response - the response, answered with the refusal when the request is refused.
 * @param homeAuth - the mounted `homeAuth` service, or `undefined` while none is mounted.
 * @param action - the action's name as the refusal states it, in sentence case, such as `Turning on full access`.
 * @returns whether the request may go on to the route.
 */
export function requireComputerOrDevice(request: ComputerRequest, response: ServerResponse, homeAuth: Pick<HomeAuthService, 'arrivalOf'> | undefined, action: string): boolean {
  const listener = homeAuth?.arrivalOf(request).listener
  if (listener !== undefined && listener !== 'loopback') return true
  return requireComputer(request, response, homeAuth, action)
}

/** The sentence a locked device reads when a route needs an unlock. */
const ELEVATION_REQUIRED_SENTENCE = 'Unlock this device first: it needs a code from your computer, or your PIN where PIN mode is on'

/**
 * The reach-device half of a route that needs an unlock (level U): its `admitPeer` admits a reach device and records
 * whether it holds a running unlock ({@link unlockOf}); its `fetch` answers `403 ELEVATION_REQUIRED` to a locked device
 * and otherwise runs the route. Without a recorded decision the Peer is the owner, who the hook
 * ({@link requireComputerOrDevice}) already placed at the computer.
 * @param homeAuth - a way to the mounted `homeAuth` service, read when a request arrives.
 * @param fetch - the route's own handler.
 * @param options - `grace: false` for a route that loosens a consent or guard row: the approval grace does not open it, only
 *   a code or a PIN unlock does. The grace opens the route by default. `renews` is explicit for every route: true for a deliberate,
 *   state-changing call, which renews a sliding unlock; false for a route the studio polls or that only reads.
 * @returns the `admitPeer` and `fetch` for `ConnectionFetchRoute`.
 */
export function gateByUnlock(homeAuth: () => DangerousModeHome | undefined, fetch: (request: Request) => Promise<Response>, options: { readonly grace?: boolean; readonly renews: boolean }): {
  readonly admitPeer: (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
} {
  const locked = new WeakSet<Request>()
  return {
    admitPeer: (request, peer) => {
      const home = homeAuth()
      if (home === undefined || peer.principal.kind !== REACH_DEVICE) return false
      const unlock = unlockOf(home, peer.principal as ReachDevicePrincipal)
      if (unlock === undefined || (unlock.grace === true && options.grace === false)) locked.add(request)
      // The route needs an unlock, so the call renews the unlock it ran under.
      else if (options.renews) home.touchUnlock?.(unlock.id)
      return true
    },
    fetch: (request) => {
      if (!locked.has(request)) return fetch(request)
      return Promise.resolve(new Response(refusalBody('ELEVATION_REQUIRED', ELEVATION_REQUIRED_SENTENCE), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }))
    },
  }
}

/**
 * The `admitPeer` of a route that only an unlocked device may use and that decides nothing else itself: a reach device
 * that holds a running unlock ({@link unlockOf}), and no other Peer. Prefer {@link gateByUnlock}, which answers a locked
 * device with a typed refusal.
 * @param homeAuth - a way to the mounted `homeAuth` service, read when a request arrives.
 * @returns the function for `ConnectionFetchRoute.admitPeer`.
 */
export function admitUnlockedDevice(homeAuth: () => DangerousModeHome | undefined): (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean {
  return (_request, peer) => {
    const home = homeAuth()
    if (home === undefined || peer.principal.kind !== REACH_DEVICE) return false
    return unlockOf(home, peer.principal as ReachDevicePrincipal) !== undefined
  }
}

/**
 * The `admitPeer` of a route that adds or tests model keys: it admits a reach device (an approved device holds a
 * session; no unlock is needed) and, while PIN mode is on, only the Peer of an unlocked page. The owner's Peer never
 * reaches `admitPeer`.
 * @param homeAuth - a way to the mounted `homeAuth` service, read when a request arrives.
 * @returns the function for `ConnectionFetchRoute.admitPeer`.
 */
export function admitKeyDevice(homeAuth: () => DangerousModeHome | undefined): (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean {
  return (_request, peer) => {
    const home = homeAuth()
    if (home === undefined || peer.principal.kind !== REACH_DEVICE) return false
    if (!home.pinEnabled()) return true
    const { unlockId } = peer.principal as ReachDevicePrincipal
    return unlockId !== undefined && home.pageUnlockOf(unlockId) !== undefined
  }
}

/**
 * The `admitPeer` of a read-only route every approved device may ask, such as the recommended plugins' purposes:
 * it admits a reach device whether or not its page is unlocked, and nothing else. The owner's Peer never reaches
 * `admitPeer`.
 * @returns the function for `ConnectionFetchRoute.admitPeer`.
 */
export function admitApprovedDevice(): (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean {
  return (_request, peer) => peer.principal.kind === REACH_DEVICE
}

/**
 * The pathname upstream's Connection routes a request target by: the target parsed against a base, which resolves dot
 * segments, their percent-encoded spellings and backslashes as the route lookup does. A hook that guards an exact route
 * compares this, never the raw target.
 * @param target - the request target as the Connection received it, or undefined.
 * @returns the routed pathname.
 */
export function routedPathname(target: string | undefined): string {
  return new URL(target ?? '/', 'http://dsh.invalid').pathname
}
