/**
 * Changes to Delorun itself that take effect without a restart (contract C21, "Harness edits"). Only the studio's built
 * client assets are live ([`@delorun/changes`' harness-live](../../changes/src/harness-live.ts)): for each such file
 * whose composed content now differs from what this Host runs, {@link LiveAssets} registers an exact web-server route
 * at the asset's URL path, which precedes the static fallback seat, and answers it with the composed content: the
 * store's approved object, or after an undo the signed release's file, each checked against its digest when it is read.
 * Connection's fence decides every HTTP request before any byte is sent, as it does for the static seat. A page that
 * is already open keeps the bytes it loaded until it reloads; running chats are not touched.
 *
 * {@link harnessEffectOf} is what the harness routes call once a decision is logged: a change to a file that is not
 * live, or when this Host's composition is unknown, takes effect at a restart; a live one is served at once, and when
 * its content cannot be read the previous content stays served and an applied change is left out, so the next start
 * leaves it out too.
 *
 * @module @delorun/plugin-changes/live-apply
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { harnessDrift, isLiveHarnessFile, leaveOutHarnessChange, liveAssetPath, liveFileBytes, type ChangeEntry, type ChangesRestartHost, type ContentVersion, type HarnessContext, type RunningComposition } from '@delorun/changes'
import { homeSpellings, withHomePlaceholder } from './home-words.ts'
import type { HarnessEffectView } from './wire.ts'

/** The content types of the studio's built assets; anything else is served as bytes. */
const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
}

/** The web server's exact routes, as `@deepseek-ai/dsh-host-webserver` takes them. */
export interface LiveRouteServer {
  /**
   * Register an exact route answered by a resource.
   * @param route - the path and the resource.
   * @returns the disposer.
   */
  register(route: { readonly kind: 'exact', readonly path: string, readonly resource: (request: Request, peer?: unknown) => Promise<Response> }): () => void
}

/** Connection's fence over an HTTP request: 401 or 403 when it does not admit the request. */
export type LiveFence = (request: Request) => 401 | 403 | undefined

/** What the logger needs. */
interface LiveLogger {
  warn(message: string): void
}

/** One served file. */
interface ServedFile {
  readonly content: ContentVersion | 'signed'
  /** Undefined when the composed content holds no such file: the route answers 404. */
  readonly bytes: Buffer | undefined
  readonly etag: string
}

/** A refresh that could not serve some live files, with the failure of each. */
export class LiveRefreshError extends Error {
  /** The failure of each live file the refresh could not serve, by the file's path in the runtime. */
  readonly failures: ReadonlyMap<string, Error>

  /**
   * @param failures - the failure of each file; not empty.
   */
  constructor(failures: ReadonlyMap<string, Error>) {
    super([...failures.values()][0]!.message)
    this.name = 'LiveRefreshError'
    this.failures = failures
  }
}

/**
 * @param error - what a read or a registration threw.
 * @returns the error, or the thrown value as an error.
 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** The live files this Host serves in place of its running tree's. */
export class LiveAssets {
  private files = new Map<string, ServedFile>()
  private readonly routes = new Map<string, () => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  private readonly server: LiveRouteServer
  private readonly fence: LiveFence

  /**
   * @param server - the web server's exact routes.
   * @param fence - Connection's fence.
   */
  constructor(server: LiveRouteServer, fence: LiveFence) {
    this.server = server
    this.fence = fence
  }

  /** The URL paths served now, sorted. */
  get paths(): readonly string[] {
    return [...this.files.keys()].map(liveAssetPath).sort()
  }

