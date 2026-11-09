/**
 * Bounded HTTP(S) retrieval for `ctx.web`: validates URLs, follows only same-origin redirects,
 * enforces time and size limits, classifies and decodes text, and leaves presentation to
 * `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies
 * or ambient credentials.
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { LookupFunction } from 'node:net'
import type { Agent, Dispatcher, Response } from 'undici'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/**
 * One resolved address of a fetch destination's hostname, as `node:dns`
 * reports it: the literal address and its IP family (4 or 6).
 */
export interface FetchGuardAddress {
  /** The resolved IP literal. */
  readonly address: string
  /** The address family, 4 or 6. */
  readonly family: number
}

/**
 * Optional pre-connection guard over this provider's destinations. Mounted as
 * the `fetchGuard` service, it is consulted before EVERY hop — the initial
 * request and each redirect target — with the hop's URL and the addresses its
 * hostname resolved to. A throw refuses the hop: the error propagates as this
 * provider's failure, and the model reads it verbatim as the typed refusal, so
 * implementations should raise a typed error naming the host and the reason.
 * With no service mounted the provider behaves exactly as it does unguarded.
 */
export interface FetchGuard {
  /** Refuse the destination by throwing; resolve to allow it. */
  check(url: URL, addresses: readonly FetchGuardAddress[]): Promise<void>
}

/**
 * The addresses a mounted guard approved for ONE fetch's hops, and the
 * transport that pins that fetch's connections to them. A guard that approved
 * `node:dns`'s answer while the socket resolved the name a second time would
 * guard nothing — a resolver that rebinds between the two lookups would still
 * connect where the guard never looked — so the connection is made on an agent
 * whose resolver returns exactly the approved addresses, and a host with no
 * approved address cannot connect at all.
 */
class PinnedConnections {
  /** The approved addresses of each host this fetch has asked to reach, by hostname. */
  private readonly approved = new Map<string, readonly FetchGuardAddress[]>()

  /** The agent pinning this fetch's connections, created on its first direct hop. */
  private agent: Agent | undefined

  /**
   * Record the addresses the guard approved for one hop.
   * @param hostname - the hop's hostname, as the URL spells it.
   * @param addresses - the approved addresses, in resolution order.
   */
  approve(hostname: string, addresses: readonly FetchGuardAddress[]): void {
    this.approved.set(hostname, addresses)
  }

  /**
   * The transport this hop must be sent on: the pinned agent for a direct
   * connection, the process's proxy dispatcher when the installed proxy policy
   * routes this URL (the proxy resolves the target itself, so there is no
   * address of ours to pin), or `undefined` when the hop was never approved and
   * the process-wide dispatcher already routes it.
   * @param url - the hop's destination.
   * @returns the dispatcher to send the hop on, or undefined for the default one.
   */
  async dispatcherFor(url: URL): Promise<Dispatcher | undefined> {
    if (!this.approved.has(url.hostname)) return undefined
    // Node-only, like the transport itself: a browser worker never reaches a hop.
    const { proxyRouteFor } = await import('@deepseek-ai/dsh-http-proxy')
    const route = proxyRouteFor(url)
    if (route.proxied) return route.dispatcher
    if (this.agent === undefined) {
      const { Agent } = await import('undici')
      this.agent = new Agent({ connect: { lookup: pinnedLookup(this.approved) } })
    }
    return this.agent
  }

  /** Release the pinned agent, once its response is read or cancelled. */
  async close(): Promise<void> {
    const agent = this.agent
    this.agent = undefined
    /* v8 ignore next -- destroy() of a live agent resolves; a best-effort release has nothing to report. */
    await agent?.destroy().catch(() => {})
  }
}

/**
 * A `node:dns`-shaped resolver for a pinned agent: it answers with exactly the
 * addresses the guard approved for the hostname the connection asked about, in
 * the resolution order the guard saw, and fails the connection for any other
 * hostname. `node:net` asks with `all: true` under its happy-eyeballs default,
 * and with a family filter when the caller pinned one.
 * @param approved - the approved addresses of each host this fetch reaches.
 * @returns the resolver to hand to the agent's `connect.lookup`.
 */
function pinnedLookup(approved: ReadonlyMap<string, readonly FetchGuardAddress[]>): LookupFunction {
  return (hostname, options, callback): void => {
    const addresses = approved.get(hostname)
    if (addresses === undefined || addresses.length === 0) {
      callback(new WebError(`no address was approved for ${JSON.stringify(hostname)}`, 'WEB_PROVIDER_ERROR'), [])
      return
    }
    const family = addresses.filter(address => options.family === undefined || address.family === options.family)
    const usable = family.length > 0 ? family : addresses
    if (options.all === true) {
      callback(null, usable.map(address => ({ address: address.address, family: address.family })))
      return
    }
    const first = usable[0]
    /* v8 ignore next -- usable is never empty: it falls back to a non-empty approved set. */
    if (first === undefined) return
    callback(null, first.address, first.family)
  }
}

