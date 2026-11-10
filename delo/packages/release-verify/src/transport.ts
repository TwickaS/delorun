/**
 * The {@link ReleaseLogTransport} the online check of contract C18 reads through: a Rekor v2 log's latest cosigned
 * checkpoint, and RFC 6962 consistency proofs computed from its C2SP `tlog-tiles` hash tiles by
 * `@delo/release-formats/log/tiles`, the one tile reader of this repository. The log serves both below
 * `https://<log origin>/api/v2`, where the origin is the trusted root's `log.origin` ({@link logEndpoints}); a build
 * for a local log passes its own endpoint set instead. The log has no proof endpoint, and the proof the tiles give is
 * verified against both signed roots by `online.ts`, so a tile served wrong makes a proof that does not verify.
 *
 * Every request goes through the `fetch` the caller injects, under the check's deadline and contract C18's 30-second
 * request timeout, with a size limit read before the body is kept, following at most {@link MAX_REDIRECTS} redirects on
 * the URL's own host. A request that fails, times out or answers another status throws {@link LogUnreachableError}; an
 * answer that is wrong in itself throws {@link LogContradictionError}: a `404` or `410` for a tile the tree size says
 * exists, an answer over its limit, a tile of the wrong length, a redirect to another host. Whether a contradiction
 * fails the check is `online.ts`'s rule: for the checkpoint, nothing is signed yet, so it does not.
 *
 * @module @delo/release-verify/transport
 */
import { RELEASE_LOG_REQUEST_TIMEOUT_SECONDS } from '@delo/contract-release-log'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { consistencyProofFromTiles, TileError } from '@delo/release-formats/log/tiles'
import { LogContradictionError, LogUnreachableError, type ReleaseLogTransport } from './online.ts'

/** The path below a Rekor v2 log's host that serves its checkpoint and its tiles. */
export const RELEASE_LOG_API_PREFIX = '/api/v2'

/** The redirects a request follows, each on the host it was sent to; the log answers directly, so a hop is rare. */
export const MAX_REDIRECTS = 2

/** The largest checkpoint note read: a body and one signature line per witness fit well inside it. */
export const CHECKPOINT_SIZE_LIMIT = 64 * 1024

/** The largest tile: 256 hashes of 32 bytes. */
const TILE_SIZE_LIMIT = 256 * 32

/** The hosts a local log's endpoint may name over plain `http:`: this machine only. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/** The `fetch` the transport reads through. */
export type Fetch = typeof globalThis.fetch

/** Where a log is read. */
export interface LogEndpoints {
  /** The log's latest checkpoint. */
  readonly checkpoint: string
  /** The log's tlog-tiles prefix, without a trailing slash; tiles are read under `<tiles>/tile/`. */
  readonly tiles: string
}

/** What the transport needs. */
export interface TilesTransportOptions extends LogEndpoints {
  /** The fetch every request goes through. */
  readonly fetch: Fetch
}

/**
 * The production endpoints of the log a trusted root names: a Rekor v2 log's checkpoint origin line is its host, with
 * a port when it has one, and the log serves its checkpoint and tiles below {@link RELEASE_LOG_API_PREFIX} there. The
 * root that names the log therefore also names where it is read.
 * @param root - the trusted root.
 * @returns `https://<origin>/api/v2/checkpoint` and `https://<origin>/api/v2`.
 * @throws Error when the origin is not a host with an optional port.
 */
export function logEndpoints(root: RootMetadata): LogEndpoints {
  const origin = root.log.origin
  let url: URL | undefined
  try {
    url = new URL(`https://${origin}`)
  } catch {
    // The URL constructor's own message names no origin, so the refusal below reports this case too.
    url = undefined
  }
  if (url === undefined || url.host !== origin.toLowerCase() || url.username !== '' || url.password !== '') {
    throw new Error(`the trusted root names the log ${JSON.stringify(origin)}, which is not a host with an optional port, so the log cannot be read from it`)
  }
  const tiles = `https://${url.host}${RELEASE_LOG_API_PREFIX}`
  return { checkpoint: `${tiles}/checkpoint`, tiles }
}

