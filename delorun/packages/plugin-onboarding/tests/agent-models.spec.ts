import { describe, expect, it, vi } from 'vitest'
import { listAgentModels } from '../src/agent-models.ts'

const deps = (provider: object | undefined, timeoutMs = 1000) => ({ provider: () => provider, cwd: () => '/profile', timeoutMs, warn: vi.fn() })

describe('the agent models route', () => {
  it('returns the models the agent reports, asked in the profile directory', async () => {
    const listModels = vi.fn((_cwd: string, _signal: AbortSignal) => Promise.resolve([{ model: 'sonnet', displayName: 'Sonnet' }, { model: 'opus', displayName: 'Opus' }]))
    await expect(listAgentModels('claude-code', deps({ listModels }))).resolves.toEqual({
      state: 'listed', models: [{ model: 'sonnet', displayName: 'Sonnet' }, { model: 'opus', displayName: 'Opus' }],
    })
    expect(listModels).toHaveBeenCalledExactlyOnceWith('/profile', expect.any(AbortSignal))
  })

  it('answers unavailable, never an error, when the agent is not installed or cannot list', async () => {
    await expect(listAgentModels('codex', deps(undefined))).resolves.toEqual({ state: 'unavailable' })
    await expect(listAgentModels('codex', deps({}))).resolves.toEqual({ state: 'unavailable' })
  })

  it('answers unavailable and logs when the agent fails or does not answer in time', async () => {
    const failing = deps({ listModels: () => Promise.reject(new Error('spawn failed')) })
    await expect(listAgentModels('codex', failing)).resolves.toEqual({ state: 'unavailable' })
    expect(failing.warn).toHaveBeenCalledWith('the codex model list was not read: spawn failed')
    const slow = deps({ listModels: (_cwd: string, signal: AbortSignal) => new Promise((_, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }) }) }, 5)
    await expect(listAgentModels('codex', slow)).resolves.toEqual({ state: 'unavailable' })
  })
})
