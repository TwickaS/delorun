/**
 * Reading and stripping the page unlock token of PIN mode (C4, "Authenticator"; C14, "PIN mode").
 *
 * A page presents its token as the `Delorun-Unlock` header on an `/api` request and as the WebSocket subprotocol
 * `delorun-unlock.<token>` on the `/api/remote.mux` upgrade. It is never read from a query. {@link takeUnlockToken} removes
 * both carriers from the request, in every header view, so no route, upgrade handler or plugin downstream sees it.
 *
 * @module @delorun/home-auth/unlock-token
 */
import type { ConnectionIndexRequest } from '@deepseek-ai/dsh-client-connection'

/** The request header that carries the token. */
export const UNLOCK_HEADER = 'delorun-unlock'

/** The prefix of the WebSocket subprotocol that carries the token. */
export const UNLOCK_SUBPROTOCOL_PREFIX = 'delorun-unlock.'

const PROTOCOL_HEADER = 'sec-websocket-protocol'

/** The token each request carried, kept for the PIN routes that name the page's unlock after admission stripped it. */
const taken = new WeakMap<object, string>()

/**
 * The unlock token a request carried, which {@link takeUnlockToken} removed from its headers.
 * @param request - the request {@link takeUnlockToken} read.
 * @returns the token, or undefined when the request carried none. A request {@link takeUnlockToken} never read still
 *   answers from its own header.
 */
export function unlockTokenOf(request: { readonly headers?: Readonly<Record<string, unknown>> }): string | undefined {
  const value = taken.get(request) ?? request.headers?.[UNLOCK_HEADER]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** What a request carried. */
export interface TakenUnlock {
  /** The token, or undefined when the request carried none. */
  readonly token: string | undefined
  /** Whether the request carried more than one token, or one that is not a single header value. */
  readonly ambiguous: boolean
}

/**
 * Remove the unlock token from a request and return it.
 * @param request - the request, whose headers change in place.
 * @returns the token the request carried, which is ambiguous when two carriers or two values were present.
 */
export function takeUnlockToken(request: ConnectionIndexRequest): TakenUnlock {
  const found: string[] = []
  const headers = request.headers
  if (headers instanceof Headers) {
    const plain = headers.get(UNLOCK_HEADER)
    if (plain !== null) found.push(plain)
    headers.delete(UNLOCK_HEADER)
    const offered = headers.get(PROTOCOL_HEADER)
    if (offered !== null) {
      const kept = splitProtocols(offered, found)
      if (kept.length === 0) headers.delete(PROTOCOL_HEADER)
      else headers.set(PROTOCOL_HEADER, kept.join(', '))
    }
  } else {
    stripPlainHeader(headers as Record<string, string | readonly string[] | undefined>, found)
    const extra = request as { headersDistinct?: Record<string, string[] | undefined>; rawHeaders?: string[] }
    if (extra.headersDistinct !== undefined) {
      for (const value of extra.headersDistinct[UNLOCK_HEADER] ?? []) found.push(value)
      Reflect.deleteProperty(extra.headersDistinct, UNLOCK_HEADER)
    }
    stripProtocolHeader(headers as Record<string, string | readonly string[] | undefined>, found)
    if (extra.headersDistinct?.[PROTOCOL_HEADER] !== undefined) {
      const kept = extra.headersDistinct[PROTOCOL_HEADER].flatMap(line => splitProtocols(line, []))
      if (kept.length === 0) Reflect.deleteProperty(extra.headersDistinct, PROTOCOL_HEADER)
      else extra.headersDistinct[PROTOCOL_HEADER] = [kept.join(', ')]
    }
    if (extra.rawHeaders !== undefined) stripRaw(extra.rawHeaders)
  }
  const distinct = [...new Set(found)]
  if (distinct.length === 1 && distinct[0] !== undefined && distinct[0] !== '') taken.set(request, distinct[0])
  return { token: distinct[0], ambiguous: distinct.length > 1 }
}

/**
 * Take the `Delorun-Unlock` header out of a node header object.
 * @param headers - the header object.
 * @param found - receives each value.
 */
function stripPlainHeader(headers: Record<string, string | readonly string[] | undefined>, found: string[]): void {
  const value = headers[UNLOCK_HEADER]
  if (typeof value === 'string') found.push(value)
  else if (value !== undefined) found.push(...value, '')
  Reflect.deleteProperty(headers, UNLOCK_HEADER)
}

/**
 * Take the unlock subprotocol out of a node header object's `Sec-WebSocket-Protocol`.
 * @param headers - the header object.
 * @param found - receives each token.
 */
function stripProtocolHeader(headers: Record<string, string | readonly string[] | undefined>, found: string[]): void {
  const value = headers[PROTOCOL_HEADER]
  if (value === undefined) return
  const kept = (typeof value === 'string' ? [value] : value).flatMap(line => splitProtocols(line, found))
  if (kept.length === 0) Reflect.deleteProperty(headers, PROTOCOL_HEADER)
  else headers[PROTOCOL_HEADER] = kept.join(', ')
}

/**
 * Split a `Sec-WebSocket-Protocol` value, collecting the unlock tokens and keeping the other protocols.
 * @param line - the header value.
 * @param found - receives each token.
 * @returns the protocols that are not the unlock subprotocol.
 */
function splitProtocols(line: string, found: string[]): string[] {
  const kept: string[] = []
  for (const entry of line.split(',').map(part => part.trim()).filter(part => part !== '')) {
    if (entry.startsWith(UNLOCK_SUBPROTOCOL_PREFIX)) found.push(entry.slice(UNLOCK_SUBPROTOCOL_PREFIX.length))
    else kept.push(entry)
  }
  return kept
}

/**
 * Remove the token from node's raw header list, which some readers use instead of the parsed views.
 * @param raw - the alternating names and values, edited in place.
 */
function stripRaw(raw: string[]): void {
  for (let at = raw.length - 2; at >= 0; at -= 2) {
    const name = raw[at]?.toLowerCase()
    if (name === UNLOCK_HEADER) {
      raw.splice(at, 2)
    } else if (name === PROTOCOL_HEADER) {
      const kept = splitProtocols(raw[at + 1] ?? '', [])
      if (kept.length === 0) raw.splice(at, 2)
      else raw[at + 1] = kept.join(', ')
    }
  }
}
