/**
 * Which listener a request arrived on, and whether that listener is the home's loopback one.
 *
 * C5 accepts an owner claim only on the loopback listener, so the question "did this request arrive on loopback?"
 * decides a security rule. Two independent answers are available and both must say loopback:
 *
 * - The stamp. A reach listener's dispatcher forwards a pre-login request to the web server's route, and stamps the
 *   request with the listener it serves ([`REQUEST_LISTENER`](#request_listener)), so the reach listener's own id is
 *   readable where the route runs.
 * - The `Host` header. The loopback listener is reached as `localhost`, `127.0.0.1` or `[::1]`, and every reach listener
 *   refuses exactly those (`HOST_MISMATCH`), so a claim that names a reach address is refused even when no stamp
 *   reached the route.
 *
 * @module @delo/home-auth/arrival
 */
import type { ListenerId } from '@delo/contract-admission'

/**
 * The symbol a reach listener's dispatcher stamps on a request it forwards, whose value is that listener's id. The
 * loopback listener has no dispatcher and stamps nothing, so an absent stamp is read as the one listener that does not
 * stamp — and the `Host` check then answers for it.
 */
export const REQUEST_LISTENER: unique symbol = Symbol.for('delo.home-auth.request-listener')

/** A request a dispatcher may have stamped. */
export interface StampedRequest {
  /** The listener that forwarded the request, when one did. */
  readonly [REQUEST_LISTENER]?: ListenerId
}

/**
 * The listener a request arrived on.
 * @param request - the request.
 * @returns the stamped listener, or `loopback` when nothing stamped the request.
 */
export function listenerOf(request: StampedRequest): ListenerId {
  return request[REQUEST_LISTENER] ?? 'loopback'
}

/**
 * Whether a `Host` header names this machine's loopback interface, which is what a studio on the home's own computer is
 * reached as.
 * @param host - the `Host` header, with its port when it has one.
 * @returns whether the host is `localhost`, a `.localhost` name or a loopback address.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const url = URL.parse(`http://${host}`)
  if (url === null) return false
  const name = url.hostname.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '[::1]') return true
  return /^127(?:\.\d{1,3}){3}$/.test(name)
}
