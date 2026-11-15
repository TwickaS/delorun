/**
 * The route denial suite of a signed-in device. The whole composition of Delorun's CLI profiles boots in this process,
 * `@delorun/bundle-local` and `@delorun/bundle-studio` included, with the experimental main chat mounted as a person adds it;
 * `@delorun/home-auth` serves the Tailscale private reach listener, and an approved device holds a live session there.
 *
 * - Every registration of the web server (exact, prefix, upgrade and the fallback) is requested as the device: one
 *   whose target is not on `REACH_DEVICE_PATHS` answers `403 LOOPBACK_REQUIRED` from the authenticator, and the
 *   registrations the device does reach are exactly the ones {@link REACHED} lists with their owner.
 * - Every entry of `REACH_DEVICE_PATHS` names something the studio serves.
 * - `open-in-app` is refused to the device and still answers the loopback studio.
 * - A target whose text begins with a listed path but that the web server routes elsewhere is refused.
 * - Every exact Fetch route is on {@link FETCH_ROUTES} with the device's decision: each refused one answers the device
 *   403, each read-only one answers the device's read 200, and each of Delorun's still answers the loopback studio.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReachListener } from '@deepseek-ai/dsh-client-connection'
import type { StudioAddress } from '@delorun/contract-admission'
// The main chat is an experimental plugin no profile mounts; this spec mounts it to request its routes as a device.
import * as mainChat from '@delorun/plugin-main-chat'
import { DeviceStore, REACH_DEVICE_PATHS, reachesDevicePath } from '@delorun/home-auth'
import { claimOf, recordOf } from '../fixtures/devices.ts'
import { tcpEndpoint, type Endpoint, type Reply } from '../admission/fixtures.ts'
import { bootStudio, targetOf, type Registration, type Studio } from '../admission/studio.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
/** The body of the authenticator's refusal of a target off the device's paths. */
const LOOPBACK_REQUIRED = JSON.stringify({ error: 'LOOPBACK_REQUIRED' })

/** Why the install-time files are served to a device. */
const STATIC = 'upstream\'s frontend-static fallback: the studio page, its built assets and its install-time files'
/** Why the routes of `@delorun/home-auth` are reached by a device. */
const HOME_AUTH = '@delorun/home-auth: sign-in and the device routes, which refuse a reach session where C5 reserves them'

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
  'exact /delorun/reach/status': '@delorun/reach: the reach status the studio shows',
  'exact /auth/owner/claim': HOME_AUTH,
  'exact /auth/devices': HOME_AUTH,
  'exact /auth/devices/remove': HOME_AUTH,
  'exact /auth/sign-in': HOME_AUTH,
  'exact /auth/branding/icon': HOME_AUTH,
  'exact /auth/device/request': HOME_AUTH,
  'prefix /auth/device/request': HOME_AUTH,
  'exact /auth/device/challenge': HOME_AUTH,
  'exact /auth/session': HOME_AUTH,
  'exact /auth/devices/window': HOME_AUTH,
  'exact /auth/devices/pending': HOME_AUTH,
  'exact /auth/devices/approve': HOME_AUTH,
  'exact /auth/devices/cancel': HOME_AUTH,
  'prefix /auth/assets': HOME_AUTH,
  'exact /auth/elevation': HOME_AUTH,
  'exact /auth/elevation/request': HOME_AUTH,
  'exact /auth/elevation/lock': HOME_AUTH,
  'exact /auth/elevation/pending': HOME_AUTH,
  'exact /auth/elevation/approve': HOME_AUTH,
  'exact /auth/elevation/revoke': HOME_AUTH,
  'exact /auth/pin/state': HOME_AUTH,
  'exact /auth/pin/unlock': HOME_AUTH,
  'exact /auth/pin/touch': HOME_AUTH,
  'exact /auth/pin/lock': HOME_AUTH,
  'exact /auth/pin/mode': HOME_AUTH,
  'exact /auth/pin/set': HOME_AUTH,
  'exact /auth/pin/off': HOME_AUTH,
  'exact /auth/pin/options': HOME_AUTH,
  'exact /auth/pin/resume': HOME_AUTH,
}

