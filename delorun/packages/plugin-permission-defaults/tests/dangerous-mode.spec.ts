/**
 * Specs of dangerous mode in `@delorun/plugin-permission-defaults`: full access is available to every chat only while the
 * row sets `fullAccessEverywhere` and the grant file is valid; each refusal is proved before the admission.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionDefaults } from '../src/index.ts'
import { apply, Config, FULL_ACCESS_PRESET, permissionStorePath, SAFER_PRESET } from '../src/index.ts'
import {
  DANGEROUS_WARNING_VERSION, dangerousGrantPath, deviceGrantsPath, readDangerousGrant, readDangerousGrantSync, removeDangerousGrant, serializePermissionStore,
  writeDangerousGrant,
} from '../src/store.ts'
import { workspaceKey } from '../src/workspace.ts'

/** Whether the next store write fails, to prove the read-time answer when a withdrawal cannot be written. */
const storeWrites = { failing: false }

vi.mock('../src/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/store.ts')>()
  return {
    ...original,
    writePermissionStore: (...args: Parameters<typeof original.writePermissionStore>) => {
      if (storeWrites.failing) return Promise.reject(new Error('the store is read-only'))
      return original.writePermissionStore(...args)
    },
  }
})

const roots: string[] = []
const originalHome = process.env['DELORUN_HOME']

afterEach(() => {
  storeWrites.failing = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELORUN_HOME']
  else process.env['DELORUN_HOME'] = originalHome
})

/** What the grant file holds before the composition starts. */
type Grant = 'none' | 'valid' | 'symlink' | 'lax-mode' | 'malformed' | 'other-warning'

/**
 * A composition with the real permission services and a recording approver.
 * @param options - the row's `fullAccessEverywhere` and the grant file to start with.
 * @returns the fixtures.
 */
async function mounted(options: { everywhere: boolean, grant: Grant, ownGrantInOther?: boolean }): Promise<{
  ctx: Context, harness: AgentLoopTestHarness, asks: ApprovalRequest[], home: string, workspace: string, other: string, defaults: PermissionDefaults
}> {
  const root = mkdtempSync(join(tmpdir(), 'delorun-dangerous-mode-'))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'work')
  const other = join(root, 'other-work')
  for (const directory of [home, workspace, other]) mkdirSync(directory, { recursive: true })
  process.env['DELORUN_HOME'] = home
  const path = dangerousGrantPath(home)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  if (options.ownGrantInOther === true) {
    writeFileSync(permissionStorePath(home), serializePermissionStore(new Map([[workspaceKey(other), { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 }]])), { mode: 0o600 })
  }
  if (options.grant === 'valid') await writeDangerousGrant(home)
  if (options.grant === 'symlink') {
    writeFileSync(join(root, 'real.json'), '{}', { mode: 0o600 })
    symlinkSync(join(root, 'real.json'), path)
  }
  if (options.grant === 'lax-mode') {
    await writeDangerousGrant(home)
    chmodSync(path, 0o644)
  }
  if (options.grant === 'malformed') writeFileSync(path, '{"v":1,"grantedAt":"yesterday","warning":1}', { mode: 0o600 })
  if (options.grant === 'other-warning') writeFileSync(path, JSON.stringify({ v: 1, grantedAt: new Date().toISOString(), warning: DANGEROUS_WARNING_VERSION + 1 }), { mode: 0o600 })
  const ctx = new Context()
  const asks: ApprovalRequest[] = []
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: SAFER_PRESET, workspaceRoot: workspace })
  ctx.provide('shell', { sandboxMode: 'workspace-write' as SandboxMode, resolve() { throw new Error('no bash') }, run() { throw new Error('no bash') }, start() { throw new Error('no bash') } } as never)
  ctx.provide('approval', { config: { policy: 'ask' }, request: async (request: ApprovalRequest) => { asks.push(request); return 'allowed-once' }, setPolicy() {} } as never)
  await ctx.plugin(PermissionPresetService, { defaultPreset: SAFER_PRESET })
  await ctx.plugin({ name: 'permission-defaults', apply: (pluginCtx: Context) => apply(pluginCtx, { ...Config(), enabled: true, fullAccessEverywhere: options.everywhere }) })
  return { ctx, harness, asks, home, workspace, other, defaults: ctx.get('permissionDefaults') as PermissionDefaults }
}

/**
 * The permission preset a session's log folds to.
 * @param ctx - the composition.
 * @param session - the session.
 * @returns the preset identity.
 */
function presetOf(ctx: Context, session: Session): string | null | undefined {
  return (ctx.sessionProjections.checkpoint(session).permissions?.val as { preset: string | null } | undefined)?.preset
}

