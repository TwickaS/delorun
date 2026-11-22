// Serves the built site on 127.0.0.1 the way a static host does: a path names its file, its `.html` page or its
// directory's index, a path in out/_redirects gets its redirect, an unknown path gets 404.html with status 404, and the
// Markdown routes, which have no extension, are text/markdown. For checking the build locally; it is not the deployment.
// Usage: node scripts/serve-static.mjs [out-dir] [port]. Port 0 picks a free port; the URL is printed.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const outDir = resolve(process.argv[2] ?? 'out')
const port = Number(process.argv[3] ?? 4173)
if (!existsSync(outDir)) {
  console.error(`serve-static: ${outDir} does not exist; run the build first`)
  process.exit(1)
}

/** The redirect rules of `_redirects`: each line is `<from> <to> <status>`, and lines starting with `#` are comments. */
const redirects = new Map()
const redirectsFile = join(outDir, '_redirects')
if (existsSync(redirectsFile)) {
  for (const line of readFileSync(redirectsFile, 'utf8').split('\n')) {
    const [from, to, status] = line.trim().split(/\s+/)
    if (from !== undefined && to !== undefined && !from.startsWith('#')) redirects.set(from, { to, status: Number(status ?? 302) })
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/**
 * The file a request path names, or undefined.
 * @param urlPath - the decoded request path.
 * @returns the absolute file path.
 */
function fileFor(urlPath) {
  const base = resolve(outDir, `.${urlPath}`)
  if (base !== outDir && !base.startsWith(outDir + sep)) return undefined
  return [base, `${base}.html`, join(base, 'index.html')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

/**
 * The content type of a built file.
 * @param file - the absolute file path.
 * @returns the type a static host would send.
 */
function typeOf(file) {
  if (file.includes(`${sep}llms.mdx${sep}`)) return 'text/markdown; charset=utf-8'
  return TYPES[extname(file)] ?? 'application/octet-stream'
}

const server = createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  const redirect = redirects.get(urlPath)
  if (redirect !== undefined) {
    response.writeHead(redirect.status, { location: redirect.to })
    response.end()
    return
  }
  const file = fileFor(urlPath)
  const served = file ?? join(outDir, '404.html')
  response.writeHead(file === undefined ? 404 : 200, { 'content-type': typeOf(served) })
  createReadStream(served).pipe(response)
})
server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`serve-static: http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : port)}/ serves ${outDir}`)
})
