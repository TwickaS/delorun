import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('the host half', () => {
  it('mounts nothing', () => {
    expect(apply()).toBeUndefined()
  })
})
