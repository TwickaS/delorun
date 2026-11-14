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

/** What {@link requireComputerUnlessDangerous} and {@link admitUnlockedDevice} read of the home. */
export type DangerousModeHome = Pick<HomeAuthService, 'arrivalOf' | 'dangerousMode' | 'elevationOf' | 'pageUnlockOf' | 'pinEnabled'>

/**
 * {@link requireComputer} for a route that an unlocked device may also use while dangerous mode holds, or an unlocked
 * PIN page while PIN mode is on: a request that arrived on a reach listener passes the hook then, and the route's `admitPeer` ({@link admitUnlockedDevice}) decides
 * whether its device holds an unlock. Every other request is decided as {@link requireComputer} decides it, so a request
 * the home cannot place, or that names a foreign `Host` on the loopback listener, is refused in both modes. A route that
 * approves a device or signs one in keeps {@link requireComputer}.
 * @param request - the request the Connection received.
 * @param response - the response, answered with the refusal when the request is refused.
 * @param homeAuth - the mounted `homeAuth` service, or `undefined` while none is mounted.
 * @param action - the action's name as the refusal states it, in sentence case, such as `Turning on full access`.
 * @returns whether the request may go on to the route.
 */
export function requireComputerUnlessDangerous(request: ComputerRequest, response: ServerResponse, homeAuth: DangerousModeHome | undefined, action: string): boolean {
  const listener = homeAuth?.arrivalOf(request).listener
  if (listener !== undefined && listener !== 'loopback' && (homeAuth?.dangerousMode() === true || homeAuth?.pinEnabled() === true)) return true
  return requireComputer(request, response, homeAuth, action)
}

/**
 * The `admitPeer` of a route that uses {@link requireComputerUnlessDangerous}: it admits a reach device that holds a
 * running unlock while dangerous mode holds, an unlocked PIN page without it (the page can do what the computer can,
 * minus the step-up routes, which keep {@link requireComputer}), and no other Peer; the owner's Peer never reaches
 * `admitPeer`.
 * @param homeAuth - a way to the mounted `homeAuth` service, read when a request arrives.
 * @returns the function for `ConnectionFetchRoute.admitPeer`.
 */
export function admitUnlockedDevice(homeAuth: () => DangerousModeHome | undefined): (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean {
  return (_request, peer) => {
    const home = homeAuth()
    if (home === undefined || peer.principal.kind !== REACH_DEVICE) return false
    const { deviceId, listener, unlockId } = peer.principal as ReachDevicePrincipal
    // A page's Peer holds only its own page unlock, never the device's; the unlock exists only while PIN mode is on.
    if (unlockId !== undefined) return home.pageUnlockOf(unlockId) !== undefined
    return home.dangerousMode() && home.elevationOf(deviceId, listener) !== undefined
  }
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
