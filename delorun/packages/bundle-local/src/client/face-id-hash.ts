/**
 * The hashes a grant request names, computed in the browser with `crypto.subtle` exactly as the home computes them
 * (`hashArgs` and `hashRequest` of `@delorun/home-auth`): SHA-256, lower-case hex, over the RFC 8785 text of the JSON.
 * The home never trusts this value: it hashes the request it actually receives and compares.
 * @module @delorun/bundle-local/client/face-id-hash
 */

/**
 * The canonical JSON text of a value: object keys sorted by code unit, no whitespace, `undefined` members dropped.
 * @param value - a JSON value.
 * @returns the text.
 * @throws {TypeError} for a non-finite number or a value JSON cannot hold.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a non-finite number has no JSON form')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new TypeError('a value of this type has no JSON form')
}

/** Lower-case hex of the SHA-256 of some text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Hash the arguments of a Remote method call.
 * @param args - the call's argument object.
 * @returns the hex hash.
 */
export function hashArgs(args: unknown): Promise<string> {
  return sha256Hex(canonicalJson(args))
}

/**
 * The body text a Fetch call's hash covers: the canonical text of JSON, and any other text as it is sent.
 * @param body - a JSON value, or the text as sent (empty for no body).
 * @returns the text.
 */
function hashedBody(body: unknown): string {
  if (typeof body !== 'string') return canonicalJson(body)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (_notJson) {
    // Text that is not JSON is hashed as the bytes the home receives.
    return body
  }
  return canonicalJson(parsed)
}

/**
 * Hash a Fetch route call.
 * @param request - the method, the pathname with its query as the home receives it, and the body: a JSON value, or the
 *   text as sent, which is hashed in canonical form when it parses as JSON.
 * @returns the hex hash of `METHOD NUL path NUL body`.
 */
export function hashRequest(request: { readonly method: string; readonly path: string; readonly body: unknown }): Promise<string> {
  return sha256Hex(`${request.method.toUpperCase()}\u0000${request.path}\u0000${hashedBody(request.body)}`)
}