  /**
   * Serve what the records compose now for every live file that differs from what this Host runs. Every new content
   * is read and checked and every new route registered before the served files change, so a failure keeps every file
   * served as it was. One refresh runs at a time, and none changes anything once the routes are disposed.
   * @param harness - the running runtime's harness.
   * @param running - what this Host booted with; an unknown composition serves nothing.
   * @returns when the routes serve the new content.
   * @throws {LiveRefreshError} naming each live file that could not be read or registered, and why.
   * @throws {ChangesError} when a record cannot be read as Delorun wrote it.
   */
  refresh(harness: HarnessContext, running: RunningComposition): Promise<void> {
    const next = this.queue.then(() => this.refreshNow(harness, running))
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Remove every route; a refresh still running then changes nothing. */
  dispose(): void {
    this.disposed = true
    for (const off of this.routes.values()) off()
    this.routes.clear()
    this.files = new Map()
  }

  private async refreshNow(harness: HarnessContext, running: RunningComposition): Promise<void> {
    if (running.kind === 'unknown' || this.disposed) return
    const drift = await harnessDrift(harness.home, harness.runtime, running)
    const next = new Map<string, ServedFile>()
    const failures = new Map<string, Error>()
    for (const [file, content] of drift.live) {
      const served = this.files.get(file)
      if (served?.content === content) {
        next.set(file, served)
        continue
      }
      try {
        const bytes = await liveFileBytes(harness.home, await harness.signed(), file, content)
        next.set(file, { content, bytes, etag: `W/"${createHash('sha1').update(bytes ?? '').digest('base64url')}"` })
      } catch (error) {
        failures.set(file, asError(error))
      }
    }
    if (failures.size > 0) throw new LiveRefreshError(failures)
    if (this.disposed) return
    const added = new Map<string, () => void>()
    try {
      for (const file of next.keys()) {
        if (this.routes.has(file)) continue
        try {
          added.set(file, this.server.register({ kind: 'exact', path: liveAssetPath(file), resource: (request, peer) => Promise.resolve(this.answer(file, request, peer)) }))
        } catch (error) {
          throw new LiveRefreshError(new Map([[file, asError(error)]]))
        }
      }
    } catch (error) {
      for (const off of added.values()) off()
      throw error
    }
    this.files = next
    for (const [file, off] of added) this.routes.set(file, off)
    for (const [file, off] of this.routes) {
      if (next.has(file)) continue
      off()
      this.routes.delete(file)
    }
  }

  /**
   * Answer one request for a served file: the fence first for an HTTP request, then the bytes with a weak ETag.
   * @param file - the file.
   * @param request - the request.
   * @param peer - the Peer of an in-process read its caller admitted; absent for HTTP.
   * @returns the response.
   */
  private answer(file: string, request: Request, peer: unknown): Response {
    if (peer === undefined) {
      const rejection = this.fence(request)
      if (rejection !== undefined) return new Response(null, { status: rejection })
    }
    const served = this.files.get(file)
    if (served?.bytes === undefined) return new Response(null, { status: 404 })
    const cache = { 'cache-control': 'no-cache', etag: served.etag }
    if (request.headers.get('if-none-match') === served.etag) return new Response(null, { status: 304, headers: cache })
    const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...cache }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(new Uint8Array(served.bytes), { status: 200, headers })
  }
}

/** What {@link harnessEffectOf} reaches. */
export interface HarnessEffectDependencies {
  /** @returns the home process's restart, or undefined when no home process runs this Host. */
  readonly restart: () => ChangesRestartHost | undefined
  /** @returns the running runtime's harness. */
  readonly harness: () => HarnessContext | undefined
  /** The live files, or undefined when this Host serves none. */
  readonly live: LiveAssets | undefined
  readonly logger: LiveLogger
}

/**
 * When a decided change to Delorun itself takes effect.
 * @param dependencies - the restart, the harness, the live files and the log.
 * @returns the function the harness routes call once the decision is logged.
 */
export function harnessEffectOf(dependencies: HarnessEffectDependencies): (entry: ChangeEntry) => Promise<HarnessEffectView> {
  return async (entry) => {
    const restart = dependencies.restart()
    if (restart === undefined) return { kind: 'not-running' }
    restart.clearFailure()
    const harness = dependencies.harness()
    const file = entry.subject.file
    const { live } = dependencies
    if (harness === undefined || file === undefined || live === undefined || restart.running.kind === 'unknown' || !isLiveHarnessFile(file)) return { kind: 'restart' }
    try {
      await live.refresh(harness, restart.running)
      return { kind: 'live', page: true }
    } catch (error) {
      // Only a failure of this entry's own file leaves it out; another file's, or a record's, leaves this change applied for the next start.
      const own = error instanceof LiveRefreshError ? error.failures.get(file) : undefined
      if (own === undefined) {
        dependencies.logger.warn(`Delorun kept serving the previous files and applied ${file} at its next start: ${asError(error).message}`)
        return { kind: 'restart' }
      }
      // A recorded failure names the home as `<Delorun home>`, as every failure Changes records does.
      const failure = withHomePlaceholder(`the studio could not serve ${file}: ${own.message}`, homeSpellings(harness.home))
      dependencies.logger.warn(`Delorun kept serving the previous ${file}: ${failure}`)
      if (entry.state !== 'applied') return { kind: 'restart' }
      const left = await leaveOutHarnessChange(harness.home, harness.runtime, entry.id, failure).catch((leaveOutError: unknown) => {
        dependencies.logger.warn(`Delorun could not leave the change ${entry.id} out: ${leaveOutError instanceof Error ? leaveOutError.message : String(leaveOutError)}`)
        return undefined
      })
      if (left === undefined) return { kind: 'restart' }
      return { kind: 'left-out', failure }
    }
  }
}
