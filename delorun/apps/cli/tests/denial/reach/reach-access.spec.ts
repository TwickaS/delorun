/**
 * The reach access denial suite. Delorun's web composition boots in this process with `@delorun/home-auth`; a device the
 * home approved opens a session on a reach listener, the authenticator admits it as a Peer, and every call it makes
 * goes through upstream's Gateway and remote access exactly as a request on the reach listener does, through the
 * shared `/api` channel with the Peer the authenticator returned.
 *
 * - Each family C14 keeps for an unlock is refused without one, naming the action: plugin installation and enabling,
 *   profile history undo and restore, a settings write in every settings namespace, terminals, slash commands, dynamic
 *   plugin code, the directory picker, a new workspace, and a chat in a folder outside the known workspaces. Under an
 *   unlock each is admitted, and the never families (credentials, the account, the settings document) stay refused,
 *   as do a slash command `REACH_DEVICE_COMMANDS` does not list and a settings write that would turn a registered
 *   computer-only switch, the external-agent consent, off.
 * - The reads a device needs to work the way it works at the computer succeed: the installed plugins and their profile
 *   history, the files of a chat's own workspace, the office previews of those files, and the composer's file names.
 *   A workspace-file call whose real path lies outside the workspace or in the Delorun home, a link's target included,
 *   is refused.
 * - Reading the chat list and the redacted settings, starting a chat in a known workspace with any preset, sending a
 *   message, stopping the run, choosing the preset a chat runs with, organizing chats and workspaces and schedule changes
 *   succeed, and the device's event stream carries the chat events and no dynamic plugin event.
 * - Every Remote method the composition registers and every event it forwards is in one of the three tables, and
 *   every entry names one that exists.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReachListener } from '@deepseek-ai/dsh-client-connection'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import { remoteMethods, type PeerScope, type RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_VERSION, type Base64Url } from '@delorun/contract-device-approval'
import { CREATE_OUTSIDE_WORKSPACES, deviceIdOf, DeviceStore, hashArgs, HomeAuthService, PROTECTED_ROW_REFUSAL, REACH_ALLOWED_ACTIONS, REACH_DENIED_ACTIONS, REACH_ELEVATED_ACTIONS, REACH_EVERYDAY_SETTINGS, REACH_KEY_ACTIONS, reachDevicePrincipal, signInMessage, switchOffRefusal, UNLISTED_COMMAND_REFUSAL } from '@delorun/home-auth'
import { EXTERNAL_AGENT_CONSENT_SWITCH } from '@delorun/plugin-delegation-consent'
import { claimOf, recordOf } from '../fixtures/devices.ts'
import { bootStudio, type Studio } from '../admission/studio.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const GLOBAL: RemoteAccessResource = { kind: 'global' }

/** One Remote call's result as the shared `/api` channel returns it. */
type Result =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> } }

let studio: Studio
let directory: string
let peer: PeerScope
let workspaceId: WorkspaceId
let deviceId: ReturnType<typeof recordOf>['id']
let deviceToken: string
let rpc = 0

/**
 * Call one Remote method as the device, through the shared `/api` channel the reach listener serves.
 * @param endpoint - the `<namespace>/<method>` endpoint.
 * @param args - its named wire arguments.
 * @returns the call's result.
 */
async function call(endpoint: string, args: Record<string, unknown>, as: PeerScope = peer): Promise<Result> {
  rpc += 1
  const response = await studio.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://127.0.0.1/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `reach-${String(rpc)}`, method: endpoint, payload: { args } }),
  }), as)
  const body = await response.json() as { readonly result: Result }
  return body.result
}

/**
 * Assert that one call is refused by remote access, naming its action.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments, valid for its descriptor so that only access refuses it.
 */
async function expectRefused(endpoint: string, args: Record<string, unknown>): Promise<void> {
  expect(await call(endpoint, args), endpoint).toMatchObject({
    ok: false,
    error: { code: 'remote-access/denied', details: { action: endpoint, reason: `loopback-required: ${endpoint}` } },
  })
}

/**
 * The exact Fetch routes whose `admitPeer` admits an approved device. The last two are decided on the global resource,
 * so they admit the device whatever chat the probe names; every other route here names a chat or a bundle the probe
 * supplies.
 */
const ADMITTED_ROUTES: ReadonlySet<string> = new Set([
  '/api/delorunOnboarding.keyTest', '/api/delorunOnboarding.recommend', '/api/delorunOnboarding.setupRecord', '/api/delorunOnboarding.deferStep',
  '/api/delorunOnboarding.readiness', '/api/delorunOnboarding.start', '/api/delorunOnboarding.localModels', '/api/delorunOnboarding.workspaceNotice',
  '/api/delorunMcpConsent.waiting', '/api/delorunBranding.icon', '/api/delorunChatStates.list', '/api/delorunChatStates.set',
  '/api/delorunPreviewFlags.list', '/api/delorunNewWorkspace.cloneStatus', '/api/delorunNewWorkspace.defaults', '/api/delorunOnboarding.agentModels', '/api/delorunTrust.check',
  // The desktop metadata a chat's card reads, and an image beside a bundle's detail document: both name no chat, so the
  // policy decides them on the global resource and admits the device.
  '/api/present.host', '/api/plugin-manager/detail-file',
])

/**
 * Assert that one call is refused by remote access until the device holds an elevation, naming its action.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @param as - the Peer that calls.
 */
async function expectElevationRequired(endpoint: string, args: Record<string, unknown>, as: PeerScope = peer): Promise<void> {
  expect(await call(endpoint, args, as), endpoint).toMatchObject({
    ok: false,
    error: { code: 'remote-access/denied', details: { action: endpoint, reason: `elevation-required: ${endpoint}` } },
  })
}

/**
 * Assert that remote access lets one call through to its service, which may still answer it with its own failure.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @param as - the Peer that calls.
 */
