/**
 * The protected-row suite of an unlocked device. The whole composition of Delo's CLI profiles boots in this process,
 * `@delo/bundle-local` included, so its `plugin-manager` row carries the profile's own `protectedPlugins` and each
 * consent row runs its own plugin. An approved device holds a live session on the Tailscale private reach listener and
 * an unlock the person approved at the computer, and calls the Gateway with its Peer.
 *
 * - `pluginManager/setPluginEnabled` on every row whose module `protectedPlugins` names is refused by the reach
 *   policy, `loopback-required`, unlocked as the device is, and each row stays enabled.
 * - Deselecting or removing the bundle that carries the protected rows, and undoing or restoring back to a profile
 *   version that turns the external-agent consent off, are refused by the plugin manager, `management-required`, and
 *   the profile's files stay as they were: only the manager compares a profile's rows before and after a change.
 * - `commands/execute` runs only a command `REACH_DEVICE_COMMANDS` lists, and the list names exactly the commands the
 *   composition registers for a chat.
 * - A settings write that would turn the external-agent consent off is refused through the switch the consent's own
 *   plugin registers (A299), while its run time limit is admitted; the terminal switch (A300) stays off through every
 *   writer the device reaches.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { StudioAddress } from '@delo/contract-admission'
import {
  DEFAULT_PERMISSION_REFUSAL, DeviceStore, HOME_AUTH_SWITCH, PROTECTED_ROW_REFUSAL, protectedEntryIdsOf, protectedPluginsIn, REACH_DEVICE_COMMANDS, REACH_SWITCH, switchOffRefusal, UNLISTED_COMMAND_REFUSAL,
} from '@delo/home-auth'
import { EXTERNAL_AGENT_CONSENT_SWITCH } from '@delo/plugin-delegation-consent'
import { DELEGATION_CONSENT_ROW } from '@delo/plugin-delegation-consent/wire'
import { claimOf, recordOf } from '../fixtures/devices.ts'
import { bootStudio, type Studio } from '../admission/studio.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
/** The bundle whose patch carries the protected rows. */
const LOCAL_BUNDLE = '@delo/bundle-local'

/** One Remote call's result as the shared `/api` channel returns it. */
type Result =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> } }

let studio: Studio
let peer: PeerScope
let workspaceId: WorkspaceId
let elevation: string
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
    body: JSON.stringify({ type: 'client-request', rpcId: `protected-${String(rpc)}`, method: endpoint, payload: { args } }),
  }), peer)
  const body = await response.json() as { readonly result: Result }
  return body.result
}

/**
 * Assert that one call is refused by remote access with one reason.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @param reason - the policy's reason.
 */
async function expectDenied(endpoint: string, args: Record<string, unknown>, reason: string): Promise<void> {
  expect(await call(endpoint, args), endpoint).toMatchObject({ ok: false, error: { code: 'remote-access/denied', details: { action: endpoint, reason } } })
}

/**
 * Assert that remote access lets one call through to its service, which may still answer it with its own failure.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @returns the call's result.
 */
async function expectAdmitted(endpoint: string, args: Record<string, unknown>): Promise<Result> {
  const result = await call(endpoint, args)
  expect(result.ok ? undefined : result.error.code, endpoint).not.toBe('remote-access/denied')
  return result
}

/**
 * The profile's own files, which a refused change leaves as they were.
 * @returns their text by name.
 */
async function profileFiles(): Promise<Record<string, string>> {
  const dir = join(studio.home, 'profiles', 'default')
  const entries = await Promise.all(['package.json', 'cordis.patch.yml'].map(async name => [name, await readFile(join(dir, name), 'utf8').catch(() => '')] as const))
  return Object.fromEntries(entries)
}

/**
 * The Loader's rows whose module the composition's `plugin-manager` row protects.
 * @returns each row's entry id, row id and module.
 */
function protectedRows(): { readonly entryId: string; readonly rowId: string; readonly name: string }[] {
  const entries = [...studio.ctx.loader.entries()]
  const manager = entries.find(entry => entry.options.name === '@deepseek-ai/dsh-plugin-manager')
  const modules = protectedPluginsIn(manager?.options.config)
  if (modules === undefined || modules.size === 0) throw new Error('the composition\'s plugin-manager row protects nothing')
  return entries.filter(entry => modules.has(entry.options.name)).map(entry => ({ entryId: entry.id, rowId: entry.options.id, name: entry.options.name }))
}

