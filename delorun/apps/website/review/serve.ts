/**
 * A static server for a built `out/` directory, for the review pass. It sends the right type for pictures, fonts and data,
 * serves `404.html` with status 404 for an unknown address, and sends `no-cache` so a second pass never reads a stale file.
 * Text types are sent brotli-compressed (gzip when brotli is not accepted) with `Content-Encoding` and `Vary: Accept-Encoding`, as
 * Cloudflare does, so the phone profile's timings read compressed sizes.
 *
 * @module @delorun/website/review/serve
 */
import { createServer, type Server } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** Content types by extension. */
export const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
}

/** The types Cloudflare compresses: text that shrinks, not pictures or fonts that are already compressed. */
const COMPRESSED = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml', '.webmanifest'])

/** The encodings the server can send. */
export type Encoding = 'br' | 'gzip' | 'identity'

/**
 * Chooses the encoding for a request, preferring brotli as Cloudflare does.
 * @param acceptEncoding - the request's `Accept-Encoding` header.
 * @param extension - the file's extension, with the dot.
 * @returns the encoding to send.
 */
export function chooseEncoding(acceptEncoding: string | undefined, extension: string): Encoding {
  if (!COMPRESSED.has(extension) || acceptEncoding === undefined) return 'identity'
  const accepted = acceptEncoding.split(',').map(part => part.trim().split(';')[0])
  if (accepted.includes('br')) return 'br'
  if (accepted.includes('gzip')) return 'gzip'
  return 'identity'
}

const cache = new Map<string, Buffer>()

function body(file: string, encoding: Encoding): Buffer {
  const key = `${file}|${encoding}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const raw = readFileSync(file)
  const made = encoding === 'br' ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : encoding === 'gzip' ? gzipSync(raw) : raw
  cache.set(key, made)
  return made
}

/**
 * Finds the file for a request path.
 * @param root - the absolute `out/` directory.
 * @param urlPath - the request path without the query.
 * @returns the file path, or `undefined` when there is none or the path leaves the root.
 */
export function resolveFile(root: string, urlPath: string): string | undefined {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '')
  const base = join(root, clean)
  if (!base.startsWith(root)) return undefined
  for (const candidate of [base, join(base, 'index.html'), `${base}.html`]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not a file at this candidate; the next spelling is tried.
    }
  }
  return undefined
}

/**
 * Starts the server on 127.0.0.1.
 * @param dir - the built directory.
 * @param port - the port.
 * @returns the listening server.
 */
export function serve(dir: string, port: number): Promise<Server> {
  const root = resolve(dir)
  const server = createServer((request, response) => {
    const file = resolveFile(root, (request.url ?? '/').split('?')[0] ?? '/')
    const send = file ?? join(root, '404.html')
    try {
      statSync(send)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not found')
      return
    }
    const encoding = chooseEncoding(request.headers['accept-encoding'], extname(send))
    const data = body(send, encoding)
    response.writeHead(file === undefined ? 404 : 200, {
      'content-type': TYPES[extname(send)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
      ...(COMPRESSED.has(extname(send)) ? { vary: 'Accept-Encoding' } : {}),
      ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
    })
    response.end(data)
  })
  return new Promise(done => server.listen(port, '127.0.0.1', () => { done(server) }))
}
