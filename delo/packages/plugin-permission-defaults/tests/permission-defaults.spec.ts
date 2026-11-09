/**
 * Specs of `@delo/plugin-permission-defaults`: the store's format and its file
 * handling, the workspace key, and the behaviour the C16 changed default
 * `permission_defaults` promises — a new workspace starts on the safer preset,
 * full access asks once per workspace, a refused consent records nothing, a
 * refused `sandbox/mode` change leaves the session in the sandbox, and the
 * switch off mounts nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  Config,
  FullAccessConsentRefusedError,
  fullAccessNote,
  FULL_ACCESS_PRESET,
  permissionStorePath,
  PermissionDefaults,
  SAFER_PRESET,
} from '../src/index.ts'
import { workspaceKey } from '../src/workspace.ts'
import { serializePermissionStore } from '../src/store.ts'

/** One mounted composition's fixtures, owned by the test that built it. */
interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly asks: ApprovalRequest[]
  readonly home: string
  readonly workspace: string
  readonly other: string
}

const roots: string[] = []
const originalHome = process.env['DELO_HOME']

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELO_HOME']
  else process.env['DELO_HOME'] = originalHome
})

/**
 * A composition with the permission-preset owner, the per-workspace defaults
 * and a recording approval answerer: the real services of a chat, the observed
 * asks, and two workspace folders.
 * @param options - the deployment default preset, the answerer's verdict, and whether the switch is on.
 * @returns the mounted fixtures.
 */
async function mounted(options: {
  defaultPreset?: string
  answer?: () => ApprovalOutcome
  enabled?: boolean
  store?: (paths: { workspace: string, other: string }) => string
} = {}): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'delo-permission-defaults-'))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'work')
  const other = join(root, 'other-work')
  for (const directory of [home, workspace, other]) mkdirSync(directory, { recursive: true })
  if (options.store !== undefined) {
    const path = permissionStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, options.store({ workspace, other }), { mode: 0o600 })
  }
  process.env['DELO_HOME'] = home
  const ctx = new Context()
  const asks: ApprovalRequest[] = []
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  // The policy home a confined command resolves its mode through: the mode
  // switch the guard refuses must leave this resolution unchanged.
  await ctx.plugin(SandboxPolicyService, { mode: SAFER_PRESET, workspaceRoot: workspace })
  ctx.provide('shell', {
    sandboxMode: 'workspace-write' as SandboxMode,
    resolve() { throw new Error('permission-defaults specs do not execute bash') },
    run() { throw new Error('permission-defaults specs do not execute bash') },
    start() { throw new Error('permission-defaults specs do not execute bash') },
  } as never)
  ctx.provide('approval', {
    config: { policy: 'ask' },
    request: async (request: ApprovalRequest) => {
      asks.push(request)
      return options.answer === undefined ? 'allowed-once' : options.answer()
    },
    setPolicy() {},
  } as never)
  await ctx.plugin(PermissionPresetService, { defaultPreset: options.defaultPreset ?? SAFER_PRESET })
  await ctx.plugin({ name: 'permission-defaults', apply: (pluginCtx: Context) => apply(pluginCtx, { enabled: options.enabled ?? true }) })
  return { ctx, harness, asks, home, workspace, other }
}

/**
 * The permission knobs a session's log folds to.
 * @param ctx - the composition.
 * @param session - the session to fold.
 * @returns the preset identity, the sandbox mode and the approval policy.
 */
function knobs(ctx: Context, session: Session): { preset: string | null, sandbox: string | null, approval: string | null } {
  return ctx.sessionProjections.checkpoint(session).permissions?.val as { preset: string | null, sandbox: string | null, approval: string | null }
}

