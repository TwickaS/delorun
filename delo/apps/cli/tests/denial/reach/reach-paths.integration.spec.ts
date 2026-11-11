/**
 * The route denial suite of a signed-in device. The whole composition of Delo's CLI profiles boots in this process,
 * `@delo/bundle-local` and `@delo/bundle-studio` included, with the experimental main chat mounted as a person adds it;
 * `@delo/home-auth` serves the Tailscale private reach listener, and an approved device holds a live session there.
 *
 * - Every registration of the web server (exact, prefix, upgrade and the fallback) is requested as the device: one
 *   whose target is not on `REACH_DEVICE_PATHS` answers `403 LOOPBACK_REQUIRED` from the authenticator, and the
 *   registrations the device does reach are exactly the ones {@link REACHED} lists with their owner.
 * - Every entry of `REACH_DEVICE_PATHS` names something the studio serves.
 * - `open-in-app` is refused to the device and still answers the loopback studio.
 * - A target whose text begins with a listed path but that the web server routes elsewhere is refused.
 * - Every exact Fetch route is on {@link FETCH_ROUTES} with the device's decision: each refused one answers the device
 *   403, and each of Delo's still answers the loopback studio.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReachListener } from '@deepseek-ai/dsh-client-connection'
import type { StudioAddress } from '@delo/contract-admission'
// The main chat is an experimental plugin no profile mounts; this spec mounts it to request its routes as a device.
import * as mainChat from '@delo/plugin-main-chat'
import { DeviceStore, REACH_DEVICE_PATHS, reachesDevicePath } from '@delo/home-auth'
import { claimOf, recordOf } from '../fixtures/devices.ts'
import { tcpEndpoint, type Endpoint, type Reply } from '../admission/fixtures.ts'
import { bootStudio, targetOf, type Registration, type Studio } from '../admission/studio.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
/** The body of the authenticator's refusal of a target off the device's paths. */
const LOOPBACK_REQUIRED = JSON.stringify({ error: 'LOOPBACK_REQUIRED' })

/** Why the install-time files are served to a device. */
const STATIC = 'upstream\'s frontend-static fallback: the studio page, its built assets and its install-time files'
/** Why the routes of `@delo/home-auth` are reached by a device. */
const HOME_AUTH = '@delo/home-auth: sign-in and the device routes, which refuse a reach session where C5 reserves them'

/**
 * Every registration a signed-in device reaches, by `<kind> <path>`, with the package that owns it. A registration the
 * table of paths passes that is not listed here fails, so a route added under a listed prefix is reviewed.
 */
const REACHED: Readonly<Record<string, string>> = {
  'fallback': STATIC,
  'prefix /api': 'upstream\'s connection: Remote calls under the reach-device policy and exact Fetch routes under FETCH_ROUTES',
  'upgrade /api/remote.mux': 'upstream\'s connection: the Remote event stream, under the reach-device policy',
  'prefix /plugins': 'upstream\'s client modules: the client plugin bundles',
  'exact /plugins/events': 'upstream\'s client HMR events: the module graph updates the client loader follows',
  'exact /delo/reach/status': '@delo/reach: the reach status the studio shows',
  'exact /auth/owner/claim': HOME_AUTH,
  'exact /auth/devices': HOME_AUTH,
  'exact /auth/devices/remove': HOME_AUTH,
  'exact /auth/sign-in': HOME_AUTH,
  'exact /auth/device/request': HOME_AUTH,
  'prefix /auth/device/request': HOME_AUTH,
  'exact /auth/device/challenge': HOME_AUTH,
  'exact /auth/session': HOME_AUTH,
  'exact /auth/devices/window': HOME_AUTH,
  'exact /auth/devices/pending': HOME_AUTH,
  'exact /auth/devices/approve': HOME_AUTH,
  'exact /auth/devices/cancel': HOME_AUTH,
  'prefix /auth/assets': HOME_AUTH,
}

/**
 * One exact Fetch route's decision for a device: `refused` answers 403, `per-call` asks remote access on each request,
 * and `admitted` answers every device through the route's own `admitPeer`. A refused route answers upstream's
 * `forbidden` unless its own check refuses the device first, with `refusal`'s code.
 */
interface FetchDecision {
  readonly device: 'refused' | 'per-call' | 'admitted'
  readonly reason: string
  readonly refusal?: string
}