async function expectAdmitted(endpoint: string, args: Record<string, unknown>, as: PeerScope = peer): Promise<void> {
  const result = await call(endpoint, args, as)
  expect(result.ok ? undefined : result.error.code, endpoint).not.toBe('remote-access/denied')
}

/**
 * Assert that a one-action PIN grant for exactly this call lets it through to its service, as a device with no passkey gets by typing its PIN (A483).
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments, hashed as the policy hashes them.
 */
async function expectAdmittedWithGrant(endpoint: string, args: Record<string, unknown>): Promise<void> {
  const grants = studio.ctx.homeAuth.faceGrants()
  if (grants === undefined) throw new Error('the home keeps no grant store')
  grants.mint({ deviceId, listener: LISTENER }, [{ action: endpoint, hash: hashArgs(args) ?? '' }], 'pin')
  await expectAdmitted(endpoint, args)
}

/**
 * The value of a call that must succeed.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @returns the value.
 */
async function expectAllowed(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await call(endpoint, args)
  if (!result.ok) throw new Error(`${endpoint} was refused: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Ask for an elevation as the device's session and approve it with the code, as the person at the computer does.
 * @returns the elevation's id.
 */
function elevate(): string {
  const admitted = studio.ctx.homeAuth.admitToken(deviceToken, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device is not signed in')
  const state = studio.ctx.homeAuth.requestElevation(admitted.sessionId, admitted.session)
  if (state.kind !== 'pending') throw new Error('no request is waiting')
  return studio.ctx.homeAuth.approveElevation(state.requestId, state.code).id
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delorun-reach-access-'))
  studio = await bootStudio()
  const ctx = studio.ctx
  await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'home', 'secrets', 'home-auth') })
  await new Promise<void>((resolve) => { ctx.inject(['authenticator', 'workspaceRegistry'], () => { resolve() }) })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  const record = recordOf(2, ADDRESS)
  deviceId = record.id
  await new DeviceStore({ file: join(directory, 'home', 'secrets', 'home-auth', 'devices.json') }).add(record)
  const opened = await ctx.homeAuth.openSession({ deviceId, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
  deviceToken = opened.token
  const admitted = ctx.authenticator.admit({ headers: { cookie: `__Host-delorun-session=${opened.token}` }, method: 'GET', url: '/' }, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  peer = admitted.peer
  const folder = join(directory, 'workspace')
  await mkdir(folder)
  await writeFile(join(folder, 'notes.md'), 'inside')
  // A link the chat's agent could create, to the folder that holds the Delorun home.
  await symlink(directory, join(folder, 'linked'))
  workspaceId = (await ctx.workspaceRegistry.create(folder)).id
}, 120_000)

afterAll(async () => {
  await reachListener?.close()
  await studio.close()
  await rm(directory, { recursive: true, force: true })
})

describe('a reach device through the Gateway', () => {
  it('speaks for its own reach-device principal, never the owner', () => {
    // Pins the principal the authenticator gives a reach Peer: an owner Peer passes every access check.
    expect(peer.principal).toEqual(reachDevicePrincipal(deviceId, LISTENER))
  })

  it('reads the chats and the redacted settings, starts a chat, sends a message and stops the run', async () => {
    // Pins the policy's bindings: without the global, Workspace and Session bindings every call below is refused.
    expect(await expectAllowed('settings/describe', {})).toMatchObject({ namespaces: expect.any(Array) })
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const listed = await expectAllowed('session/list', { _request: {} }) as { readonly items: readonly { readonly sessionId: string }[] }
    // Pins the Session bindings: `session/list` filters its rows through them, so a Session the device just started is listed.
    expect(listed.items.map(item => item.sessionId)).toContain(created.sessionId)
    await expect(expectAllowed('session/prompt', {
      request: { requestId: 'reach-prompt-1', sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Hello from the phone' }] },
    })).resolves.toMatchObject({ accepted: true })
    await expect(expectAllowed('session/cancel', { request: { sessionId: created.sessionId } })).resolves.toMatchObject({ accepted: true })
  })

  it('receives the chat events it may follow and no event of a refused family', async () => {
    const ctx = studio.ctx
    const abort = new AbortController()
    const events = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal))[Symbol.asyncIterator]()
    try {
      await expect(events.next()).resolves.toMatchObject({ value: { type: 'ready' } })
      // The plugin manager declares this event's type; this package does not compile against it. The name comes from
      // the elevated table's key, since the vendor rescope gate rewrites a quoted text that starts with the Cordis
      // package name.
      const retract = 'event:cordis/dynamic-retract'.slice('event:'.length)
      expect(REACH_ELEVATED_ACTIONS).toHaveProperty([`event:${retract}`])
      ctx.emit(retract as never, { id: 'reach-dynamic' } as never)
      const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
      const seen: string[] = []
      for (;;) {
        const frame = (await events.next()).value as { readonly event: string; readonly args: readonly { readonly sessionId?: string }[] }
        seen.push(frame.event)
        if (frame.event === 'api-session/added' && frame.args[0]?.sessionId === created.sessionId) break
      }
      // Pins the event roles: a forwarded event reaches the device only when an allowed action names it.
      expect(seen).not.toContain(retract)
    } finally {
      abort.abort()
      await events.return?.()
    }
  })

  it('refuses an allowed action on a Session the policy cannot name, saying so', async () => {
    // Pins `explain`: without it the refusal reads `no-allow` and names no reason.
    expect(await call('session/cancel', { request: { sessionId: 'no-such-session' } })).toMatchObject({
      ok: false, error: { code: 'remote-access/denied', details: { action: 'session/cancel', reason: 'resource-unlisted: session/cancel' } },
    })
  })

  it('starts a chat in a known workspace with any preset, and needs an unlock for any other folder', async () => {
    const roster = await expectAllowed('agentPresets/list', {}) as { readonly presets: readonly { readonly id: string; readonly isDefault: boolean }[] }
    const chosen = roster.presets.find(preset => !preset.isDefault)
    if (chosen === undefined) throw new Error('the composition defines no preset besides the default')
    await expect(expectAllowed('session/create', { request: { workspaceId, agentPreset: chosen.id } })).resolves.toMatchObject({ agentPreset: chosen.id })
    await expect(expectAllowed('session/create', { request: { cwd: join(directory, 'workspace') } })).resolves.toMatchObject({ sessionId: expect.any(String) })
    // Pins the known-workspace check: a chat started in any other folder may write anywhere under it.
    for (const request of [{ cwd: '/' }, { cwd: directory }, {}]) {
      expect(await call('session/create', { request }), JSON.stringify(request)).toMatchObject({
        ok: false,
        error: { code: 'remote-access/denied', details: { action: 'session/create', reason: CREATE_OUTSIDE_WORKSPACES } },
      })
    }
  })

  it('chooses the preset a chat that has not started runs with', async () => {
    // Pins the allow list's preset entry: without it `agentPresets/select` is refused as `loopback-required`.
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const roster = await expectAllowed('agentPresets/list', {}) as { readonly presets: readonly { readonly id: string; readonly isDefault: boolean }[] }
    const chosen = roster.presets.find(preset => !preset.isDefault)
    if (chosen === undefined) throw new Error('the composition defines no preset besides the default')
    await expect(expectAllowed('agentPresets/select', { agentId: created.sessionId, agentPreset: chosen.id })).resolves.toBe(chosen.id)
  })

  it('needs an unlock for plugin installation, enabling and profile history undo', async () => {
    // Pins the unlock check: an owner principal, or a binding without the condition, would dispatch each call.
    await expectElevationRequired('pluginManager/installBundle', { spec: '@example/bundle' })
    await expectElevationRequired('pluginManager/setPluginEnabled', { id: 'delorun-permission-defaults', enabled: false })
    await expectElevationRequired('pluginManager/setBundleEnabled', { name: '@delorun/plugin-cost-meter-other', enabled: false })
    await expectElevationRequired('pluginManager/removeBundle', { name: '@delorun/plugin-cost-meter-other' })
    // A bundle that carries a computer-only row is refused before the unlock is asked, locked or not.
    for (const spec of [['pluginManager/setBundleEnabled', { name: '@delorun/bundle-local', enabled: false }], ['pluginManager/removeBundle', { name: '@delorun/bundle-local' }]] as const) {
      expect(await call(spec[0], spec[1]), spec[0]).toMatchObject({ ok: false, error: { details: { action: spec[0], reason: PROTECTED_ROW_REFUSAL } } })
    }
    await expectElevationRequired('pluginManager/undo', {})
    await expectElevationRequired('pluginManager/restore', { version: 'v0' })
  })

  it('reads the plugins and the profile history it can no longer change', async () => {
    // Pins the allow list's plugin reads: each was refused as `loopback-required` while it sat in the deny table.
    expect(await expectAllowed('pluginManager/listPlugins', {})).toEqual(expect.any(Array))
    expect(await expectAllowed('pluginManager/listBundles', {})).toEqual(expect.any(Array))
    expect(await expectAllowed('pluginManager/registries', {})).toEqual(expect.any(Object))
    await expect(expectAllowed('pluginManager/history', { limit: 5 })).resolves.toEqual(expect.any(Object))
    await expect(expectAllowed('pluginInventory/list', {})).resolves.toEqual(expect.any(Object))
    expect(await expectAllowed('pluginRegistryProbe/fastest', {})).toEqual(expect.anything())
  })

  it('reads the files of a chat\'s own workspace, and refuses a path outside it', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    // Pins the workspace-file allow entries: the studio's file preview and the composer's mention list need them. Each
    // call reaches its service, which answers for the workspace, instead of the policy refusing it as `loopback-required`.
    expect(await expectAllowed('workspaceFiles/list', { workspaceFileScopeId: created.sessionId, path: '.' })).toEqual(expect.any(Object))
    expect(await expectAllowed('workspaceFiles/stat', { workspaceFileScopeId: created.sessionId, path: 'notes.md' })).toMatchObject({ bytes: 6 })
    expect(await expectAllowed('workspaceFiles/read', { workspaceFileScopeId: created.sessionId, path: join(directory, 'workspace', 'notes.md'), range: {} }))
      .toEqual(expect.any(Object))
    expect(await expectAllowed('fileReferences/list', { agentId: created.sessionId, query: 'index' })).toEqual(expect.any(Array))
    // Pins the workspace-file condition: the service reads an absolute path wherever it points and follows a link in
    // any directory of the path, so the policy keeps a device to a real path inside the workspace and outside the Delorun
    // home; `linked/home/secrets/home-auth/devices.json` would read the home's device list.
    const outside = ['/etc/hostname', '../../etc/hostname', 'linked/home/secrets/home-auth/devices.json', join(directory, 'home', 'secrets', 'home-auth', 'devices.json'), 'missing.txt']
    for (const action of ['workspaceFiles/read', 'workspaceFiles/stat'] as const) {
      for (const path of outside) {
        expect(await call(action, { workspaceFileScopeId: created.sessionId, path, ...(action === 'workspaceFiles/read' ? { range: {} } : {}) }), path).toMatchObject({
          ok: false,
          error: { code: 'remote-access/denied', details: { action, reason: `loopback-required: ${action} with a path outside the chat's workspace` } },
        })
      }
    }
    expect(await call('workspaceFiles/list', { workspaceFileScopeId: created.sessionId, path: 'linked/home' }))
      .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    // Pins the wire names the condition reads: a byte read's base file under `options`, and a render's path.
    expect(await call('workspaceFiles/readBytes', { workspaceFileScopeId: created.sessionId, path: 'notes.md', options: { baseFile: 'linked/home/secrets/home-auth/devices.json' } }))
      .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(await call('workspaceFiles/readBytes', { workspaceFileScopeId: created.sessionId, path: 'linked/home/secrets/home-auth/devices.json', options: {} }))
      .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(await call('officeKit/render', { workspaceFileScopeId: created.sessionId, path: 'linked/home/secrets/home-auth/devices.json', priority: 'foreground' }))
      .toMatchObject({ ok: false, error: { code: 'remote-access/denied', details: { reason: 'loopback-required: officeKit/render with a path outside the chat\'s workspace' } } })
  })

  it('needs an unlock for a settings write in every settings namespace, and never opens the settings document', async () => {
    const described = await expectAllowed('settings/describe', {}) as { readonly namespaces: readonly { readonly ns: string }[] }
    const namespaces = described.namespaces.map(view => view.ns)
    expect(namespaces.length).toBeGreaterThan(0)
    for (const ns of namespaces) {
      // The everyday namespaces are written without an unlock; the pairing is pinned in home-auth's reach-access spec.
      if (Object.hasOwn(REACH_EVERYDAY_SETTINGS, ns)) {
        // Decided through remote access, not called, so the test writes no setting.
        expect(studio.ctx.remoteAccess.decide({ principal: reachDevicePrincipal(deviceId, LISTENER), action: 'settings/update', resources: [GLOBAL], args: { ns, patch: {} } }), ns).toEqual({ kind: 'allow' })
        continue
      }
      // Pins the unlock check for each namespace the composition describes.
      await expectElevationRequired('settings/mutate', { ns, ops: [{ op: 'unset', path: ['delorun'] }] })
      await expectElevationRequired('settings/update', { ns, patch: {} })
      // A permission-preset section names the current default, since leaving it out could loosen new chats' permission.
      await expectElevationRequired('settings/replace', { ns, section: ns === 'permission' ? { defaultPreset: 'workspace-write' } : {} })
    }
    await expectRefused('settings/openSettingsDocument', {})
  })

  it('admits the model key actions to an approved device', () => {
    // Decided through remote access, not called, so the test saves no key.
    const principal = reachDevicePrincipal(deviceId, LISTENER)
    for (const action of Object.keys(REACH_KEY_ACTIONS)) {
      expect(studio.ctx.remoteAccess.decide({ principal, action: action as `${string}/${string}`, resources: [GLOBAL] }), action).toEqual({ kind: 'allow' })
    }
  })

  it('never reaches account sign-in', async () => {
    await expectRefused('account/getState', {})
  })

  it('needs a grant for a terminal in every workspace, which an unlock never gives, whatever a stale terminal switch file, a full-access grant or dangerous mode says', async () => {
    const elsewhere = join(directory, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    const otherWorkspace = (await studio.ctx.workspaceRegistry.create(elsewhere)).id
    const granted = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const ungranted = await expectAllowed('session/create', { request: { workspaceId: otherWorkspace } }) as { readonly sessionId: SessionId }
    // The switch an earlier version kept in this file is obsolete: it is never read.
    const stale = join(directory, 'home', 'secrets', 'home-auth', 'reach-terminal.json')
    await writeFile(stale, JSON.stringify({ v: 1, withoutUnlock: true }), { mode: 0o600 })
    const dispose = studio.ctx.effect(() => studio.ctx.provide('reachFullAccessGrants', { dangerousMode: () => true, onDangerousModeEnd: () => () => {} }), 'test dangerous mode')
    let unlock: string | undefined
    try {
      for (const agentId of [granted.sessionId, ungranted.sessionId]) {
        await expectAdmitted('terminal/shells', { agentId })
        await expectElevationRequired('terminal/create', { agentId, request: { id: 'phone-1', cols: 80, rows: 24 } })
      }
      await expectAdmitted('terminal/list', { sessionId: granted.sessionId })
      unlock = elevate()
      await expectAdmitted('terminal/shells', { agentId: ungranted.sessionId })
      await expectAdmitted('terminal/list', { sessionId: granted.sessionId })
    } finally {
      if (unlock !== undefined) studio.ctx.homeAuth.revokeElevation(unlock)
      await dispose()
      await rm(stale, { force: true })
    }
  })

  it('needs an unlock for terminals and the directory picker, and reads the Changes view', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    await expectAdmitted('terminal/list', { sessionId: created.sessionId })
    // F29: a terminal's metadata is free, so a first terminal takes one Face ID, at create.
    await expectAdmitted('terminal/shells', { agentId: created.sessionId })
    await expectAdmitted('terminal/environment', { agentId: created.sessionId })
    await expectElevationRequired('terminal/create', { agentId: created.sessionId, request: { id: 'phone-2', cols: 80, rows: 24 } })
    await expectElevationRequired('directoryPicker/pick', {})
    await expectAdmitted('workspaceFiles/changes', { workspaceFileScopeId: created.sessionId, path: '.' })
  })

  it('renames, pins and unpins a chat', async () => {
    // Pins the allow list's chat organization entries: each is refused as `loopback-required` without them.
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    await expect(expectAllowed('session/rename', { request: { sessionId: created.sessionId, title: 'Renamed on the phone' } }))
      .resolves.toMatchObject({ title: 'Renamed on the phone' })
    await expect(expectAllowed('workspace/pinSession', { request: { sessionId: created.sessionId } }))
      .resolves.toMatchObject({ pinnedSessionIds: expect.arrayContaining([created.sessionId]) })
    const unpinned = await expectAllowed('workspace/unpinSession', { request: { sessionId: created.sessionId } }) as { readonly pinnedSessionIds: readonly string[] }
    expect(unpinned.pinnedSessionIds).not.toContain(created.sessionId)
  })

  it('needs an unlock for slash commands, dynamic plugin code and a new workspace', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    // Pins the elevated table: without an unlock each is refused naming the unlock it needs.
    await expectElevationRequired('commands/execute', { agentId: created.sessionId, line: '/plan', submittedAttachments: [] })
    await expectElevationRequired('dynamicCordisRunner/inventory', {})
    await expectElevationRequired('workspace/create', { request: { path: directory } })
  })

  it('archives, restores and reorders chats and changes scheduled follow-ups without an unlock', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const other = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    // Pins the allowed table's organization entries: each was refused as `elevation-required` while it was elevated.
    await expect(expectAllowed('workspace/archiveSession', { request: { sessionId: created.sessionId } })).resolves.toBeDefined()
    await expect(expectAllowed('workspace/unarchiveSession', { request: { sessionId: created.sessionId } })).resolves.toBeDefined()
    await expect(expectAllowed('workspace/insertSessionBefore', { request: { workspaceId, sessionId: created.sessionId, beforeSessionId: other.sessionId } })).resolves.toBeDefined()
    await expect(expectAllowed('schedule/deleteInactive', {})).resolves.toBeDefined()
  })
})