beforeAll(async () => {
  studio = await bootStudio([], { local: true })
  const ctx = studio.ctx
  await new Promise<void>((resolve) => { ctx.inject(['authenticator', 'homeAuth', 'pluginManager', 'workspaceRegistry', 'commands'], () => { resolve() }) })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  const record = recordOf(2, ADDRESS)
  await new DeviceStore({ file: join(studio.home, 'secrets', 'home-auth', 'devices.json') }).add(record)
  const opened = await ctx.homeAuth.openSession({ deviceId: record.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
  const admitted = ctx.authenticator.admit({ headers: { cookie: `__Host-delo-session=${opened.token}` }, method: 'GET', url: '/' }, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  peer = admitted.peer
  const signedIn = ctx.homeAuth.admitToken(opened.token, LISTENER)
  if (signedIn.kind !== 'admitted') throw new Error('the device is not signed in')
  const requested = ctx.homeAuth.requestElevation(signedIn.sessionId, signedIn.session)
  if (requested.kind !== 'pending') throw new Error('no unlock request is waiting')
  elevation = ctx.homeAuth.approveElevation(requested.requestId, requested.code).id
  const folder = join(studio.home, 'workspace')
  await mkdir(folder)
  workspaceId = (await ctx.workspaceRegistry.create(folder)).id
}, 120_000)

afterAll(async () => {
  studio.ctx.homeAuth.revokeElevation(elevation)
  await studio.close()
})

describe('an unlocked device and the protected plugin rows', () => {
  it('protects the consent, guard and sandbox rows of the shipped composition', () => {
    const names = protectedRows().map(row => row.name)
    expect(names).toEqual(expect.arrayContaining([
      '@delo/plugin-delegation-consent', '@delo/plugin-permission-defaults', '@delo/plugin-mcp-consent', '@delo/plugin-schedule-consent',
      '@delo/plugin-instruction-consent', '@delo/plugin-fetch-guard', '@delo/bundle-local/update-check', '@delo/home-auth',
    ]))
    // The policy reads the same rows from the Loader that the plugin-manager row names.
    expect(protectedEntryIdsOf(studio.ctx)).toEqual(new Set(protectedRows().map(row => row.entryId)))
  })

  it('finds among the settings namespaces only the protected rows whose live fields the reach policy decides', async () => {
    // The settings service writes only a row's live fields; a protected row that gains one fails here until the reach
    // policy decides its settings writes, as it does for the external-agent consent's switch.
    const described = await expectAdmitted('settings/describe', {}) as { readonly ok: true; readonly value: { readonly namespaces: readonly { readonly ns: string }[] } }
    const namespaces = described.value.namespaces.map(view => view.ns)
    expect(namespaces.length).toBeGreaterThan(0)
    const decided = studio.ctx.homeAuth.computerOnlySwitches().map(target => target.ns)
    // The home-auth and reach rows are refused as a whole, so a reach row without live fields (it is not described) is still decided.
    const found = namespaces.filter(ns => protectedRows().some(row => row.rowId === ns))
    expect(found.filter(ns => !decided.includes(ns))).toEqual([])
    expect([...decided].sort()).toEqual([DELEGATION_CONSENT_ROW, HOME_AUTH_SWITCH.ns, REACH_SWITCH.ns].sort())
    // Every computer-only switch names a protected row.
    expect(decided.filter(ns => !protectedRows().some(row => row.rowId === ns))).toEqual([])
  })

  it('never switches a protected row off or on, and each stays enabled', async () => {
    for (const row of protectedRows()) {
      // Pins the protected-row check: an unlock admits plugin management, which would reach the manager's own refusal.
      await expectDenied('pluginManager/setPluginEnabled', { id: row.entryId, enabled: false }, PROTECTED_ROW_REFUSAL)
      await expectDenied('pluginManager/setPluginEnabled', { id: row.entryId, enabled: true }, PROTECTED_ROW_REFUSAL)
    }
    const listed = await studio.ctx.pluginManager.listPlugins()
    for (const row of protectedRows()) expect(listed.find(plugin => plugin.entryId === row.entryId), row.name).toMatchObject({ enabled: true })
  })

  it('never deselects or removes the bundle that carries the protected rows', async () => {
    const before = await profileFiles()
    // Pins the manager's bundle refusal for a device's call: the policy admits it under an unlock.
    const deselected = await expectAdmitted('pluginManager/setBundleEnabled', { name: LOCAL_BUNDLE, enabled: false })
    expect(deselected).toMatchObject({ ok: true, value: { changed: false, error: { code: 'management-required', diagnostic: expect.stringContaining('@delo/plugin-delegation-consent') } } })
    // This composition links the bundle from the checkout, so the manager refuses its removal before it asks about
    // protection; the protection's removal refusal is pinned by the plugin manager's own `delo-protected-plugins.spec.ts`.
    const removed = await expectAdmitted('pluginManager/removeBundle', { name: LOCAL_BUNDLE })
    expect(removed).toMatchObject({ ok: true, value: { changed: false, error: { code: 'not-removable' } } })
    expect(await profileFiles()).toEqual(before)
  })

  describe.each(['restore', 'undo'] as const)('%s back to a profile version that turns the external-agent consent off', (action) => {
    it('is refused, and leaves the profile and the consent as they were', async () => {
      const dir = join(studio.home, 'profiles', 'default')
      const patch = join(dir, 'cordis.patch.yml')
      const original = await readFile(patch, 'utf8').catch(() => undefined)
      const manager = studio.ctx.pluginManager
      // A version the person saved at the computer outside plugin management, then put back.
      await manager.history(1)
      await writeFile(patch, JSON.stringify([{ id: DELEGATION_CONSENT_ROW, config: { enabled: false } }]))
      const saved = await manager.history(1)
      if (!saved.available) throw new Error(saved.reason)
      const version = saved.versions[0]?.id
      if (original === undefined) await rm(patch, { force: true })
      else await writeFile(patch, original)
      await manager.history(1)
      const before = await profileFiles()
      // Pins the manager's comparison of the composed rows before and after: the policy admits these under an unlock.
      const result = await expectAdmitted(`pluginManager/${action}`, action === 'restore' ? { version } : {})
      expect(result).toMatchObject({ ok: true, value: { changed: false, error: { code: 'management-required' } } })
      expect(JSON.stringify(result)).toContain('@delo/plugin-delegation-consent')
      expect(await profileFiles()).toEqual(before)
      expect(studio.ctx.get('delegationConsent')).toBeDefined()
    })
  })
})

describe('an unlocked device and slash commands', () => {
  it('runs a listed command and never another', async () => {
    const created = await expectAdmitted('session/create', { request: { workspaceId } }) as { readonly ok: true; readonly value: { readonly sessionId: SessionId } }
    const agentId = created.value.sessionId
    // Pins the command list: an unlock admits `commands/execute`, which would run whatever a plugin registered.
    for (const line of ['/config set enabled false', '/plugins', '/settings', 'plan']) {
      await expectDenied('commands/execute', { agentId, line, submittedAttachments: [] }, UNLISTED_COMMAND_REFUSAL)
    }
    await expectAdmitted('commands/execute', { agentId, line: '/plan', submittedAttachments: [] })
  })

  it('lists exactly the commands the composition registers for a chat', async () => {
    const created = await expectAdmitted('session/create', { request: { workspaceId } }) as { readonly ok: true; readonly value: { readonly sessionId: SessionId } }
    const listed = await expectAdmitted('commands/list', { agentId: created.value.sessionId }) as { readonly ok: true; readonly value: readonly { readonly name: string }[] }
    // A command a later merge registers fails here until it is classified, as does a stale entry.
    expect(listed.value.map(command => command.name).sort()).toEqual(Object.keys(REACH_DEVICE_COMMANDS).sort())
  })
})

describe('an unlocked device and the computer-only switches', () => {
  it('never turns the external-agent consent off, through the switch the consent\'s own plugin registers', async () => {
    const ns = DELEGATION_CONSENT_ROW
    const off = switchOffRefusal(EXTERNAL_AGENT_CONSENT_SWITCH.label)
    // Pins the plugin's registration and the policy's read of it (A299).
    expect(off).toBe('loopback-required: turning the external-agent consent off')
    await expectDenied('settings/mutate', { ns, ops: [{ op: 'set', path: ['enabled'], value: false }] }, off)
    await expectDenied('settings/update', { ns, patch: { enabled: false } }, off)
    await expectDenied('settings/replace', { ns, section: { runTimeoutMinutes: 30 } }, off)
    await expectAdmitted('settings/update', { ns, patch: { runTimeoutMinutes: 45 } })
    expect(studio.ctx.get('delegationConsent')).toBeDefined()
  })

  it('never loosens the permission new chats start in, and may tighten it', async () => {
    // The composition's new chats start in workspace-write, with approval asked.
    expect(studio.ctx.get('permissionPresets')?.defaultPreset).toBe('workspace-write')
    await expectDenied('settings/update', { ns: 'permission', patch: { defaultPreset: 'danger-full-access' } }, DEFAULT_PERMISSION_REFUSAL)
    await expectDenied('settings/mutate', { ns: 'permission', ops: [{ op: 'unset', path: ['defaultPreset'] }] }, DEFAULT_PERMISSION_REFUSAL)
    await expectAdmitted('settings/update', { ns: 'permission', patch: { defaultPreset: 'read-only' } })
  })

  it('finds only execution limits among the bash sandbox\'s live fields, none of which widens the sandbox', async () => {
    // The sandbox mode and its writable roots belong to the sandbox-policy row, which has no live field; a live field
    // the bash sandbox gains fails here until the reach policy decides whether a device may change it.
    const described = await expectAdmitted('settings/describe', {}) as { readonly ok: true; readonly value: { readonly namespaces: readonly { readonly ns: string; readonly schema: { readonly uid: number; readonly refs: Record<string, { readonly dict?: Record<string, number> }> } }[] } }
    const views = described.value.namespaces
    expect(views.some(view => view.ns === 'sandbox-policy')).toBe(false)
    const schema = views.find(view => view.ns === 'bash-sandbox')?.schema
    expect(Object.keys(schema?.refs[String(schema.uid)]?.dict ?? {}).sort()).toEqual(['cwd', 'graceMs', 'maxOutputBytes', 'maxSpillBytes', 'maxTimeoutMs', 'timeoutMs'])
  })
})
