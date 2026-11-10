/**
 * Inclusion and consistency proofs read from a log's tiles (C2SP `tlog-tiles`), which is how Rekor v2 serves its Merkle
 * tree: it has no proof endpoint. A tile at level `L` holds up to 256 consecutive node hashes of tree level `8L`; level 0 holds leaf
 * hashes. The tile `N` of a level is at `tile/<L>/<N>`, with `N` in zero-padded three-digit path elements of which all
 * but the last begin with `x`, and the rightmost tile of a tree size that does not fill it is the partial tile
 * `tile/<L>/<N>.p/<W>` of width `W`. A log may delete a partial tile once its full tile exists, so a missing partial
 * tile is read from the full tile's first `W` hashes. The proofs computed here are the RFC 6962 audit path and the RFC 6962
 * consistency proof; whether they reproduce a checkpoint's root is what the bundle verification and the online check
 * verify.
 *
 * @module @delo/release-formats/log/tiles
 */
import { nodeHash } from './merkle.ts'

/** A log answer that does not hold together: a tile the log's checkpoint says exists but it does not serve, or a tile of the wrong length. */
export class TileError extends Error {
  override readonly name = 'TileError'
}

/** Hashes in a full tile. */
export const TILE_WIDTH = 256

/** Tree levels a tile spans. */
const TILE_HEIGHT = 8

/** Bytes of one hash. */
const HASH_SIZE = 32

/**
 * Reads one tile.
 * @param path - the tile's path below the log's tile prefix, such as `tile/0/x001/234.p/17`.
 * @returns the tile's bytes, or `undefined` when the log does not serve it.
 */
export type TileFetcher = (path: string) => Promise<Uint8Array | undefined>

/**
 * The path of a tile.
 * @param level - the tile level, 0 to 63.
 * @param index - the tile's index within its level.
 * @param width - the width of a partial tile, 1 to 255; absent for a full tile.
 * @returns `tile/<L>/<N>[.p/<W>]`.
 */
export function tilePath(level: number, index: number, width?: number): string {
  const digits = String(index).padStart(Math.ceil(String(index).length / 3) * 3, '0')
  const groups = digits.match(/\d{3}/gu)!
  const encoded = groups.map((group, position) => (position < groups.length - 1 ? `x${group}` : group)).join('/')
  return `tile/${String(level)}/${encoded}${width === undefined ? '' : `.p/${String(width)}`}`
}

/** The node hashes of one tree size, read from its tiles; each tile is fetched at most once. */
class TileTree {
  private readonly tiles = new Map<string, Promise<Buffer>>()

  constructor(private readonly size: number, private readonly fetchTile: TileFetcher) {}

  /** The hashes a tile holds for this tree size, from the partial tile or, when the log no longer serves it, the full one. */
  private async tile(level: number, index: number): Promise<Buffer> {
    const stored = Math.floor(this.size / TILE_WIDTH ** level)
    const width = Math.min(TILE_WIDTH, stored - index * TILE_WIDTH)
    const key = `${String(level)}/${String(index)}`
    let pending = this.tiles.get(key)
    if (pending === undefined) {
      pending = this.read(level, index, width)
      this.tiles.set(key, pending)
    }
    return pending
  }

  private async read(level: number, index: number, width: number): Promise<Buffer> {
    if (width < TILE_WIDTH) {
      const partial = await this.fetchTile(tilePath(level, index, width))
      if (partial !== undefined) return checkedTile(tilePath(level, index, width), partial, width)
    }
    const full = await this.fetchTile(tilePath(level, index))
    if (full === undefined) {
      throw new TileError(`the log serves neither ${width < TILE_WIDTH ? `${tilePath(level, index, width)} nor ` : ''}${tilePath(level, index)}`)
    }
    return checkedTile(tilePath(level, index), full, TILE_WIDTH).subarray(0, width * HASH_SIZE)
  }

