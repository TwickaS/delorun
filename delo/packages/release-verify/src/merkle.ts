/**
 * RFC 6962 tree hashing as contract C18's release log uses it: the leaf of a log entry is the hash of its body, nodes
 * are the hash of their two children, and a client proves that an entry is in a tree of a given size (inclusion) and
 * that a tree of a smaller size is a prefix of a larger one (consistency). Only the verifying side lives here: the
 * client never builds a tree, so a broken builder cannot make a wrong bundle verify.
 *
 * @module @delo/release-verify/merkle
 */
import { createHash } from 'node:crypto'

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
 * (RFC 6962, 2.1.2, as the log serves it).
 *
 * The proof is the audit path of the older tree's rightmost leaf in the newer tree, with that leaf's hash first, except
 * when the older tree is that one leaf: the shape SUBPROOF(m, D[n], true) has when it runs down to the leaf rather than
 * stopping at a known subtree root. The client therefore recomputes both roots from the proof instead of trusting
 * either: the path must reproduce the newer root at that leaf's index, and the left siblings along it, folded in order,
 * must reproduce the older root.
 * @param firstSize - the size of the older tree.
 * @param firstRoot - the older tree's root hash.
 * @param secondSize - the size of the newer tree.
 * @param secondRoot - the newer tree's root hash.
 * @param proof - the consistency proof's hashes, the older tree's rightmost leaf hash first.
 * @returns `true` when the proof verifies.
 */
export function verifyConsistencyProof(firstSize: number, firstRoot: Uint8Array, secondSize: number, secondRoot: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(firstSize) || !Number.isSafeInteger(secondSize)) return false
  if (firstSize <= 0 || firstSize > secondSize) return false
  // A tree against itself needs no proof, only the same root.
  if (firstSize === secondSize && proof.length === 0) return Buffer.from(firstRoot).equals(Buffer.from(secondRoot))
  // A one-leaf tree's rightmost leaf is its root, which the client already holds; every other tree hands it over first.
  const seed = firstSize === 1 ? Buffer.from(firstRoot) : proof[0]
  if (seed === undefined) return false
  const path = firstSize === 1 ? proof : proof.slice(1)
  const leafIndex = firstSize - 1
  const computedSecond = rootFromInclusionProof(leafIndex, secondSize, seed, path)
  if (computedSecond === undefined || !computedSecond.equals(Buffer.from(secondRoot))) return false
  // The older tree's root is the same leaf, folded with the left siblings the path meets on the way up, and nothing
  // else: a sibling to the right lies past the older tree's last leaf, so it belongs to the newer tree alone.
  let computedFirst: Buffer = Buffer.from(seed)
  let index = leafIndex
  let last = secondSize - 1
  for (const sibling of path) {
    if (last === 0) return false
    if (index % 2 === 1 || index === last) {
      computedFirst = nodeHash(sibling, computedFirst)
      if (index % 2 === 0) {
        while (index !== 0 && index % 2 === 0) {
          index = Math.floor(index / 2)
          last = Math.floor(last / 2)
        }
      }
    }
    index = Math.floor(index / 2)
    last = Math.floor(last / 2)
  }
  return last === 0 && computedFirst.equals(Buffer.from(firstRoot))
}