describe('a terminal with no grant', () => {
  // Removing the grant-only return for a terminal in the condition lets an unlocked phone open a shell outside the sandbox; while the home keeps no grant store, so no grant exists.
  it('is refused to an unlocked phone in dangerous mode too, and its unlock opens nothing: only a grant for the call does', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const dispose = studio.ctx.effect(() => studio.ctx.provide('reachFullAccessGrants', { dangerousMode: () => true, onDangerousModeEnd: () => () => {} }), 'test dangerous mode')
    const unlock = elevate()
    try {
      await expectAdmitted('terminal/shells', { agentId: created.sessionId })
      await expectElevationRequired('terminal/create', { agentId: created.sessionId, request: { id: 'careful-1', cols: 80, rows: 24 } })
      await expectAdmitted('terminal/list', { sessionId: created.sessionId })
      // A running unlock opens no other elevated action either (A483); a grant for the call does.
      await expectElevationRequired('directoryPicker/list', {})
      await expectAdmittedWithGrant('directoryPicker/list', {})
    } finally {
      studio.ctx.homeAuth.revokeElevation(unlock)
      await dispose()
    }
  })

  // Removing the route's removal leaves a way for a phone to answer: the Phone powers route is gone.
  it('has no Phone powers route to change, for a phone, unlocked or not', async () => {
    const unlock = elevate()
    try {
      // Nothing is registered at the address; the web server answers a POST there with 404 or 405, never with a level.
      expect([404, 405]).toContain((await postAsPhone('/auth/phone-powers', { level: 'full' }, deviceCookie())).status)
    } finally {
      studio.ctx.homeAuth.revokeElevation(unlock)
    }
  })
})

