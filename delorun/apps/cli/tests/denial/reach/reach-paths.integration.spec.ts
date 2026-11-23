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
/** Why the Changes reads are reached by a device: they answer any signed-in device. */
const CHANGES = '@delorun/plugin-changes: reads for any signed-in device'
/**
 * Why the Changes controls of `@delorun/plugin-changes` are reached by a device: each action, setup and protection route
 * decides by its control's level in `access.ts` before it reads the body. Undo and Discard of a plugin's change and Discard
 * of a change to Delorun take a grant, or an unlock on a device with no passkey; turning protection on needs nothing; every
 * other action, setup included, Apply and Undo of a change to Delorun, Make my copy and turning protection off take a grant
 * from every device (a PIN grant where it holds no passkey) and stay at the computer with no grant store;
 * dismissing the notice of a device's change is the computer's alone.
 */
const CHANGES_CONTROLS = '@delorun/plugin-changes: a device only as the control\'s level allows, with a grant or an unlock it entered; the notice of a device\'s change only at the computer'
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
  'exact /delorun/branding/icon': '@delorun/plugin-theme: the studio\'s custom icon, which the page and the installed app show',
  'exact /delorun/changes/apply': CHANGES_CONTROLS,
  'exact /delorun/changes/create': CHANGES_CONTROLS,
  'exact /delorun/changes/discard': CHANGES_CONTROLS,
  'exact /delorun/changes/done': CHANGES_CONTROLS,
  'exact /delorun/changes/exit-safe-mode': CHANGES_CONTROLS,
  'exact /delorun/changes/off': CHANGES_CONTROLS,
  'exact /delorun/changes/on': CHANGES_CONTROLS,
  'exact /delorun/changes/request': CHANGES_CONTROLS,
  'exact /delorun/changes/reveal': CHANGES_CONTROLS,
  'exact /delorun/changes/safe-mode': CHANGES_CONTROLS,
  'exact /delorun/changes/setup-apply': CHANGES_CONTROLS,
  'exact /delorun/changes/setup-export': CHANGES_CONTROLS,
  'exact /delorun/changes/setup-inspect': CHANGES_CONTROLS,
  'exact /delorun/changes/show': CHANGES,
  'exact /delorun/changes/state': CHANGES,
  'exact /delorun/changes/undo': CHANGES_CONTROLS,
  'exact /delorun/changes/work': CHANGES_CONTROLS,
  'exact /delorun/changes/workspaces': CHANGES,
  'exact /delorun/changes/harness-apply': CHANGES_CONTROLS,
  'exact /delorun/changes/harness-undo': CHANGES_CONTROLS,
  'exact /delorun/changes/harness-discard': CHANGES_CONTROLS,
  'exact /delorun/changes/harness-copy': CHANGES_CONTROLS,
  'exact /delorun/changes/restart': CHANGES_CONTROLS,
  'exact /delorun/changes/restart-cancel': CHANGES_CONTROLS,
  'exact /delorun/changes/protection-off': CHANGES_CONTROLS,
  'exact /delorun/changes/protection-on': CHANGES_CONTROLS,
  'exact /delorun/changes/notice-seen': CHANGES_CONTROLS,
  'exact /auth/owner/claim': HOME_AUTH,
  'exact /auth/branding/icon': HOME_AUTH,
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
  'exact /auth/elevation': HOME_AUTH,
  'exact /auth/elevation/request': HOME_AUTH,
  'exact /auth/elevation/lock': HOME_AUTH,
  'exact /auth/elevation/end-grace': HOME_AUTH,
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
  'exact /auth/passkey/state': HOME_AUTH,
  'exact /auth/passkey/options': HOME_AUTH,
  'exact /auth/passkey/verify': HOME_AUTH,
  'exact /auth/passkey/pin': HOME_AUTH,
  'exact /auth/passkey/pass': HOME_AUTH,
  'exact /auth/passkey/lock': HOME_AUTH,
  'exact /auth/passkey/register/options': HOME_AUTH,
  'exact /auth/passkey/register': HOME_AUTH,
  'exact /auth/passkey/add/request': HOME_AUTH,
  'exact /auth/passkey/add/pending': HOME_AUTH,
  'exact /auth/passkey/add/approve': HOME_AUTH,
  'exact /auth/passkey/devices': HOME_AUTH,
  'exact /auth/passkey/remove': HOME_AUTH,
}

