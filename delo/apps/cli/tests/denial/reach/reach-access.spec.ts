/**
 * The reach access denial suite. Delo's web composition boots in this process with `@delo/home-auth`; a device the
 * home approved opens a session on a reach listener, the authenticator admits it as a Peer, and every call it makes
 * goes through upstream's Gateway and remote access exactly as a request on the reach listener does, through the
 * shared `/api` channel with the Peer the authenticator returned.
 *
 * - Each family C14 reserves for the home's own computer is refused, naming the action: plugin installation and
 *   enabling, profile history undo and restore, a settings write in every settings namespace, credentials, terminals,
 *   the Changes surface, slash commands, schedule changes, dynamic plugin code, workspace management, archiving and
 *   reordering chats, account and the directory picker.
 * - The reads a device needs to work the way it works at the computer succeed: the installed plugins and their profile
 *   history, the files of a chat's own workspace, the office previews of those files, and the composer's file names.
 *   A workspace-file read of an absolute path, or one that walks out of the workspace, is refused.
 * - Reading the chat list and the redacted settings, starting a chat, sending a message, stopping the run, choosing the
 *   preset a chat runs with, and renaming, pinning and unpinning a chat succeed, and the device's event stream carries
 *   the chat events and no plugin management event.
 * - Every Remote method the composition registers and every event it forwards is on the allow list or the deny table,
 *   and every entry of either names one that exists.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import { remoteMethods, type PeerScope, type RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { StudioAddress } from '@delo/contract-admission'
import { DeviceStore, HomeAuthService, REACH_ALLOWED_ACTIONS, REACH_DENIED_ACTIONS, reachDevicePrincipal } from '@delo/home-auth'
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
let rpc = 0

/**
 * Call one Remote method as the device, through the shared `/api` channel the reach listener serves.
 * @param endpoint - the `<namespace>/<method>` endpoint.
 * @param args - its named wire arguments.
 * @returns the call's result.
 */
