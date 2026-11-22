/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: a webserver resource serving the built frontend directory
 * with explicit index entry points. A readable index renders at the dist root,
 * the configured index path and, while an index injection row names a
 * distribution's recovery routes (the `dshRecoveryRoutes` global), `/recovery`,
 * where the boot page shows that distribution's recovery screen; without such a
 * row `/recovery` is an ordinary missing path. Missing paths return 404, traversal outside the
 * dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
 * is 405. An HTTP index request first passes Connection's browser
 * authentication and renders for the browser Peer; an in-process read renders
 * for the Peer its caller admitted. An HTTP read of any other dist file first
 * passes the same fence, so a rebound page and an unauthenticated caller
 * cannot read the application's bytes while the index is gated; only the
 * install-time files at the dist root a launcher fetches before sign-in (the
 * favicons, the Web app manifest and the icons it names, and the touch icons)
 * stay public. Both
 * renders go through the webserver's index render (structured injection rows,
 * then raw taps).
 * Non-index assets carry a weak ETag with `cache-control: no-cache` and answer
 * a matching `If-None-Match` with 304, while the index carries no cache
 * headers. The dist location is workspace knowledge of the composing
 * application, so `distIndex` is typically supplied through a `!!js`
 * expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { RECOVERY_ROUTES_GLOBAL } from './recovery.ts'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'
const JSON_MIME = 'application/json; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Launchers require an image Content-Type for the install icons.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

/**
 * The dist-root path that answers the structured index injection rows as JSON, for a client that boots from a Host it
 * reaches over HTTP (Delorun's desktop app) instead of reading the rows from the page the Host renders. It is reserved:
 * a dist file with this name is never served. It answers the rows the webserver's `collectIndexInjections`
 * returns for the Peer that may load the index, so it exposes nothing the index does not already render for that Peer.
 */
export const INDEX_INJECTIONS_PATH = '/index-injections.json'

/** The page path of the boot page's recovery screen, which renders the index while a distribution names its routes. */
const RECOVERY_PATH = '/recovery'

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** The Web app manifest, at the dist root; the icons it names are public too. */
const MANIFEST = 'manifest.webmanifest'

/**
 * Dist-root files a browser requests by a fixed name from a page it has not
 * authenticated yet: the manifest, the favicons the index links and the one a
 * browser probes on its own, and the touch icons iOS probes.
 */
const PUBLIC_ROOT_FILES: ReadonlySet<string> = new Set([
  MANIFEST,
  'favicon.ico',
  'favicon.svg',
  'favicon-dark.svg',
  'apple-touch-icon.png',
  'apple-touch-icon-precomposed.png',
])

/**
 * The dist-root file names a manifest's `icons` list. An icon `src` resolves
 * against the manifest's own URL, as a launcher resolves it, and is decoded as
 * a request path is, so `icon%20192.png` names the file `icon 192.png`; a `src`
 * that leaves the dist root's top level (another directory, another origin) or
 * does not decode names nothing here. An unreadable or unparsable manifest
 * names no icon.
 * @param path - absolute path of the manifest.
 * @returns the icon file names directly under the dist root.
 */
async function readManifestIcons(path: string): Promise<ReadonlySet<string>> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // An unreadable or unparsable manifest names no icon, so its icons stay
    // fenced; a request for the manifest itself reports the read failure.
    return new Set()
  }
  const icons = typeof manifest === 'object' && manifest !== null && 'icons' in manifest ? manifest.icons : undefined
  const names = new Set<string>()
  if (!Array.isArray(icons)) return names
  const base = new URL(`http://dist.invalid/${MANIFEST}`)
  for (const icon of icons) {
    const src: unknown = typeof icon === 'object' && icon !== null && 'src' in icon ? icon.src : undefined
    if (typeof src !== 'string') continue
    let name: string
    try {
      const url = new URL(src, base)
      if (url.origin !== base.origin) continue
      name = decodeURIComponent(url.pathname.slice(1))
    } catch {
      // An unresolvable src, or one with a malformed percent-escape, names no file.
      continue
    }
    if (name !== '' && !name.includes('/')) names.add(name)
  }
  return names
}

/**
 * A reader of the icons the dist root's manifest lists. It parses the manifest
 * once per version of the file, told apart by its inode, size and change
 * times, so a rebuilt dist is followed without a parse per request. An absent
 * manifest lists no icon.
 * @param distRoot - absolute dist root directory.
 * @returns the reader, which resolves to the icon file names directly under the dist root.
 */
function manifestIconReader(distRoot: string): () => Promise<ReadonlySet<string>> {
  const path = join(distRoot, MANIFEST)
  let cached: { readonly version: string; readonly names: ReadonlySet<string> } | undefined
  return async () => {
    let version: string
    try {
      const file = await stat(path)
      version = `${String(file.ino)}:${String(file.size)}:${String(file.mtimeMs)}:${String(file.ctimeMs)}`
    } catch {
      // An absent or unreadable manifest lists no icon until it can be read.
      cached = undefined
      return new Set()
    }
    if (cached?.version === version) return cached.names
    const names = await readManifestIcons(path)
    cached = { version, names }
    return names
  }
}

/**
 * Whether a dist file is served before a caller is signed in. A launcher reads
 * the manifest and the icons it names to install the application, and a browser
 * asks for the favicon and touch icons from a page it has not authenticated
 * yet; nothing else in the dist is meaningful outside the signed-in
 * application. Only those exact files at the dist root are public, so a chunk
 * or a file in a subdirectory with a similar name stays fenced.
 * @param distRoot - absolute dist root directory.
 * @param target - absolute path of the requested file, already inside the dist root.
 * @param manifestIcons - reads the icon names the manifest lists.
 * @returns true for a public dist-root file.
 */
