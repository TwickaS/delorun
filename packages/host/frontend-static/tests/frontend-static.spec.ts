/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'
import { INDEX_INJECTIONS_PATH } from '../src/index.ts'
import { RECOVERY_ROUTES_GLOBAL } from '../src/recovery.ts'

/** How many times the plugin read the dist manifest's bytes. */
const manifestReads = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      if (typeof args[0] === 'string' && args[0].endsWith('manifest.webmanifest')) manifestReads.count += 1
      return actual.readFile(...args)
    },
  }
})

let root: string | undefined
let context: Context | undefined

/** The fixture's Web app manifest, which names the install icon. */
const MANIFEST_TEXT = '{"icons":[{"src":"icon-192.png"}]}'

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and the authenticated Web rows, then boot them through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'preview.html'), '<body>preview</body>')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), MANIFEST_TEXT)
  await writeFile(join(dist, 'favicon.svg'), '<svg/>')
  await writeFile(join(dist, 'icon-192.png'), 'PNG')
  await mkdir(join(dist, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and the body. */
async function request(
  port: number | undefined,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; type: string | null; body: string }> {
  if (port === undefined) throw new Error('frontend-static test: the listener has not bound a port')
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  }
}

/** GET (by default) one path with an exact `Host` header; returns status, content-type, and the body. */
async function raw(
  port: number | undefined,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; type: string | null; body: string }> {
  if (port === undefined) throw new Error('frontend-static test: the listener has not bound a port')
  type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }
  const response = await new Promise<Reply>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false, agent: false }, (incoming) => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk: string) => { body += chunk })
      incoming.on('end', () => { resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }) })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
  const type = response.headers['content-type']
  return { status: response.status, type: typeof type === 'string' ? type : null, body: response.body }
}

/** Exchange the launch token for the owner's browser cookie. */
async function signIn(loaded: Context): Promise<{
  readonly exchange: Response
  readonly authenticated: (init?: RequestInit) => RequestInit
}> {
  const launchUrl = loaded.connection.authenticatedUrl(`http://127.0.0.1:${String(loaded.webServer.port)}`)
  const exchange = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = exchange.headers.get('set-cookie')
  if (setCookie === null) throw new Error('authenticated frontend did not set a cookie')
  const cookie = setCookie.split(';', 1)[0]!
  return {
    exchange,
    authenticated: (init?: RequestInit): RequestInit => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return { ...init, headers }
    },
  }
}

