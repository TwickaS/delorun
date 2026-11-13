/**
 * A permission-defaults row that is on but whose network or permission service failed to activate fails closed: the
 * `sandboxNetwork` resolver answers no network for every workspace instead of leaving the host's network, and a
 * failed permission service keeps the full-access guard that refuses `danger-full-access`. With the switch off, the
 * row mounts nothing and commands share the host's network, as stock. A healthy row with the default `open` network
 * answers no network setting, which is the host's, as stock.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, CommandNetwork, Config, PermissionDefaults, SAFER_PRESET } from '../src/index.ts'
import { PERMISSION_DEFAULTS_ROW } from '../src/failed.ts'

const roots: string[] = []
const originalHome = process.env['DELO_HOME']
const contexts: Context[] = []
const patched: { readonly target: object, readonly original: PropertyDescriptor | undefined }[] = []

afterEach(async () => {
  for (const { target, original } of patched.splice(0)) {
    if (original === undefined) Reflect.deleteProperty(target, Service.init)
    else Object.defineProperty(target, Service.init, original)
  }
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELO_HOME']
  else process.env['DELO_HOME'] = originalHome
})

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'delo-permission-failclosed-'))
  roots.push(root)
  mkdirSync(join(root, 'home'), { recursive: true })
  process.env['DELO_HOME'] = join(root, 'home')
})

/**
 * Make a service's activation throw until the test ends.
 * @param service - the service class.
 */
function crash(service: { readonly prototype: object }): void {
  patched.push({ target: service.prototype, original: Object.getOwnPropertyDescriptor(service.prototype, Service.init) })
  Object.defineProperty(service.prototype, Service.init, { configurable: true, value: () => Promise.reject(new Error('the activation crashed')) })
}

/**
 * Mount the row over the services it needs.
 * @param enabled - the row's switch.
 * @returns the context.
 */
async function mount(enabled: boolean): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: SAFER_PRESET, workspaceRoot: roots[0] ?? '/' })
  ctx.provide('shell', { sandboxMode: 'workspace-write', resolve() {}, run() {}, start() {} } as never)
  ctx.provide('approval', { config: { policy: 'ask' }, request: async () => 'allowed-once', setPolicy() {} } as never)
  await ctx.plugin(PermissionPresetService, { defaultPreset: SAFER_PRESET })
  const row = ctx.plugin({ name: 'permission-defaults', apply: (scope: Context) => apply(scope, { ...Config(), enabled }) })
  await row.await().catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  return ctx
}

const session = { id: 'chat-1', header: { cwd: '/work' } } as unknown as Session

describe('a permission-defaults row whose network service failed', () => {
  it('answers no network for every workspace, never the host\'s, while the switch is on', async () => {
    crash(CommandNetwork)
    const ctx = await mount(true)
    expect(ctx.sandboxNetwork({ workspaceRoot: '/work' })).toEqual({ mode: 'off' })
    expect(ctx.sandboxNetwork({ workspaceRoot: '/elsewhere' })).toEqual({ mode: 'off' })
    expect(ctx.sandboxPolicy.resolve().network).toEqual({ mode: 'off' })
  })
})

describe('a permission-defaults row whose permission service failed', () => {
  it('answers no network and refuses full access, while the switch is on', async () => {
    crash(PermissionDefaults)
    const ctx = await mount(true)
    expect(ctx.sandboxNetwork({ workspaceRoot: '/work' })).toEqual({ mode: 'off' })
    const guard = ctx.get('sandboxModeGuard')
    const reason = guard?.(session, 'danger-full-access')
    expect(reason).toContain(PERMISSION_DEFAULTS_ROW)
    expect(reason).toMatch(/restart/iu)
    expect(reason).toMatch(/safe mode/iu)
    expect(reason).toMatch(/logs/iu)
    expect(guard?.(session, 'workspace-write')).toBeUndefined()
  })
})

describe('a permission-defaults row with its switch off', () => {
  it('mounts nothing, so commands share the host\'s network, as stock', async () => {
    crash(CommandNetwork)
    crash(PermissionDefaults)
    const ctx = await mount(false)
    expect(ctx.get('sandboxNetwork')).toBeUndefined()
    expect(ctx.get('sandboxModeGuard')).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve().network).toBeUndefined()
  })
})

describe('a healthy permission-defaults row with the default network', () => {
  it('leaves the host\'s network, as stock', async () => {
    const ctx = await mount(true)
    expect(ctx.sandboxNetwork({ workspaceRoot: '/work' })).toBeUndefined()
  })
})
