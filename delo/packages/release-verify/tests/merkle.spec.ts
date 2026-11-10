/**
 * RFC 6962 hashing as the client verifies it: an inclusion proof reproduces the tree's root hash for every index and
 * size, and a consistency proof shows that a smaller tree is a prefix of a larger one. The proofs come from this
 * suite's own builders, written from RFC 6962 §2.1 rather than from the verifier, so a verifier that hashes a leaf or a
 * node otherwise cannot agree with them.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// The log side's own verifier, read by path: a differential against the implementation the log serves proofs with, not
// a second copy of the client's walk.
import { verifyConsistency as referenceVerify } from '@delo/release-formats/log/merkle'
import { isPowerOfTwo, leafHash, nodeHash, rootFromInclusionProof, verifyConsistencyProof } from '../src/merkle.ts'
import { consistencyProof, inclusionProof, treeRoot } from './fixtures.ts'

/** The leaf hashes of a tree of `count` leaves, each the hash of its index's decimal text. */
function leaves(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) => leafHash(Buffer.from(String(index))))
}

describe('leaf and node hashing', () => {
  it('hashes a leaf with RFC 6962\'s 0x00 prefix and a node with its 0x01 prefix', () => {
    const leaf = Buffer.from('a body')
    expect(leafHash(leaf).toString('hex')).toBe(createHash('sha256').update(Buffer.from([0x00])).update(leaf).digest('hex'))
    const left = Buffer.alloc(32, 1)
    const right = Buffer.alloc(32, 2)
    expect(nodeHash(left, right).toString('hex')).toBe(createHash('sha256').update(Buffer.from([0x01])).update(left).update(right).digest('hex'))
    expect(leafHash(leaf).equals(nodeHash(left, right))).toBe(false)
  })
})

describe('the inclusion proof', () => {
  it('reproduces the root hash at every index of every tree of one to nine leaves', () => {
    for (let size = 1; size <= 9; size++) {
      const hashes = leaves(size)
      const root = treeRoot(hashes)
      for (let index = 0; index < size; index++) {
        const proof = inclusionProof(index, hashes)
        expect(rootFromInclusionProof(index, size, hashes[index]!, proof)?.toString('hex')).toBe(root.toString('hex'))
      }
    }
  })

  it('refuses an index outside the tree, and a size below its index', () => {
    const hashes = leaves(3)
    expect(rootFromInclusionProof(3, 3, hashes[0]!, inclusionProof(0, hashes))).toBeUndefined()
    expect(rootFromInclusionProof(-1, 3, hashes[0]!, [])).toBeUndefined()
    expect(rootFromInclusionProof(0, 0, hashes[0]!, [])).toBeUndefined()
    expect(rootFromInclusionProof(0.5, 3, hashes[0]!, [])).toBeUndefined()
  })

  it('does not reproduce the root hash when a proof hash is not the entry\'s sibling', () => {
    const hashes = leaves(4)
    const proof = inclusionProof(1, hashes)
    const tampered = proof.map(() => Buffer.alloc(32, 9))
    expect(rootFromInclusionProof(1, 4, hashes[1]!, tampered)?.toString('hex')).not.toBe(treeRoot(hashes).toString('hex'))
  })

  it('does not reproduce the root hash from another leaf\'s hash', () => {
    const hashes = leaves(4)
    expect(rootFromInclusionProof(1, 4, hashes[2]!, inclusionProof(1, hashes))?.toString('hex')).not.toBe(treeRoot(hashes).toString('hex'))
  })
})

describe('the consistency proof', () => {
  it('verifies from every older size to every newer one, up to nine leaves', () => {
    for (let size = 1; size <= 9; size++) {
      const hashes = leaves(size)
      for (let first = 1; first <= size; first++) {
        const proof = consistencyProof(first, hashes)
        expect(verifyConsistencyProof(first, treeRoot(hashes.slice(0, first)), size, treeRoot(hashes), proof)).toBe(true)
      }
    }
  })

  it('verifies an empty proof for a tree against itself, and refuses one that names another root', () => {
    const hashes = leaves(4)
    expect(verifyConsistencyProof(4, treeRoot(hashes), 4, treeRoot(hashes), [])).toBe(true)
    expect(verifyConsistencyProof(4, treeRoot(leaves(3)), 4, treeRoot(hashes), [])).toBe(false)
  })

  it('refuses a proof from a larger tree to a smaller one, or from an empty tree', () => {
    const hashes = leaves(4)
    expect(verifyConsistencyProof(4, treeRoot(hashes), 3, treeRoot(hashes.slice(0, 3)), consistencyProof(4, hashes))).toBe(false)
    expect(verifyConsistencyProof(0, treeRoot(hashes), 4, treeRoot(hashes), [])).toBe(false)
  })

  it('refuses a proof whose hashes are another tree\'s', () => {
    const hashes = leaves(6)
    const other = leaves(5)
    expect(verifyConsistencyProof(2, treeRoot(hashes.slice(0, 2)), 6, treeRoot(hashes), consistencyProof(2, other))).toBe(false)
  })

  it('refuses a proof that names the newer root hash as the older one', () => {
    const hashes = leaves(5)
    expect(verifyConsistencyProof(2, treeRoot(hashes), 5, treeRoot(hashes), consistencyProof(2, hashes))).toBe(false)
  })
})