/**
 * One exact Fetch route's decision for a device: `refused` answers 403, `per-call` asks remote access on each request,
 * `read` admits a device's `GET` and nothing else, `admitted` answers every device through the route's own
 * `admitPeer`, and `unlock` admits a device to the route, which answers `403 ELEVATION_REQUIRED` while the device is
 * locked and runs for an unlocked one. A refused route answers upstream's `forbidden` unless its own check refuses the device first, with
 * `refusal`'s code.
 */
interface FetchDecision {
  readonly device: 'refused' | 'per-call' | 'read' | 'admitted' | 'unlock'
  readonly reason: string
  readonly refusal?: string
  /** The status a `read` or `admitted` route answers the probe, which names no argument; 200 when absent. A 400 shows the device was admitted. */
  readonly answers?: number
}

const UNLOCKED = (reason: string): FetchDecision => ({ device: 'unlock', reason })
const READ = (reason: string, answers?: number): FetchDecision => ({ device: 'read', reason, ...answers === undefined ? {} : { answers } })
const OPEN = (reason: string, answers?: number): FetchDecision => ({ device: 'admitted', reason, ...answers === undefined ? {} : { answers } })
/**
 * The `unlock` routes that are face rows (`gateByClass`): a running unlock, a PIN window or the approval grace never opens them (A483); a device needs a
 * one-action grant, a PIN grant where it holds no passkey.
 */
const FACE_ROUTES: ReadonlySet<string> = new Set([
  '/api/delorunDelegationConsent.allow', '/api/delorunExternalAgents.refresh', '/api/delorunMcpConsent.accept', '/api/delorunNetwork.set', '/api/delorunNewWorkspace.add', '/api/delorunNewWorkspace.clone',
  '/api/delorunNewWorkspace.create', '/api/delorunNewWorkspace.places', '/api/delorunNewWorkspace.preview', '/api/delorunNewWorkspace.search', '/api/delorunNewWorkspace.setDefaults',
  '/api/delorunPacks.enqueue', '/api/delorunPacks.remove', '/api/delorunPacks.retry', '/api/delorunPermission.setFullAccess', '/api/delorunReport.details',
  '/api/delorunTrash.empty', '/api/delorunTrash.purge', '/api/delorunTrash.removeSetAside', '/api/delorunVersions.save', '/api/delorunVersions.switch',
  '/api/delorunRun.prompts', '/api/delorunRun.background',
])
const UPSTREAM_OWNER_ONLY = 'upstream declares no device admission, so only the owner reaches it'

/**
 * Every exact Fetch route of the composition with the device's decision. A paired device does what the computer's studio
 * does: a read or a step that only tightens is open to it, a step that widens access needs the unlock, and what
 * upstream declares owner-only stays refused.
 */
