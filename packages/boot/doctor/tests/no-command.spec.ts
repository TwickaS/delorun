import * as ChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DoctorRegistry from '../src/index.ts'
import * as Checks from '../src/checks.ts'

// Every spawn entry point records its calls and still runs the real function, so a spawn from the doctor's checks
// is visible to the assertions below.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
  }
})

const contexts: Context[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Number of calls to any spawn entry point of `node:child_process` since the last clear. */
function spawnCalls(): number {
  const entries = [
    ChildProcess.spawn,
    ChildProcess.spawnSync,
    ChildProcess.exec,
    ChildProcess.execFile,
    ChildProcess.execFileSync,
    ChildProcess.execSync,
  ]
  return entries.reduce((total, entry) => total + (vi.isMockFunction(entry) ? entry.mock.calls.length : 0), 0)
}

describe('the doctor runs no command', () => {
  it('confines a no-op command for the sandbox check, reads the enforcement, and spawns nothing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const confine = vi.fn((argv: readonly string[]) => Promise.resolve({
      argv: ['wrapped', ...argv],
      enforcement: 'full' as const,
      denialSignatures: [],
      runnerFailureRules: [],
    }))
    ctx.provide('sandbox', { confine } as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) } as never)
    await ctx.plugin(DoctorRegistry, { checkTimeoutMs: 1_000 })
    await ctx.plugin(Checks)
    const results = await ctx.doctor.run(new AbortController().signal)
    expect(confine).toHaveBeenCalledTimes(1)
    expect(confine).toHaveBeenCalledWith(['true'], expect.objectContaining({ mode: 'workspace-write' }), expect.any(AbortSignal))
    expect(results.find(result => result.id === 'sandbox-enforcement')).toMatchObject({ status: 'pass' })
    expect(spawnCalls()).toBe(0)
  })
})
