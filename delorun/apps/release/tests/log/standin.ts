/**
 * Local stand-ins for the release log and its witness, so the release-log specs need no network: an in-memory RFC
 * 6962 log that accepts `hashedrekord` v0.0.2 requests with the key types it is set to accept (Ed25519ph and ECDSA
 * P-256 by default, `PKIX_ED25519_PH` alone where a spec stands in for a Rekor v2 instance that refuses the other), builds
 * the entry body from them and signs checkpoints with a throwaway Ed25519 note key, and a witness that cosigns a
 * checkpoint with a throwaway cosignature key. The stand-in does not check the request's signature; the bundle
 * verifier does. The log serves its tree as C2SP `tlog-tiles` do, and can stop serving each partial tile whose full tile
 * exists, as a log may.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { HashedRekordRequest, ReleaseLogBundle } from '@delorun/contract-release-log'
import { entryBody } from '@delorun/release-formats/log/entry'
import { inclusionProof, leafHash, nodeHash, treeRoot } from '@delorun/release-formats/log/merkle'
import { checkpointBody, NOTE_COSIGNATURE, NOTE_ED25519, signatureLine, verifierKey } from '@delorun/release-formats/log/note'

/** The log refused an entry's key type, which Rekor v2 answers with HTTP 400 `invalid hashedrekord request`. */
export class EntryTypeRefused extends Error {
  /**
   * @param details - the refused key details.
   */
  constructor(details: string) {
    super(`unsupported entry algorithm ${details}`)
    this.name = 'EntryTypeRefused'
  }
}

/** An in-memory log. */
export class LogStandIn {
  readonly origin = 'log.example.test'
  readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey
  readonly vkey = verifierKey(this.origin, NOTE_ED25519, this.key)
  private readonly leaves: Buffer[] = []
  private readonly bodies: Buffer[] = []
  /** Whether the log still serves a partial tile once its full tile exists. */
  keepsReplacedPartials = true
  /** Every tile path asked for, in order. */
  readonly tileRequests: string[] = []
  /** The entry key types the log accepts; a spec removes one to stand in for a log that refuses it. */
  readonly accepts = new Set<string>(['PKIX_ED25519_PH', 'PKIX_ECDSA_P256_SHA_256'])
  /** The key details of every request submitted, accepted or refused, in order. */
  readonly submitted: string[] = []

  /**
   * Accept a request as Rekor v2 does: refuse key details the log does not accept and append the body built from it.
   * @param request - the request.
   * @returns the entry's index.
   * @throws EntryTypeRefused when the log does not accept the key details.
   */
  submit(request: HashedRekordRequest): number {
    const details: string = request.hashedRekordRequestV002.signature.verifier.keyDetails
    this.submitted.push(details)
    if (!this.accepts.has(details)) throw new EntryTypeRefused(details)
    return this.append(entryBody(request))
  }

  /**
   * The canonical body of an entry.
   * @param index - the entry's index.
   * @returns the body's bytes.
   */
  body(index: number): Buffer {
    return this.bodies[index]!
  }

  /**
   * Append an entry body as given, the way a log that accepted any body would.
   * @param body - the canonical entry body.
   * @returns its index.
   */
  append(body: Buffer): number {
    this.bodies.push(body)
    this.leaves.push(leafHash(body))
    return this.leaves.length - 1
  }

  /**
   * The signed checkpoint of the current tree, without cosignatures.
   * @returns the note text.
   */
  checkpoint(): string {
    const body = checkpointBody(this.origin, this.leaves.length, treeRoot(this.leaves))
    return `${body}\n${signatureLine(this.origin, this.key, body)}`
  }

  /**
   * Append leaf hashes directly, to grow the tree quickly in tile specs.
   * @param count - how many leaves to add; each is the leaf hash of its index's decimal text.
   */
  grow(count: number): void {
    for (let index = 0; index < count; index++) this.append(Buffer.from(String(this.leaves.length)))
  }

  /**
   * Answer a tile request as a tile server does.
   * @param path - the path below the tile prefix.
   * @returns the tile's bytes, or `undefined` for a tile the log does not serve.
   */
  tile(path: string): Buffer | undefined {
    this.tileRequests.push(path)
    const match = /^tile\/(\d+)\/((?:x\d{3}\/)*\d{3})(?:\.p\/(\d+))?$/u.exec(path)
    if (match === null) return undefined
    const level = Number(match[1])
    const index = Number(match[2]!.replaceAll('x', '').replaceAll('/', ''))
    const width = match[3] === undefined ? 256 : Number(match[3])
    if (match[3] !== undefined && (width < 1 || width > 255)) return undefined
    const hashes = this.level(level * 8)
    if (match[3] !== undefined && !this.keepsReplacedPartials && hashes.length >= (index + 1) * 256) return undefined
    const tile = hashes.slice(index * 256, index * 256 + width)
    return tile.length === width ? Buffer.concat(tile) : undefined
  }

  private levels: { size: number, hashes: Buffer[][] } = { size: -1, hashes: [] }

  /** The hashes of every complete subtree at a tree level, for the current size. */
  private level(height: number): Buffer[] {
    if (this.levels.size !== this.leaves.length) this.levels = { size: this.leaves.length, hashes: [this.leaves] }
    while (this.levels.hashes.length <= height) {
      const below = this.levels.hashes.at(-1)!
      const next: Buffer[] = []
      for (let position = 0; position + 1 < below.length; position += 2) next.push(nodeHash(below[position]!, below[position + 1]!))
      this.levels.hashes.push(next)
    }
    return this.levels.hashes[height]!
  }

  /**
   * The bundle of an entry at the current tree size.
   * @param index - the entry's index.
   * @param manifest - the manifest file's name and digest.
   * @param checkpoint - the (cosigned) checkpoint to include.
   * @returns the bundle.
   */
  bundle(index: number, manifest: ReleaseLogBundle['manifest'], checkpoint: string): ReleaseLogBundle {
    return {
      schema: 'delorun.release-log-bundle/1',
      manifest,
      entry: { logIndex: index, integratedTime: 0, body: this.bodies[index]!.toString('base64') },
      inclusion: { logIndex: index, treeSize: this.leaves.length, rootHash: treeRoot(this.leaves).toString('hex'), hashes: inclusionProof(index, this.leaves).map(hash => hash.toString('hex')) },
      checkpoint,
    }
  }
}

/** A witness that cosigns checkpoints. */
export class WitnessStandIn {
  readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey

  readonly name: string

  constructor(name = 'witness.example.test') {
    this.name = name
  }

  /** The witness's verifier key. */
  get vkey(): string {
    return verifierKey(this.name, NOTE_COSIGNATURE, this.key)
  }

  /**
   * Add this witness's cosignature line to a checkpoint note.
   * @param note - the checkpoint note.
   * @param time - the cosigning time in Unix seconds.
   * @returns the note with the cosignature appended.
   */
  cosign(note: string, time: number): string {
    const body = note.slice(0, note.lastIndexOf('\n\n') + 1)
    return `${note}${signatureLine(this.name, this.key, body, time)}`
  }
}
