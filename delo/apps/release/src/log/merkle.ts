/**
 * RFC 6962 Merkle tree hashing and proof verification, as the release log's inclusion and consistency proofs use it
 * (contract C18): a leaf hash is SHA-256 of 0x00 and the leaf, an interior node SHA-256 of 0x01 and its children.
 *
 * @module @delo/release/log/merkle
 */
import { createHash } from 'node:crypto'
import { MAX_PROOF_HASHES } from '@delo/contract-release-log'

/**
 * The leaf hash of an entry body.
 * @param leaf - the canonical entry body.
 * @returns the 32-byte hash.
 */
export function leafHash(leaf: Uint8Array): Buffer {
  return createHash('sha256').update(Buffer.from([0x00])).update(leaf).digest()
}

/**
 * The hash of an interior node.
 * @param left - the left child's hash.
 * @param right - the right child's hash.
 * @returns the 32-byte hash.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(Buffer.from([0x01])).update(left).update(right).digest()
}

/**
 * Whether a size is a power of two, by arithmetic exact for every safe integer: a 32-bit `&` would read `2^32 + 2^31`
 * as one. `@delo/release-verify` keeps the same function; it depends on this package, so this one cannot import it.
 * @param size - a positive safe integer.
 * @returns `true` for 1, 2, 4, …; `false` for anything else, every size from 2^53 up included.
 */
export function isPowerOfTwo(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && 2 ** Math.round(Math.log2(size)) === size
}

/**
 * The root a leaf's inclusion proof reproduces, by the inclusion-proof verification algorithm of RFC 9162.
 * @param index - the leaf's index.
 * @param size - the tree size.
 * @param leaf - the leaf hash.
 * @param proof - the audit path.
 * @returns the root hash, or `undefined` when the proof's length does not fit the index and size, or either is not a
 *   safe integer.
 */
export function rootFromInclusionProof(index: number, size: number, leaf: Uint8Array, proof: readonly Uint8Array[]): Buffer | undefined {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size || proof.length > MAX_PROOF_HASHES) return undefined
  let fn = index
  let sn = size - 1
  let r: Buffer = Buffer.from(leaf)
  for (const p of proof) {
    if (sn === 0) return undefined
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      r = nodeHash(r, p)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 ? r : undefined
}

/**
 * Whether a consistency proof shows that the tree of `size1` with root `root1` is a prefix of the tree of `size2`
 * with root `root2`, by the consistency-proof verification algorithm of RFC 9162.
 * @param size1 - the older tree's size.
 * @param size2 - the newer tree's size.
 * @param root1 - the older root.
 * @param root2 - the newer root.
 * @param proof - the consistency proof.
 * @returns true when the proof verifies; false for a size that is negative or not a safe integer, 2^53 and beyond.
 */
export function verifyConsistency(size1: number, size2: number, root1: Uint8Array, root2: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(size1) || !Number.isSafeInteger(size2) || size1 < 0 || size1 > size2 || proof.length > MAX_PROOF_HASHES) return false
  if (size1 === size2) return proof.length === 0 && Buffer.from(root1).equals(Buffer.from(root2))
  if (size1 === 0) return proof.length === 0
  let path = [...proof]
  if (isPowerOfTwo(size1)) path = [root1, ...path]
  if (path.length === 0) return false
  let fn = size1 - 1
  let sn = size2 - 1
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  let fr: Buffer = Buffer.from(path[0]!)
  let sr: Buffer = Buffer.from(path[0]!)
  for (const c of path.slice(1)) {
    if (sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr)
      sr = nodeHash(c, sr)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      sr = nodeHash(sr, c)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 && fr.equals(Buffer.from(root1)) && sr.equals(Buffer.from(root2))
}

/**
 * The root of a list of leaf hashes (RFC 6962 MTH), for the log stand-in and tests.
 * @param leaves - the leaf hashes.
 * @returns the root hash; SHA-256 of nothing for an empty tree.
 */
export function treeRoot(leaves: readonly Uint8Array[]): Buffer {
  if (leaves.length === 0) return createHash('sha256').digest()
  if (leaves.length === 1) return Buffer.from(leaves[0]!)
  const split = 2 ** Math.floor(Math.log2(leaves.length - 1))
  return nodeHash(treeRoot(leaves.slice(0, split)), treeRoot(leaves.slice(split)))
}

/**
 * The inclusion proof of a leaf (RFC 6962 PATH), for the log stand-in and tests.
 * @param index - the leaf's index.
 * @param leaves - the leaf hashes.
 * @returns the audit path.
 */
export function inclusionProof(index: number, leaves: readonly Uint8Array[]): Buffer[] {
  if (leaves.length <= 1) return []
  const split = 2 ** Math.floor(Math.log2(leaves.length - 1))
  return index < split
    ? [...inclusionProof(index, leaves.slice(0, split)), treeRoot(leaves.slice(split))]
    : [...inclusionProof(index - split, leaves.slice(split)), treeRoot(leaves.slice(0, split))]
}

/**
 * The consistency proof between two tree sizes (RFC 6962 PROOF), for the log stand-in and tests.
 * @param size1 - the older size, at least 1.
 * @param leaves - the newer tree's leaf hashes.
 * @returns the proof.
 */
export function consistencyProof(size1: number, leaves: readonly Uint8Array[]): Buffer[] {
  const subproof = (m: number, tree: readonly Uint8Array[], complete: boolean): Buffer[] => {
    if (m === tree.length) return complete ? [] : [treeRoot(tree)]
    const split = 2 ** Math.floor(Math.log2(tree.length - 1))
    return m <= split
      ? [...subproof(m, tree.slice(0, split), complete), treeRoot(tree.slice(split))]
      : [...subproof(m - split, tree.slice(split), false), treeRoot(tree.slice(0, split))]
  }
  return subproof(size1, leaves, true)
}
