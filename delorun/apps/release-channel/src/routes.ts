/**
 * The public Worker's request handling: `GET` and `HEAD` for exactly the channel's three kinds of path, read from a
 * bucket through `head` and `get` alone. Every other method or path answers 404; there is no write route.
 *
 * - `/timestamp.json`, cached for 60 seconds;
 * - `/root/<n>.root.json`, immutable;
 * - `/releases/download/v<version>/<file>`, immutable, where `<file>` is one plain file name.
 *
 * @module @delorun/release-channel/routes
 */

/** An object's metadata. */
export interface ObjectHead {
  /** The size in bytes. */
  readonly size: number
  /** The entity tag, unquoted. */
  readonly etag: string
}

/** An object with a readable body. */
export interface ObjectBody extends ObjectHead {
  /** The body, or the requested range of it. */
  readonly body: ReadableStream
}

/** The read-only part of an R2 bucket binding that the public Worker is written against. */
export interface ReadOnlyBucket {
  /**
   * Read an object's metadata.
   * @param key - the object key.
   * @returns the metadata, or `null`.
   */
  head(key: string): Promise<ObjectHead | null>
  /**
   * Read an object, or a byte range of it.
   * @param key - the object key.
   * @param options - the range: an offset and length.
   * @returns the object, or `null`.
   */
  get(key: string, options?: { range: { offset: number, length: number } }): Promise<ObjectBody | null>
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const TIMESTAMP_CACHE = 'public, max-age=60'
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const RELEASE_FILE = new RegExp(`^/releases/download/v${VERSION}/[A-Za-z0-9][A-Za-z0-9._-]*$`, 'u')
const ROOT_FILE = /^\/root\/[1-9][0-9]*\.root\.json$/u

/**
 * The bucket key and cache policy of a request path.
 * @param path - the URL's path.
 * @returns the key and `Cache-Control` value, or `undefined` when the channel serves no such path.
 */
function route(path: string): { key: string, cache: string } | undefined {
  if (path === '/timestamp.json') return { key: 'timestamp.json', cache: TIMESTAMP_CACHE }
  if (ROOT_FILE.test(path) || (RELEASE_FILE.test(path) && !path.includes('..'))) return { key: path.slice(1), cache: IMMUTABLE }
  return undefined
}

/**
 * Parse a single-range `Range` header against an object's size.
 * @param header - the header value.
 * @param size - the object's size.
 * @returns the byte range, `'unsatisfiable'` when it lies outside the object, or `undefined` for no usable range,
 * which serves the whole object.
 */
function byteRange(header: string, size: number): { start: number, end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null || (match[1] === '' && match[2] === '')) return undefined
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

function headers(key: string, cache: string, head: ObjectHead): Headers {
  return new Headers({
    'Content-Type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'Cache-Control': cache,
    'ETag': `"${head.etag}"`,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  })
}

/**
 * Answer one request.
 * @param request - the request.
 * @param bucket - the read-only bucket.
 * @returns the response: the object, a range of it, 416 for a range outside it, or 404.
 */
export async function handleChannelRequest(request: Request, bucket: ReadOnlyBucket): Promise<Response> {
  const notFound = new Response('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound
  const target = route(new URL(request.url).pathname)
  if (target === undefined) return notFound
  const head = await bucket.head(target.key)
  if (head === null) return notFound
  const answer = headers(target.key, target.cache, head)
  const requested = request.headers.get('Range')
  const range = requested === null ? undefined : byteRange(requested, head.size)
  if (range === 'unsatisfiable') {
    answer.set('Content-Range', `bytes */${String(head.size)}`)
    return new Response(null, { status: 416, headers: answer })
  }
  if (range === undefined) {
    answer.set('Content-Length', String(head.size))
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: answer })
    const object = await bucket.get(target.key)
    return object === null ? notFound : new Response(object.body, { status: 200, headers: answer })
  }
  answer.set('Content-Length', String(range.end - range.start + 1))
  answer.set('Content-Range', `bytes ${String(range.start)}-${String(range.end)}/${String(head.size)}`)
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers: answer })
  const object = await bucket.get(target.key, { range: { offset: range.start, length: range.end - range.start + 1 } })
  return object === null ? notFound : new Response(object.body, { status: 206, headers: answer })
}
