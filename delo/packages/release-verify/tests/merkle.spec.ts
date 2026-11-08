/**
 * RFC 6962 hashing as the client verifies it: an inclusion proof reproduces the tree's root hash for every index and
 * size, and a consistency proof shows that a smaller tree is a prefix of a larger one. The proofs come from this
 * suite's own builders, written from RFC 6962 §2.1 rather than from the verifier, so a verifier that hashes a leaf or a
 * node otherwise cannot agree with them.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { leafHash, nodeHash, rootFromInclusionProof, verifyConsistencyProof } from '../src/merkle.ts'
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
