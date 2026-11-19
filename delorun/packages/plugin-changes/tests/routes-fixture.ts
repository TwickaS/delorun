/**
 * A loopback HTTP server that serves the studio's Changes routes over a stand-in for Connection's admission, and a
 * raw-socket client that sets any `Host`, `Origin` or cookie and can withhold a body, for the route specs.
 *
 * The stand-in admits a request whose cookie is `studio=valid` and refuses any other with 401, or with 403 when the
 * request carries `x-test-fence: refuse`, as Connection's Host/Origin fence does. `x-test-remote: 1` admits it as a
 * remote session, as a reach dispatcher's admission does, and `x-test-listener: <id>` stamps it with that listener. A
 * remote session with `x-test-unlock: fresh | grace | none` is the paired device {@link TEST_DEVICE} holding that
 * unlock; without the header it is no paired device's.
 *
 * @module @delorun/plugin-changes/tests/routes-fixture
 */
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { changeId, CHANGE_LOG_SCHEMA, enforceApprovedContent, type HarnessContext, storeEmptyVersion, storeFileVersion, versionsDirectory, writeHarnessLog, type ChangeEntry, type ChangesContext, type ChangeState, type PluginOperationResult, type ReloadOutcome } from '@delorun/changes'
import { REQUEST_LISTENER } from '@delorun/home'
import { onTestFinished } from 'vitest'
import { restartRoutes, type RestartRouteDependencies } from '../src/restart-route.ts'
import { changesRoutes, type ChangesRoute, type FaceAccess, type RouteDependencies, type RouteDevice } from '../src/routes.ts'

/** The fixture's profile. */
export const PROFILE = 'default'

/** The cookie the stand-in admits. */
export const CREDENTIAL = 'Cookie: studio=valid'

/** A remote session's stand-in Peer, with the unlock its paired device holds, if it is one. */
interface RemotePeer {
  readonly session: 'remote'
  readonly unlock?: RouteDevice['unlock']
}

/** The paired device a remote session with `x-test-unlock` speaks for. */
export const TEST_DEVICE = { id: 'device-test-1', label: 'Test phone' } as const

/** The studio's own session on the loopback listener. */
const LOCAL = Object.freeze({ session: 'local' })

/** A Delorun home with one profile whose manifest names no dependency. */
export interface RouteHome {
  readonly root: string
  readonly ctx: ChangesContext
}

/**
 * A Delorun home with the profile `default`; removed after the test.
 * @returns the home and the profile's context.
 */
export function routeHome(): RouteHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-routes-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const home = join(root, '.delorun')
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  return { root, ctx: { home, profile: PROFILE, profileDir, lockWaitMs: 5_000 } }
}

/**
 * A home whose profile links the plugin `plug` from a folder, turned on in its bundle list and approved by the first
 * start under Changes.
 * @returns the profile and the folder.
 */