const TRASH = 'the trash holds deleted chats and workspaces, and moving to, restoring from or deleting from it is not in the device rule'
const FULL_ACCESS = 'turning a workspace\'s full access on or off is a full-access grant, which only the home\'s computer gives; the plugin refuses a device before upstream\'s gate'
const MCP_ANSWER = 'accepting or revoking a stdio MCP server decides whether its command runs outside the sandbox, which only the home\'s computer decides; the plugin refuses a device before upstream\'s gate'
const UPSTREAM_OWNER_ONLY = 'upstream declares no device admission, so only the owner reaches it'

/**
 * Every exact Fetch route of the composition with the device's decision. Delo's routes default to refused; a device
 * keeps a read only to render a chat it can already read or to send the person to the computer, as the waiting MCP
 * servers' names do.
 */
const FETCH_ROUTES: Readonly<Record<string, FetchDecision>> = {
  '/api/deloChatStates.list': { device: 'refused', reason: 'snooze and settle states order the chat list at the computer; a device renders every chat without them, and the client keeps its last states' },
  '/api/deloChatStates.set': { device: 'refused', reason: 'snoozing or settling a chat is not in the device rule' },
  '/api/deloOnboarding.setupRecord': { device: 'refused', reason: 'what the terminal setup recorded serves onboarding at the computer' },
  '/api/deloOnboarding.addWorkspace': { device: 'refused', reason: 'adds a folder as a workspace, which is workspace management the home\'s computer keeps', refusal: 'LOOPBACK_ONLY' },
  '/api/deloNetwork.list': { device: 'refused', reason: 'lists each workspace\'s network setting, which is read and changed only at the home\'s computer', refusal: 'LOOPBACK_ONLY' },
  '/api/deloNetwork.set': { device: 'refused', reason: 'changes a workspace\'s network, which only the person at the home\'s computer chooses', refusal: 'LOOPBACK_ONLY' },
  '/api/deloMainChat.open': { device: 'refused', reason: 'creates the main chat on its configured preset, which a device does not choose' },
  '/api/deloMainChat.reports': { device: 'refused', reason: 'a count for the main chat\'s sidebar mark; a device reads the main chat itself through session/page' },
  '/api/deloUpdateCheck.notice': { device: 'refused', reason: 'the update notice names the release that runs and how many installed plugins an update would turn off, and the update runs only at the computer' },
  '/api/deloTrash.list': { device: 'refused', reason: TRASH },
  '/api/deloTrash.deleteChat': { device: 'refused', reason: TRASH },
  '/api/deloTrash.deleteWorkspace': { device: 'refused', reason: TRASH },
  '/api/deloTrash.restore': { device: 'refused', reason: TRASH },
  '/api/deloTrash.purge': { device: 'refused', reason: TRASH },
  '/api/deloTrash.empty': { device: 'refused', reason: TRASH },
  '/api/deloPermission.workspaces': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloPermission.review': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloPermission.setFullAccess': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloMcpConsent.pending': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloMcpConsent.accept': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloMcpConsent.decline': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloMcpConsent.revoke': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/deloMcpConsent.waiting': { device: 'admitted', reason: 'the names of the servers waiting for the person\'s OK, without their commands, so a phone says to approve them at the computer' },
  '/api/session/uploadFileBinary': { device: 'per-call', reason: 'upstream asks remote access for fileUploads/upload, which the reach-device policy allows' },
  '/api/session.export': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/session.markdown': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/plugin-manager/detail-file': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/file': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/present.host': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/present.open': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/changes.summary': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/changes.open': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
  '/api/changes.diff': { device: 'refused', reason: UPSTREAM_OWNER_ONLY },
}

let studio: Studio
let listener: ReachListener
let phone: Endpoint
/** The device's session cookie. */
let session: string
/** The loopback studio's origin and its browser cookie, which admits the owner. */
let loopback: { readonly origin: string; readonly cookie: string }

/**
 * Send one request as the device, with its session cookie and the listener's origin.
 * @param path - the request target.
 * @param options - the method, and whether it is an upgrade.
 * @returns the reply.
 */
function asPhone(path: string, options: { method?: string; upgrade?: boolean } = {}): Promise<Reply> {
  return phone.send(path, { cookie: session, origin: phone.origin }, options)
}

/**
 * Send one request as the loopback studio, with the owner's browser cookie.
 * @param path - the request path.
 * @param method - the method; a `POST` carries a JSON body.
 * @param body - the JSON body of a `POST`.
 * @returns the response.
 */