describe('dangerous mode refuses without both halves', () => {
  it.each<[string, boolean, Grant]>([
    ['the row set and no grant file', true, 'none'],
    ['a grant file and the row off', false, 'valid'],
  ])('refuses full access with %s', async (_label, everywhere, grant) => {
    const { ctx, harness, defaults, workspace } = await mounted({ everywhere, grant })
    const agent = await harness.create(SessionId('chat-refused'), {}, { cwd: workspace })
    expect(defaults.everywhere().on).toBe(false)
    expect(defaults.granted(workspace)).toBe(false)
    expect(defaults.review(agent.session, FULL_ACCESS_PRESET)).toContain('needs one consent')
    expect(() => ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET)).toThrow()
  })

  it.each<[Grant, string]>([
    ['symlink', 'symbolic link'],
    ['lax-mode', '0644'],
    ['malformed', 'format this version reads'],
    ['other-warning', 'format this version reads'],
  ])('refuses a %s grant file and names the problem', async (grant, words) => {
    const { harness, defaults, workspace } = await mounted({ everywhere: true, grant })
    const agent = await harness.create(SessionId('chat-bad-grant'), {}, { cwd: workspace })
    expect(defaults.everywhere().on).toBe(false)
    expect(defaults.everywhere().problem).toContain(words)
    expect(defaults.storeProblem).toContain(words)
    expect(defaults.review(agent.session, FULL_ACCESS_PRESET)).toContain(words)
  })

  it('refuses a chat with no workspace folder without the grant', async () => {
    const { harness, defaults } = await mounted({ everywhere: true, grant: 'none' })
    const agent = await harness.create(SessionId('chat-no-folder'), {}, {})
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toThrow('no workspace folder')
  })
})

describe('the dangerous-mode fact the reach policy reads', () => {
  it.each<[string, boolean, Grant, boolean]>([
    ['the row set and no grant file', true, 'none', false],
    ['a grant file and the row off', false, 'valid', false],
    ['a symlinked grant file', true, 'symlink', false],
    ['a 0644 grant file', true, 'lax-mode', false],
    ['a malformed grant file', true, 'malformed', false],
    ['a grant file for another warning', true, 'other-warning', false],
    ['the row set and a valid grant file', true, 'valid', true],
  ])('reads %s as %s', async (_label, everywhere, grant, expected) => {
    const { ctx } = await mounted({ everywhere, grant })
    expect(ctx.get('reachFullAccessGrants')?.dangerousMode()).toBe(expected)
  })

  it('reads false again once the grant file is removed', async () => {
    const { ctx, defaults, home } = await mounted({ everywhere: true, grant: 'valid' })
    expect(ctx.get('reachFullAccessGrants')?.dangerousMode()).toBe(true)
    await removeDangerousGrant(home)
    await defaults.reload()
    expect(ctx.get('reachFullAccessGrants')?.dangerousMode()).toBe(false)
  })
})

describe('the mode-end notice the reach policy subscribes to', () => {
  it('calls a listener once the grant file is removed, and not after it is disposed', async () => {
    const { ctx, defaults, home } = await mounted({ everywhere: true, grant: 'valid' })
    const ended: number[] = []
    const off = ctx.get('reachFullAccessGrants')?.onDangerousModeEnd(() => { ended.push(1) })
    const disposed = ctx.get('reachFullAccessGrants')?.onDangerousModeEnd(() => { ended.push(2) })
    disposed?.()
    await removeDangerousGrant(home)
    await defaults.reload()
    // Pins the notice: without it the mode ends silently and a device's loosened settings wait for the next read.
    expect(ended).toEqual([1])
    off?.()
  })
})

