/**
 * Changes to Delorun itself that take effect without a restart: an applied change to one of the studio's built client
 * assets is served at once under Connection's fence, a change to any other file waits for a restart and is never
 * served, and when the new content cannot be read the previous content stays served and the change is left out.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { harnessCopyDirectory, readHarnessLog, type ChangesRestartHost, type HarnessContext, type RunningComposition } from '@delorun/changes'
import { describe, expect, it } from 'vitest'
import { harnessEffectOf, LiveAssets, type LiveRouteServer } from '../src/live-apply.ts'
import { HARNESS_PATHS, SHOW_PATH } from '../src/wire.ts'
import { get, json, post, routeHome, RUNTIME, serveRoutes } from './routes-fixture.ts'

/** A built studio asset of the fixture runtime. */
const ASSET = 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-1a2b.js'
/** Its URL path. */
const ASSET_PATH = '/assets/index-1a2b.js'
/** A server file of the fixture runtime, which is never live. */
const SERVER_FILE = 'app/node_modules/delorun/lib/start.js'

type Resource = (request: Request, peer?: unknown) => Promise<Response>

/** A stand-in for the web server's exact routes. */
class FakeWebServer implements LiveRouteServer {
  readonly routes = new Map<string, Resource>()

  register(route: { readonly kind: 'exact', readonly path: string, readonly resource: Resource }): () => void {
    expect(this.routes.has(route.path)).toBe(false)
    this.routes.set(route.path, route.resource)
    return () => { this.routes.delete(route.path) }
  }
}

/**
 * Install runtime {@link RUNTIME} with a server file and a studio asset, and give its harness.
 * @param home - the Delorun home.
 * @returns the harness.
 */
function assetHarness(home: string): HarnessContext {
  const directory = join(home, 'runtimes', RUNTIME)
  const files = { 'app/package.json': '{"name":"closure"}\n', [SERVER_FILE]: 'export const start = 1\n', [ASSET]: 'console.log("signed")\n' }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  const signed = {
    directory,
    files: Object.entries(files).map(([path, text]) => ({ path, length: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), executable: false })),
  }
  return { home, runtime: RUNTIME, signed: () => Promise.resolve(signed) }
}

/** The home process's restart as a Host that booted on the signed installation sees it. */
function bootedSigned(running: RunningComposition = { kind: 'known', files: {} }): ChangesRestartHost & { cleared: number } {
  return {
    running,
    cleared: 0,
    view: () => ({ kind: 'idle' }),
    runningChats: () => 0,
    begin: () => Promise.resolve({ runningChats: 0 }),
    cancel: () => Promise.resolve(false),
    clearFailure() { this.cleared += 1 },
  }
}

/** The fence: `x-test-fence: refuse` is another site, no `studio=valid` cookie is no credential. */
function fence(request: Request): 401 | 403 | undefined {
  if (request.headers.get('x-test-fence') === 'refuse') return 403
  return request.headers.get('cookie') === 'studio=valid' ? undefined : 401
}

async function liveStudio(running?: RunningComposition) {
  const { ctx } = routeHome()
  const harness = assetHarness(ctx.home)
  const web = new FakeWebServer()
  const live = new LiveAssets(web, fence)
  const restart = bootedSigned(running)
  const warnings: string[] = []
  // What the live files are read through; a spec breaks it to fail the live read alone.
  let liveHarness = harness
  const server = await serveRoutes(ctx, { harness: () => harness, harnessEffect: harnessEffectOf({ restart: () => restart, harness: () => liveHarness, live, logger: { warn: (message) => { warnings.push(message) } } }) })
  expect(json(await post(server.port, HARNESS_PATHS.copy, {}))).toMatchObject({ kind: 'copy', created: true })
  /**
   * Change a file in the person's copy and list the waiting change.
   * @param file - the file.
   * @param text - its new text.
   * @returns the change.
   */
  const edit = async (file: string, text: string) => {
    writeFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), file), text)
    return ((json(await get(server.port, `${SHOW_PATH}?pending`)).harness) as { id: string, to: string, file: string }[]).find(change => change.file === file)!
  }
  /**
   * @param headers - the request's headers.
   * @returns the served asset's response, or undefined when no route serves it.
   */
  const fetchAsset = (headers: Record<string, string> = { cookie: 'studio=valid' }) => web.routes.get(ASSET_PATH)?.(new Request(`http://127.0.0.1${ASSET_PATH}`, { headers }))
  /** Make every later read of the signed installation for a live file fail, naming a path in the home. */
  const breakLiveReads = () => {
    liveHarness = { ...harness, signed: () => Promise.reject(new Error(`${join(ctx.home, 'runtimes', RUNTIME)} could not be read`)) }
  }
  return { ctx, harness, web, live, restart, server, warnings, edit, fetchAsset, breakLiveReads }
}

