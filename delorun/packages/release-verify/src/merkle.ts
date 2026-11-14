/**
 * RFC 6962 tree hashing as contract C18's release log uses it: the leaf of a log entry is the hash of its body, nodes
 * are the hash of their two children, and a client proves that an entry is in a tree of a given size (inclusion) and
 * that a tree of a smaller size is a prefix of a larger one (consistency). Only the verifying side lives here: the
 * client never builds a tree, so a broken builder cannot make a wrong bundle verify.
 *
 * @module @delorun/release-verify/merkle
 */
import { createHash } from 'node:crypto'
import { MAX_PROOF_HASHES } from '@delorun/contract-release-log'

/** The prefix RFC 6962 hashes a leaf with. */
const LEAF_PREFIX = Buffer.from([0x00])

/** The prefix RFC 6962 hashes a node with. */
const NODE_PREFIX = Buffer.from([0x01])

/**
 * The hash of a log entry's leaf.
 * @param body - the entry body's bytes, the RFC 8785 serialization the log stores.
 * @returns the 32-byte leaf hash.
 */
export function leafHash(body: Uint8Array): Buffer {
  return createHash('sha256').update(LEAF_PREFIX).update(body).digest()
}

/**
 * The hash of an inner node.
 * @param left - the left child's hash.
 * @param right - the right child's hash.
 * @returns the 32-byte node hash.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(NODE_PREFIX).update(left).update(right).digest()
}

/**
 * Whether a size is a power of two, by arithmetic exact for every safe integer: a 32-bit `&` would read `2^32 + 2^31`
 * as one.
 * @param size - a positive safe integer.
 * @returns `true` for 1, 2, 4, …
 */
export function isPowerOfTwo(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && 2 ** Math.round(Math.log2(size)) === size
}

/**
 * The root hash an inclusion proof reproduces (RFC 9162, the inclusion-proof check).
 * @param index - the leaf's index in the tree.
 * @param size - the tree size the proof is against.
 * @param leaf - the leaf's hash.
 * @param proof - the audit path, from the leaf's sibling up to the root.
 * @returns the root hash, or `undefined` when the proof cannot hold for that index and size.
 */
export function rootFromInclusionProof(index: number, size: number, leaf: Uint8Array, proof: readonly Uint8Array[]): Buffer | undefined {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return undefined
  let result: Buffer = Buffer.from(leaf)
  let leafIndex = index
  let last = size - 1
  for (const sibling of proof) {
    if (last === 0) return undefined
    if (leafIndex % 2 === 1 || leafIndex === last) {
      result = nodeHash(sibling, result)
      if (leafIndex % 2 === 0) {
        while (leafIndex !== 0 && leafIndex % 2 === 0) {
          leafIndex = Math.floor(leafIndex / 2)
          last = Math.floor(last / 2)
        }
      }
    } else {
      result = nodeHash(result, sibling)
    }
    leafIndex = Math.floor(leafIndex / 2)
    last = Math.floor(last / 2)
  }
  return last === 0 ? result : undefined
}

/**
 * Whether a consistency proof shows that the tree at `firstSize` is a prefix of the tree at `secondSize`
 * (RFC 6962, 2.1.2, verified by RFC 9162's consistency-proof algorithm, section 2.1.4).
 *
 * The proof is PROOF(m, D[n]) as the log serves it: the roots of the known subtrees between the older tree and the
 * newer one, not an audit path of the older tree's rightmost leaf. When the older size is an exact power of two the
 * proof omits the older root, because PROOF ends at SUBPROOF(m, D[m], true) = {}; the walk therefore starts from the
 * older root the client already holds. The first hash of any other proof is the root of the rightmost subtree the
 * recursion reached, which for an even older size is a two-or-more-leaf subtree rather than a leaf. The walk climbs
 * both roots together, taking a proof hash as the left child of both while the older tree's last index is odd or the
 * older and newer last indices meet, and as the right child of the newer root alone otherwise.
 * @param firstSize - the size of the older tree.
 * @param firstRoot - the older tree's root hash.
 * @param secondSize - the size of the newer tree.
 * @param secondRoot - the newer tree's root hash.
 * @param proof - the consistency proof's hashes, oldest subtree first.
 * @returns `true` when the proof verifies.
 */
export function verifyConsistencyProof(firstSize: number, firstRoot: Uint8Array, secondSize: number, secondRoot: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(firstSize) || !Number.isSafeInteger(secondSize)) return false
  if (firstSize <= 0 || firstSize > secondSize || proof.length > MAX_PROOF_HASHES) return false
  // A tree against itself needs no proof, only the same root.
  if (firstSize === secondSize) return proof.length === 0 && Buffer.from(firstRoot).equals(Buffer.from(secondRoot))
  // A power-of-two older tree's root is the start of the proof the client already holds; the log leaves it out.
  const path = isPowerOfTwo(firstSize) ? [Buffer.from(firstRoot), ...proof] : [...proof]
  const seed = path[0]
  if (seed === undefined) return false
  // The walking indices are the last leaf of each tree: an odd one means both roots take one more left child.
  let first = firstSize - 1
  let second = secondSize - 1
  while (first % 2 === 1) {
    first = Math.floor(first / 2)
    second = Math.floor(second / 2)
  }
  let computedFirst: Buffer = Buffer.from(seed)
  let computedSecond: Buffer = Buffer.from(seed)
  for (const hash of path.slice(1)) {
    if (second === 0) return false
    if (first % 2 === 1 || first === second) {
      computedFirst = nodeHash(hash, computedFirst)
      computedSecond = nodeHash(hash, computedSecond)
      if (first % 2 === 0) {
        while (first !== 0 && first % 2 === 0) {
          first = Math.floor(first / 2)
          second = Math.floor(second / 2)
        }
      }
    } else {
      computedSecond = nodeHash(computedSecond, hash)
    }
    first = Math.floor(first / 2)
    second = Math.floor(second / 2)
  }
  return second === 0 && computedFirst.equals(Buffer.from(firstRoot)) && computedSecond.equals(Buffer.from(secondRoot))
}
