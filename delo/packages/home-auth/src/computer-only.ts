/**
 * The refusal of a Delo route that only the person at the home's own computer may use, such as turning on a
 * workspace's full access or accepting an MCP server command (C14, "Tailnet membership"). A route of another Delo plugin
 * calls {@link requireComputer} from its `connection/request` listener, before the body is read, so a reach session, or
 * any request the home cannot place on the loopback listener, is answered `403 LOOPBACK_REQUIRED` naming the action and
 * reaches no route. The listener matches the request with {@link routedPathname}, the pathname upstream's Connection
 * routes an exact Fetch route by, so no spelling of the target (`/x/../`, `%2e%2e`, `\`) reaches the route without the
 * check.
 *
 * @module @delo/home-auth/computer-only
 */
import type { ServerResponse } from 'node:http'
import { isLoopbackHost } from './arrival.ts'
import { refusalBody } from './errors.ts'
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