/**
 * One exact Fetch route's decision for a device: `refused` answers 403, `per-call` asks remote access on each request,
 * `read` admits a device's `GET` and nothing else, and `admitted` answers every device through the route's own
 * `admitPeer`. A refused route answers upstream's `forbidden` unless its own check refuses the device first, with
 * `refusal`'s code.
 */
interface FetchDecision {
  readonly device: 'refused' | 'per-call' | 'read' | 'admitted'
  readonly reason: string
  readonly refusal?: string
  /** The status a `read` or `admitted` route answers the probe, which names no argument; 200 when absent. A 400 shows the device was admitted. */
  readonly answers?: number
}

const TRASH = 'the trash holds deleted chats and workspaces, and moving to, restoring from or deleting from it is not in the device rule'
const FULL_ACCESS = 'turning a workspace\'s full access on or off is a full-access grant, which only the home\'s computer gives; the plugin refuses a device before upstream\'s gate, unless dangerous mode holds and the device holds an unlock'
const MCP_ANSWER = 'accepting or revoking a stdio MCP server decides whether its command runs outside the sandbox, which only the home\'s computer decides; the plugin refuses a device before upstream\'s gate'
const EXTERNAL_AGENT = 'allowing or revoking an external agent for a workspace decides whether a program outside the sandbox starts without asking, which only the home\'s computer decides; the plugin refuses a device before upstream\'s gate'
const VERSIONS_WRITE = 'saving, trying and switching setup versions changes what runs, which only the home\'s computer does'
const DANGEROUS_STATE = 'reading and turning off dangerous mode: the route admits only a device that holds a running unlock, and this device holds none; no route turns the mode on'
const UPSTREAM_OWNER_ONLY = 'upstream declares no device admission, so only the owner reaches it'

/**
 * Every exact Fetch route of the composition with the device's decision. Delorun's routes default to refused; a device
 * keeps a read only to render a chat it can already read, to send the person to the computer, as the waiting MCP
 * servers' names do, or when the studio shows it on every page, as the trust badge's bill.
 */
