/**
 * The publish-time high-water mark endpoint of the cron Worker: the publisher posts the `timestamp.json` it just
 * uploaded, signed with an HMAC-SHA-256 over the body under the secret `MARK_SECRET`, and the Worker moves the mark to
 * that timestamp at once instead of at the next cron run. The publish S3 token still cannot write the mark; only a
 * holder of the HMAC secret can ask the Worker to.
 *
 * The Worker records the mark from the body only when the bucket holds exactly those bytes and the body verifies under
 * the newest root of the bucket's root chain, so the request names a timestamp the release signers signed. The body is
 * limited to {@link MARK_BODY_LIMIT} bytes. The mark never lowers: a lower version or a channel on a lower release is refused, and
 * the same request sent again changes nothing, so a replay cannot move the mark.
 *
 * @module @delorun/release-channel/mark-endpoint
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { checkAgainstMark, raiseMark, type HighWaterMark, type MarkStore } from './mark.ts'
import { newestRoot } from './resign-core.ts'

/** The request header that carries the hex HMAC-SHA-256 of the body. */
export const MARK_SIGNATURE_HEADER = 'x-delorun-mark-signature'

/** The path the publisher posts to. */
export const MARK_PATH = '/mark'

/** The most bytes of request body the endpoint reads; a `timestamp.json` is about a kilobyte. */
export const MARK_BODY_LIMIT = 64 * 1024

/** What the endpoint reads of the bucket. */
export interface MarkBucket {
  /**
   * List the keys under a prefix.
   * @param prefix - the key prefix, such as `root/`.
   * @returns the keys.
   */
  list(prefix: string): Promise<string[]>
  /**
   * Read an object.
   * @param key - the object key.
   * @returns its bytes, or undefined when it does not exist.
   */
  read(key: string): Promise<{ readonly bytes: Uint8Array } | undefined>
}

/**
 * The HMAC a publisher sends for a body.
 * @param secret - the shared secret.
 * @param body - the request body, the uploaded `timestamp.json`.
 * @returns the hex digest.
 */
export function markSignature(secret: string, body: Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Whether a signature is the body's HMAC, compared in constant time.
 * @param secret - the shared secret.
 * @param body - the request body.
 * @param signature - the header's value.
 * @returns whether it matches.
 */
function signed(secret: string, body: Uint8Array, signature: string | null): boolean {
  if (signature === null) return false
  const expected = Buffer.from(markSignature(secret, body))
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * The version and channel releases a timestamp names.
 * @param bytes - the `timestamp.json` bytes.
 * @returns them, as the mark holds them.
 * @throws Error when the bytes are not a timestamp file.
 */
function seenIn(bytes: Uint8Array): HighWaterMark {
  const signedJson = readEnvelope('timestamp', bytes).signedJson as { readonly version: number, readonly channels: Readonly<Record<'stable' | 'beta', { readonly release: string }>> }
  return { version: signedJson.version, channels: { stable: signedJson.channels.stable.release, beta: signedJson.channels.beta.release } }
}

/**
 * Read a request body of at most {@link MARK_BODY_LIMIT} bytes, counting what arrives.
 * @param request - the request.
 * @returns the bytes, or undefined when the declared length or the streamed bytes exceed the limit.
 */
async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MARK_BODY_LIMIT) return undefined
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = request.body?.getReader()
  while (reader !== undefined) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MARK_BODY_LIMIT) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Answer a publisher's request to move the mark.
 * @param request - the request: a `POST` to {@link MARK_PATH} with the timestamp as the body.
 * @param deps - the HMAC secret, the bucket, the mark store and the clock in Unix seconds.
 * @returns 200 with the mark, 401 for a missing or wrong signature, 404 for another path, 405 for another method, 409
 * when the timestamp lies below the mark, is not the bucket's, or does not verify under the bucket's newest root, 400
 * for a body that is not a timestamp, 413 for a body over {@link MARK_BODY_LIMIT}.
 */
export async function handleMarkRequest(request: Request, deps: { readonly secret: string, readonly bucket: MarkBucket, readonly mark: MarkStore, readonly now: () => number }): Promise<Response> {
  if (new URL(request.url).pathname !== MARK_PATH) return new Response('Not found\n', { status: 404 })
  if (request.method !== 'POST') return new Response('Method not allowed\n', { status: 405, headers: { allow: 'POST' } })
  const body = await boundedBody(request)
  if (body === undefined) return new Response('The body is too large\n', { status: 413 })
  if (!signed(deps.secret, body, request.headers.get(MARK_SIGNATURE_HEADER))) return new Response('Unauthorized\n', { status: 401 })
  let seen: HighWaterMark
  try {
    seen = seenIn(body)
  } catch (_notTimestamp: unknown) {
    return new Response('The body is not a timestamp file\n', { status: 400 })
  }
  const stored = await deps.bucket.read('timestamp.json')
  if (stored === undefined || !Buffer.from(stored.bytes).equals(body)) return new Response('The bucket does not hold this timestamp.json\n', { status: 409 })
  try {
    // An expired timestamp still moves the mark: its signature and lifetime hold, as for the cron run's previous file.
    verifyTimestamp(await newestRoot(deps.bucket), body, deps.now(), undefined, { allowExpired: true })
  } catch (error) {
    return new Response(`The timestamp does not verify under the bucket's roots: ${error instanceof Error ? error.message : String(error)}\n`, { status: 409 })
  }
  const current = await deps.mark.read()
  try {
    checkAgainstMark(current, seen)
  } catch (error) {
    return new Response(`${error instanceof Error ? error.message : String(error)}\n`, { status: 409 })
  }
  if (current === undefined || seen.version > current.version) await raiseMark(deps.mark, seen)
  return Response.json(seen)
}