  /**
   * The hash of the complete subtree of `2^height` leaves that starts at leaf `index * 2^height`.
   * @param height - the subtree's height.
   * @param index - the subtree's index among subtrees of that height.
   * @returns the hash.
   */
  async node(height: number, index: number): Promise<Buffer> {
    const level = Math.floor(height / TILE_HEIGHT)
    const below = height % TILE_HEIGHT
    const first = index * 2 ** below
    const tile = await this.tile(level, Math.floor(first / TILE_WIDTH))
    const offset = first % TILE_WIDTH
    let hashes: Buffer[] = []
    for (let position = offset; position < offset + 2 ** below; position++) hashes.push(tile.subarray(position * HASH_SIZE, (position + 1) * HASH_SIZE))
    while (hashes.length > 1) {
      const next: Buffer[] = []
      for (let position = 0; position < hashes.length; position += 2) next.push(nodeHash(hashes[position]!, hashes[position + 1]!))
      hashes = next
    }
    return hashes[0]!
  }

  /**
   * The RFC 6962 hash of the leaves `[start, end)`, where `start` is a multiple of the largest power of two below the
   * range's size, as every range of the audit path is.
   */
  async range(start: number, end: number): Promise<Buffer> {
    const count = end - start
    if (Number.isInteger(Math.log2(count))) return this.node(Math.log2(count), start / count)
    const split = 2 ** Math.floor(Math.log2(count - 1))
    return nodeHash(await this.range(start, start + split), await this.range(start + split, end))
  }

  /**
   * The RFC 6962 consistency proof (section 2.1.2) of the leaves `[start, end)` from their first `first` leaves, as
   * `SUBPROOF(first, D[start:end], complete)` defines it.
   */
  async consistency(first: number, start: number, end: number, complete: boolean): Promise<Buffer[]> {
    const count = end - start
    if (first === count) return complete ? [] : [await this.range(start, end)]
    const split = 2 ** Math.floor(Math.log2(count - 1))
    return first <= split
      ? [...await this.consistency(first, start, start + split, complete), await this.range(start + split, end)]
      : [...await this.consistency(first - split, start + split, end, false), await this.range(start, start + split)]
  }

  /** The audit path of a leaf within the leaves `[start, end)`, leaf level first. */
  async path(leaf: number, start: number, end: number): Promise<Buffer[]> {
    if (end - start <= 1) return []
    const split = 2 ** Math.floor(Math.log2(end - start - 1))
    return leaf < start + split
      ? [...await this.path(leaf, start, start + split), await this.range(start + split, end)]
      : [...await this.path(leaf, start + split, end), await this.range(start, start + split)]
  }
}

function checkedTile(path: string, bytes: Uint8Array, width: number): Buffer {
  if (bytes.byteLength !== width * HASH_SIZE) throw new TileError(`${path} holds ${String(bytes.byteLength)} bytes, not ${String(width * HASH_SIZE)}`)
  return Buffer.from(bytes)
}

/**
 * The inclusion proof of a leaf in a tree size, computed from the log's tiles.
 * @param index - the leaf's index.
 * @param size - the tree size, which a verified checkpoint names.
 * @param fetchTile - reads a tile below the log's tile prefix.
 * @returns the audit path, leaf level first.
 * @throws Error when the index is outside the tree, a tile the proof needs is not served, or a tile has the wrong length.
 */
export async function inclusionProofFromTiles(index: number, size: number, fetchTile: TileFetcher): Promise<Buffer[]> {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) throw new Error(`leaf ${String(index)} is not in a tree of size ${String(size)}`)
  return new TileTree(size, fetchTile).path(index, 0, size)
}

/**
 * The consistency proof that the tree of `first` leaves is a prefix of the tree of `second` leaves, computed from the
 * log's tiles.
 * @param first - the older tree size.
 * @param second - the newer tree size, at least `first`.
 * @param fetchTile - reads a tile below the log's tile prefix.
 * @returns the proof's hashes, oldest subtree first; empty when the sizes are equal.
 * @throws TileError when a tile the proof needs is not served or has the wrong length.
 * @throws Error when the sizes are not a tree and a larger tree.
 */
export async function consistencyProofFromTiles(first: number, second: number, fetchTile: TileFetcher): Promise<Buffer[]> {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || first > second) throw new Error(`a tree of size ${String(first)} is not a prefix of a tree of size ${String(second)}`)
  if (first === second) return []
  return new TileTree(second, fetchTile).consistency(first, 0, second, true)
}