async function call(endpoint: string, args: Record<string, unknown>): Promise<Result> {
  rpc += 1
  const response = await studio.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://127.0.0.1/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `reach-${String(rpc)}`, method: endpoint, payload: { args } }),
  }), peer)
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delo-reach-access-'))
  studio = await bootStudio()
  const ctx = studio.ctx
  await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'home-auth') })
  await new Promise<void>((resolve) => { ctx.inject(['authenticator', 'workspaceRegistry'], () => { resolve() }) })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  const record = recordOf(2, ADDRESS)
  deviceId = record.id
  await new DeviceStore({ file: join(directory, 'home-auth', 'devices.json') }).add(record)
  const opened = await ctx.homeAuth.openSession({ deviceId, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
  const admitted = ctx.authenticator.admit({ headers: { cookie: `__Host-delo-session=${opened.token}` }, method: 'GET', url: '/' }, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  peer = admitted.peer
  const folder = join(directory, 'workspace')
  await mkdir(folder)
  workspaceId = (await ctx.workspaceRegistry.create(folder)).id
}, 120_000)

afterAll(async () => {
  await studio.close()
  await rm(directory, { recursive: true, force: true })
})

describe('a reach device through the Gateway', () => {
  it('speaks for its own reach-device principal, never the owner', () => {
    // Pins the principal the authenticator gives a reach Peer: an owner Peer passes every access check.
    expect(peer.principal).toEqual(reachDevicePrincipal(deviceId))
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
      // The plugin manager declares this event's type; this package does not compile against it.
      ctx.emit('plugin-manager/install-state' as never, { requestId: 'reach-install' } as never)
      const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
      const seen: string[] = []
      for (;;) {
        const frame = (await events.next()).value as { readonly event: string; readonly args: readonly { readonly sessionId?: string }[] }
        seen.push(frame.event)
        if (frame.event === 'api-session/added' && frame.args[0]?.sessionId === created.sessionId) break
      }
      // Pins the event roles: a forwarded event reaches the device only when an allowed action names it.
      expect(seen).not.toContain('plugin-manager/install-state')
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

  it('refuses a chat in a folder of its choosing or with a preset', async () => {
    // Pins the create condition: a chat started in any folder may write anywhere under it, and a preset decides its tools.
    for (const request of [{ cwd: '/' }, { workspaceId, agentPreset: 'any' }]) {
      expect(await call('session/create', { request }), JSON.stringify(request)).toMatchObject({
        ok: false,
        error: { code: 'remote-access/denied', details: { action: 'session/create', reason: 'loopback-required: session/create with a folder or a preset' } },
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

  it('refuses plugin installation, enabling and profile history undo', async () => {
    // Pins the deny-by-default roles: an owner principal, or a role listing these, would dispatch each call.
    await expectRefused('pluginManager/installBundle', { spec: '@example/bundle' })
    await expectRefused('pluginManager/setPluginEnabled', { id: 'delo-permission-defaults', enabled: false })
    await expectRefused('pluginManager/setBundleEnabled', { name: '@delo/bundle-local', enabled: false })
    await expectRefused('pluginManager/removeBundle', { name: '@delo/bundle-local' })
    await expectRefused('pluginManager/undo', {})
    await expectRefused('pluginManager/restore', { version: 'v0' })
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
    expect(await call('workspaceFiles/stat', { workspaceFileScopeId: created.sessionId, path: 'missing.txt' }))
      .toMatchObject({ ok: false, error: { code: 'workspace-file/not-found' } })
    expect(await expectAllowed('fileReferences/list', { agentId: created.sessionId, query: 'index' })).toEqual(expect.any(Array))
    // Pins the workspace-file condition: the service reads an absolute path wherever it points, so the policy keeps a
    // device to a relative one inside the workspace.
    for (const path of ['/etc/hostname', '../../etc/hostname']) {
      expect(await call('workspaceFiles/read', { workspaceFileScopeId: created.sessionId, path, range: {} }), path).toMatchObject({
        ok: false,
        error: { code: 'remote-access/denied', details: { action: 'workspaceFiles/read', reason: 'loopback-required: workspaceFiles/read with a path outside the chat\'s workspace' } },
      })
    }
  })

  it('refuses a settings write in every settings namespace, and the settings document', async () => {
    const described = await expectAllowed('settings/describe', {}) as { readonly namespaces: readonly { readonly ns: string }[] }
    const namespaces = described.namespaces.map(view => view.ns)
    expect(namespaces.length).toBeGreaterThan(0)
    for (const ns of namespaces) {
      // Pins the deny-by-default roles for each namespace the composition describes.
      await expectRefused('settings/mutate', { ns, ops: [{ op: 'unset', path: ['delo'] }] })
      await expectRefused('settings/update', { ns, patch: {} })
      await expectRefused('settings/replace', { ns, section: {} })
    }
    await expectRefused('settings/openSettingsDocument', {})
    await expectRefused('session/initializeDefaultModel', {})
  })

  it('refuses credentials, account sign-in and model discovery with the stored credentials', async () => {
    await expectRefused('credentials/describe', { refs: [] })
    await expectRefused('credentials/set', { ref: 'deepseek', value: 'not-a-key' })
    await expectRefused('credentials/unset', { ref: 'deepseek' })
    await expectRefused('account/getState', {})
  })

  it('refuses terminals, the Changes surface, the directory picker and opening applications on the computer', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    await expectRefused('terminal/list', { sessionId: created.sessionId })
    await expectRefused('terminal/shells', { agentId: created.sessionId })
    await expectRefused('workspaceFiles/changes', { workspaceFileScopeId: created.sessionId, path: '.' })
    await expectRefused('directoryPicker/pick', {})
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

  it('refuses slash commands, schedule changes, dynamic plugin code, workspace management, archiving and reordering', async () => {
    const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    const other = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
    await expectRefused('commands/execute', { agentId: created.sessionId, line: '/plugins', submittedAttachments: [] })
    await expectRefused('schedule/deleteInactive', {})
    await expectRefused('dynamicCordisRunner/inventory', {})
    await expectRefused('workspace/create', { request: { path: directory } })
    await expectRefused('workspace/initializeDefault', {})
    await expectRefused('workspace/archiveSession', { request: { sessionId: created.sessionId } })
    await expectRefused('workspace/unarchiveSession', { request: { sessionId: created.sessionId } })
    await expectRefused('workspace/insertSessionBefore', { request: { workspaceId, sessionId: created.sessionId, beforeSessionId: other.sessionId } })
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

  it('reaches no exact route but the raw upload route: no file read by path, deliverable action or change', async () => {
    const routes = exactRoutes()
    // The routes this rule is about: a file read by path, deliverable actions and change reads.
    expect([...routes.keys()]).toEqual(expect.arrayContaining(['/api/file', '/api/present.open', '/api/changes.summary', '/api/changes.diff', UPLOAD]))
    for (const [path, methods] of routes) {
      if (path === UPLOAD) continue
      for (const method of methods) {
        // Pins Connection's owner rule for exact routes: a route that declares no `admitPeer` refuses every other Peer.
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

  const classified = (): Set<string> => new Set([...Object.keys(REACH_ALLOWED_ACTIONS), ...Object.keys(REACH_DENIED_ACTIONS)])
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

  it('decide through remote access: allowed actions on the global resource, every other refused naming it', () => {
    const principal = reachDevicePrincipal(deviceId)
    const decisions = [...registeredEndpoints(), ...forwarded()].sort().map((action) => {
      const decision = studio.ctx.remoteAccess.decide({ principal, action: action as `${string}/${string}`, resources: [GLOBAL] })
      return { action, decision: decision.kind === 'allow' ? 'allow' : decision.reason }
    })
    // Pins the policy registration and its roles: without a policy every decision reads `no-allow`.
    expect(decisions).toEqual(decisions.map(({ action }) => ({
      action, decision: Object.hasOwn(REACH_ALLOWED_ACTIONS, action) ? 'allow' : `loopback-required: ${action}`,
    })))
  })
})