describe('live changes to the studio\'s assets', () => {
  it('a reloadable change takes effect without restart', async () => {
    const { web, live, restart, server, edit, fetchAsset } = await liveStudio()
    expect(web.routes.size).toBe(0)
    const change = await edit(ASSET, 'console.log("changed")\n')
    const applied = json(await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to }))
    expect(applied).toMatchObject({ kind: 'harness', entry: { state: 'applied' }, effect: { kind: 'live', page: true } })
    expect(restart.cleared).toBe(1)
    expect(live.paths).toEqual([ASSET_PATH])
    const served = await fetchAsset()
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(served?.headers.get('cache-control')).toBe('no-cache')
    expect(await served?.text()).toBe('console.log("changed")\n')
    const etag = served!.headers.get('etag')!
    expect(etag).toMatch(/^W\/"/u)
    expect((await fetchAsset({ cookie: 'studio=valid', 'if-none-match': etag }))?.status).toBe(304)

    // Undone, the Host serves its running tree again, which is the signed file.
    const undone = json(await post(server.port, HARNESS_PATHS.undo, { id: change.id }))
    expect(undone).toMatchObject({ entry: { state: 'undone' }, effect: { kind: 'live', page: true } })
    expect(web.routes.size).toBe(0)
    expect(live.paths).toEqual([])
  })

  it('a live file is served only to a request Connection admits', async () => {
    const { server, edit, fetchAsset, web } = await liveStudio()
    const change = await edit(ASSET, 'console.log("changed")\n')
    await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to })
    const unauthenticated = await fetchAsset({})
    expect(unauthenticated?.status).toBe(401)
    expect(await unauthenticated?.text()).not.toContain('changed')
    const crossSite = await fetchAsset({ cookie: 'studio=valid', 'x-test-fence': 'refuse' })
    expect(crossSite?.status).toBe(403)
    expect(await crossSite?.text()).not.toContain('changed')
    // An in-process read its caller already admitted carries a Peer and skips the fence.
    const inProcess = await web.routes.get(ASSET_PATH)?.(new Request(`http://127.0.0.1${ASSET_PATH}`), { session: 'local' })
    expect(await inProcess?.text()).toBe('console.log("changed")\n')
  })

  it('a non-reloadable change is never applied live', async () => {
    const { web, server, edit } = await liveStudio()
    const change = await edit(SERVER_FILE, 'export const start = 2\n')
    expect(json(await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to }))).toMatchObject({ entry: { state: 'applied' }, effect: { kind: 'restart' } })
    expect(web.routes.size).toBe(0)
    // Nor is an asset change while the Host's composition is unknown.
    const unknown = await liveStudio({ kind: 'unknown' })
    const asset = await unknown.edit(ASSET, 'console.log("changed")\n')
    expect(json(await post(unknown.server.port, HARNESS_PATHS.apply, { id: asset.id, to: asset.to }))).toMatchObject({ effect: { kind: 'restart' } })
    expect(unknown.web.routes.size).toBe(0)
  })

  it('a failed live reload leaves previous code running and the change left out', async () => {
    const { ctx, server, edit, fetchAsset, warnings, breakLiveReads } = await liveStudio()
    const first = await edit(ASSET, 'console.log("first")\n')
    await post(server.port, HARNESS_PATHS.apply, { id: first.id, to: first.to })
    expect(await (await fetchAsset())?.text()).toBe('console.log("first")\n')

    // The next change is applied, and the live read of what it composes fails.
    const second = await edit(ASSET, 'console.log("second")\n')
    breakLiveReads()
    const reply = json(await post(server.port, HARNESS_PATHS.apply, { id: second.id, to: second.to }))
    expect(reply).toMatchObject({ entry: { id: second.id, state: 'applied' }, effect: { kind: 'left-out' } })
    const { failure } = reply.effect as { failure: string }
    expect(failure).toContain(ASSET)
    expect(failure).toContain('<Delorun home>')
    expect(failure).not.toContain(ctx.home)
    expect(await (await fetchAsset())?.text()).toBe('console.log("first")\n')
    expect(warnings.some(warning => warning.includes('kept serving the previous'))).toBe(true)
    const entries = (await readHarnessLog(ctx.home)).entries
    expect(entries.find(entry => entry.id === second.id)).toMatchObject({ state: 'left-out-at-start' })
    expect(entries.find(entry => entry.id === first.id)).toMatchObject({ state: 'applied' })
  })

  it('a Host no home process runs takes every change at its next start', async () => {
    const effect = harnessEffectOf({ restart: () => undefined, harness: () => undefined, live: undefined, logger: { warn: () => {} } })
    expect(await effect({ subject: { file: ASSET } } as Parameters<typeof effect>[0])).toEqual({ kind: 'not-running' })
  })
})
