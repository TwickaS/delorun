import { afterEach, describe, expect, it } from 'vitest'
import { currentUnlockToken, onUnlockToken, setUnlockToken } from '../src/client/page-unlock-token.ts'

afterEach(() => { setUnlockToken(null) })

describe('the page unlock token', () => {
  it('starts locked, holds the token it is given and tells listeners each change once', () => {
    const seen: (string | null)[] = []
    const stop = onUnlockToken(token => seen.push(token))
    expect(currentUnlockToken()).toBeNull()
    setUnlockToken('t1')
    setUnlockToken('t1')
    expect(currentUnlockToken()).toBe('t1')
    setUnlockToken(null)
    stop()
    setUnlockToken('t2')
    expect(seen).toEqual(['t1', null])
  })
})
