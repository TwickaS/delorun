/**
 * The process handlers upstream's profile runner installs for each Delo command that boots a profile: none for the
 * home process of `delorun start`, which owns one signal listener across all its Host boots, and its signal handlers
 * for `delorun headless`, a one-shot run whose process upstream's runner ends. Neither installs upstream's fail-loud
 * handlers: the CLI's last-resort handler reports a crash and disposes the registered Host.
 */
import { Context } from '@deepseek-ai/cordis'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upstreamDependencies } from '../src/start.ts'
import { headlessDependencies } from '../src/upstream.ts'

vi.mock('@deepseek-ai/dsh/profile-boot', () => ({ runProfile: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
})

describe('the real commands\' profile runner', () => {
  it.each([
    ['delorun start', false, () => upstreamDependencies().runProfile],
    ['delorun headless', true, () => headlessDependencies().runProfile],
  ] as const)('%s boots through upstream\'s runProfile with its signal handlers set to %s and no fail-loud handlers', async (_command, signals, runner) => {
    vi.mocked(runProfile).mockResolvedValue({ ctx: new Context(), shutdown: { shutdown: vi.fn(), interrupt: vi.fn() } })
    await runner()({ environment: createLaunchEnvironmentSnapshot([]), profile: 'default', patchFiles: [], args: [] })
    expect(runProfile).toHaveBeenCalledOnce()
    expect(vi.mocked(runProfile).mock.calls[0]?.[0]).toMatchObject({ signals, failLoud: false })
  })
})