async function isPublicAsset(distRoot: string, target: string, manifestIcons: () => Promise<ReadonlySet<string>>): Promise<boolean> {
  if (dirname(target) !== distRoot) return false
  const name = basename(target)
  return PUBLIC_ROOT_FILES.has(name) || (await manifestIcons()).has(name)
}

/** The two fences {@link serveStatic} consults before it reads bytes, and whether the recovery page is offered. */
interface StaticFences {
  /** Answers an index request; the response to send instead of the document, or undefined to serve it. */
  index: () => Response | undefined
  /** Whether an index injection row names a distribution's recovery routes, so `/recovery` renders the index. */
  recovery: () => boolean
  /** The structured injection rows of the Peer that may load the index; read only after {@link StaticFences.index} admitted the request. */
  injections: () => IndexInjection[]
  /** Answers a non-public file request; the response to send instead of the bytes, or undefined to serve them. */
  asset: () => Response | undefined
}

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Answer one GET or HEAD dist request; the webserver answers any other method
 * with 405 before a resource runs. A malformed percent-escape or a filesystem
 * failure other than a missing or non-file target rejects.
 * @param request - the request; only its method and URL path are read.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param fences - the answers {@link StaticFences} supplies for an index
 * request and for a file that is not public, each consulted before its bytes,
 * and whether `/recovery` is an index entry.
 * @param renderIndex - turns the raw index.html body into the served document
 * for the dist root and configured index path.
 * @param manifestIcons - reads the icon names the dist root's manifest lists,
 * which are public with the fixed install files.
 * @returns the dist response; a HEAD response carries the GET status and
 * headers without a body. A file other than the index carries
 * `cache-control: no-cache` and a weak ETag from a SHA-1 of its bytes, and a
 * request whose `If-None-Match` equals that ETag receives an empty 304.
 */
async function serveStatic(
  request: Request, distRoot: string, distIndex: string,
  fences: StaticFences,
  renderIndex: (html: string) => string,
  manifestIcons: () => Promise<ReadonlySet<string>>,
): Promise<Response> {
  const target = resolve(normalize(join(distRoot, decodeURIComponent(new URL(request.url).pathname))))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array<ArrayBuffer>
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex || (target === join(distRoot, RECOVERY_PATH) && fences.recovery())) {
      const refusal = fences.index()
      if (refusal !== undefined) return refusal
      body = renderIndex(await readFile(distIndex, 'utf8'))
      headers = { 'content-type': HTML_MIME }
    } else if (target === join(distRoot, INDEX_INJECTIONS_PATH)) {
      // The same admission as the index, then only the rows. The index carries no cache headers; this answer is per Peer,
      // so it forbids storing as well. Raw `tapIndex` transforms act on whole pages and are not rows, so they are not carried.
      const refusal = fences.index()
      if (refusal !== undefined) return refusal
      body = JSON.stringify(fences.injections())
      headers = { 'content-type': JSON_MIME, 'cache-control': 'no-store' }
    } else {
      // Every dist file but the install-time ones belongs to the signed-in
      // application, so the fence decides before its bytes are read.
      if (!(await isPublicAsset(distRoot, target, manifestIcons))) {
        const refusal = fences.asset()
        if (refusal !== undefined) return refusal
      }
      body = await readFile(target)
      // Weak: gzip changes the transferred bytes.
      const cache = { 'cache-control': 'no-cache', etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` }
      if (request.headers.get('if-none-match') === cache.etag) return new Response(null, { status: 304, headers: cache })
      headers = { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', ...cache }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the caller, which the webserver answers with 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/**
 * Claim the webserver fallback seat with a resource serving the dist.
 * @param ctx - plugin context carrying the webServer and connection services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Connection's browser authentication writes the token exchange's 303 or
  // the 401 through a writeHead/end response; capture it as a Fetch response.
  // The answer stays a 401 unless Connection writes another one.
  const authorizeIndex = (request: Request): Response | undefined => {
    let status = 401
    let headers = new Headers()
    let body: string | undefined
    const admitted = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) { body = text },
    })
    return admitted ? undefined : new Response(body, { status, headers })
  }
  // Connection's fence and browser authentication answer a dist file the same
  // way the API answers a route: 403 for a rebound or cross-origin request, 401
  // for one the browser cookie does not admit.
  const fenceAsset = (request: Request): Response | undefined => {
    const rejection = ctx.connection.requestRejection(request)
    if (rejection === undefined) return undefined
    return new Response(rejection === 401 ? 'unauthorized' : 'forbidden', { status: rejection })
  }
  // One cached reading of the manifest's icons per mounted instance, so a remount starts fresh.
  const manifestIcons = manifestIconReader(distRoot)
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request, peer) => serveStatic(
      request,
      distRoot,
      distIndex,
      // A read with a Peer was admitted by its caller; an HTTP request carries
      // none and passes Connection's fence instead.
      {
        index: () => peer === undefined ? authorizeIndex(request) : undefined,
        asset: () => peer === undefined ? fenceAsset(request) : undefined,
        injections: () => ctx.webServer.collectIndexInjections(peer ?? ctx.connection.browserPeer),
        recovery: () => ctx.webServer.collectIndexInjections(peer ?? ctx.connection.browserPeer)
          .some(row => row.kind === 'global' && row.name === RECOVERY_ROUTES_GLOBAL),
      },
      // The browser authentication admits the owner's shared browser Peer. The
      // base goes in after all index transforms, so it precedes every resource
      // reference they insert.
      html => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer)
        .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`),
      manifestIcons,
    ),
  }), 'frontend-static: fallback seat')
}