/** The anonymous HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - resolved transport and response limits.
   * @param resolveGuard - reads the optionally mounted `fetchGuard` service at
   *   each hop; `undefined` (or a lookup that answers `undefined`) runs the
   *   provider unguarded, byte-identical to upstream's.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly resolveGuard?: () => FetchGuard | undefined,
  ) {}

  /** No credentials to check — an anonymous fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    // One pinned transport per fetch: a hop's approved addresses live for this
    // call, and the agent holding the connection is released when it ends.
    const pinned = new PinnedConnections()
    try {
      return await this.followAndRead(request.url, d.signal, pinned)
    } finally {
      await pinned.close()
    }
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal, pinned: PinnedConnections): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl)
    let redirectsFollowed = 0

    for (;;) {
      const response = await this.requestOnce(currentUrl, signal, pinned)
      if (isRedirectStatus(response.status)) {
        // Enforce the redirect budget before validating the next hop.
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          // A redirect status with no Location is not a usable resource. Cancel
          // the (possibly streaming) body before throwing so no socket leaks.
          await response.body?.cancel()
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, currentUrl)
        // Re-validate the target against the same transport hygiene a direct request gets: a
        // redirect must not be a back door to a credentialed, non-http(s), or over-long URL
        // that validateFetchUrl would reject.
        let validatedTarget: URL
        try {
          validatedTarget = validateFetchUrl(target.toString())
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error: unknown) {
          await response.body?.cancel()
          throw error
        }
        await response.body?.cancel()
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }

      return await this.readBody(response, currentUrl, signal)
    }
  }

  /**
   * Send one GET through the dispatcher the hop calls for: the process-wide one,
   * which applies the installed proxy policy, or the pinned agent the guard's
   * approved addresses select for a direct hop.
   */
  private async requestOnce(url: URL, signal: AbortSignal, pinned: PinnedConnections): Promise<Response> {
    // The guard classifies each hop before its connection opens. It sits outside
    // the transport translation below on purpose: a refusal propagates as the
    // guard's typed error — the model-facing refusal — not as a network failure.
    await this.checkFetchGuard(url, pinned)
    const headers = {
      'user-agent': this.limits.userAgent,
      'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    }
    try {
      // Keep the Node-only transport out of browser-worker startup; a real request loads it here.
      const { fetch } = await import('undici')
      const dispatcher = await pinned.dispatcherFor(url)
      return await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, ...dispatcher === undefined ? {} : { dispatcher } })
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /**
   * Consult the mounted `fetchGuard` (if any) about this hop's destination. The
   * hostname is resolved first so the guard classifies the addresses the
   * connection would actually use, never just the name; an IP literal skips the
   * lookup. Only mounted guards resolve and classify — with none, no lookup, no
   * call and no pinning happen and the provider is byte-identical to upstream's.
   * The addresses a guard approves are then the only ones the hop may connect
   * to, so a resolver that answers this lookup and the connection's differently
   * cannot carry the hop somewhere the guard never saw.
   */
  private async checkFetchGuard(url: URL, pinned: PinnedConnections): Promise<void> {
    const guard = this.resolveGuard?.()
    if (guard === undefined) return
    let addresses: readonly FetchGuardAddress[]
    try {
      addresses = await resolveAddresses(url.hostname)
    } catch (error: unknown) {
      throw new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    await guard.check(url, addresses)
    pinned.approve(url.hostname, addresses)
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Reject unsupported declarations before reading, releasing the response stream.
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    let decoded: string
    try {
      // Only a real byte-cap truncation permits an incomplete UTF-8 suffix.
      decoded = decoder.decode(bytes, { stream: decoder.fatal && truncatedByBytes })
    } catch (error: unknown) {
      throw new WebError(
        'response body is not valid UTF-8 for the malformed charset declaration',
        'WEB_UNSUPPORTED_CONTENT_TYPE',
        { cause: error },
      )
    }
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    // Undici exposes response chunks as `any`; Fetch guarantees body chunks are Uint8Array.
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Resolve a hostname to every address the connection could use. An IP literal
 * resolves to itself without a lookup; otherwise `node:dns` resolves all
 * addresses in the order the resolver returned them. The Node-only import is
 * dynamic so browser-worker startup stays free of it.
 */
async function resolveAddresses(hostname: string): Promise<readonly FetchGuardAddress[]> {
  const { isIP } = await import('node:net')
  const literal = isIP(hostname)
  if (literal !== 0) return [{ address: hostname, family: literal }]
  const dns = await import('node:dns')
  return await dns.promises.lookup(hostname, { all: true, verbatim: true })
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request-phase `fetch` rejects with the abort reason, while the read-phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
