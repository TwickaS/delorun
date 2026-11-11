/**
 * Browser-trust fence for every /api request. Defends the two confused-deputy
 * paths a browser opens against a local HTTP API — DNS rebinding (Host names
 * the attacker's domain while the socket reaches this server) and cross-site
 * requests fired from a malicious page. The Host fence binds every request,
 * browser-looking or not: over plain HTTP a browser attaches neither Origin
 * nor Fetch-Metadata to reads (images and navigations — those headers go only
 * to trustworthy destinations), so an unmarked request may still be a rebound
 * browser read and Host is the one header rebinding cannot forge. Non-browser
 * and remote clients pass the same fence via loopback, the listener's bind IP
 * literal, or a declared `trustedHosts` authority. Binding policy belongs to
 * the webserver config; this fence never establishes identity.
 */

import { API_PATH } from './api-path.ts'
import { isLoopbackHostname } from './loopback-hostname.ts'
import type { ConnectionTrustRequest } from './rpc.ts'

type TrustHeaders = ConnectionTrustRequest['headers']

/** Methods whose requests a browser sends without a body, so without any browser account of their origin. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

function header(headers: TrustHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalized URL of a bare authority (hostname lowercased, default port
 * stripped, IPv6 bracketed), or undefined when unparsable.
 * @param authority - `host` or `host:port` text.
 * @param scheme - special scheme to parse under; its default port is the one stripped.
 */
