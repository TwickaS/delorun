/**
 * The loopback rule of `studio-browser`. The browse adapter drives the person's own signed-in browser, so the only
 * origins a run may reach are the studio's own, on this computer. No flag or environment variable widens the rule.
 *
 * @module @delo/tools/studio-browser/origin
 */

/** An `http:` or `https:` origin whose host is `127.0.0.1`, `localhost` or `[::1]`. Only {@link loopbackOrigin} makes one. */
export type LoopbackOrigin = string & { readonly __brand: 'LoopbackOrigin' }

/** The hosts `URL` reports for the loopback addresses; IPv6 hosts keep their brackets. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Accept a studio URL only when it names a loopback address.
 * @param url - the URL the person or agent passed.
 * @returns the URL's origin, scheme, host and port without path.
 * @throws Error when `url` does not parse, is not `http:` or `https:`, or its host is not a loopback address.
 */
export function loopbackOrigin(url: string): LoopbackOrigin {
  const refusal = new Error(`studio-browser drives only a studio on this computer: ${url} is not a loopback address`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    // An unparsable URL names no address, so it is refused like any other non-loopback one.
    throw new Error(refusal.message, { cause: error })
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOOPBACK_HOSTS.has(parsed.hostname)) throw refusal
  return parsed.origin as LoopbackOrigin
}
