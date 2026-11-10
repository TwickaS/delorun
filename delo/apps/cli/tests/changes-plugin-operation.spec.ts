/**
 * The plugin operation `delorun changes apply` runs for an agent's plugin request: upstream's `runProfilePnpm` for the
 * profile, with `delorun plugin`'s bounds, its output on the command's streams; and upstream's own loader.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { loadUpstream, upstreamPluginOperation } from '../src/changes/plugin-operation.ts'

// Loading upstream's profile boot module takes several seconds under a loaded host.
vi.setConfig({ testTimeout: 120_000 })

const CTX = { home: '/h', profile: 'default', profileDir: '/h/profiles/default' }

describe('upstreamPluginOperation', () => {
  it('runs upstream\'s operation for the profile and prints its output on the command\'s streams', async () => {
    const printed: string[] = []
    const errors: string[] = []
    const runProfilePnpm = vi.fn(async (_context: PackageOperationContext, _args: readonly string[], options: PackageOperationOptions) => {
      options.onOutput?.('added 1\n', 'stdout')
      options.onOutput?.('warning\n', 'stderr')
      return { exitCode: 0, logPath: '/l', output: '', truncated: false }
    })
    const run = upstreamPluginOperation(CTX, { stdout: text => void printed.push(text), stderr: text => void errors.push(text) }, async () => ({ installAnchor: '/anchor', runProfilePnpm }))
    expect(await run(['add', 'x@1'])).toEqual({ exitCode: 0, logPath: '/l' })
    expect(runProfilePnpm).toHaveBeenCalledWith(
      { profile: 'default', dir: '/h/profiles/default', installAnchor: '/anchor', cwd: process.cwd(), home: '/h' },
      ['add', 'x@1'],
      expect.objectContaining({ execution: 'cli', outputBytes: 16_384, lookupTimeoutMs: 120_000 }),
    )
    expect(printed).toEqual(['added 1\n'])
    expect(errors).toEqual(['warning\n'])
  })

  it('loads upstream\'s operation and anchor by default', async () => {
    const upstream = await loadUpstream()
    expect(typeof upstream.installAnchor).toBe('string')
    expect(typeof upstream.runProfilePnpm).toBe('function')
    // The default loader is the one the operation uses when none is given.
    expect(upstreamPluginOperation(CTX, { stdout: () => {}, stderr: () => {} })).toBeTypeOf('function')
  })
})