/**
 * @returns the test device's session cookie.
 */
function deviceCookie(): string {
  return `__Host-delorun-session=${deviceToken}`
}

let reachListener: ReachListener | undefined

/**
 * Send one JSON `POST` to the reach listener as a phone at the home's address does.
 * @param path - the target.
 * @param body - the JSON body.
 * @param cookie - the session cookie to send, if any.
 * @returns the status, the first cookie set and the parsed body.
 */
async function postAsPhone(path: string, body: unknown, cookie?: string): Promise<{ readonly status: number; readonly cookie: string | undefined; readonly json: Record<string, unknown> }> {
  reachListener ??= await studio.ctx.connection.openReachListener({ listener: LISTENER, bind: { kind: 'loopback' } })
  const port = reachListener.address?.port
  if (port === undefined) throw new Error('the reach listener has no address')
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path, setHost: false, agent: false,
      headers: { host: new URL(ADDRESS).host, origin: ADDRESS, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...cookie === undefined ? {} : { cookie } },
    }, (response) => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { received += chunk })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, cookie: response.headers['set-cookie']?.[0]?.split(';')[0], json: JSON.parse(received || '{}') as Record<string, unknown> })
      })
    })
    request.on('error', reject)
    request.end(text)
  })
}

/**
 * Approve a phone with a real device key now and sign it in for the first time on the reach listener, which starts
 * its approval grace.
 * @param label - the phone's label, unique to the test.
 * @returns the phone's Peer and the grace's id.
 */
