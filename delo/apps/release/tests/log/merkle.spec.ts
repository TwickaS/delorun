/**
 * The release log's Merkle checks on trees whose sizes do not fit in 32 bits: the vectors `@delo/release-verify`'s own
 * spec holds its copy of the power-of-two test to.
 */
import { describe, expect, it } from 'vitest'
import { isPowerOfTwo, nodeHash, rootFromInclusionProof, verifyConsistency } from '../../src/log/merkle.ts'

describe('trees beyond 32 bits', () => {
  it('tells powers of two apart by arithmetic exact for every safe integer, refusing 2^53 and beyond, where a 32-bit mask reads 2^32 + 2^31 as one', () => {
    for (const exponent of [0, 1, 31, 32, 40, 52]) expect(isPowerOfTwo(2 ** exponent), String(exponent)).toBe(true)
    for (const size of [0, -4, 3, 2 ** 32 + 2 ** 31, 2 ** 40 + 2 ** 39, 2 ** 53, 1.5]) expect(isPowerOfTwo(size), String(size)).toBe(false)
  })

  it('verifies a one-leaf extension of a tree of 2^32 + 2^31 and of 2^40 + 2^39 leaves', () => {
    for (const exponent of [32, 40]) {
      const whole = Buffer.alloc(32, 1)
      const half = Buffer.alloc(32, 2)
      const leaf = Buffer.alloc(32, 3)
      const first = 2 ** exponent + 2 ** (exponent - 1)
      // PROOF(m, D[m+1]) for m = 2^k + 2^(k-1): the right half of the older tree, the new leaf, then the left subtree.
      expect(verifyConsistency(first, first + 1, nodeHash(whole, half), nodeHash(whole, nodeHash(half, leaf)), [half, leaf, whole]), String(exponent)).toBe(true)
      expect(verifyConsistency(first, first + 1, nodeHash(whole, half), nodeHash(whole, nodeHash(half, Buffer.alloc(32, 4))), [half, leaf, whole])).toBe(false)
    }
  })

  it('verifies a one-leaf extension of a tree of exactly 2^32 and 2^40 leaves, and refuses sizes from 2^53 up', () => {
    for (const exponent of [32, 40]) {
      const old = Buffer.alloc(32, 5)
      const leaf = Buffer.alloc(32, 6)
      expect(verifyConsistency(2 ** exponent, 2 ** exponent + 1, old, nodeHash(old, leaf), [leaf]), String(exponent)).toBe(true)
    }
    expect(verifyConsistency(1, 2 ** 53 + 2, Buffer.alloc(32), Buffer.alloc(32), [])).toBe(false)
    expect(verifyConsistency(2 ** 53, 2 ** 53, Buffer.alloc(32), Buffer.alloc(32), [])).toBe(false)
    expect(verifyConsistency(-1, 2, Buffer.alloc(32), Buffer.alloc(32), [Buffer.alloc(32)])).toBe(false)
  })

  it('reproduces a root at index 2^40 of a tree of 2^40 + 1 leaves, and refuses an index or size that is not a safe integer', () => {
    const left = Buffer.alloc(32, 7)
    const leaf = Buffer.alloc(32, 8)
    expect(rootFromInclusionProof(2 ** 40, 2 ** 40 + 1, leaf, [left])).toEqual(nodeHash(left, leaf))
    expect(rootFromInclusionProof(2 ** 53, 2 ** 53 + 2, leaf, [left])).toBeUndefined()
    expect(rootFromInclusionProof(-1, 2, leaf, [left])).toBeUndefined()
    expect(rootFromInclusionProof(0.5, 2, leaf, [left])).toBeUndefined()
  })
})