describe('the consistency proof against RFC 6962 PROOF', () => {
  // The release app serves these proofs and verifies them with its own walk, which the audit found correct. Comparing
  // the client's verifier against that implementation, rather than against a copy of itself, is what this block is for.
  it('agrees with the release log\'s verifier on every genuine proof between every pair of sizes up to 64', () => {
    let verified = 0
    for (let second = 2; second <= 64; second++) {
      const hashes = leaves(second)
      const secondRoot = treeRoot(hashes)
      for (let first = 1; first < second; first++) {
        const firstRoot = treeRoot(hashes.slice(0, first))
        const proof = consistencyProof(first, hashes)
        const ours = verifyConsistencyProof(first, firstRoot, second, secondRoot, proof)
        const reference = referenceVerify(first, second, firstRoot, secondRoot, proof)
        expect({ first, second, ours, reference }).toEqual({ first, second, ours: true, reference: true })
        verified += 1
      }
    }
    // Every ordered pair of distinct sizes up to 64: 64 * 63 / 2.
    expect(verified).toBe(2016)
  })

  it('accepts the 4-to-8 proof the fixed walk is a regression for', () => {
    const hashes = leaves(8)
    const proof = consistencyProof(4, hashes)
    expect(proof.map(hash => hash.toString('hex'))).toEqual([treeRoot(hashes.slice(4, 8)).toString('hex')])
    expect(verifyConsistencyProof(4, treeRoot(hashes.slice(0, 4)), 8, treeRoot(hashes), proof)).toBe(true)
  })

  it('is bound to the proof\'s own shapes: a hash removed, added or reordered refuses', () => {
    const hashes = leaves(8)
    const secondRoot = treeRoot(hashes)
    for (const first of [1, 2, 3, 4, 5, 6, 7]) {
      const firstRoot = treeRoot(hashes.slice(0, first))
      const proof = consistencyProof(first, hashes)
      expect(verifyConsistencyProof(first, firstRoot, 8, secondRoot, proof.slice(1))).toBe(false)
      expect(verifyConsistencyProof(first, firstRoot, 8, secondRoot, [...proof, ...proof.slice(-1)])).toBe(false)
      if (proof.length > 1) {
        expect(verifyConsistencyProof(first, firstRoot, 8, secondRoot, [...proof].reverse())).toBe(false)
      }
    }
  })

  it('refuses a proof longer than the contract\'s bound', () => {
    const hashes = leaves(8)
    const proof = consistencyProof(4, hashes)
    expect(verifyConsistencyProof(4, treeRoot(hashes.slice(0, 4)), 8, treeRoot(hashes), [...Array.from({ length: 65 }, () => proof[0]!)])).toBe(false)
  })
})

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
      expect(verifyConsistencyProof(first, nodeHash(whole, half), first + 1, nodeHash(whole, nodeHash(half, leaf)), [half, leaf, whole]), String(exponent)).toBe(true)
      expect(verifyConsistencyProof(first, nodeHash(whole, half), first + 1, nodeHash(whole, nodeHash(half, Buffer.alloc(32, 4))), [half, leaf, whole])).toBe(false)
    }
  })

  it('verifies a one-leaf extension of a tree of exactly 2^32 and 2^40 leaves, and refuses sizes beyond 2^53', () => {
    for (const exponent of [32, 40]) {
      const old = Buffer.alloc(32, 5)
      const leaf = Buffer.alloc(32, 6)
      expect(verifyConsistencyProof(2 ** exponent, old, 2 ** exponent + 1, nodeHash(old, leaf), [leaf])).toBe(true)
    }
    expect(verifyConsistencyProof(1, Buffer.alloc(32), 2 ** 53 + 2, Buffer.alloc(32), [])).toBe(false)
  })
})

describe('a proof that is empty where the tree needs one', () => {
  it('refuses an empty proof from a tree whose size is not a power of two', () => {
    expect(verifyConsistencyProof(3, Buffer.alloc(32, 1), 5, Buffer.alloc(32, 2), [])).toBe(false)
  })
})