async function gracePhone(label: string): Promise<{ readonly peer: PeerScope; readonly graceId: string }> {
  const ctx = studio.ctx
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const exported = keys.publicKey.export({ format: 'jwk' })
  const publicKey = { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(exported.x ?? ''), y: brandString<Base64Url>(exported.y ?? '') } as const
  const id = deviceIdOf(publicKey)
  await new DeviceStore({ file: join(directory, 'home', 'secrets', 'home-auth', 'devices.json') })
    .add({ v: DEVICE_APPROVAL_VERSION, id, publicKey, address: ADDRESS, label, platform: '', approvedAt: Date.now(), approvedBy: null, lastSignInAt: null })
  const challenged = await postAsPhone('/auth/device/challenge', { deviceId: id })
  const challenge = challenged.json.challenge
  if (typeof challenge !== 'string') throw new Error(`no sign-in challenge (${String(challenged.status)})`)
  const signature = sign('sha256', signInMessage(ADDRESS, challenge), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const signedIn = await postAsPhone('/auth/session', { deviceId: id, challenge, signature })
  if (signedIn.cookie === undefined) throw new Error(`the sign-in set no session cookie (${String(signedIn.status)})`)
  const grace = ctx.homeAuth.elevationOf(id, LISTENER)
  if (grace?.grace !== true) throw new Error('the first sign-in started no approval grace')
  const admitted = ctx.authenticator.admit({ headers: { cookie: signedIn.cookie }, method: 'GET', url: '/' }, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the phone was not admitted')
  return { peer: admitted.peer, graceId: grace.id }
}

describe('a reach device in its approval grace', () => {
  it('cannot create a terminal even at the Full level, and takes no other elevated action either', async () => {
    const graced = await gracePhone('Grace phone 1')
    try {
      const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
      // The grace opens no elevated action (A483): it needs a grant for the call, like the unlock.
      await expectElevationRequired('directoryPicker/list', {}, graced.peer)
      // Pins GRACE_REFUSED_ACTIONS in the unlock check: the grace stands for a computer-approved unlock everywhere else.
      await expectAdmitted('terminal/shells', { agentId: created.sessionId }, graced.peer)
      await expectElevationRequired('terminal/create', { agentId: created.sessionId, request: { id: 'grace-1', cols: 80, rows: 24 } }, graced.peer)
      await expectAdmitted('terminal/list', { sessionId: created.sessionId }, graced.peer)
    } finally {
      studio.ctx.homeAuth.revokeElevation(graced.graceId)
    }
  })

  it('cannot attach to an existing terminal to write to it, and neither can an unlocked device without a grant', async () => {
    const graced = await gracePhone('Grace phone 2')
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const unlock = elevate()
    /**
     * Open the attachment that carries a terminal's input as one Peer and report the refusal, if any.
     * @param as - the Peer that opens it.
     * @returns the refusal's error, or undefined when remote access let it through to the terminal controller.
     */
    const attach = async (as: PeerScope): Promise<unknown> => {
      const abort = new AbortController()
      try {
        await studio.ctx.typertGateway.wireStream.open('terminal/attach', { args: { agentId: created.sessionId, id: 'phone-terminal' } }, (async function* () {})(), as, abort.signal)
        return undefined
      } catch (error) {
        return error
      } finally {
        abort.abort()
      }
    }
    try {
      // A terminal takes a grant: an unlocked device is refused too, and while the home keeps no grant store, so no grant exists.
      expect(await attach(peer)).toMatchObject({ code: 'remote-access/denied', details: { action: 'terminal/attach', reason: 'elevation-required: terminal/attach' } })
      // Pins GRACE_REFUSED_ACTIONS for the input stream: under the grace the attachment never opens.
      expect(await attach(graced.peer)).toMatchObject({ code: 'remote-access/denied', details: { action: 'terminal/attach', reason: 'elevation-required: terminal/attach' } })
    } finally {
      studio.ctx.homeAuth.revokeElevation(unlock)
      studio.ctx.homeAuth.revokeElevation(graced.graceId)
    }
  })
})

describe('an elevated reach device through the Gateway', () => {
  it('takes an elevated action only with a grant for the call, whatever unlock runs, and never a never action', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    await expectElevationRequired('dynamicCordisRunner/inventory', {})
    const id = elevate()
    try {
      // Pins the unlock check through the Gateway: the same calls reach their services once the person approved it.
      await expectElevationRequired('dynamicCordisRunner/inventory', {})
      await expectAdmittedWithGrant('dynamicCordisRunner/inventory', {})
      await expectAdmitted('terminal/shells', { agentId: created.sessionId })
      await expectAdmittedWithGrant('directoryPicker/list', {})
      await expectAdmittedWithGrant('settings/update', { ns: 'delorun-reach-access-probe', patch: {} })
      // A chat outside the known workspaces is a face action too: the unlock refuses it and a grant for the call opens it.
      expect(await call('session/create', { request: { cwd: directory } })).toMatchObject({ ok: false, error: { code: 'remote-access/denied', details: { reason: CREATE_OUTSIDE_WORKSPACES } } })
      studio.ctx.homeAuth.faceGrants()?.mint({ deviceId, listener: LISTENER }, [{ action: 'session/create', hash: hashArgs({ request: { cwd: directory } }) ?? '' }], 'pin')
      await expect(expectAllowed('session/create', { request: { cwd: directory } })).resolves.toMatchObject({ sessionId: expect.any(String) })
      // Every elevated action but a terminal is allowed on the global resource, so none is left `resource-unlisted` under an unlock; a terminal takes a grant.
      const principal = reachDevicePrincipal(deviceId, LISTENER)
      for (const action of Object.keys(REACH_ELEVATED_ACTIONS).filter(name => !name.startsWith('terminal/') && !name.startsWith('event:'))) {
        expect(studio.ctx.remoteAccess.decide({ principal, action: action as `${string}/${string}`, resources: [GLOBAL] }), action).toEqual({ kind: 'allow' })
      }
      // Pins the never table under an unlock: credentials, the account and the computer's own screen.
      await expectRefused('account/getState', {})
      await expectRefused('settings/openSettingsDocument', {})
      // The unlock admits nothing for the same device's principal on another listener, where it has no Peer.
      expect(studio.ctx.remoteAccess.decide({ principal: reachDevicePrincipal(deviceId, 'reach-tailscale-funnel'), action: 'dynamicCordisRunner/inventory', resources: [GLOBAL] }))
        .toMatchObject({ kind: 'deny' })
    } finally {
      studio.ctx.homeAuth.revokeElevation(id)
    }
    // Pins the revoke at the computer: the device's next elevated call is refused again.
    await expectElevationRequired('dynamicCordisRunner/inventory', {})
  })

  it('never turns the external-agent consent off, and takes its run time limit and turning it on', async () => {
    /**
     * Assert that one settings write is refused as turning the consent off, which no unlock admits.
     * @param endpoint - the settings write.
     * @param args - its named wire arguments.
     */
    const expectConsentKept = async (endpoint: string, args: Record<string, unknown>): Promise<void> => {
      expect(await call(endpoint, args), endpoint).toMatchObject({
        ok: false,
        error: { code: 'remote-access/denied', details: { action: endpoint, reason: switchOffRefusal(EXTERNAL_AGENT_CONSENT_SWITCH.label) } },
      })
    }
    const { ns } = EXTERNAL_AGENT_CONSENT_SWITCH
    // This composition leaves the consent's plugin out, so the spec registers the switch the plugin registers when mounted.
    const unregister = studio.ctx.homeAuth.registerComputerOnlySwitch(EXTERNAL_AGENT_CONSENT_SWITCH)
    // Without an unlock the same writes are refused for the switch, not for the unlock: no unlock would admit them.
    await expectConsentKept('settings/update', { ns, patch: { enabled: false } })
    await expectConsentKept('settings/replace', { ns, section: { enabled: false, runTimeoutMinutes: 30 } })
    const id = elevate()
    try {
      // Pins the argument check through the Gateway: each settings write that could turn it off is refused under an unlock.
      await expectConsentKept('settings/mutate', { ns, ops: [{ op: 'set', path: ['enabled'], value: false }] })
      await expectConsentKept('settings/mutate', { ns, ops: [{ op: 'unset', path: ['enabled'] }] })
      await expectConsentKept('settings/update', { ns, patch: { enabled: false } })
      await expectConsentKept('settings/replace', { ns, section: { enabled: false, runTimeoutMinutes: 30 } })
      await expectConsentKept('settings/replace', { ns, section: { runTimeoutMinutes: 30 } })
      // The run time limit and turning the consent on reach the settings service.
      await expectAdmittedWithGrant('settings/mutate', { ns, ops: [{ op: 'set', path: ['runTimeoutMinutes'], value: 45 }] })
      await expectAdmittedWithGrant('settings/update', { ns, patch: { runTimeoutMinutes: 45 } })
      await expectAdmittedWithGrant('settings/mutate', { ns, ops: [{ op: 'set', path: ['enabled'], value: true }] })
      await expectAdmittedWithGrant('settings/update', { ns, patch: { enabled: true } })
      await expectAdmittedWithGrant('settings/replace', { ns, section: { enabled: true, runTimeoutMinutes: 45 } })
    } finally {
      studio.ctx.homeAuth.revokeElevation(id)
      unregister()
    }
  })

  it('never runs a slash command no list names, unlocked or not', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const line = '/config set enabled false'
    const expectUnlisted = async (): Promise<void> => {
      expect(await call('commands/execute', { agentId: created.sessionId, line, submittedAttachments: [] })).toMatchObject({
        ok: false,
        error: { code: 'remote-access/denied', details: { action: 'commands/execute', reason: UNLISTED_COMMAND_REFUSAL } },
      })
    }
    // Pins the command list through the Gateway, before the unlock check and under an unlock.
    await expectUnlisted()
    const id = elevate()
    try {
      await expectUnlisted()
      await expectAdmittedWithGrant('commands/execute', { agentId: created.sessionId, line: '/plan', submittedAttachments: [] })
    } finally {
      studio.ctx.homeAuth.revokeElevation(id)
    }
  })

  it('stops when the device locks it', async () => {
    elevate()
    studio.ctx.homeAuth.lockElevation(deviceId, LISTENER)
    // Pins the device's lock; the end of an unlock's minutes is pinned in the package's own specs, on their clock.
    await expectElevationRequired('dynamicCordisRunner/inventory', {})
  })

  it('lifts nothing for another device', async () => {
    const other = recordOf(3, ADDRESS)
    await new DeviceStore({ file: join(directory, 'home', 'secrets', 'home-auth', 'devices.json') }).add(other)
    const opened = await studio.ctx.homeAuth.openSession({ deviceId: other.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
    const admitted = studio.ctx.authenticator.admit({ headers: { cookie: `__Host-delorun-session=${opened.token}` }, method: 'GET', url: '/' }, LISTENER)
    if (admitted.kind !== 'admitted') throw new Error('the second device was not admitted')
    const id = elevate()
    try {
      // Pins the device binding: device A's unlock admits nothing device B asks for.
      await expectElevationRequired('dynamicCordisRunner/inventory', {}, admitted.peer)
      await expectAdmittedWithGrant('dynamicCordisRunner/inventory', {})
    } finally {
      studio.ctx.homeAuth.revokeElevation(id)
    }
  })
})

describe('a reach device and the exact Fetch routes', () => {
  /** The raw upload route, the one exact route a device reaches. */
  const UPLOAD = '/api/session/uploadFileBinary'
  /** A one-pixel PNG. */
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

  /**
   * Request one exact route as the device, through the shared `/api` channel the reach listener serves.
   * @param path - the route path and query.
   * @param init - the request's method, headers and body.
   * @returns the response.
   */
  function send(path: string, init: RequestInit = {}): Promise<Response> {
    return studio.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://127.0.0.1${path}`, init), peer)
  }

  /**
   * Upload one image to a chat as the device.
   * @param sessionId - the chat the query names.
   * @returns the response.
   */
  function uploadPixel(sessionId: string): Promise<Response> {
    return send(`${UPLOAD}?${new URLSearchParams({ sessionId, mediaType: 'image/png', name: 'pixel.png' }).toString()}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PIXEL,
    })
  }

  /**
   * The exact Fetch routes the composition registers, read from Connection's private route table as the Gateway
   * claims and the route registry above read theirs.
   * @returns each route path with its methods.
   */
  function exactRoutes(): Map<string, readonly string[]> {
    const connection: unknown = studio.ctx.connection
    const original: unknown = typeof connection === 'object' && connection !== null ? Reflect.get(connection, symbols.original) : undefined
    const table: unknown = typeof original === 'object' && original !== null ? Reflect.get(original, 'fetchRoutes') : undefined
    if (!(table instanceof Map)) throw new Error('reach access: Connection has no exact Fetch route table')
    const routes = new Map<string, readonly string[]>()
    for (const [path, route] of table as Map<string, { readonly methods: ReadonlySet<string> }>) routes.set(path, [...route.methods])
    return routes
  }

  it('reaches no exact route but the ones whose action the policy allows: no file read by path and no open on the computer', async () => {
    const routes = exactRoutes()
    // The routes this rule is about: a file read by path, and the two actions that open on the computer's own screen.
    expect([...routes.keys()]).toEqual(expect.arrayContaining(['/api/file', '/api/present.open', '/api/changes.open', UPLOAD]))
    for (const [path, methods] of routes) {
      // The upload route, the guide's read routes and key test, the recommended plugins' purposes, the chat states' list and set, the branding icon upload, the preview flags' list, the desktop metadata and the bundle detail image admit an approved device.
      if (path === UPLOAD || ADMITTED_ROUTES.has(path)) continue
      for (const method of methods) {
        // Pins Connection's owner rule for exact routes: a route that declares no `admitPeer` refuses every other Peer.
        // The two open routes declare none on purpose: they run an application on the computer's own screen, which
        // `REACH_DENIED_ACTIONS` refuses to a device, so admitting them would contradict the policy.
        const response = await send(`${path}?path=${encodeURIComponent(directory)}&sessionId=any&seq=0&index=0`, { method })
        expect(response.status, `${method} ${path}`).toBe(403)
      }
    }
  })

  it('refuses a file read by path, even inside a workspace it may name', async () => {
    await expect(send(`/api/file?path=${encodeURIComponent(join(directory, 'workspace'))}`)).resolves.toMatchObject({ status: 403 })
  })

  it('uploads an image to a chat it may name and reads it back by its id through that chat', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    // Pins the upload route's `admitPeer`: without it the route refuses every Peer but the owner.
    const response = await uploadPixel(created.sessionId)
    expect(response.status).toBe(200)
    const uploaded = await response.json() as { readonly ok: boolean; readonly value: { readonly image: { readonly attachmentId: string } } }
    expect(uploaded).toMatchObject({ ok: true, value: { image: { mediaType: 'image/png' } } })
    const read = await expectAllowed('session/attachment', { request: { sessionId: created.sessionId, attachment: uploaded.value.image } }) as { readonly data: string }
    expect(read.data).toBe(PIXEL.toString('base64'))
  })

  it('refuses an upload to a chat it cannot name, and an image read through one', async () => {
    // Pins the upload route's decision: it asks remote access about the Session its query names.
    await expect(uploadPixel('no-such-session')).resolves.toMatchObject({ status: 403 })
    const response = await send(UPLOAD, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PIXEL })
    expect(response.status).toBe(403)
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const uploaded = await (await uploadPixel(created.sessionId)).json() as { readonly value: { readonly image: unknown } }
    expect(await call('session/attachment', { request: { sessionId: 'no-such-session', attachment: uploaded.value.image } })).toMatchObject({
      ok: false, error: { code: 'remote-access/denied', details: { action: 'session/attachment', reason: 'resource-unlisted: session/attachment' } },
    })
  })
})

describe('the reach access tables', () => {
  /**
   * Every Remote method the booted composition registers: its strict definitions and the SRC methods of every active
   * Service with a Remote binding, which is the set the Gateway claims.
   * @returns the endpoints.
   */
  function registeredEndpoints(): Set<string> {
    const ctx = studio.ctx
    const endpoints = new Set(ctx.typert.local.list().map(descriptor => `${descriptor.namespace}/${descriptor.method}`))
    for (const [key, definition] of Object.entries(ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver: unknown = ctx.get(key)
      if (typeof receiver !== 'object' || receiver === null) continue
      const original: unknown = Reflect.get(receiver, symbols.original)
      const service = typeof original === 'object' && original !== null ? original : receiver
      const binding: unknown = Reflect.get(service, 'typertRemote')
      const namespace: unknown = typeof binding === 'object' && binding !== null ? Reflect.get(binding, 'namespace') : undefined
      if (typeof namespace !== 'string') continue
      for (const marker of remoteMethods(service)) endpoints.add(`${namespace}/${marker.exportName ?? marker.method}`)
    }
    return endpoints
  }

  const classified = (): Set<string> => new Set([...Object.keys(REACH_ALLOWED_ACTIONS), ...Object.keys(REACH_KEY_ACTIONS), ...Object.keys(REACH_ELEVATED_ACTIONS), ...Object.keys(REACH_DENIED_ACTIONS)])
  const forwarded = (): Set<string> => new Set(API_REMOTE_FORWARDED_EVENTS.map(entry => `event:${entry.event}`))

  it('classify every Remote method and forwarded event of the composition', () => {
    const endpoints = registeredEndpoints()
    // A new method or event is refused by default; this lists it so that its classification is a decision.
    expect([...endpoints, ...forwarded()].filter(action => !classified().has(action)).sort()).toEqual([])
    expect(endpoints.size).toBeGreaterThan(100)
  })

  it('name no Remote method or forwarded event that the composition lacks', () => {
    const known = new Set([...registeredEndpoints(), ...forwarded()])
    expect([...classified()].filter(action => !known.has(action)).sort()).toEqual([])
  })

  it('decide through remote access: allowed actions on the global resource, elevated ones needing an elevation, every other refused naming it', () => {
    const principal = reachDevicePrincipal(deviceId, LISTENER)
    const decisions = [...registeredEndpoints(), ...forwarded()].sort().map((action) => {
      const decision = studio.ctx.remoteAccess.decide({ principal, action: action as `${string}/${string}`, resources: [GLOBAL] })
      return { action, decision: decision.kind === 'allow' ? 'allow' : decision.reason }
    })
    // Pins the policy registration and its roles: without a policy every decision reads `no-allow`.
    expect(decisions).toEqual(decisions.map(({ action }) => ({
      action,
      decision: Object.hasOwn(REACH_ALLOWED_ACTIONS, action)
        ? 'allow'
        : Object.hasOwn(REACH_KEY_ACTIONS, action) ? 'allow' // PIN mode is off here
        // A question without arguments lists a method and never spends a grant; a call needs the grant, and an event never has one.
        : Object.hasOwn(REACH_ELEVATED_ACTIONS, action) ? (action.startsWith('event:') ? `elevation-required: ${action}` : 'allow') : `loopback-required: ${action}`,
    })))
  })
})