describe('the permission_defaults switch', () => {
  it('defaults to off, the parity value', () => {
    expect(Config()).toEqual({ enabled: false })
  })

  it('mounts nothing when off, so the deployment default reaches a new chat exactly as upstream seeds it', async () => {
    const { ctx, harness, workspace } = await mounted({ enabled: false, defaultPreset: FULL_ACCESS_PRESET })
    expect(ctx.get('permissionDefaults')).toBeUndefined()
    expect(ctx.get('sandboxModeGuard')).toBeUndefined()
    const agent = await harness.create(SessionId('chat-off'), {}, { cwd: workspace })
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: FULL_ACCESS_PRESET, sandbox: FULL_ACCESS_PRESET, approval: 'never' })
  })

  it('refuses to mount over another provider of the one guard slot', async () => {
    const ctx = new Context()
    try {
      const dispose = ctx.provide('sandboxModeGuard', () => undefined)
      await expect(apply(ctx, { enabled: true })).rejects.toThrow('another plugin already provides the sandbox-mode guard')
      dispose()
    } finally {
      void ctx.fiber.dispose()
    }
  })
})

describe('a new workspace', () => {
  it('starts on the safer preset, not on the deployment default', async () => {
    const { ctx, harness, workspace } = await mounted({ defaultPreset: FULL_ACCESS_PRESET })
    const agent = await harness.create(SessionId('chat-new'), {}, { cwd: workspace })
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: SAFER_PRESET, sandbox: SAFER_PRESET, approval: 'ask' })
    expect(ctx.get('permissionDefaults')?.defaultPreset(workspace)).toBe(SAFER_PRESET)
  })

  it('starts on the preset the person chose for it once that workspace has one', async () => {
    const { ctx, harness, workspace } = await mounted()
    const first = await harness.create(SessionId('chat-first'), {}, { cwd: workspace })
    await ctx.get('permissionDefaults')?.select(first, FULL_ACCESS_PRESET)
    const second = await harness.create(SessionId('chat-second'), {}, { cwd: workspace })
    expect(knobs(ctx, second.session)).toMatchObject({ preset: FULL_ACCESS_PRESET, sandbox: FULL_ACCESS_PRESET })
  })

  it('keeps the safer preset in a workspace nobody consented to, whatever another workspace chose', async () => {
    const { ctx, harness, workspace, other } = await mounted()
    const first = await harness.create(SessionId('chat-a'), {}, { cwd: workspace })
    await ctx.get('permissionDefaults')?.select(first, FULL_ACCESS_PRESET)
    const elsewhere = await harness.create(SessionId('chat-b'), {}, { cwd: other })
    expect(knobs(ctx, elsewhere.session)).toMatchObject({ preset: SAFER_PRESET, sandbox: SAFER_PRESET })
  })
})

