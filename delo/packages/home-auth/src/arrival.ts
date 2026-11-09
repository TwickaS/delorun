/**
 * Which listener a request arrived on, whether that listener is the home's loopback one, and the studio address a
 * loopback request binds its device to.
 *
 * C5 accepts an owner claim, and answers the device list and the removal, only on the loopback listener, so the
 * question "did this request arrive on loopback?" decides a security rule. Two independent answers are available and
 * both must say loopback:
 *
 * - The stamp. A reach listener's dispatcher forwards a pre-login request to the web server's route, and stamps the
 *   request with the listener it serves ([`REQUEST_LISTENER`](#request_listener)), so the reach listener's own id is
 *   readable where the route runs.
 * - The `Host` header. The loopback listener is reached as `localhost`, `127.0.0.1` or `[::1]`, and every reach listener
 *   refuses exactly those (`HOST_MISMATCH`), so a request that names a reach address is refused even when no stamp
 *   reached the route.
 *
 * A browser can be made to send a request to the loopback listener while its `Host` names an attacker's name — that is
 * what DNS rebinding does — so the `Host` answer is the one that keeps a page on another origin away from the home's
 * records. The address a loopback claim records is the listener's own origin rather than the spelling the claim
 * happened to use, because a device is trusted on exactly one address (C5, "Binding to an address").
 *
 * @module @delo/home-auth/arrival
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { LOOPBACK_LISTENER_ADDRESS, type ListenerId, type StudioAddress } from '@delo/contract-admission'

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
 * The studio address of the loopback listener, `http://127.0.0.1:3080`: the origin every loopback spelling records, so a
 * device claimed as `localhost` and a request that arrives as `127.0.0.1` are the same address.
 */
export const LOOPBACK_STUDIO_ADDRESS: StudioAddress = brandString<StudioAddress>(
  `http://${LOOPBACK_LISTENER_ADDRESS.host}:${String(LOOPBACK_LISTENER_ADDRESS.port)}`,
)

/**
 * A `Host` header that names the loopback listener: a loopback name (`.localhost` names included), a loopback address or
 * `[::1]`, each with an optional port. Anything else the URL parser would still read as loopback — userinfo, a path, a
 * query, a fragment — is no authority at all and does not match.
 */
const LOOPBACK_AUTHORITY = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::(\d{1,5}))?$/i

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

/**
 * The studio address a request's `Host` names, when the authority is the loopback listener's.
 *
 * Every loopback spelling — `localhost`, `127.0.0.1`, `[::1]`, a `.localhost` name, with or without a port, and through
 * SSH port forwarding — is the one listener, so it answers with that listener's own origin,
 * {@link LOOPBACK_STUDIO_ADDRESS}. An address that is not an authority at all is answered with `undefined`, so a caller
 * refuses it instead of recording it: the `Host` header of an attacker's page is never written to a device record.
 * @param host - the request's `Host` header.
 * @returns the listener's address, or undefined when the header names no loopback authority.
 */
export function loopbackAddressOf(host: string | undefined): StudioAddress | undefined {
  if (host === undefined) return undefined
  const match = LOOPBACK_AUTHORITY.exec(host)
  if (match === null) return undefined
  const port = match[1]
  if (port !== undefined) {
    const number = Number(port)
    if (number < 1 || number > 65535) return undefined
  }
  return LOOPBACK_STUDIO_ADDRESS
}

/**
 * Whether a state-changing request came from the loopback listener's own origin, which is what a browser sends when the
 * studio itself made the request and never when another page did.
 *
 * `Origin` is compared with the request's own `Host`, both read as loopback authorities, so a page on another origin —
 * a DNS-rebinding name, a page the person visited, or a sandboxed frame that sends `Origin: null` — names something
 * else and is refused. A client that sends no `Origin` is a program rather than a browser and carries no cookie a page
 * could borrow, so it is left to the arrival check.
 * @param origin - the request's `Origin` header.
 * @param host - the request's `Host` header.
 * @returns whether the origin is the request's own loopback origin.
 */
export function isSameLoopbackOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false
  if (loopbackAddressOf(host) === undefined) return false
  return origin.toLowerCase() === `http://${host.toLowerCase()}`
}

/**
 * Whether a `Sec-Fetch-Site` header says the request came from somewhere other than the page served on this listener.
 * @param site - the request's `Sec-Fetch-Site` header, absent for a program rather than a browser.
 * @returns whether the browser named the request as foreign, or as neither own nor typed.
 */
export function isForeignFetchSite(site: string | undefined): boolean {
  return site !== undefined && site !== 'same-origin' && site !== 'none'
}
