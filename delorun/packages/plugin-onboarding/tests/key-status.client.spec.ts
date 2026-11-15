import { describe, expect, it, vi } from 'vitest'
import { createKeyStatus, didNotPass } from '../src/client/key-status.ts'
import type { KeyTestAnswer } from '../src/wire.ts'

const copy = () => ({ failed: 'failed', test: 'test', testing: 'testing' })
const refused: KeyTestAnswer = { providers: [{ provider: 'deepseek-official', name: 'DeepSeek', result: 'rejected' }, { provider: 'openai', name: 'OpenAI', result: 'works' }] }

describe('the shared key status', () => {
  it('counts a refused or failed key as not passing, and nothing else', () => {
    expect(['rejected', 'failed'].every(result => didNotPass(result as never))).toBe(true)
    expect(['works', 'unreachable', 'no-key', 'untested'].some(result => didNotPass(result as never))).toBe(false)
  })

  it('publishes the routes whose key did not pass, and tells listeners while it tests', async () => {
    const status = createKeyStatus(() => Promise.resolve(refused), copy)
    const heard = vi.fn()
    status.subscribe(heard)
    expect(status.getSnapshot().failed.size).toBe(0)
    const run = status.refresh()
    expect(status.getSnapshot().testing).toBe(true)
    await run
    expect([...status.getSnapshot().failed]).toEqual(['deepseek-official'])
    expect(status.getSnapshot().testing).toBe(false)
    expect(status.answer()).toBe(refused)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('joins a test already running and keeps the last answer when the harness cannot be asked', async () => {
    const ask = vi.fn<() => Promise<KeyTestAnswer | undefined>>().mockResolvedValueOnce(refused).mockResolvedValueOnce(undefined)
    const status = createKeyStatus(ask, copy)
    const [first, second] = [status.refresh(), status.refresh()]
    expect(first).toBe(second)
    await first
    expect(ask).toHaveBeenCalledOnce()
    status.test()
    await status.refresh()
    expect(status.answer()).toBe(refused)
    expect(status.copy().test).toBe('test')
  })
})