const FETCH_ROUTES: Readonly<Record<string, FetchDecision>> = {
  '/api/delorunBrowsePair.start': { device: 'refused', reason: 'pairing runs browse on the computer and links the person\'s own Chrome, with their sign-ins; only the computer\'s own studio starts it' },
  '/api/delorunBrowser.test': { device: 'refused', reason: 'the Settings Browser page\'s test starts a browser on the computer, outside the agent sandbox; only the computer\'s own studio asks (route-access C)' },
  '/api/delorunRun.state': READ('reads the answers of How Delorun runs and what runs now: port numbers and whether phone access is on, with no key or path'),
  '/api/delorunRun.prompts': UNLOCKED('turning questions off lets a chat do more without asking, so a device confirms `stock` with Face ID or its PIN every time; `safer` only tightens'),
  '/api/delorunRun.background': UNLOCKED('keeping Delorun running after the terminal closes decides whether the studio stays reachable'),
  '/api/delorunRun.dangerousBegin': { device: 'refused', reason: 'the first step of turning dangerous mode on, which only the person at the computer does (route-access C)', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunRun.dangerousConfirm': { device: 'refused', reason: 'turning dangerous mode on is done only at the computer, in dangerous mode and with an unlock too (route-access C)', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunRun.port': { device: 'refused', reason: 'the studio\'s port decides where it listens and changes its sign-in address (route-access C)', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunRun.reachPreview': { device: 'refused', reason: 'it reads Tailscale on the computer and issues the ticket that turning phone access on needs (route-access C)', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunRun.reach': { device: 'refused', reason: 'turning phone access on or off decides who can reach the home (route-access C)', refusal: 'LOOPBACK_REQUIRED' },
  '/api/delorunBrowser.install': { device: 'refused', reason: 'the Settings Browser page downloads a browser build onto the computer; only the computer\'s own studio asks (route-access C)' },
  '/api/delorunPreviewFlags.list': READ('names the declared preview flags and whether each is on, with no setting or data'),
  '/api/delorunChatStates.list': READ('snooze and settle states order the chat list, which a phone shows too'),
  '/api/delorunChatStates.set': OPEN('snoozing or settling a chat is everyday organising', 400),
  '/api/delorunNewWorkspace.places': UNLOCKED('lists the computer\'s recent workspaces and folders by path'),
  '/api/delorunNewWorkspace.search': UNLOCKED('walks the computer\'s folders and names them by path'),
  '/api/delorunNewWorkspace.preview': UNLOCKED('names the entries and the Git branch of a folder on the computer'),
  '/api/delorunNewWorkspace.add': UNLOCKED('adds a folder as a workspace, which is what the model may write'),
  '/api/delorunNewWorkspace.create': UNLOCKED('makes a folder, runs Git in it and adds it as a workspace'),
  '/api/delorunNewWorkspace.clone': UNLOCKED('runs Git as the person and adds the clone as a workspace'),
  '/api/delorunNewWorkspace.cloneStatus': OPEN('reports a clone\'s progress; reading only, so no unlock is needed', 400),
  '/api/delorunNewWorkspace.defaults': OPEN('reads a workspace\'s model and browser defaults by its path; reading only', 400),
  '/api/delorunNewWorkspace.setDefaults': UNLOCKED('sets the model and browser every new chat in a workspace starts with'),
  '/api/delorunOnboarding.workspaceNotice': READ('names the workspace record files the registry set aside at start-up'),
  '/api/delorunOnboarding.setupRecord': READ('what setup recorded serves onboarding on a phone'),
  '/api/delorunNetwork.list': READ('lists each workspace\'s network setting'),
  '/api/delorunNetwork.set': UNLOCKED('a looser network setting lets commands reach more of the network'),
  '/api/delorunOnboarding.agentModels': OPEN('lists an agent\'s models; reading only, so no unlock is needed', 400),
  '/api/delorunOnboarding.start': READ('a random id naming this start of the home, with no setting or data'),
  '/api/delorunPacks.list': OPEN('an approved phone reads which plugin packs the release offers and how far each install is; names and progress only', 400),
  '/api/delorunPacks.cancel': OPEN('cancelling a queued or running install only tightens', 400),
  '/api/delorunPacks.dismiss': OPEN('dismissing a finished install\'s row only tidies the list', 400),
  '/api/delorunPacks.enqueue': UNLOCKED('adding a plugin pack downloads and installs code on the computer'),
  '/api/delorunPacks.retry': UNLOCKED('retrying a pack install downloads and installs code on the computer'),
  '/api/delorunPacks.remove': UNLOCKED('removing an installed pack changes what the computer runs'),
  '/api/delorunOnboarding.deferStep': OPEN('notes that a setup step waits for the computer; ids from a closed list, no setting changes', 400),
  '/api/delorunRequirements.check': READ('what each row of the profile needs set up, and whether it is: names, never values'),
  '/api/delorunOnboarding.localModels': READ('probes this computer\'s loopback model servers'),
  '/api/delorunOnboarding.readiness': READ('whether the coding agents are signed in and how far Tailscale is set up serves onboarding on a phone'),
  '/api/delorunOnboarding.keyTest': OPEN('An approved phone tests its model keys; the answer names each provider and its result, never a key; while PIN mode is on only an unlocked page is admitted'),
  '/api/delorunOnboarding.recommend': OPEN('An approved phone reads what the recommended plugins are for, so the Recommended plugins step orders them; the answer names packages and connections only', 400),
  '/api/delorunBranding.icon': OPEN('an approved phone uploads the Branding icon as it writes any everyday setting; the host checks the bytes (PNG, JPEG or WebP, at most 256 KB, never SVG), and the probe sends none, so the route answers 415 past its admission', 415),
  '/api/delorunMainChat.open': OPEN('opens the main chat, which exists to be opened; the probe\'s composition cannot create it, so the route answers 502 past its admission', 502),
  '/api/delorunMainChat.reports': READ('a count for the main chat\'s sidebar mark'),
  '/api/delorunTrust.bill': READ('the trust badge shows on every studio page, a device\'s included (C15); the bill names what runs and what was checked, and no secret'),
  '/api/delorunTrust.check': OPEN('Check now only checks; it changes nothing, so no unlock is needed', 415),
  '/api/delorunVersions.list': READ('the setup versions screen lists the saved versions and which one runs; it names no secret'),
  '/api/delorunVersions.changes': READ('the setup versions screen compares a saved version with the running one; the probe names no version, so the route answers 400 BAD_REQUEST', 400),
  '/api/delorunReport.details': UNLOCKED('the report holds an excerpt of the home\'s log, which can name paths of the home'),
  '/api/delorunVersions.save': UNLOCKED('saving a setup version writes to the computer'),
  '/api/delorunVersions.switch': UNLOCKED('switching a setup version changes what runs'),
  '/api/delorunUpdateCheck.channel': READ('the Settings copy on a signed-in device names the release host this installation contacts, which is the channel origin\'s host alone; it names no secret and changes nothing'),
  '/api/delorunUpdateCheck.notice': READ('the update notice names the release that runs and how many installed plugins an update would turn off'),
  '/api/delorunUpdateCheck.notes': READ('the release notes of the update that would run'),
  '/api/delorunTrash.list': OPEN('the trash lists deleted chats and workspaces; a POST, so the bodiless probe answers 400', 400),
  '/api/delorunTrash.deleteChat': OPEN('moving a chat to the trash is reversible', 400),
  '/api/delorunTrash.deleteWorkspace': OPEN('moving a workspace to the trash is reversible', 400),
  '/api/delorunTrash.restore': OPEN('restoring from the trash is reversible', 400),
  '/api/delorunTrash.setAside': OPEN('lists the set-aside and copy directories an update kept; reading only', 400),
  '/api/delorunTrash.removeSetAside': UNLOCKED('deleting set-aside data is for good'),
  '/api/delorunTrash.purge': UNLOCKED('deleting from the trash is for good'),
  '/api/delorunTrash.empty': UNLOCKED('emptying the trash is for good'),
  '/api/delorunPermission.workspaces': READ('lists the workspaces and their full access'),
  '/api/delorunPermission.review': OPEN('shows what full access would allow, before anything changes', 400),
  '/api/delorunPermission.setFullAccess': UNLOCKED('a workspace\'s full access lets a chat write outside the workspace sandbox'),
  '/api/delorunPermission.everywhere': READ('reading whether dangerous mode is on'),
  '/api/delorunPermission.everywhereOff': OPEN('turning dangerous mode off only tightens; turning it on is the computer-only `delorunRun.dangerousConfirm`'),
  '/api/delorunMcpConsent.pending': READ('lists the MCP servers waiting for the person\'s OK'),
  '/api/delorunMcpConsent.accept': UNLOCKED('accepting a stdio MCP server lets its command run outside the sandbox'),
  '/api/delorunMcpConsent.decline': OPEN('declining only withholds consent', 400),
  '/api/delorunMcpConsent.revoke': OPEN('revoking only withdraws consent', 400),
  '/api/delorunDelegationConsent.grants': READ('lists which external agents may work in which workspaces'),
  '/api/delorunDelegationConsent.levels': READ('reads each external agent\'s saved level and what its sandbox lacks; it changes no level, which only a settings write does, and the reach policy ranks that'),
  '/api/delorunDelegationConsent.allow': UNLOCKED('allowing an external agent for a workspace starts a program outside the sandbox without asking'),
  '/api/delorunDelegationConsent.revoke': OPEN('revoking only withdraws a grant', 400),
  '/api/delorunExternalAgents.accounts': READ('reads each agent\'s sign-in, plan and limit figures, which hold no personal data; reading starts no check'),
  '/api/delorunExternalAgents.refresh': UNLOCKED('a check starts the person\'s own Claude Code or Codex program on the computer'),
  '/api/delorunMcpConsent.waiting': READ('the names of the servers waiting for the person\'s OK, without their commands'),
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
/** The approved device's id, whose unlock the unlock pass starts and ends. */
let deviceId: string
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
  deviceId = record.id
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
      if (decision?.device === 'unlock') {
        // Pins the unlock gate: a locked device is admitted to the route and refused by it with the typed code.
        const reply = await asPhone(route.path, { method: route.methods[0] ?? 'GET' })
        const error = reply.status === 403 ? (JSON.parse(reply.body) as { readonly error?: unknown }).error : reply.body
        expect.soft({ path: route.path, status: reply.status, error }).toEqual({ path: route.path, status: 403, error: 'ELEVATION_REQUIRED' })
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

  it('runs the unlock routes for an unlocked device but never a face route, and again refuses them once it is locked', async () => {
    const { homeAuth } = studio.ctx
    const admitted = homeAuth.admitToken(session.slice(session.indexOf('=') + 1), LISTENER)
    if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
    const requested = homeAuth.requestElevation(admitted.sessionId, admitted.session)
    if (requested.kind !== 'pending') throw new Error('no unlock request is waiting')
    homeAuth.approveElevation(requested.requestId, requested.code)
    try {
      const unlockRoutes = fetchRoutes().filter(route => FETCH_ROUTES[route.path]?.device === 'unlock')
      expect(unlockRoutes.length).toBeGreaterThan(8)
      for (const route of unlockRoutes) {
        const reply = await asPhone(route.path, { method: route.methods[0] ?? 'GET' })
        const error = reply.status === 403 ? (JSON.parse(reply.body || '{}') as { readonly error?: unknown }).error : undefined
        // Pins A483: an unlocked device is still refused every face route; removing a route from FACE_ROUTES, or the grant-only refusal, fails here.
        // Pins the gate's other half: every other unlock route runs for an unlocked device, which answers past the admission.
        expect.soft({ path: route.path, status: reply.status, error }).toEqual(FACE_ROUTES.has(route.path)
          ? { path: route.path, status: 403, error: 'ELEVATION_REQUIRED' }
          : { path: route.path, status: reply.status, error: undefined })
      }
    } finally {
      homeAuth.lockElevation(deviceId, LISTENER)
    }
    const locked = await asPhone('/api/delorunVersions.save', { method: 'POST' })
    expect(locked.status).toBe(403)
  })

  it('lets an approved phone test model keys but not an unauthenticated or locked one, and sends no key back', async () => {
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
