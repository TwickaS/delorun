/**
 * The web server paths a signed-in device reaches over a reach listener. The authenticator admits a request with a live
 * session only when its target is on {@link REACH_DEVICE_PATHS}, and refuses every other target with
 * `403 LOOPBACK_REQUIRED` before any route, upgrade handler or the fallback runs, so a route that checks only that its
 * request was admitted never answers a device unless this table lists its path.
 *
 * A listed path is not an allowed action: `/api` still passes each Remote call through the `reach-device` remote access
 * policy (`./reach-access.ts`), and each exact Fetch route under it answers a device only when the route admits that
 * Peer; the routes under `/auth` decide their own arrival.
 *
 * @module @delorun/home-auth/reach-paths
 */

/** How a {@link ReachDevicePath} matches a pathname: `exact` equals it; `prefix` equals it or begins with it and `/`. */
export type ReachDevicePathMatch = 'exact' | 'prefix'

/** One path a signed-in device reaches, with what it lets the person do from the device. */
export interface ReachDevicePath {
  readonly path: string
  readonly match: ReachDevicePathMatch
  readonly reason: string
}

/** Why each install-time file of the studio's build is listed. */
const INSTALL_FILE = 'an install-time file of the studio\'s build: the web manifest and the icons it and the page name'

/**
 * Every path a signed-in device reaches. Each `path` is absolute, holds no empty, `.` or `..` segment and no
 * percent-escape, and has no trailing slash.
 */
export const REACH_DEVICE_PATHS: readonly ReachDevicePath[] = [
  { path: '/', match: 'exact', reason: 'the studio\'s page, which the fallback serves' },
  { path: '/assets', match: 'prefix', reason: 'the studio\'s built scripts, styles, fonts and grammar chunks, which the fallback serves' },
  { path: '/manifest.webmanifest', match: 'exact', reason: INSTALL_FILE },
  { path: '/favicon.svg', match: 'exact', reason: INSTALL_FILE },
  { path: '/favicon-dark.svg', match: 'exact', reason: INSTALL_FILE },
  { path: '/apple-touch-icon.png', match: 'exact', reason: INSTALL_FILE },
  { path: '/icon-192.png', match: 'exact', reason: INSTALL_FILE },
  { path: '/icon-512.png', match: 'exact', reason: INSTALL_FILE },
  { path: '/icon-maskable-512.png', match: 'exact', reason: INSTALL_FILE },
  { path: '/api', match: 'prefix', reason: 'Remote calls, their event stream and its `/api/remote.mux` upgrade, which the `reach-device` policy decides one by one, and exact Fetch routes, which answer only a Peer they admit' },
  { path: '/plugins', match: 'prefix', reason: 'the client plugin bundles the client module loader imports, and the module graph updates it follows at `/plugins/events`' },
  { path: '/auth', match: 'prefix', reason: 'sign-in, session rotation and the device routes of this package, which decide their own arrival' },
  { path: '/delorun/reach/status', match: 'exact', reason: 'the reach status the studio shows, which `@delorun/reach` answers to a signed-in device' },
]

/** Percent-escapes of `/` and `\`, which a route that decodes its path would read as a separator. */
const ENCODED_SEPARATOR = /%(?:2f|5c)/i

/**
 * The pathname of a request target that names exactly one path: the target's path, up to its query, when parsing it
 * changes nothing and it holds no empty segment and no escaped separator. A target with a dot segment, a backslash, an
 * escaped dot segment, a double slash or an escaped slash names a path other than its text, so it has none.
 * @param target - the request target, origin-form.
 * @returns the pathname, or undefined when the target is not a plain path.
 */
export function plainPathname(target: string): string | undefined {
  if (!target.startsWith('/')) return undefined
  const end = target.search(/[?#]/)
  const raw = end === -1 ? target : target.slice(0, end)
  // A path-absolute input always parses against a base; this is the pathname the web server routes by.
  const pathname = new URL(raw, 'http://reach.invalid').pathname
  if (pathname !== raw || raw.includes('//') || ENCODED_SEPARATOR.test(raw)) return undefined
  return pathname
}

/**
 * Whether a signed-in device reaches a request target over a reach listener.
 * @param target - the request target, origin-form.
 * @returns whether the target is a plain path on {@link REACH_DEVICE_PATHS}.
 */
export function reachesDevicePath(target: string): boolean {
  const pathname = plainPathname(target)
  if (pathname === undefined) return false
  return REACH_DEVICE_PATHS.some(entry => pathname === entry.path || (entry.match === 'prefix' && pathname.startsWith(`${entry.path}/`)))
}