describe('dangerous mode with the row and the grant file', () => {
  it('admits full access in any workspace, asks nothing and records the default without a grant time', async () => {
    const { ctx, harness, asks, defaults, workspace, home } = await mounted({ everywhere: true, grant: 'valid' })
    const agent = await harness.create(SessionId('chat-everywhere'), {}, { cwd: workspace })
    expect(defaults.everywhere()).toMatchObject({ on: true, grantedAt: expect.any(String) })
    expect(defaults.granted(workspace)).toBe(true)
    await defaults.select(agent, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(0)
    expect(presetOf(ctx, agent.session)).toBe(FULL_ACCESS_PRESET)
    const stored = JSON.parse(readFileSync(permissionStorePath(home), 'utf8')) as { workspaces: Record<string, { preset: string, fullAccessGrantedAt: number | null }> }
    expect(stored.workspaces[workspaceKey(workspace)]).toEqual({ preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: null })
    expect(defaults.workspaces().everywhere.on).toBe(true)
  })

  it('switches a chat with no workspace folder', async () => {
    const { ctx, harness, defaults } = await mounted({ everywhere: true, grant: 'valid' })
    const agent = await harness.create(SessionId('chat-no-folder-ok'), {}, {})
    await defaults.select(agent, FULL_ACCESS_PRESET)
    expect(presetOf(ctx, agent.session)).toBe(FULL_ACCESS_PRESET)
  })

  it('sets open full-access chats back when the grant file is removed, and keeps a workspace with its own grant', async () => {
    const { ctx, harness, defaults, workspace, other, home } = await mounted({ everywhere: true, grant: 'valid', ownGrantInOther: true })
    const plain = await harness.create(SessionId('chat-plain'), {}, { cwd: workspace })
    const granted = await harness.create(SessionId('chat-granted'), {}, { cwd: other })
    ctx.permissionPresets.set(plain.session, FULL_ACCESS_PRESET)
    ctx.permissionPresets.set(granted.session, FULL_ACCESS_PRESET)
    expect(await removeDangerousGrant(home)).toBe(true)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    await defaults.reload()
    expect(presetOf(ctx, plain.session)).toBe(SAFER_PRESET)
    expect(presetOf(ctx, granted.session)).toBe(FULL_ACCESS_PRESET)
    expect(defaults.everywhere().on).toBe(false)
  })

  it('withdraws a grant a device minted when the mode ends, sets its chats back, and keeps the computer\'s grants', async () => {
    const { ctx, harness, defaults, workspace, other, home } = await mounted({ everywhere: true, grant: 'valid', ownGrantInOther: true })
    const minted = await harness.create(SessionId('chat-minted'), {}, { cwd: workspace })
    const own = await harness.create(SessionId('chat-own'), {}, { cwd: other })
    const review = defaults.reviewChat('chat-minted')
    await defaults.setFullAccess({ workspace, reviewId: review.reviewId, on: true, confirmed: true, chat: 'chat-minted' }, 'device')
    expect(presetOf(ctx, minted.session)).toBe(FULL_ACCESS_PRESET)
    ctx.permissionPresets.set(own.session, FULL_ACCESS_PRESET)
    expect(defaults.grantedFolders()).toContain(workspaceKey(workspace))
    expect(existsSync(deviceGrantsPath(home))).toBe(true)
    await removeDangerousGrant(home)
    await defaults.reload()
    expect(defaults.grantedFolders()).toEqual([workspaceKey(other)])
    expect(presetOf(ctx, minted.session)).toBe(SAFER_PRESET)
    expect(presetOf(ctx, own.session)).toBe(FULL_ACCESS_PRESET)
    expect(existsSync(deviceGrantsPath(home))).toBe(false)
  })

  it('refuses full access to a device-made grant once the mode is off, although writing its withdrawal failed', async () => {
    const { harness, defaults, workspace, home } = await mounted({ everywhere: true, grant: 'valid' })
    const minter = await harness.create(SessionId('chat-failed-withdrawal'), {}, { cwd: workspace })
    const review = defaults.reviewChat('chat-failed-withdrawal')
    await defaults.setFullAccess({ workspace, reviewId: review.reviewId, on: true, confirmed: true }, 'device')
    expect(defaults.granted(workspace)).toBe(true)
    storeWrites.failing = true
    await removeDangerousGrant(home)
    await defaults.reload()
    // Pins the read-time rule: the store still holds the grant (its withdrawal was not written) and the record still names it, yet nothing counts.
    expect(readFileSync(permissionStorePath(home), 'utf8')).toContain('fullAccessGrantedAt')
    expect(existsSync(deviceGrantsPath(home))).toBe(true)
    expect(defaults.granted(workspace)).toBe(false)
    expect(defaults.grantedFolders()).toEqual([])
    expect(defaults.review(minter.session, FULL_ACCESS_PRESET)).toContain('needs one consent')
    expect(defaults.workspaces().workspaces.find(row => row.workspace === workspaceKey(workspace))?.grantedAt).toBeNull()
    storeWrites.failing = false
    await defaults.reload()
    expect(existsSync(deviceGrantsPath(home))).toBe(false)
    expect(defaults.granted(workspace)).toBe(false)
  })

  it('keeps a grant the computer made, and one it re-made over a device\'s, when the mode ends', async () => {
    const { harness, defaults, workspace, home } = await mounted({ everywhere: true, grant: 'valid' })
    await harness.create(SessionId('chat-computer'), {}, { cwd: workspace })
    const review = defaults.reviewChat('chat-computer')
    const device = await defaults.setFullAccess({ workspace, reviewId: review.reviewId, on: true, confirmed: true }, 'device')
    const off = await defaults.setFullAccess({ workspace, reviewId: device.access.reviewId, on: false, confirmed: true }, 'computer')
    await defaults.setFullAccess({ workspace, reviewId: off.access.reviewId, on: true, confirmed: true }, 'computer')
    expect(existsSync(deviceGrantsPath(home))).toBe(false)
    await removeDangerousGrant(home)
    await defaults.reload()
    expect(defaults.grantedFolders()).toEqual([workspaceKey(workspace)])
  })

  it('withdraws a device-made grant at start when the mode is off', async () => {
    const { defaults, workspace, home } = await mounted({ everywhere: true, grant: 'valid' })
    const store = permissionStorePath(home)
    writeFileSync(store, serializePermissionStore(new Map([[workspaceKey(workspace), { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 }]])), { mode: 0o600 })
    writeFileSync(deviceGrantsPath(home), JSON.stringify({ v: 1, workspaces: [workspaceKey(workspace)] }), { mode: 0o600 })
    await removeDangerousGrant(home)
    await defaults.reload()
    expect(defaults.grantedFolders()).toEqual([])
  })

  it('refuses again at the next decision once the grant file is gone', async () => {
    const { harness, defaults, workspace, home } = await mounted({ everywhere: true, grant: 'valid' })
    const agent = await harness.create(SessionId('chat-gone'), {}, { cwd: workspace })
    expect(defaults.review(agent.session, FULL_ACCESS_PRESET)).toBeUndefined()
    await removeDangerousGrant(home)
    expect(defaults.review(agent.session, FULL_ACCESS_PRESET)).toContain('needs one consent')
  })
})

/**
 * Run a device's `/permission danger-full-access` line: the command the reach policy lists for an unlocked device, whose
 * handler selects the preset through the same guard as every other switch.
 * @param ctx - the composition.
 * @param agent - the chat.
 * @returns the command's result, or the refusal the guard threw.
 */
async function runPermissionCommand(ctx: Context, agent: { session: Session }): Promise<{ kind: string, text?: string } | { threw: string }> {
  const registered: Array<{ name: string, handler: (call: { agent: unknown, rawInput: string }) => { kind: string, text?: string } }> = []
  ctx.provide('commands', { register(definition: (typeof registered)[number]) { registered.push(definition); return () => {} } } as never)
  // The command registers on the next turns of the event loop, once the injected child context activates.
  for (let turn = 0; turn < 50 && registered.length === 0; turn++) await new Promise(resolve => setTimeout(resolve, 5))
  const command = registered.find(definition => definition.name === 'permission')
  if (command === undefined) throw new Error('the /permission command was not registered')
  try { return command.handler({ agent, rawInput: 'danger-full-access' }) } catch (refusal) { return { threw: (refusal as Error).message } }
}

describe('a device\'s /permission danger-full-access', () => {
  it('is refused under Safer prompts in a workspace without a grant', async () => {
    const { ctx, harness, workspace } = await mounted({ everywhere: false, grant: 'none' })
    const agent = await harness.create(SessionId('chat-device-safer'), {}, { cwd: workspace })
    const result = await runPermissionCommand(ctx, agent)
    expect(result).toHaveProperty('threw')
    expect(presetOf(ctx, agent.session)).not.toBe(FULL_ACCESS_PRESET)
  })

  it('switches the chat with dangerous mode on', async () => {
    const { ctx, harness, workspace } = await mounted({ everywhere: true, grant: 'valid' })
    const agent = await harness.create(SessionId('chat-device-dangerous'), {}, { cwd: workspace })
    expect(await runPermissionCommand(ctx, agent)).toMatchObject({ kind: 'success' })
    expect(presetOf(ctx, agent.session)).toBe(FULL_ACCESS_PRESET)
  })
})

describe('the grant file store', () => {
  it('writes mode 0600 JSON with the version, time and warning, and reads it back sync and async', async () => {
    const { home } = await mounted({ everywhere: false, grant: 'none' })
    await writeDangerousGrant(home, new Date('2026-11-13T10:00:00.000Z'))
    const path = dangerousGrantPath(home)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, grantedAt: '2026-11-13T10:00:00.000Z', warning: DANGEROUS_WARNING_VERSION })
    expect(await readDangerousGrant(path)).toEqual({ kind: 'valid', grantedAt: '2026-11-13T10:00:00.000Z' })
    expect(readDangerousGrantSync(path)).toEqual({ kind: 'valid', grantedAt: '2026-11-13T10:00:00.000Z' })
  })

  it('reads an absent file as absent and removes nothing from a home without one', async () => {
    const { home } = await mounted({ everywhere: false, grant: 'none' })
    expect(await readDangerousGrant(dangerousGrantPath(home))).toEqual({ kind: 'absent' })
    expect(readDangerousGrantSync(dangerousGrantPath(home))).toEqual({ kind: 'absent' })
    expect(await removeDangerousGrant(home)).toBe(false)
  })
})