const FETCH_ROUTES: Readonly<Record<string, FetchDecision>> = {
  '/api/delorunChatStates.list': { device: 'refused', reason: 'snooze and settle states order the chat list at the computer; a device renders every chat without them, and the client keeps its last states' },
  '/api/delorunChatStates.set': { device: 'refused', reason: 'snoozing or settling a chat is not in the device rule' },
  '/api/delorunOnboarding.workspaceNotice': { device: 'refused', reason: 'names the workspace record files the registry set aside at start-up, which is workspace housekeeping the home\'s computer shows' },
  '/api/delorunOnboarding.setupRecord': { device: 'refused', reason: 'what the terminal setup recorded serves onboarding at the computer' },
  '/api/delorunOnboarding.addWorkspace': { device: 'refused', reason: 'adds a folder as a workspace, which is workspace management the home\'s computer keeps', refusal: 'LOOPBACK_ONLY' },
  '/api/delorunNetwork.list': { device: 'refused', reason: 'lists each workspace\'s network setting, which is read and changed only at the home\'s computer', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunNetwork.set': { device: 'refused', reason: 'changes a workspace\'s network, which only the person at the home\'s computer chooses', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunOnboarding.clone': { device: 'refused', reason: 'runs Git as the person and adds the clone as a workspace, which is workspace management the home\'s computer keeps', refusal: 'LOOPBACK_ONLY' },
  '/api/delorunOnboarding.cloneStatus': { device: 'refused', reason: 'reports a clone the computer started', refusal: 'LOOPBACK_ONLY' },
  '/api/delorunOnboarding.localModels': { device: 'refused', reason: 'probes this computer\'s loopback model servers (Ollama, LM Studio), which only the computer can add as providers' },
  '/api/delorunOnboarding.readiness': { device: 'refused', reason: 'whether the coding agents are signed in and how far Tailscale is set up serves onboarding at the computer' },
  '/api/delorunOnboarding.keyTest': { device: 'admitted', reason: 'A380: an approved phone tests its model keys; the answer names each provider and its result, never a key; while PIN mode is on only an unlocked page is admitted' },
  '/api/delorunOnboarding.recommend': { device: 'admitted', answers: 400, reason: 'A381: an approved phone reads what the recommended plugins are for, so the Recommended plugins step orders them; the answer names packages and connections only' },
  '/api/delorunMainChat.open': { device: 'refused', reason: 'creates the main chat on its configured preset, which a device does not choose' },
  '/api/delorunMainChat.reports': { device: 'refused', reason: 'a count for the main chat\'s sidebar mark; a device reads the main chat itself through session/page' },
  '/api/delorunTrust.bill': { device: 'read', reason: 'the trust badge shows on every studio page, a device\'s included (C15); the bill names what runs and what was checked, and no secret' },
  '/api/delorunTrust.check': { device: 'refused', reason: 'Check now hashes the runtime and runs the release-log check, which only the home\'s computer starts' },
  '/api/delorunVersions.list': { device: 'read', reason: 'the setup versions screen lists the saved versions and which one runs, which a signed-in studio reads; it names no secret' },
  '/api/delorunVersions.changes': { device: 'read', reason: 'the setup versions screen compares a saved version with the running one, which a signed-in studio reads; the history\'s admission keeps secret fields out; the probe names no version, so the route answers 400 BAD_REQUEST', answers: 400 },
  '/api/delorunReport.details': { device: 'refused', reason: 'the report holds an excerpt of the home\'s log, which only the computer the home runs on may read; a device reports its versions without it' },
  '/api/delorunVersions.save': { device: 'refused', reason: VERSIONS_WRITE, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunVersions.switch': { device: 'refused', reason: VERSIONS_WRITE, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunUpdateCheck.channel': { device: 'read', reason: 'the Settings copy on a signed-in device names the release host this installation contacts, which is the channel origin\'s host alone; it names no secret and changes nothing' },
  '/api/delorunUpdateCheck.notice': { device: 'refused', reason: 'the update notice names the release that runs and how many installed plugins an update would turn off, and the update runs only at the computer' },
  '/api/delorunUpdateCheck.notes': { device: 'refused', reason: 'the release notes of the update that would run, which is read where the update notice is, at the computer that runs the update' },
  '/api/delorunTrash.list': { device: 'refused', reason: TRASH },
  '/api/delorunTrash.deleteChat': { device: 'refused', reason: TRASH },
  '/api/delorunTrash.deleteWorkspace': { device: 'refused', reason: TRASH },
  '/api/delorunTrash.restore': { device: 'refused', reason: TRASH },
  '/api/delorunTrash.purge': { device: 'refused', reason: TRASH },
  '/api/delorunTrash.empty': { device: 'refused', reason: TRASH },
  '/api/delorunPermission.workspaces': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunPermission.review': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunPermission.setFullAccess': { device: 'refused', reason: FULL_ACCESS, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunPermission.everywhere': { device: 'refused', reason: DANGEROUS_STATE },
  '/api/delorunPermission.everywhereOff': { device: 'refused', reason: DANGEROUS_STATE },
  '/api/delorunMcpConsent.pending': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunMcpConsent.accept': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunMcpConsent.decline': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunMcpConsent.revoke': { device: 'refused', reason: MCP_ANSWER, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunDelegationConsent.grants': { device: 'refused', reason: EXTERNAL_AGENT, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunDelegationConsent.allow': { device: 'refused', reason: EXTERNAL_AGENT, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunDelegationConsent.revoke': { device: 'refused', reason: EXTERNAL_AGENT, refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunMcpConsent.waiting': { device: 'admitted', reason: 'the names of the servers waiting for the person\'s OK, without their commands, so a phone says to approve them at the computer' },
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
  session = `__Host-delorun-session=${opened.token}`
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
      { kind: 'exact', path: '/delorun/reach/status' }, { kind: 'exact', path: '/auth/devices' }, { kind: 'fallback' },
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
    expect((await asPhone('/delorun/reach/status')).status).toBe(200)
    expect((await asPhone('/api/remote.mux', { upgrade: true })).status).toBe(101)
    // Every prefix entry and the reach status name a registration; the fallback answers the rest.
    const served = new Set(studio.registrations.map(keyOf))
    for (const entry of REACH_DEVICE_PATHS.filter(candidate => candidate.path.startsWith('/api') || candidate.path.startsWith('/plugins') || candidate.path.startsWith('/auth') || candidate.path.startsWith('/delorun'))) {
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

  it('decides every exact Fetch route for the device, and Delorun\'s still answer the loopback studio', async () => {
    const routes = fetchRoutes()
    // Pins FETCH_ROUTES: a route without a decision fails here, as does a stale entry.
    expect(routes.map(route => route.path).sort()).toEqual(Object.keys(FETCH_ROUTES).sort())
    for (const route of routes) {
      const decision = FETCH_ROUTES[route.path]
      if (decision?.device === 'read') {
        // Pins the route's `admitPeer`: without it Connection refuses the device's read with `forbidden`.
        expect.soft({ path: route.path, methods: route.methods, status: (await asPhone(route.path)).status }).toEqual({ path: route.path, methods: ['GET'], status: decision.answers ?? 200 })
        continue
      }
      if (decision?.device === 'admitted') {
        const reply = await asPhone(route.path, { method: route.methods[0] ?? 'GET' })
        expect.soft({ path: route.path, status: reply.status }).toEqual({ path: route.path, status: decision.answers ?? 200 })
        continue
      }
      if (decision?.device !== 'refused') continue
      const method = route.methods[0] ?? 'GET'
      const reply = await asPhone(route.path, { method })
      // Pins upstream's exact-route gate and each route's lack of a device admission, or the route's own refusal.
      const body = decision.refusal === undefined ? reply.body : (JSON.parse(reply.body) as { readonly error?: unknown }).error
      expect.soft({ path: route.path, status: reply.status, body }).toEqual({ path: route.path, status: 403, body: decision.refusal ?? 'forbidden' })
      if (!route.path.startsWith('/api/delorun')) continue
      // A body each POST route refuses or ignores, so nothing is deleted.
      const answer = await asStudio(route.path, method, '{"clearLogs":"not a flag"}')
      expect.soft({ path: route.path, refused: answer.status === 401 || answer.status === 403 }).toEqual({ path: route.path, refused: false })
    }
  })

  it('lets an approved phone test model keys (A380) but not an unauthenticated or locked one, and sends no key back', async () => {
    const path = '/api/delorunOnboarding.keyTest'
    const fakeKey = 'sk-a380-known-fake-key-0123456789'
    const saved = process.env['DEEPSEEK_API_KEY']
    process.env['DEEPSEEK_API_KEY'] = fakeKey
    try {
      // Pins `admitPeer` on the route: a tailnet request with no session never reaches the route.
      const anonymous = await phone.send(path, { origin: phone.origin }, { method: 'POST' })
      expect.soft(anonymous.status, 'no session').toBeGreaterThanOrEqual(401)
      expect.soft(anonymous.body).not.toContain(fakeKey)
      // Pins the admission of the approved device.
      const admitted = await asPhone(path, { method: 'POST' })
      expect(admitted.status).toBe(200)
      // Pins the answer: it names providers and results alone, so no admitted response carries the key.
      expect(admitted.body).not.toContain(fakeKey)
      for (const [route, decision] of Object.entries(FETCH_ROUTES)) {
        if (decision.device !== 'read' && decision.device !== 'admitted') continue
        expect.soft((await asPhone(route, { method: route === path ? 'POST' : 'GET' })).body, route).not.toContain(fakeKey)
      }
      // Pins the PIN check: while PIN mode is on, a page that presents no unlock is refused.
      await studio.ctx.homeAuth.setPin('739150', {})
      const locked = await asPhone(path, { method: 'POST' })
      expect(locked.status).toBe(403)
      expect(locked.body).not.toContain(fakeKey)
    } finally {
      await studio.ctx.homeAuth.turnPinOff()
      if (saved === undefined) delete process.env['DEEPSEEK_API_KEY']
      else process.env['DEEPSEEK_API_KEY'] = saved
    }
  })
})
