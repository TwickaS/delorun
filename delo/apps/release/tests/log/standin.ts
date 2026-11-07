/**
 * Local stand-ins for the release log and its witness, so the release-log specs need no network: an in-memory RFC
 * 6962 log that, like Rekor v2, accepts `hashedrekord` v0.0.2 requests only with `PKIX_ED25519_PH` key details, builds
 * the entry body from them and signs checkpoints with a throwaway Ed25519 note key, and a witness that cosigns a
 * checkpoint with a throwaway cosignature key. The stand-in does not check the request's signature; the bundle
 * verifier does.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { RELEASE_LOG_ENTRY_KEY_DETAILS, type HashedRekordRequest, type ReleaseLogBundle } from '@delo/contract-release-log'
import { entryBody } from '../../src/log/entry.ts'
import { inclusionProof, leafHash, treeRoot } from '../../src/log/merkle.ts'
import { checkpointBody, NOTE_COSIGNATURE, NOTE_ED25519, signatureLine, verifierKey } from '../../src/log/note.ts'

/** An in-memory log. */
export class LogStandIn {
  readonly origin = 'log.example.test/release-log'
  readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey
  readonly vkey = verifierKey(this.origin, NOTE_ED25519, this.key)
  private readonly leaves: Buffer[] = []
  private readonly bodies: Buffer[] = []

  /**
   * Accept a request as Rekor v2 does: refuse key details other than Ed25519ph and append the body built from it.
   * @param request - the request.
   * @returns the entry's index.
   * @throws Error when the key details are not `PKIX_ED25519_PH`.
   */
  submit(request: HashedRekordRequest): number {
    const details: string = request.hashedRekordRequestV002.signature.verifier.keyDetails
    if (details !== RELEASE_LOG_ENTRY_KEY_DETAILS) throw new Error(`unsupported entry algorithm ${details}`)
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
   * The bundle of an entry at the current tree size.
   * @param index - the entry's index.
   * @param manifest - the manifest file's name and digest.
   * @param checkpoint - the (cosigned) checkpoint to include.
   * @returns the bundle.
   */
  bundle(index: number, manifest: ReleaseLogBundle['manifest'], checkpoint: string): ReleaseLogBundle {
    return {
      schema: 'delo.release-log-bundle/1',
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

  constructor(readonly name = 'witness.example.test') {}

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