export async function approvedPlugin(): Promise<{ readonly ctx: ChangesContext, readonly source: string }> {
  const { root, ctx } = routeHome()
  const source = join(root, 'plug')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(source, 'index.js'), 'export default "one"\n')
  const manifestPath = join(ctx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
  manifest.dependencies.plug = `link:${source}`
  manifest.dsh.profile.bundles = ['plug']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(ctx.profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      plug:\n        specifier: link:${source}\n        version: link:${relative(ctx.profileDir, source)}\n`)
  const link = join(ctx.profileDir, 'node_modules', 'plug')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), source), link)
  await enforceApprovedContent({ home: ctx.home, profile: ctx.profile, profileDir: ctx.profileDir })
  return { ctx, source }
}

/** The runtime the logged changes to Delorun itself name. */
export const RUNTIME = '0.4.0'

/** One logged change to a file of Delorun itself. */
export interface HarnessFields {
  readonly file: string
  /** The file's content before the change; absent for an added file. */
  readonly before?: string
  /** The file's content after the change; absent for a removed file. */
  readonly after?: string
  readonly state: ChangeState
  /** When it was decided, ISO 8601. */
  readonly at: string
  readonly leftOut?: { readonly at: string, readonly failure: string }
  /** Whether the store keeps the content after the change, as it does until collection removes it. */
  readonly kept?: boolean
}

/**
 * Store both sides of each change and write them as the log of changes to Delorun itself, in the order given.
 * @param home - the Delorun home.
 * @param changes - the changes.
 * @returns the log's entries.
 */
export async function logHarnessChanges(home: string, changes: readonly HarnessFields[]): Promise<ChangeEntry[]> {
  const entries: ChangeEntry[] = []
  for (const change of changes) {
    const side = (text: string | undefined) => text === undefined ? storeEmptyVersion(home) : storeFileVersion(home, change.file, Buffer.from(text), false)
    const from = await side(change.before)
    const to = await side(change.after)
    if (change.kept === false) rmSync(join(versionsDirectory(home), `${to}.json`))
    const subject = { file: change.file, runtime: RUNTIME }
    entries.push({
      id: changeId('harness-edit', subject, from, to), kind: 'harness-edit', state: change.state, subject, from, to,
      summary: `Delorun ${RUNTIME} itself: ${change.file}`, createdAt: change.at,
      ...change.state === 'pending' ? {} : { decidedAt: change.at, decidedFrom: 'terminal' },
      ...change.leftOut === undefined ? {} : { leftOut: change.leftOut },
    })
  }
  await writeHarnessLog(home, { schema: CHANGE_LOG_SCHEMA, entries })
  return entries
}

/** A running server and what its routes reached. */
export interface RouteServer {
  readonly port: number
  /** How often the routes asked for the profile, which they do only after the arrival and the site passed. */
  readonly profileReads: () => number
  /** How often the routes reloaded the Host. */
  readonly reloads: () => number
  /** What the routes reported to the Host's log. */
  readonly warnings: string[]
  /** The arguments of each plugin operation the routes ran, which succeeds unless `operationResult` says otherwise. */
  readonly operations: (readonly string[])[]
  /** How often a device's unlock was renewed after an action. */
  readonly renewals: () => number
}

/**
 * Serve the Changes routes on a loopback port; stopped after the test.
 * @param ctx - the profile the Host runs, or undefined for a Host that runs none.
 * @param options - what the dependencies answer, replacing the defaults; `operationResult` is what the stand-in plugin
 *   operation answers; `restartRoute` is the restart the Restart routes reach, none by default; `extraRoutes` builds the
 *   routes of another plugin over the same dependencies, as `@delorun/plugin-update` does with the Changes gate.
 * @returns the server.
 */
export async function serveRoutes(ctx: ChangesContext | undefined, options: Partial<RouteDependencies> & { readonly reloadOutcome?: ReloadOutcome, readonly operationResult?: PluginOperationResult, readonly powers?: 'careful' | 'full', readonly face?: FaceAccess, readonly restartRoute?: RestartRouteDependencies, readonly extraRoutes?: (dependencies: RouteDependencies) => readonly ChangesRoute[] } = {}): Promise<RouteServer> {
  let profileReads = 0
  let renewals = 0
  let reloads = 0
  const warnings: string[] = []
  const operations: (readonly string[])[] = []
  let port: number | undefined
  const dependencies: RouteDependencies = {
    connection: {
      admit: (request: IncomingMessage) => {
        if (request.headers['x-test-fence'] === 'refuse') return { rejection: 403 }
        if (request.headers.cookie !== 'studio=valid') return { rejection: 401 }
        const unlock = request.headers['x-test-unlock']
        const remote: RemotePeer = { session: 'remote', ...unlock === 'fresh' || unlock === 'grace' || unlock === 'none' ? { unlock } : {} }
        return { peer: request.headers['x-test-remote'] === '1' ? remote : LOCAL, ...request.headers['x-test-roll'] === '1' ? { setCookie: 'studio=rolled; HttpOnly' } : {} }
      },
      isReachPeer: peer => (peer as Partial<RemotePeer>).session === 'remote',
    },
    profile: () => {
      profileReads += 1
      return ctx
    },
    reload: () => {
      reloads += 1
      return Promise.resolve(options.reloadOutcome ?? { ok: true })
    },
    pluginOperation: () => (args) => {
      operations.push(args)
      return Promise.resolve(options.operationResult ?? { exitCode: 0 })
    },
    installationBundles: [],
    logger: { warn: (message: string) => { warnings.push(message) } },
    loopbackPort: () => port,
    scaffold: () => { throw new Error('this route fixture scaffolds nothing') },
    workspaces: () => [],
    reveal: () => {},
    delorunVersion: () => '0.0.0',
    devices: {
      deviceOf: (peer) => {
        const { unlock } = peer as Partial<RemotePeer>
        return Promise.resolve(unlock === undefined ? undefined : { ...TEST_DEVICE, unlock, renew: () => { renewals += 1 }, ...options.face === undefined ? {} : { face: options.face } })
      },
      phonePowers: () => ({ level: options.powers ?? 'careful', chosen: options.powers !== undefined }),
    },
    harness: () => undefined,
    harnessEffect: () => Promise.resolve({ kind: 'restart' }),
    restartState: () => Promise.resolve(undefined),
    clearRestartFailure: () => {},
    ...options,
  }
  const routes = [...changesRoutes(dependencies), ...restartRoutes(dependencies, options.restartRoute ?? { restart: () => undefined, waitSeconds: 600 }), ...options.extraRoutes?.(dependencies) ?? []]
  const server = createServer((request, response) => {
    const listener = request.headers['x-test-listener']
    if (typeof listener === 'string') Object.defineProperty(request, REQUEST_LISTENER, { value: listener })
    const route = routes.find(candidate => candidate.path === new URL(request.url ?? '/', 'http://server.invalid').pathname)
    if (route === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void route.handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  return { port, profileReads: () => profileReads, reloads: () => reloads, warnings, operations, renewals: () => renewals }
}

/**
 * How long a request whose body is withheld waits for its answer, in milliseconds: a route that refuses before it reads
 * the body answers at once, and one that waits for the body fails the spec after this instead of at the test timeout.
 */
export const ANSWER_BEFORE_BODY_MS = 2_000

/** One reply. */
export interface Reply {
  readonly status: number
  /** The reply's head, lower-cased. */
  readonly head: string
  readonly body: string
}

/**
 * Send one request on a socket and read the reply once its head and `Content-Length` bytes of body arrived, which lets
 * a spec set `Host` and withhold the body: a reply to such a request proves the route did not wait for the body.
 * @param port - the server's port.
 * @param head - the request line and headers, each without its carriage return.
 * @param body - what to write after the headers, which may be shorter than `Content-Length` claims.
 * @param answerWithinMs - how long to wait for the reply; unbounded when absent.
 * @returns the reply.
 * @throws {Error} when no reply arrived within `answerWithinMs`.
 */
export async function raw(port: number, head: readonly string[], body = '', answerWithinMs?: number): Promise<Reply> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  let received = ''
  socket.setEncoding('utf8')
  const replied = new Promise<void>((resolve) => {
    socket.once('close', () => { resolve() })
    socket.on('data', (chunk: string) => {
      received += chunk
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) return
      const length = /\r\ncontent-length: *(\d+)/i.exec(received.slice(0, end))?.[1]
      if (length === undefined || Buffer.byteLength(received.slice(end + 4)) >= Number(length)) resolve()
    })
  })
  socket.write(`${head.join('\r\n')}\r\n\r\n${body}`)
  let timer: NodeJS.Timeout | undefined
  const deadline = answerWithinMs === undefined
    ? new Promise<never>(() => {})
    : new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`no answer within ${String(answerWithinMs)} ms: the route waited for a body that was withheld`)) }, answerWithinMs)
    })
  try {
    await Promise.race([replied, deadline])
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
  const split = received.indexOf('\r\n\r\n')
  return { status: Number(received.split('\r\n')[0]?.split(' ')[1] ?? 0), head: received.slice(0, split).toLowerCase(), body: received.slice(split + 4) }
}

/** What a request carries besides its target. */
export interface Send {
  readonly method?: string
  /** The `Host` header; the server's loopback address by default. */
  readonly host?: string
  /** Headers, each `Name: value`; the credential is not added unless listed. */
  readonly headers?: readonly string[]
  /** The JSON body, or raw text. */
  readonly body?: unknown
  /**
   * Send only the head: `Content-Length` claims the body, which never arrives, and the reply must come within
   * {@link ANSWER_BEFORE_BODY_MS}.
   */
  readonly withholdBody?: boolean
}

/**
 * Send one request.
 * @param port - the server's port.
 * @param path - the target.
 * @param send - the method, headers and body.
 * @returns the reply.
 */
export function send(port: number, path: string, send: Send = {}): Promise<Reply> {
  const body = send.body === undefined ? '' : typeof send.body === 'string' ? send.body : JSON.stringify(send.body)
  const withheld = send.withholdBody === true
  return raw(port, [
    `${send.method ?? 'GET'} ${path} HTTP/1.1`,
    `Host: ${send.host ?? `127.0.0.1:${String(port)}`}`,
    ...send.method === 'POST' ? ['Content-Type: application/json', `Content-Length: ${String(Buffer.byteLength(body))}`] : [],
    ...send.headers ?? [],
    'Connection: close',
  ], withheld ? '' : body, withheld ? ANSWER_BEFORE_BODY_MS : undefined)
}

/**
 * Post a JSON body with the studio's credential from the studio's own origin.
 * @param port - the server's port.
 * @param path - the target.
 * @param body - the body.
 * @returns the reply.
 */
export function post(port: number, path: string, body: unknown = {}): Promise<Reply> {
  return send(port, path, { method: 'POST', headers: [CREDENTIAL, `Origin: http://127.0.0.1:${String(port)}`, 'Sec-Fetch-Site: same-origin'], body })
}

/**
 * Read with the studio's credential.
 * @param port - the server's port.
 * @param path - the target, query included.
 * @returns the reply.
 */
export function get(port: number, path: string): Promise<Reply> {
  return send(port, path, { headers: [CREDENTIAL] })
}

/**
 * @param reply - a reply.
 * @returns its parsed body.
 */
export function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>
}

/** A file of the fixture runtime's `app/` directory the harness specs change. */
export const RUNTIME_FILE = 'app/node_modules/delorun/lib/start.js'

/**
 * Install runtime {@link RUNTIME} in a home's store with two files and give its harness, as the home process gives the
 * Host the running runtime's verified file list.
 * @param home - the Delorun home.
 * @returns the harness.
 */
export function routeHarness(home: string): HarnessContext {
  const directory = join(home, 'runtimes', RUNTIME)
  const files = { 'app/package.json': '{"name":"closure"}\n', [RUNTIME_FILE]: 'export const start = 1\n' }
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

/** The address a paired device reaches the studio at. */
export const DEVICE_HOST = 'studio.example.ts.net'

/**
 * A request from the paired device {@link TEST_DEVICE}'s own studio page.
 * @param unlock - the unlock the device holds.
 * @param body - the JSON body.
 * @param withholdBody - whether only the head is sent, for a request that must be refused before its body.
 * @returns what {@link send} takes.
 */
export function fromDevice(unlock: RouteDevice['unlock'], body: unknown = {}, withholdBody = false): Send {
  return { method: 'POST', host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', `x-test-unlock: ${unlock}`, `Origin: https://${DEVICE_HOST}`], body, withholdBody }
}