function parseAuthority(authority: string, scheme: 'http:' | 'https:' = 'http:'): URL | undefined {
  try {
    // http: and https: are WHATWG "special schemes": parsing yields a non-empty hostname or throws.
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether text is a bare authority exactly as an HTTP client writes it, so
 * {@link parseAuthority} reads it instead of repairing it. Parsing accepts
 * spellings the fence must not trust: user information (`evil@localhost`
 * authorizes `localhost`), surrounding and embedded whitespace or control
 * characters (WHATWG strips tabs and newlines anywhere in a URL), an IPv4
 * address's trailing dot, and non-ASCII host text (percent-decoded or mapped
 * by the host parser). Each of those names one authority to a browser and
 * another to this fence, so they are refused before parsing.
 * @param authority - a `Host` header value.
 * @returns true for printable ASCII host[:port] text with no user information and no trailing dot.
 */
function isBareAuthority(authority: string): boolean {
  // Printable ASCII without space: every whitespace and control spelling fails here.
  if (!/^[\x21-\x7E]+$/.test(authority) || authority.includes('@')) return false
  return !authority.endsWith('.')
}

/**
 * How many `Host` header lines a raw header list carries.
 * @param rawHeaders - alternating name/value lines, as node:http reports them.
 * @returns the number of `Host` lines.
 */
export function countHostLines(rawHeaders: readonly string[]): number {
  let lines = 0
  for (let at = 0; at < rawHeaders.length; at += 2) {
    if (rawHeaders[at]?.toLowerCase() === 'host') lines += 1
  }
  return lines
}

/**
 * Whether the request carries exactly one `Host` line. node:http keeps only
 * the first `Host` in its parsed view, so a repeated line is invisible there
 * while a downstream hop, a proxy, or a second parser may read the other one;
 * a raw list is the only witness. A Fetch `Headers` merges repeats into one
 * comma-joined value, which the authority check already refuses.
 */
function hasOneHostLine(request: ConnectionTrustRequest): boolean {
  return request.rawHeaders === undefined || countHostLines(request.rawHeaders) === 1
}

/**
 * Whether a request target reaches the shared `/api` channel. The target is
 * read as the webserver's router reads it, through WHATWG URL parsing, which
 * removes dot segments (`/x/../api`, `/x/%2e%2e/api`) and reads `\` as `/`,
 * so no spelling routes to `/api` while this check reads another path.
 * @param url - the request target, relative or absolute; undefined when the carrier reports none.
 * @returns true for `/api` and every path below it; an absent or unparsable
 *   target counts as `/api`, because the channel this fence guards is the only caller.
 */
function isApiTarget(url: string | undefined): boolean {
  if (url === undefined) return true
  let path: string
  try {
    path = new URL(url, 'http://dsh.invalid').pathname
  } catch {
    // An unparsable target is answered by the router's own failure; until then it gets the stricter rule.
    return true
  }
  return path === API_PATH || path.startsWith(`${API_PATH}/`)
}

/**
 * Whether the request must carry a browser's own account of its origin: a
 * state-changing request on the `/api` channel. A browser that attaches
 * Fetch-Metadata labels every fetch, and `same-site` names another origin on
 * the same site, which for a loopback listener is another local port whose
 * page the browser sends credentialed requests for without a preflight. The
 * Origin fence is blind when `Origin` is absent, so a present marker has to
 * decide. A request with neither `Origin` nor a marker is settled by
 * {@link isBrowserMarkedDestination}.
 */
function needsOriginAccount(request: ConnectionTrustRequest): boolean {
  const method = request.method?.toUpperCase()
  if (method === undefined || BODYLESS_METHODS.has(method)) return false
  return isApiTarget(request.url)
}

/**
 * Whether a request that states neither `Origin` nor Fetch-Metadata may come
 * from a non-browser caller (an SDK script, curl, the Desktop forwarder), which
 * has no origin to state. A browser attaches Fetch-Metadata to every request it
 * sends to a potentially trustworthy destination, loopback or HTTPS, so a
 * missing marker there names a caller that is not a Fetch-Metadata browser.
 * To any other destination a browser withholds the markers, and a no-referrer
 * form post withholds `Origin` too, so such a request is indistinguishable
 * from a forged one and stays refused. A browser without Fetch-Metadata
 * support is not told apart from a script: the cookie is `SameSite=Strict`, so
 * only a page on another local port could ride it.
 * @param hostUrl - the parsed `Host` authority, already accepted by the Host fence.
 * @param protocol - listener protocol.
 * @returns true when the destination is one a Fetch-Metadata browser always marks.
 */
function isBrowserMarkedDestination(hostUrl: URL, protocol: 'http:' | 'https:'): boolean {
  return protocol === 'https:' || isLoopbackHostname(hostUrl.hostname)
}

/**
 * Assert one configured `trustedHosts` entry is a bare authority (`host` or
 * `host:port`) in canonical form: it must survive WHATWG parsing unchanged
 * (case aside). Anything parsing would silently rewrite is refused as a typo
 * that must fail the load loudly instead of being ignored until requests 403
 * or quietly changing the grant: URL parts beyond the authority
 * (`harness.internal/path`, `user@harness.internal` — which would authorize
 * the embedded hostname), stripped whitespace, a dangling colon or
 * zero-padded port (which would broaden an intended exact-port grant to every
 * port), and non-canonical host spellings (`0x7f.0.0.1`, percent-encoding,
 * unbracketed IPv6; IDN hosts are declared in punycode, the form the wire
 * carries).
 * @param entry - the configured value, verbatim.
 */
export function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/**
 * Canonical form of a parsed authority: `hostname` when no port was written,
 * else `hostname:port`. The port is judged from URL parses under both special
 * schemes (their default ports differ, so `:80` and `:443` still count as
 * explicit), never from the raw string, where WHATWG trimming would misread
 * shapes like `host:port ` as port-less.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`${entryUrl.protocol === 'http:' ? 'https:' : 'http:'}//${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the request authority matches a `trustedHosts` entry. An entry with
 * an explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port. Both sides compare through WHATWG normalization,
 * so case and a redundant scheme-default port never decide trust.
 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[], protocol: 'http:' | 'https:'): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry, protocol)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Classify an authority already accepted by {@link assertTrustedAuthority}.
 * @param entry - the configured authority, verbatim.
 * @returns true unless the entry parses as a loopback hostname.
 */
export function isRemoteAuthority(entry: string): boolean {
  const url = parseAuthority(entry)
  return url === undefined || !isLoopbackHostname(url.hostname)
}

/**
 * Whether a parsed authority names the deployment's own bind address. A browser
 * dialing that literal sends it as Host, and accepting it grants nothing
 * further: the literal is no rebinding target, the Origin and cross-site checks
 * still apply, and it stays outside `trustedHosts`. Matching ignores the port,
 * like a port-less entry, and any `%zone` id (an interface selector, not
 * address text).
 */
function isBindAddressAuthority(hostUrl: URL, bindHost: string | undefined): boolean {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bindUrl !== undefined && bindUrl.hostname === hostUrl.hostname
}

/**
 * Decide whether one /api request may reach the RPC bridge.
 * @param request - Node HTTP or Fetch request facts (headers, and the method and target when the carrier reports them).
 * @param trustedHosts - non-loopback authorities this deployment serves: exact `host:port`, or port-less `host` matching any port.
 * @param bindHost - the listener's own bind IP literal, accepted on any port independently of `trustedHosts`.
 * @param protocol - listener protocol for default Host ports; HTTP when no Web carrier is mounted.
 * @returns true when the Host is ours (loopback, the bind address, or trusted), it appears
 *   exactly once, and any attached browser markers are same-origin. A state-changing `/api`
 *   request with no markers at all passes only toward loopback or an HTTPS listener.
 */
export function isTrustedApiRequest(
  request: ConnectionTrustRequest,
  trustedHosts: readonly string[],
  bindHost?: string,
  protocol: 'http:' | 'https:' = 'http:',
): boolean {
  // Host fence (DNS-rebinding defense), applied to every request: the browser
  // fills Host from the URL it believes it is talking to, so a rebound page
  // carries the attacker's domain here even though the socket lands on this
  // server. There is no marker shortcut — a browser read over plain HTTP
  // (images and navigations) arrives with neither Origin nor
  // Fetch-Metadata, indistinguishable from curl, and its response is readable
  // by the rebound page.
  const host = header(request.headers, 'host')
  if (host === undefined || !isBareAuthority(host) || !hasOneHostLine(request)) return false
  const hostUrl = parseAuthority(host, protocol)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)
    && !isTrustedAuthority(hostUrl, trustedHosts, protocol)
    && !isBindAddressAuthority(hostUrl, bindHost)) return false
  const site = header(request.headers, 'sec-fetch-site')
  // Cross-site fence: modern browsers label the initiator relationship on
  // every fetch; an explicit cross-site marker is refused regardless of Origin.
  if (site === 'cross-site') return false
  // Origin fence: when a browser attaches an Origin it must be exactly this
  // authority (compared through the same normalization as the Host). Absent
  // Origin is fine for a read — the Host fence above already bound the request.
  // The literal "null" (sandboxed iframes, file: pages) is an opaque origin, refused.
  const origin = header(request.headers, 'origin')
  if (origin !== undefined && !isSameAuthorityOrigin(origin, host)) return false
  if (!needsOriginAccount(request)) return true
  if (origin !== undefined || site === 'same-origin' || site === 'none') return true
  return site === undefined && isBrowserMarkedDestination(hostUrl, protocol)
}

/**
 * Compare Host under the Origin's HTTP(S) scheme so default ports normalize
 * consistently. The transport may remain HTTP behind an HTTPS proxy.
 * @param origin - verbatim Origin header value.
 * @param host - verbatim Host header value already accepted by the Host fence.
 * @returns true only when the Origin is this listener's own `http(s)` authority.
 */
function isSameAuthorityOrigin(origin: string, host: string): boolean {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  // Only http(s) can name this listener: the opaque `null` already threw above,
  // and every other scheme (file:, ftp:) fails here rather than matching by
  // hostname alone.
  const scheme = originUrl.protocol === 'https:' ? 'https:'
    : originUrl.protocol === 'http:' ? 'http:'
      : undefined
  if (scheme === undefined) return false
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== undefined && originUrl.host === hostUrl.host
}
