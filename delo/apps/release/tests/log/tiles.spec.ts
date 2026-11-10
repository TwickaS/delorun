/**
 * Inclusion proofs computed from a log's tiles (C2SP `tlog-tiles`), against the log stand-in's tile server: the path
 * encoding, proofs equal to RFC 6962's for every leaf of small trees and reproducing the root across tile levels,
 * partial tiles with the full-tile fallback, and refusals of missing or malformed tiles.
 */
import { describe, expect, it } from 'vitest'
import { consistencyProof, inclusionProof, leafHash, rootFromInclusionProof, treeRoot, verifyConsistency } from '../../src/log/merkle.ts'
import { consistencyProofFromTiles, inclusionProofFromTiles, tilePath, TileError } from '../../src/log/tiles.ts'
import { LogStandIn } from './standin.ts'

function served(log: LogStandIn): (path: string) => Promise<Uint8Array | undefined> {
  return path => Promise.resolve(log.tile(path))
}

describe('tile paths', () => {
  it('encode the index in three-digit elements, all but the last prefixed with x, and a partial tile\'s width', () => {
    expect(tilePath(0, 0)).toBe('tile/0/000')
    expect(tilePath(0, 67)).toBe('tile/0/067')
    expect(tilePath(0, 1000)).toBe('tile/0/x001/000')
    expect(tilePath(0, 1_234_067)).toBe('tile/0/x001/x234/067')
    expect(tilePath(1, 273, 17)).toBe('tile/1/273.p/17')
  })
})

describe('inclusion proofs from tiles', () => {
  it('equal RFC 6962\'s audit path for every leaf of every tree up to 40 leaves', async () => {
    const log = new LogStandIn()
    const leaves: Buffer[] = []
    for (let size = 1; size <= 40; size++) {
      log.grow(1)
      leaves.push(leafHash(Buffer.from(String(size - 1))))
      for (let index = 0; index < size; index++) {
        expect(await inclusionProofFromTiles(index, size, served(log))).toEqual(inclusionProof(index, leaves))
      }
    }
  })

  it('reproduce the root across three tile levels, reading the partial tiles the tree size needs', async () => {
    const log = new LogStandIn()
    log.grow(70_000)
    const leaves = Array.from({ length: 70_000 }, (_, index) => leafHash(Buffer.from(String(index))))
    const root = treeRoot(leaves)
    for (const index of [0, 1, 255, 256, 65_535, 65_536, 69_887, 69_888, 69_999]) {
      const proof = await inclusionProofFromTiles(index, 70_000, served(log))
      expect(rootFromInclusionProof(index, 70_000, leaves[index]!, proof)).toEqual(root)
    }
    expect(log.tileRequests).toEqual(expect.arrayContaining(['tile/0/273.p/112', 'tile/1/001.p/17', 'tile/2/000.p/1']))
    expect(log.tileRequests.filter(path => path.includes('.p/')).every(path => ['tile/0/273.p/112', 'tile/1/001.p/17', 'tile/2/000.p/1'].includes(path))).toBe(true)
  })

  it('reads a partial tile the log no longer serves from the first hashes of its full tile', async () => {
    const log = new LogStandIn()
    log.grow(600)
    log.keepsReplacedPartials = false
    const leaves = Array.from({ length: 300 }, (_, index) => leafHash(Buffer.from(String(index))))
    const proof = await inclusionProofFromTiles(299, 300, served(log))
    expect(rootFromInclusionProof(299, 300, leaves[299]!, proof)).toEqual(treeRoot(leaves))
    expect(log.tileRequests).toEqual(expect.arrayContaining(['tile/0/001.p/44', 'tile/0/001']))
  })

  it('refuses when the log serves neither the partial nor the full tile', async () => {
    const log = new LogStandIn()
    log.grow(300)
    await expect(inclusionProofFromTiles(299, 300, path => Promise.resolve(path.startsWith('tile/0/001') ? undefined : log.tile(path)))).rejects.toThrow('the log serves neither tile/0/001.p/44 nor tile/0/001')
  })

  it('refuses a tile of the wrong length and a leaf outside the tree', async () => {
    const log = new LogStandIn()
    log.grow(5)
    await expect(inclusionProofFromTiles(2, 5, path => Promise.resolve(log.tile(path)?.subarray(1)))).rejects.toThrow('tile/0/000.p/5 holds 159 bytes, not 160')
    await expect(inclusionProofFromTiles(5, 5, served(log))).rejects.toThrow('leaf 5 is not in a tree of size 5')
  })
})

describe('consistency proofs from tiles', () => {
  it('equal RFC 6962\'s consistency proof for every pair of tree sizes up to 40 leaves', async () => {
    const log = new LogStandIn()
    log.grow(40)
    const leaves = Array.from({ length: 40 }, (_, index) => leafHash(Buffer.from(String(index))))
    for (let second = 1; second <= 40; second++) {
      for (let first = 1; first <= second; first++) {
        const proof = await consistencyProofFromTiles(first, second, served(log))
        expect(proof, `${String(first)} to ${String(second)}`).toEqual(consistencyProof(first, leaves.slice(0, second)))
      }
    }
  })

  it('verify across three tile levels, from a tree size that is no multiple of a tile', async () => {
    const log = new LogStandIn()
    log.grow(70_000)
    const leaves = Array.from({ length: 70_000 }, (_, index) => leafHash(Buffer.from(String(index))))
    const proof = await consistencyProofFromTiles(40_321, 70_000, served(log))
    expect(verifyConsistency(40_321, 70_000, treeRoot(leaves.slice(0, 40_321)), treeRoot(leaves), proof)).toBe(true)
  })

  it('reads no tile for equal sizes, and refuses sizes that are not a tree and a larger tree', async () => {
    const log = new LogStandIn()
    expect(await consistencyProofFromTiles(5, 5, served(log))).toEqual([])
    expect(log.tileRequests).toEqual([])
    await expect(consistencyProofFromTiles(0, 5, served(log))).rejects.toThrow('not a prefix')
    await expect(consistencyProofFromTiles(6, 5, served(log))).rejects.toThrow('not a prefix')
  })

  it('refuses a tile the log does not serve or serves at the wrong length, as an answer that does not hold together', async () => {
    const log = new LogStandIn()
    log.grow(40)
    await expect(consistencyProofFromTiles(10, 40, () => Promise.resolve(undefined))).rejects.toThrow('the log serves neither tile/0/000.p/40 nor tile/0/000')
    await expect(consistencyProofFromTiles(10, 300, () => Promise.resolve(undefined))).rejects.toThrow(/^the log serves neither tile\/0\/000$/u)
    await expect(consistencyProofFromTiles(10, 40, () => Promise.resolve(new Uint8Array(33)))).rejects.toBeInstanceOf(TileError)
  })
})