describe('real Loader composition', () => {
  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const { exchange, authenticated } = await signIn(loaded)
    expect(exchange.status).toBe(303)
    expect(exchange.headers.get('location')).toBe('./')

    expect(await request(port, '/')).toMatchObject({
      status: 401,
      type: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })

    // Real assets with their MIME types; a live rebuild is served on the next read.
    // Every dist file but the install-time ones is part of the signed-in
    // application: the same fence the index passes binds its bytes.
    expect(await request(port, '/app.js')).toMatchObject({ status: 401, body: 'unauthorized' })
    expect(await raw(port, '/app.js', { host: 'evil.example' })).toMatchObject({ status: 403, body: 'forbidden' })
    expect(await raw(port, '/app.js', { host: `127.0.0.1:${String(port)}`, origin: 'http://evil.example' }))
      .toMatchObject({ status: 403 })
    // The files a launcher reads before sign-in stay public, whatever the authority.
    expect(await raw(port, '/favicon.svg', { host: 'evil.example' })).toMatchObject({ status: 200, body: '<svg/>' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: MANIFEST_TEXT,
    })
    expect(await request(port, '/app.js', authenticated())).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    // The install icons are images; a launcher must not receive them as octet-stream.
    expect(await request(port, '/icon-192.png')).toMatchObject({ status: 200, type: 'image/png', body: 'PNG' })
    expect(await request(port, '/favicon.svg')).toMatchObject({ status: 200, type: 'image/svg+xml', body: '<svg/>' })
    expect(await request(port, '/app.js', authenticated({ method: 'HEAD' }))).toEqual({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js', authenticated())).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin', authenticated())).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    // A plugin row stands in for the Host's plugin-resource rows: the base the
    // shell inserts must precede it, not merely exist.
    const renderedFor: Connection.PeerScope[] = []
    const offRows = loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'script-preload', src: 'plugins/boot.js' })
    })
    for (const path of ['/', '/index.html', '/?view=test']) {
      const got = await request(port, path, authenticated())
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
      // The served document carries the entry-directory base exactly once, and
      // it precedes every injected row and tap markup, so the shell's
      // app-owned routes and the Host's resource rows resolve under one mount.
      expect(got.body.match(/<base\b/g)).toHaveLength(1)
      const base = got.body.indexOf('<base href="./">')
      expect(base).toBeLessThan(got.body.indexOf('<link rel="preload" as="script" href="plugins/boot.js">'))
      expect(base).toBeLessThan(got.body.indexOf('<script>window.__T__=1</script>'))
    }
    // An authenticated browser renders for the owner's shared browser Peer.
    expect(renderedFor).toEqual(Array.from({ length: 3 }, () => loaded.connection.browserPeer))
    offRows()
    expect(await request(port, '/', authenticated({ method: 'HEAD' }))).toEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '',
    })
    untap()
    expect((await request(port, '/', authenticated())).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell. A
    // signed-in caller is answered the miss: the fence runs before the read, so
    // an unauthorised caller learns nothing about which files exist.
    const ordinaryMisses = ['/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }
    expect(await request(port, '/missing.js')).toMatchObject({ status: 401, body: 'unauthorized' })
    expect(await request(port, '/api/no/such/route', authenticated())).toEqual({
      status: 404,
      type: 'text/plain;charset=UTF-8',
      body: 'not found',
    })

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path', authenticated())).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })

  it('keeps public only the exact dist-root install files, so a look-alike chunk or a nested copy stays fenced', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const dist = join(root!, 'dist')
    await mkdir(join(dist, 'assets'))
    for (const name of ['icon-evil.js', 'favicon-chunk.js', 'apple-touch-icon-chunk.js', 'icon-512.png', 'assets/icon-192.png', 'assets/favicon.svg', 'assets/manifest.webmanifest']) {
      await writeFile(join(dist, name), 'BYTES')
    }
    const status = async (path: string): Promise<number> => (await request(port, path)).status
    // A file named like an install file but not one of them, or a copy below the root, needs sign-in.
    for (const path of ['/icon-evil.js', '/favicon-chunk.js', '/apple-touch-icon-chunk.js', '/icon-512.png', '/assets/icon-192.png', '/assets/favicon.svg', '/assets/manifest.webmanifest']) {
      expect(await status(path), path).toBe(401)
    }
    expect(await status('/icon-192.png')).toBe(200)
    expect(await status('/favicon.svg')).toBe(200)

    // The manifest decides which icons are public: a root-level src in either
    // spelling counts, and one in another directory or on another origin does not.
    await writeFile(join(dist, 'manifest.webmanifest'), JSON.stringify({ icons: [
      { src: '/icon-512.png' },
      { src: 'assets/icon-192.png' },
      { src: 'https://cdn.example/icon-evil.js' },
      { src: './' },
      { src: 'http://[' },
      { src: 7 },
      'icon-evil.js',
    ] }))
    expect(await status('/icon-512.png')).toBe(200)
    for (const path of ['/icon-192.png', '/assets/icon-192.png', '/icon-evil.js']) expect(await status(path), path).toBe(401)

    // A manifest that names no icon list, is not JSON, or is absent makes no icon public.
    for (const text of ['null', '{"icons":{}}', 'not json']) {
      await writeFile(join(dist, 'manifest.webmanifest'), text)
      expect(await status('/icon-512.png'), text).toBe(401)
    }
    await rm(join(dist, 'manifest.webmanifest'))
    expect(await status('/icon-512.png')).toBe(401)
    expect(await status('/favicon.svg')).toBe(200)
  })

  it('serves a manifest icon whose src is percent-encoded, as the decoded request path names it', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const dist = join(root!, 'dist')
    await writeFile(join(dist, 'icon 192.png'), 'SPACED')
    await writeFile(join(dist, 'manifest.webmanifest'), JSON.stringify({ icons: [{ src: 'icon%20192.png' }, { src: 'bad%zz.png' }] }))
    expect(await request(loaded.webServer.port, '/icon%20192.png')).toMatchObject({ status: 200, body: 'SPACED' })
  })

  it('parses the manifest once per version of the file, not once per request', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const manifest = join(root!, 'dist', 'manifest.webmanifest')
    manifestReads.count = 0
    for (let at = 0; at < 3; at += 1) expect((await request(port, '/icon-192.png')).status).toBe(200)
    expect(manifestReads.count).toBe(1)
    // A rewritten manifest is read again, and its new list decides.
    await writeFile(manifest, JSON.stringify({ icons: [{ src: 'icon-512.png' }] }))
    expect((await request(port, '/icon-192.png')).status).toBe(401)
    expect(manifestReads.count).toBe(2)
  })

  it('/recovery is not served when Delorun\'s Changes service is not mounted', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const { authenticated } = await signIn(loaded)
    // Pins the recovery row check: without it `/recovery` renders the index for a composition that names no recovery
    // routes, whose boot page then offers no recovery screen.
    expect(await request(port, '/recovery', authenticated())).toEqual({ status: 404, type: null, body: '' })
    expect(await request(port, '/recovery')).toMatchObject({ status: 401 })
    // A distribution that names its recovery routes, as `@delorun/plugin-changes` does, gets the page behind the index fence.
    const offRecovery = loaded.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'global', name: RECOVERY_ROUTES_GLOBAL, value: '/delorun/changes' })
    })
    expect(await request(port, '/recovery')).toMatchObject({ status: 401 })
    const page = await request(port, '/recovery', authenticated())
    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' })
    expect(page.body).toContain('shell')
    expect(page.body).toContain('globalThis["dshRecoveryRoutes"] = "/delorun/changes"')
    expect(page.body.match(/<base\b/g)).toHaveLength(1)
    offRecovery()
    expect((await request(port, '/recovery', authenticated())).status).toBe(404)
  })

  it('answers in-process reads for the given Peer without browser authentication', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = (path: string, init?: RequestInit) => server.readResource(new Request(`http://reader.invalid${path}`, init), reader)
    const renderedFor: Connection.PeerScope[] = []
    loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'global', name: '__READER__', value: peer === reader })
    })

    // The index renders for the reader's Peer with no cookie or token, and
    // keeps the entry-directory base ahead of the injected rows.
    for (const path of ['/', '/index.html']) {
      const index = await read(path)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const html = await index.text()
      expect(html).toContain('globalThis["__READER__"] = true')
      expect(html.indexOf('<base href="./">')).toBeLessThan(html.indexOf('__READER__'))
      expect(html).toContain('shell')
    }
    expect(renderedFor).toEqual([reader, reader])
    const head = await read('/', { method: 'HEAD' })
    expect({ status: head.status, type: head.headers.get('content-type'), body: await head.text() })
      .toEqual({ status: 200, type: 'text/html; charset=utf-8', body: '' })

    // Assets, misses, traversal, and methods keep the HTTP semantics.
    const asset = await read('/app.js')
    expect({ status: asset.status, type: asset.headers.get('content-type'), body: await asset.text() })
      .toEqual({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect((await read('/missing.js')).status).toBe(404)
    expect((await read('/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await read('/app.js', { method: 'POST', body: 'x' })).status).toBe(405)
    await expect(read('/bad%00path')).rejects.toThrow()
    await rm(join(root!, 'dist', 'index.html'))
    expect((await read('/')).status).toBe(404)
  })

  it('answers the injection rows as JSON only to the Peer that may load the index, and never to anyone else', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    loaded.on('webserver/index-inject', (rows, peer) => {
      rows.push({ kind: 'global', name: '__READER__', value: peer === reader })
      rows.push({ kind: 'script-src', placement: 'head', src: '/plugins/a.js' })
    })
    const { authenticated } = await signIn(loaded)

    // Denial: the same refusals as the index itself for no cookie, a wrong cookie and a foreign Host, with no rows in the body.
    const index = await request(port, '/')
    expect(index.status).toBe(401)
    for (const init of [undefined, { headers: { cookie: 'dsh-auth-0=wrong' } }]) {
      const refused = await request(port, INDEX_INJECTIONS_PATH, init)
      expect(refused.status).toBe(index.status)
      expect(refused.body).not.toContain('__READER__')
    }
    const cookie = new Headers(authenticated().headers).get('cookie')!
    const foreign = await raw(port, INDEX_INJECTIONS_PATH, { host: 'evil.example', cookie })
    expect(foreign.status).toBe((await raw(port, '/', { host: 'evil.example', cookie })).status)
    expect(foreign.status).not.toBe(200)
    expect(foreign.body).not.toContain('__READER__')

    // The admitted browser Peer gets exactly the rows the index renders for it, uncached.
    const answer = await fetch(`http://127.0.0.1:${String(port)}${INDEX_INJECTIONS_PATH}`, authenticated())
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(answer.headers.get('cache-control')).toBe('no-store')
    const browserRows = loaded.webServer.collectIndexInjections(loaded.connection.browserPeer)
    expect(await answer.json()).toEqual(browserRows)
    expect(browserRows).toEqual(expect.arrayContaining([
      { kind: 'global', name: '__READER__', value: false },
      { kind: 'script-src', placement: 'head', src: '/plugins/a.js' },
    ]))
    const page = await request(port, '/', authenticated())
    expect(page.body).toContain('globalThis["__READER__"] = false')

    // A reader that its caller admitted gets only its own Peer's rows, not the browser Peer's.
    const read = await loaded.webServer.readResource(new Request(`http://reader.invalid${INDEX_INJECTIONS_PATH}`), reader)
    const readerRows = loaded.webServer.collectIndexInjections(reader)
    expect(await read.json()).toEqual(readerRows)
    expect(readerRows).toContainEqual({ kind: 'global', name: '__READER__', value: true })
    expect(readerRows).not.toContainEqual({ kind: 'global', name: '__READER__', value: false })

    // The path is reserved, answers only GET and HEAD, and a HEAD carries no rows.
    await writeFile(join(root!, 'dist', 'index-injections.json'), '["dist file"]')
    expect(await (await fetch(`http://127.0.0.1:${String(port)}${INDEX_INJECTIONS_PATH}`, authenticated())).json()).toEqual(browserRows)
    const head = await fetch(`http://127.0.0.1:${String(port)}${INDEX_INJECTIONS_PATH}`, authenticated({ method: 'HEAD' }))
    expect({ status: head.status, body: await head.text() }).toEqual({ status: 200, body: '' })
    expect((await loaded.webServer.readResource(new Request(`http://reader.invalid${INDEX_INJECTIONS_PATH}`, { method: 'POST', body: 'x' }), reader)).status).toBe(405)
  })

  it('lets browsers revalidate every file except the index', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    // A dist file is served to the signed-in browser, which revalidates it like any other resource.
    const { authenticated } = await signIn(loaded)
    const first = await fetch(`${base}/app.js`, authenticated())
    const etag = first.headers.get('etag')
    if (etag === null) throw new Error('a dist file carried no ETag')
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(await first.text()).toBe('export {}')

    const revalidated = await fetch(`${base}/app.js`, authenticated({ headers: { 'if-none-match': etag } }))
    expect([revalidated.status, revalidated.headers.get('etag'), revalidated.headers.get('cache-control')]).toEqual([304, etag, 'no-cache'])
    expect(await revalidated.text()).toBe('')
    // An in-process read revalidates the same way.
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = await loaded.webServer.readResource(new Request(`${base}/app.js`, { headers: { 'if-none-match': etag } }), reader)
    expect(read.status).toBe(304)

    // New content under the same name changes the ETag, so the stale copy is replaced.
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    const rebuilt = await fetch(`${base}/app.js`, authenticated({ headers: { 'if-none-match': etag } }))
    expect(rebuilt.status).toBe(200)
    expect(rebuilt.headers.get('etag')).not.toBe(etag)
    expect(await rebuilt.text()).toBe('export const rebuilt = true')

    // Only the rendered index carries no cache headers; another HTML file revalidates.
    const html = await fetch(`${base}/preview.html`, authenticated())
    expect([html.status, html.headers.get('cache-control')]).toEqual([200, 'no-cache'])
    expect(html.headers.get('etag')).toMatch(/^W\//)
    expect(await html.text()).toBe('<body>preview</body>')
    const index = await loaded.webServer.readResource(new Request(`${base}/`), reader)
    expect([index.status, index.headers.get('cache-control'), index.headers.get('etag')]).toEqual([200, null, null])
  })
})