describe('the full-access consent', () => {
  it('asks once per workspace, names the preset and the folder, and records the grant', async () => {
    const { ctx, harness, asks, workspace, home } = await mounted()
    const agent = await harness.create(SessionId('chat-ask'), {}, { cwd: workspace })
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    expect(defaults.granted(workspace)).toBe(false)
    await defaults.select(agent, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(1)
    expect(asks[0]?.toolName).toBe('permission')
    expect(asks[0]?.reason).toBe(fullAccessNote(workspaceKey(workspace)))
    expect(defaults.granted(workspace)).toBe(true)
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: FULL_ACCESS_PRESET, sandbox: FULL_ACCESS_PRESET })
    // The grant is durable, so the person is not asked again in this workspace.
    const stored = JSON.parse(readFileSync(permissionStorePath(home), 'utf8')) as { workspaces: Record<string, { preset: string, fullAccessGrantedAt: number | null }> }
    expect(stored.workspaces[workspaceKey(workspace)]).toMatchObject({ preset: FULL_ACCESS_PRESET })
    expect(stored.workspaces[workspaceKey(workspace)]?.fullAccessGrantedAt).toEqual(expect.any(Number))
    const again = await harness.create(SessionId('chat-ask-again'), {}, { cwd: workspace })
    await defaults.select(again, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(1)
  })

  it('asks again in another workspace, because a consent covers one folder', async () => {
    const { ctx, harness, asks, workspace, other } = await mounted()
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    const first = await harness.create(SessionId('chat-w'), {}, { cwd: workspace })
    await defaults.select(first, FULL_ACCESS_PRESET)
    const second = await harness.create(SessionId('chat-o'), {}, { cwd: other })
    await defaults.select(second, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(2)
    expect(asks[1]?.reason).toBe(fullAccessNote(workspaceKey(other)))
  })

  it('records nothing when the person refuses, and keeps the safer preset', async () => {
    const { ctx, harness, asks, workspace, home } = await mounted({ answer: () => 'rejected' })
    const agent = await harness.create(SessionId('chat-refused'), {}, { cwd: workspace })
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toThrow(FullAccessConsentRefusedError)
    expect(defaults.granted(workspace)).toBe(false)
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: SAFER_PRESET, sandbox: SAFER_PRESET })
    expect(() => readFileSync(permissionStorePath(home))).toThrow()
    // Nothing was granted, so the next attempt asks again.
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toThrow(FullAccessConsentRefusedError)
    expect(asks).toHaveLength(2)
  })

  it('never asks for the safer preset, and withdraws the grant when the person goes back to it', async () => {
    const { ctx, harness, asks, workspace, home } = await mounted()
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    const agent = await harness.create(SessionId('chat-back'), {}, { cwd: workspace })
    await defaults.select(agent, SAFER_PRESET)
    expect(asks).toHaveLength(0)
    await defaults.select(agent, FULL_ACCESS_PRESET)
    await defaults.select(agent, SAFER_PRESET)
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: SAFER_PRESET, sandbox: SAFER_PRESET })
    // Choosing the safer preset is an answer, so the workspace's grant is no
    // longer standing: the store records no grant time and the next full-access
    // selection asks again.
    expect(defaults.granted(workspace)).toBe(false)
    const stored = JSON.parse(readFileSync(permissionStorePath(home), 'utf8')) as { workspaces: Record<string, { preset: string, fullAccessGrantedAt: number | null }> }
    expect(stored.workspaces[workspaceKey(workspace)]).toEqual({ preset: SAFER_PRESET, fullAccessGrantedAt: null })
    await defaults.select(agent, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(2)
  })

  it('refuses a chat with no workspace folder, which has no per-workspace permission', async () => {
    const { ctx, harness } = await mounted()
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    const agent = await harness.create(SessionId('chat-nowhere'))
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toThrow('this chat has no workspace folder')
  })

  it('refuses full access when the permission store cannot be read, naming the store\'s problem', async () => {
    const { ctx, harness, workspace } = await mounted({ store: () => '{' })
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    expect(defaults.storeProblem).toContain('no JSON document')
    const agent = await harness.create(SessionId('chat-refused-store'), {}, { cwd: workspace })
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: SAFER_PRESET })
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toThrow('the permission store is refused')
  })
})

describe('a refused sandbox/mode change', () => {
  it('leaves the session in the sandbox, and a command started in the same synchronous step runs there', async () => {
    const { ctx, harness, workspace } = await mounted()
    const agent = await harness.create(SessionId('chat-confined'), {}, { cwd: workspace })
    const before = knobs(ctx, agent.session)
    expect(before).toMatchObject({ sandbox: SAFER_PRESET })
    // The person's preset switch is the one write path; the guard runs before
    // anything is appended, so the log keeps the mode it had.
    let refusal: unknown
    try {
      ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).name).toBe('SandboxModeRefusedError')
    expect((refusal as Error).message).toContain('needs one consent for that workspace first')
    // Same synchronous step: no event was appended, so the resolved policy a
    // command starts under is still the sandboxed one.
    expect(knobs(ctx, agent.session)).toEqual(before)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(SAFER_PRESET)
  })
})

describe('the store the plugin reads', () => {
  it('seeds the recorded preset of a workspace that already granted full access, and asks nothing there', async () => {
    const { ctx, harness, asks, workspace } = await mounted({
      store: paths => serializePermissionStore(new Map([[
        workspaceKey(paths.workspace),
        { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1_700_000_000_000 },
      ]])),
    })
    const defaults = ctx.get('permissionDefaults') as PermissionDefaults
    const agent = await harness.create(SessionId('chat-recorded'), {}, { cwd: workspace })
    expect(knobs(ctx, agent.session)).toMatchObject({ preset: FULL_ACCESS_PRESET, sandbox: FULL_ACCESS_PRESET })
    expect(defaults.granted(workspace)).toBe(true)
    await defaults.select(agent, FULL_ACCESS_PRESET)
    expect(asks).toHaveLength(0)
  })
})
