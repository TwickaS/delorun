/** The high-water mark: its KV storage and the comparison that refuses a rolled-back timestamp. */
import { describe, expect, it } from 'vitest'
import { checkAgainstMark, kvMark, type MarkNamespace } from '../src/mark.ts'

const at = (version: number, stable: string, beta = stable) => ({ version, channels: { stable, beta } })

describe('high-water mark', () => {
  it('round-trips through a KV namespace and reads nothing before the first write', async () => {
    const data = new Map<string, string>()
    const namespace: MarkNamespace = { get: async key => data.get(key) ?? null, put: async (key, value) => { data.set(key, value) } }
    const mark = kvMark(namespace)
    expect(await mark.read()).toBeUndefined()
    await mark.write(at(4, '0.1.0'))
    expect(await mark.read()).toEqual(at(4, '0.1.0'))
  })

  it('accepts the first sighting, an equal mark and a higher one', () => {
    expect(() => checkAgainstMark(undefined, at(1, '0.1.0'))).not.toThrow()
    expect(() => checkAgainstMark(at(4, '0.1.0'), at(4, '0.1.0'))).not.toThrow()
    expect(() => checkAgainstMark(at(4, '0.1.0'), at(5, '0.2.0'))).not.toThrow()
  })

  it('refuses a lower version and a channel on a lower release', () => {
    expect(() => checkAgainstMark(at(4, '0.1.0'), at(3, '0.1.0'))).toThrow(/rolled back/u)
    expect(() => checkAgainstMark(at(4, '0.2.0', '0.3.0'), at(5, '0.2.0', '0.2.9'))).toThrow(/beta release 0\.2\.9/u)
  })
})