/**
 * Refuse an endpoint the transport would read that is neither HTTPS nor this machine's loopback over HTTP.
 * @param name - the endpoint's name, for the message.
 * @param value - the URL.
 * @throws Error when the URL does not parse or breaks the rule; a misconfigured transport fails when it is built.
 */
function requireSecure(name: string, value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new Error(`the release-log transport's ${name} URL ${JSON.stringify(value)} is neither HTTPS nor this machine's loopback address`)
  }
}

/**
 * The reason a failure gives.
 * @param error - the failure.
 * @returns its message.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch one URL and read at most `limit` bytes of its body, following at most {@link MAX_REDIRECTS} redirects on the
 * URL's own host.
 * @param fetch - the fetch.
 * @param url - the URL.
 * @param limit - the most bytes the body may hold.
 * @param signal - the check's deadline.
 * @returns the body, or `undefined` when the server answered 404 or 410.
 * @throws LogUnreachableError when the request fails or times out, or the status is not 2xx, 3xx, 404 or 410.
 * @throws LogContradictionError when the body exceeds `limit`, or a redirect leaves the host or exceeds the limit.
 */
async function fetchLimited(fetch: Fetch, url: string, limit: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
  const origin = new URL(url)
  let current = url
  let response: Response
  for (let hops = 0; ; hops++) {
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000)]) })
    } catch (error) {
      throw new LogUnreachableError(`${current} could not be fetched: ${reasonOf(error)}`)
    }
    if (response.status < 300 || response.status >= 400) break
    await response.body?.cancel()
    const next = new URL(response.headers.get('location') ?? '', current)
    if (next.protocol !== origin.protocol || next.host !== origin.host) throw new LogContradictionError(`${current} redirects to ${next.href}, outside the log's host ${origin.host}`)
    if (hops === MAX_REDIRECTS) throw new LogContradictionError(`${url} redirects more than ${String(MAX_REDIRECTS)} times`)
    current = next.href
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LogUnreachableError(`${current} answered ${String(response.status)}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          throw new LogContradictionError(`${current} answered more than ${String(limit)} bytes, which its format does not allow`)
        }
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof LogContradictionError) throw error
      throw new LogUnreachableError(`${current} could not be read: ${reasonOf(error)}`)
    }
  }
  return Buffer.concat(chunks)
}

/**
 * A transport over `fetch` and a tlog-tiles log.
 * @param options - the fetch, the checkpoint URL and the tiles prefix.
 * @returns the transport.
 * @throws Error when either URL is neither HTTPS nor this machine's loopback over HTTP.
 */
export function tilesTransport(options: TilesTransportOptions): ReleaseLogTransport {
  requireSecure('checkpoint', options.checkpoint)
  requireSecure('tiles', options.tiles)
  return {
    async latestCheckpoint(signal: AbortSignal): Promise<string> {
      const bytes = await fetchLimited(options.fetch, options.checkpoint, CHECKPOINT_SIZE_LIMIT, signal)
      if (bytes === undefined) throw new LogContradictionError(`the log does not serve its checkpoint at ${options.checkpoint}`)
      return Buffer.from(bytes).toString('utf8')
    },
    async consistencyProof(firstSize: number, secondSize: number, signal: AbortSignal): Promise<readonly string[]> {
      try {
        const proof = await consistencyProofFromTiles(firstSize, secondSize, path => fetchLimited(options.fetch, `${options.tiles}/${path}`, TILE_SIZE_LIMIT, signal))
        return proof.map(hash => hash.toString('hex'))
      } catch (error) {
        if (error instanceof TileError) throw new LogContradictionError(`the log's checkpoint names ${String(secondSize)} entries, but ${error.message}`)
        throw error
      }
    },
  }
}