function asStudio(path: string, method = 'GET', body = '{}'): Promise<Response> {
  return fetch(`${loopback.origin}${path}`, {
    method,
    redirect: 'manual',
    headers: { cookie: loopback.cookie, origin: loopback.origin, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body } : {}),
  })
}

/**
 * The exact Fetch routes Connection holds, with their methods, read from its private table.
 * @returns each route's path and methods.
 */
function fetchRoutes(): { readonly path: string; readonly methods: readonly string[] }[] {
  const table: unknown = Reflect.get(studio.ctx.connection, 'fetchRoutes')
  if (!(table instanceof Map)) throw new Error('the connection has no Fetch route table')
  return [...(table as Map<string, { readonly methods: ReadonlySet<string> }>)].map(([path, route]) => ({ path, methods: [...route.methods] }))
}

/**
 * The key {@link REACHED} lists a registration by.
 * @param registration - the registration.
 * @returns `<kind> <path>`, or `fallback`.
 */
function keyOf(registration: Registration): string {
  return registration.kind === 'fallback' ? 'fallback' : `${registration.kind} ${registration.path}`
}

beforeAll(async () => {
  studio = await bootStudio([], { local: true })
  const ctx = studio.ctx
  await new Promise<void>((resolve) => { ctx.inject(['authenticator', 'homeAuth', 'reach'], () => { resolve() }) })
  const root = join(studio.home, 'workspaces')
  await mkdir(root)
  await ctx.plugin(mainChat, { enabled: true, root, preset: 'coder', listLimit: 30, readBytes: 12_000, reportBytes: 2_000, noteChars: 2_000 })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  const record = recordOf(2, ADDRESS)
  await new DeviceStore({ file: join(studio.home, 'secrets', 'home-auth', 'devices.json') }).add(record)
  const opened = await ctx.homeAuth.openSession({ deviceId: record.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
  session = `__Host-delo-session=${opened.token}`
  listener = await ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
  if (listener.address === undefined) throw new Error('the reach listener has no address')
  phone = tcpEndpoint(LISTENER, listener.address.port, ADDRESS)
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const minted = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const cookie = minted.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  if (!cookie.startsWith('dsh-auth-')) throw new Error(`the launch-token exchange set no browser cookie (${String(minted.status)})`)
  loopback = { origin, cookie }
}, 120_000)

afterAll(async () => {
  await listener.close()
  await studio.close()
})

describe('the routes a signed-in device reaches', () => {
  it('refuses every registration off the device\'s paths and reaches only the listed ones', async () => {
    const registrations = studio.registrations
    // The shipped composition, so a route a later merge adds is requested here too.
    expect(registrations).toEqual(expect.arrayContaining([
      { kind: 'exact', path: '/open-in-app/apps' }, { kind: 'exact', path: '/open-in-app/open' }, { kind: 'prefix', path: '/open-in-app/icon' },
      { kind: 'exact', path: '/delo/reach/status' }, { kind: 'exact', path: '/auth/devices' }, { kind: 'fallback' },
    ]))
    const reached: string[] = []
    for (const registration of registrations) {
      const { path, upgrade } = targetOf(registration)
      // The fallback is reached at the studio's own files, and refused at a path no route claims.
      if (registration.kind === 'fallback' || !reachesDevicePath(path)) {
        if (registration.kind === 'fallback') reached.push(keyOf(registration))
        const reply = await asPhone(path, { upgrade })
        // `/connect` is refused one step earlier, by its own code.
        const expected = path === '/connect' ? { status: 401, body: JSON.stringify({ error: 'CONNECT_REFUSED' }) } : { status: 403, body: LOOPBACK_REQUIRED }
        // Pins the path check in `admit`: without it each of these reaches its route, open-in-app's included.
        expect.soft({ registration, status: reply.status, body: reply.body }).toEqual({ registration, ...expected })
      } else {
        reached.push(keyOf(registration))
      }
    }
    // Pins REACHED: a registration under a listed prefix that nobody reviewed fails here, as does a stale entry.
    expect(reached.sort()).toEqual(Object.keys(REACHED).sort())
  })

  it('serves every listed path that the studio needs', async () => {
    const page = await asPhone('/')
    expect(page.status).toBe(200)
    const asset = /(?:src|href)="\.?\/?(assets\/[^"]+)"/.exec(page.body)?.[1]
    if (asset === undefined) throw new Error('the studio page names no built asset')
    expect((await asPhone(`/${asset}`)).status).toBe(200)
    for (const entry of REACH_DEVICE_PATHS.filter(candidate => candidate.reason.startsWith('an install-time file'))) {
      expect({ path: entry.path, status: (await asPhone(entry.path)).status }).toEqual({ path: entry.path, status: 200 })
    }
    expect((await asPhone('/delo/reach/status')).status).toBe(200)
    expect((await asPhone('/api/remote.mux', { upgrade: true })).status).toBe(101)
    // Every prefix entry and the reach status name a registration; the fallback answers the rest.
    const served = new Set(studio.registrations.map(keyOf))
    for (const entry of REACH_DEVICE_PATHS.filter(candidate => candidate.path.startsWith('/api') || candidate.path.startsWith('/plugins') || candidate.path.startsWith('/auth') || candidate.path.startsWith('/delo'))) {
      const named = [...served].some(key => key.endsWith(` ${entry.path}`) || key.includes(` ${entry.path}/`))
      expect({ path: entry.path, named }).toEqual({ path: entry.path, named: true })
    }
  })

  it('refuses open-in-app to the device and keeps it on the loopback studio', async () => {
    // Pins the path check: open-in-app checks only that the request was admitted, so a device reached it before.
    for (const reply of [
      await asPhone('/open-in-app/apps'),
      await asPhone('/open-in-app/open', { method: 'POST' }),
      await asPhone('/open-in-app/icon/vscode'),
    ]) {
      expect({ status: reply.status, body: reply.body }).toEqual({ status: 403, body: LOOPBACK_REQUIRED })
    }
    const apps = await asStudio('/open-in-app/apps')
    expect(apps.status).toBe(200)
    expect(await apps.json()).toEqual({ apps: expect.any(Array) })
    // A body without an app reaches the route's own validation, past its admission, and opens nothing.
    const open = await asStudio('/open-in-app/open', 'POST', '{}')
    expect({ status: open.status, body: await open.json() }).toEqual({ status: 400, body: expect.objectContaining({ code: 'bad-request' }) })
  })

  it('refuses a target that begins with a listed path but routes elsewhere', async () => {
    // Each begins with a listed path; the web server routes the first, second and fourth to open-in-app. Pins the
    // plain-path rule with the third, whose escaped slashes a route could decode, and the fifth, which the parser reads
    // as a path under `/api` other than its text.
    for (const target of [
      '/assets/../open-in-app/apps',
      '/api/%2e%2e/open-in-app/apps',
      '/plugins/..%2F..%2Fopen-in-app/apps',
      '/auth/./../open-in-app/apps',
      '/api//../open-in-app/apps',
    ]) {
      const reply = await asPhone(target)
      expect({ target, status: reply.status, body: reply.body }).toEqual({ target, status: 403, body: LOOPBACK_REQUIRED })
    }
  })

  it('decides every exact Fetch route for the device, and Delo\'s still answer the loopback studio', async () => {
    const routes = fetchRoutes()
    // Pins FETCH_ROUTES: a route without a decision fails here, as does a stale entry.
    expect(routes.map(route => route.path).sort()).toEqual(Object.keys(FETCH_ROUTES).sort())
    for (const route of routes) {
      const decision = FETCH_ROUTES[route.path]
      if (decision?.device === 'admitted') {
        const reply = await asPhone(route.path, { method: route.methods[0] ?? 'GET' })
        expect.soft({ path: route.path, status: reply.status }).toEqual({ path: route.path, status: 200 })
        continue
      }
      if (decision?.device !== 'refused') continue
      const method = route.methods[0] ?? 'GET'
      const reply = await asPhone(route.path, { method })
      // Pins upstream's exact-route gate and each route's lack of a device admission, or the route's own refusal.
      const body = decision.refusal === undefined ? reply.body : (JSON.parse(reply.body) as { readonly error?: unknown }).error
      expect.soft({ path: route.path, status: reply.status, body }).toEqual({ path: route.path, status: 403, body: decision.refusal ?? 'forbidden' })
      if (!route.path.startsWith('/api/delo')) continue
      // A body each POST route refuses or ignores, so nothing is deleted.
      const answer = await asStudio(route.path, method, '{"clearLogs":"not a flag"}')
      expect.soft({ path: route.path, refused: answer.status === 401 || answer.status === 403 }).toEqual({ path: route.path, refused: false })
    }
  })
})
