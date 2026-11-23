/**
 * Fixtures of the release-log specs: throwaway Ed25519 keys generated in the test, an in-memory RFC 6962 log that
 * builds entry bodies, inclusion and consistency proofs the way a log serves them, a witness that cosigns a
 * checkpoint, and a checkpoint distributor stand-in the online check reads. Every answer is computed locally, so no
 * spec reaches the network, the log or a witness, and no key here is a real one.
 *
 * The tree builders are written from RFC 6962 §2.1 rather than from the package's own hashing, so a verifier that
 * mis-hashes a leaf or a node cannot agree with them.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ed25519ph } from '@noble/curves/ed25519.js'
import {
  RELEASE_LOG_BUNDLE_SCHEMA,
  RELEASE_LOG_ENTRY_API_VERSION,
  RELEASE_LOG_ENTRY_DIGEST_ALGORITHM,
  RELEASE_LOG_ENTRY_KEY_DETAILS,
  RELEASE_LOG_ENTRY_TYPE,
  type ReleaseLogBundle,
} from '@delorun/contract-release-log'
import { RELEASE_SCHEMAS, type KeyId, type PublicKey, type RootMetadata, type SemanticVersion, type Sha256Hex, type UtcTimestamp } from '@delorun/contract-release-manifest'
import type { ReleaseLogTransport } from '../src/online.ts'

/** The signature type of a log's checkpoint signature. */
export const NOTE_SIGNATURE = 0x01

/** The signature type of a witness cosignature. */
export const NOTE_COSIGNATURE = 0x04

/** The version every fixture release carries. */
export const VERSION = '0.1.0'

/** The manifest file's bytes, as the client verified them under contract C2. */
export const MANIFEST = Buffer.from('{"schema":"delorun.release-manifest/1","version":"0.1.0"}\n')

/** Throwaway keys: a trusted targets key, an unrelated one, the log's note key, and two witness keys. */
export interface Keys {
  readonly targets: KeyObject
  readonly other: KeyObject
  readonly log: KeyObject
  readonly witness: KeyObject
  readonly stranger: KeyObject
}

/**
 * New throwaway Ed25519 keys, one per role the specs need.
 * @returns the private keys.
 */
export function throwawayKeys(): Keys {
  const next = (): KeyObject => generateKeyPairSync('ed25519').privateKey
  return { targets: next(), other: next(), log: next(), witness: next(), stranger: next() }
}

/**
 * A key's 32-byte raw public value.
 * @param key - the key.
 * @returns the raw bytes.
 */
export function rawPublic(key: KeyObject): Buffer {
  const x = createPublicKey(key).export({ format: 'jwk' }).x
  if (x === undefined) throw new Error('the fixture key is not an Ed25519 key')
  return Buffer.from(x, 'base64url')
}

/**
 * A key's 32-byte private seed.
 * @param key - the private key.
 * @returns the seed, which `@noble/curves` signs with.
 */
function seedOf(key: KeyObject): Buffer {
  const d = createPrivateKey({ key: key.export({ format: 'der', type: 'pkcs8' }), format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }).d
  if (d === undefined) throw new Error('the fixture key holds no private value')
  return Buffer.from(d, 'base64url')
}

/**
 * The public key entry a trusted root lists for a key.
 * @param key - the key.
 * @returns the entry.
 */
export function publicEntry(key: KeyObject): PublicKey {
  return { algorithm: 'ed25519', public: rawPublic(key).toString('base64') }
}

/**
 * A key's id: the lowercase hex SHA-256 of its raw public value, as contract C2 names keys.
 * @param key - the key.
 * @returns the id.
 */
export function keyId(key: KeyObject): KeyId {
  return brandString<KeyId>(createHash('sha256').update(rawPublic(key)).digest('hex'))
}

/**
 * The 4-byte key hash of a signed-note key.
 * @param name - the key's name.
 * @param type - the signature type.
 * @param key - the key.
 * @returns the hash.
 */
function keyHashOf(name: string, type: number, key: KeyObject): Buffer {
  return createHash('sha256').update(name, 'utf8').update('\n').update(Buffer.from([type])).update(rawPublic(key)).digest().subarray(0, 4)
}

/**
 * A key in signed-note verifier format.
 * @param name - the key's name.
 * @param type - the signature type.
 * @param key - the key.
 * @returns the verifier key, as a trusted root carries one.
 */
export function verifierKey(name: string, type: number, key: KeyObject): string {
  const encoded = Buffer.concat([Buffer.from([type]), rawPublic(key)]).toString('base64')
  return `${name}+${keyHashOf(name, type, key).toString('hex')}+${encoded}`
}

/**
 * One signature line of a signed note.
 * @param name - the signer's name.
 * @param type - the signature type.
 * @param key - the private key.
 * @param body - the note body the signature covers.
 * @param time - the cosigning time in Unix seconds, for a cosignature.
 * @returns the signature line, ending with a newline.
 * @throws Error when a cosignature is asked for without a time.
 */
export function signatureLine(name: string, type: number, key: KeyObject, body: string, time?: number): string {
  const hash = keyHashOf(name, type, key)
  let signature: Buffer
  if (type === NOTE_COSIGNATURE) {
    if (time === undefined) throw new Error('a cosignature needs a cosigning time')
    const seconds = Buffer.alloc(8)
    seconds.writeBigUInt64BE(BigInt(time))
    signature = Buffer.concat([seconds, sign(null, Buffer.from(`cosignature/v1\ntime ${String(time)}\n${body}`, 'utf8'), key)])
  } else {
    signature = sign(null, Buffer.from(body, 'utf8'), key)
  }
  return `— ${name} ${Buffer.concat([hash, signature]).toString('base64')}\n`
}

/** RFC 6962's leaf prefix. */
const LEAF_PREFIX = Buffer.from([0x00])

/** RFC 6962's node prefix. */
const NODE_PREFIX = Buffer.from([0x01])

/**
 * The hash of one leaf, as RFC 6962 §2.1 defines it.
 * @param leaf - the leaf's bytes.
 * @returns the leaf hash.
 */
function hashLeaf(leaf: Uint8Array): Buffer {
  return createHash('sha256').update(LEAF_PREFIX).update(leaf).digest()
}

/**
 * The hash of an inner node, as RFC 6962 §2.1 defines it.
 * @param left - the left child's hash.
 * @param right - the right child's hash.
 * @returns the node hash.
 */
function hashNode(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(NODE_PREFIX).update(left).update(right).digest()
}

/**
 * The largest power of two strictly below a count, RFC 6962's `k`.
 * @param count - the count.
 * @returns the power.
 */
function splitAt(count: number): number {
  return 2 ** Math.floor(Math.log2(count - 1))
}

/**
 * The Merkle tree hash of a run of leaf hashes (RFC 6962 §2.1.1).
 * @param hashes - the leaf hashes.
 * @returns the subtree's root hash.
 */
export function treeRoot(hashes: readonly Buffer[]): Buffer {
  if (hashes.length === 0) return createHash('sha256').digest()
  const only = hashes[0]
  if (hashes.length === 1 && only !== undefined) return only
  const split = splitAt(hashes.length)
  return hashNode(treeRoot(hashes.slice(0, split)), treeRoot(hashes.slice(split)))
}

/**
 * The audit path of one leaf (RFC 6962 §2.1.3).
 * @param index - the leaf's index.
 * @param hashes - every leaf hash of the tree.
 * @returns the path, from the leaf's sibling up to the root.
 */
export function inclusionProof(index: number, hashes: readonly Buffer[]): Buffer[] {
  if (hashes.length <= 1) return []
  const split = splitAt(hashes.length)
  return index < split
    ? [...inclusionProof(index, hashes.slice(0, split)), treeRoot(hashes.slice(split))]
    : [...inclusionProof(index - split, hashes.slice(split)), treeRoot(hashes.slice(0, split))]
}

/**
 * The consistency proof from one tree size to another (RFC 6962 §2.1.2).
 * @param first - the older tree's size.
 * @param hashes - every leaf hash of the newer tree.
 * @param complete - whether the older tree's root is already known to the verifier.
 * @returns the proof's hashes.
 */
function subProof(first: number, hashes: readonly Buffer[], complete: boolean): Buffer[] {
  // SUBPROOF(m, D[m], true) is empty and SUBPROOF(m, D[m], false) is {MTH(D[m])}: the recursion stops when the run of
  // leaves is the older tree itself, whatever its size, not only when it is one leaf.
  if (first === hashes.length) return complete ? [] : [treeRoot(hashes)]
  const split = splitAt(hashes.length)
  return first <= split
    ? [...subProof(first, hashes.slice(0, split), complete), treeRoot(hashes.slice(split))]
    : [...subProof(first - split, hashes.slice(split), false), treeRoot(hashes.slice(0, split))]
}

/**
 * The consistency proof from the tree of `first` leaves to the tree of every leaf hash given.
 * @param first - the older tree's size.
 * @param hashes - every leaf hash of the newer tree.
 * @returns the proof's hashes.
 */
export function consistencyProof(first: number, hashes: readonly Buffer[]): Buffer[] {
  return subProof(first, hashes, true)
}

/** What an entry body the specs build may vary. */
export interface EntryBodyOptions {
  /** The manifest file the entry claims. */
  readonly manifest: Uint8Array
  /** The key that signs the entry. */
  readonly signer: KeyObject
  /** The verifier's public key, when it is not the signer's. */
  readonly verifier?: KeyObject
  /** The entry's `kind`; `hashedrekord` by default. */
  readonly kind?: string
  /** The entry's `apiVersion`; Rekor v2's `0.0.2` by default. */
  readonly apiVersion?: string
  /** The entry's digest algorithm; `SHA2_512` by default. */
  readonly algorithm?: string
  /** The digest the entry claims; the manifest's SHA-512 by default. */
  readonly digest?: string
  /** The entry's `keyDetails`; `PKIX_ED25519_PH` by default. */
  readonly keyDetails?: string
  /** The signature's bytes; the signer's Ed25519ph signature over the manifest by default. */
  readonly signature?: Uint8Array
}

/**
 * A Rekor v2 entry body, serialized as the log stores it.
 * @param options - what the body carries.
 * @returns the body's bytes.
 */
export function entryBody(options: EntryBodyOptions): Buffer {
  const signer = options.verifier ?? options.signer
  const der = createPublicKey(signer).export({ format: 'der', type: 'spki' }).toString('base64')
  return Buffer.from(JSON.stringify({
    apiVersion: options.apiVersion ?? RELEASE_LOG_ENTRY_API_VERSION,
    kind: options.kind ?? RELEASE_LOG_ENTRY_TYPE,
    spec: {
      hashedRekordV002: {
        data: {
          algorithm: options.algorithm ?? RELEASE_LOG_ENTRY_DIGEST_ALGORITHM,
          digest: options.digest ?? createHash('sha512').update(options.manifest).digest('base64'),
        },
        signature: {
          content: Buffer.from(options.signature ?? ed25519ph.sign(options.manifest, seedOf(options.signer))).toString('base64'),
          verifier: { publicKey: { rawBytes: der }, keyDetails: options.keyDetails ?? RELEASE_LOG_ENTRY_KEY_DETAILS },
        },
      },
    },
  }))
}

/** An in-memory log that serves the entries it accepted and the checkpoints it signs. */
export class FixtureLog {
  /** The origin line the trusted root names. */
  readonly origin: string = 'log.example.test'

  /** The log's note key. */
  readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey

  private readonly bodies: Buffer[] = []

  private readonly hashes: Buffer[] = []

  /** The log's verifier key, as a trusted root carries it. */
  get vkey(): string {
    return verifierKey(this.origin, NOTE_SIGNATURE, this.key)
  }

  /** The tree's size. */
  get size(): number {
    return this.hashes.length
  }

  /** The tree's root hash. */
  get rootHash(): Buffer {
    return treeRoot(this.hashes)
  }

  /** Every leaf hash of the tree, from the first entry up. */
  get leafHashes(): readonly Buffer[] {
    return this.hashes
  }

  /**
   * Accept an entry, as Rekor v2 does when it appends the body built from a request.
   * @param body - the entry body.
   * @returns the entry's index.
   */
  append(body: Buffer): number {
    this.bodies.push(body)
    this.hashes.push(hashLeaf(body))
    return this.hashes.length - 1
  }

  /**
   * Submit a manifest's entry, signed by a targets key.
   * @param manifest - the manifest file's bytes.
   * @param signer - the targets key that signs the entry.
   * @returns the entry's index.
   */
  submit(manifest: Uint8Array, signer: KeyObject): number {
    return this.append(entryBody({ manifest, signer }))
  }

  /**
   * The body of one entry.
   * @param index - the entry's index.
   * @returns the body's bytes.
   * @throws Error when no entry holds that index.
   */
  body(index: number): Buffer {
    const body = this.bodies[index]
    if (body === undefined) throw new Error(`the fixture log holds no entry ${String(index)}`)
    return body
  }

  /**
   * The signed checkpoint of the current tree, without cosignatures.
   * @returns the note text.
   */
  checkpoint(): string {
    return this.note(this.size, this.rootHash)
  }

  /**
   * A checkpoint this log's key signs for any tree, without cosignatures: the tree of its first `size` entries, or a
   * tree it never held when a spec names another root hash.
   * @param size - the tree size.
   * @param rootHash - the root hash; the root of the first `size` entries by default.
   * @returns the note text.
   */
  note(size: number, rootHash: Buffer = treeRoot(this.hashes.slice(0, size))): string {
    const body = `${this.origin}\n${String(size)}\n${rootHash.toString('base64')}\n`
    return `${body}\n${signatureLine(this.origin, NOTE_SIGNATURE, this.key, body)}`
  }

  /**
   * The bundle of one entry at the current tree size.
   * @param index - the entry's index.
   * @param name - the manifest file's name.
   * @param sha256 - the manifest file's SHA-256, lowercase hex.
   * @param checkpoint - the cosigned checkpoint to carry.
   * @returns the bundle.
   */
  bundle(index: number, name: string, sha256: string, checkpoint: string): ReleaseLogBundle {
    return {
      schema: RELEASE_LOG_BUNDLE_SCHEMA,
      manifest: { name, sha256: brandString<Sha256Hex>(sha256) },
      entry: { logIndex: index, integratedTime: 0, body: this.body(index).toString('base64') },
      inclusion: { logIndex: index, treeSize: this.size, rootHash: this.rootHash.toString('hex'), hashes: inclusionProof(index, this.hashes).map(hash => hash.toString('hex')) },
      checkpoint,
    }
  }
}

/** A witness that cosigns checkpoints with its own key. */
export class FixtureWitness {
  /** The witness's note key. */
  readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey

  readonly name: string

  /**
   * @param name - the witness's name.
   */
  constructor(name = 'witness.example.test') {
    this.name = name
  }

  /** The witness's verifier key, as a trusted root carries it. */
  get vkey(): string {
    return verifierKey(this.name, NOTE_COSIGNATURE, this.key)
  }

  /**
   * Add this witness's cosignature to a checkpoint note.
   * @param note - the signed checkpoint.
   * @param time - the cosigning time in Unix seconds.
   * @returns the note with the cosignature line appended.
   */
  cosign(note: string, time: number): string {
    const body = note.slice(0, note.lastIndexOf('\n\n') + 1)
    return `${note}${signatureLine(this.name, NOTE_COSIGNATURE, this.key, body, time)}`
  }
}

/** The trusted root's fields the specs replace. */
export interface RootOptions {
  /** The log the root names. */
  readonly log?: { readonly origin: string, readonly vkey: string }
  /** The witnesses the root names. */
  readonly witnesses?: { readonly keys: readonly { readonly name: string, readonly vkey: string }[], readonly threshold: number }
  /** The log-entry keys the root lists, in place of the targets key as its one Ed25519ph key. */
  readonly logEntryKeys?: RootMetadata['logEntryKeys']
  /** The targets keys the root lists, in place of the one active key. */
  readonly targets?: readonly { readonly keyid: KeyId, readonly status: 'active' | 'retired' | 'revoked', readonly lastRelease?: SemanticVersion }[]
}

/**
 * Trusted root metadata over the fixture keys.
 * @param keys - the fixture keys.
 * @param log - the fixture log the root names.
 * @param witnesses - the witnesses the root names.
 * @param options - fields to replace.
 * @returns the root metadata.
 */
export function rootMetadata(keys: Keys, log: FixtureLog, witnesses: readonly FixtureWitness[], options: RootOptions = {}): RootMetadata {
  const listed = [keys.targets, keys.other, keys.log, keys.witness]
  const trustedLog = options.log ?? { origin: log.origin, vkey: log.vkey }
  return {
    schema: RELEASE_SCHEMAS.root,
    version: 1,
    issued: brandString<UtcTimestamp>('2026-11-01T00:00:00Z'),
    expires: brandString<UtcTimestamp>('2027-10-01T00:00:00Z'),
    keys: Object.fromEntries(listed.map(key => [keyId(key), publicEntry(key)])),
    roles: {
      root: { keyids: [keyId(keys.log)], threshold: 1 },
      targets: { keys: options.targets ?? [{ keyid: keyId(keys.targets), status: 'active' }], threshold: 1 },
      timestamp: { keyids: [keyId(keys.other)], threshold: 1 },
      catalogue: { keyids: [keyId(keys.other)], threshold: 1 },
    },
    log: trustedLog,
    logs: [trustedLog],
    witnesses: options.witnesses ?? { keys: witnesses.map(witness => ({ name: witness.name, vkey: witness.vkey })), threshold: 1 },
    logEntryKeys: options.logEntryKeys ?? [{ keyDetails: 'PKIX_ED25519_PH', public: createPublicKey(keys.targets).export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' }],
  }
}

/** A checkpoint distributor and log stand-in the online check reads, answering from fields a spec sets. */
export class FixtureTransport implements ReleaseLogTransport {
  /** The note the distributor serves. */
  note = ''

  /** The proof the log serves. */
  proof: readonly string[] = []

  /** Proofs served for a given older tree size, ahead of {@link proof}. */
  readonly proofsFrom = new Map<number, readonly string[]>()

  /** What the distributor throws, when it is unreachable. */
  distributorFailure: Error | undefined = undefined

  /** What the log throws, when it is unreachable. */
  logFailure: Error | undefined = undefined

  /** Every consistency proof asked for, in order. */
  readonly asked: { readonly first: number, readonly second: number }[] = []

  /**
   * Serve the note the distributor holds.
   * @returns the note.
   * @throws Error when the distributor is unreachable.
   */
  async latestCheckpoint(): Promise<string> {
    if (this.distributorFailure !== undefined) throw this.distributorFailure
    return this.note
  }

  /**
   * Serve the proof the log holds.
   * @param first - the older tree's size.
   * @param second - the newer tree's size.
   * @returns the proof's hashes.
   * @throws Error when the log is unreachable.
   */
  async consistencyProof(first: number, second: number): Promise<readonly string[]> {
    this.asked.push({ first, second })
    if (this.logFailure !== undefined) throw this.logFailure
    return this.proofsFrom.get(first) ?? this.proof
  }
}

/** A log with one entry for {@link MANIFEST}, an earlier and a later entry around it, and a cosigned checkpoint. */
export interface Scenario {
  readonly keys: Keys
  readonly log: FixtureLog
  readonly witness: FixtureWitness
  readonly root: RootMetadata
  /** The bundle of the manifest's entry, cosigned at {@link COSIGNED_AT}. */
  readonly bundle: ReleaseLogBundle
}

/** The cosigning time every fixture checkpoint carries. */
export const COSIGNED_AT = 1_793_981_700

/**
 * The standard fixture: a log holding an earlier entry, the manifest's entry and a later one, a witness that cosigned
 * the checkpoint, and the trusted root over them.
 * @returns the fixture.
 */
export function scenario(): Scenario {
  const keys = throwawayKeys()
  const log = new FixtureLog()
  const witness = new FixtureWitness()
  log.append(Buffer.from('an earlier entry'))
  const index = log.submit(MANIFEST, keys.targets)
  log.append(Buffer.from('a later entry'))
  const root = rootMetadata(keys, log, [witness])
  const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', createHash('sha256').update(MANIFEST).digest('hex'), witness.cosign(log.checkpoint(), COSIGNED_AT))
  return { keys, log, witness, root, bundle }
}

/**
 * A `fetch` that answers as a tlog-tiles log over a fixture log: `<prefix>/checkpoint` serves a note the spec sets, and
 * `<prefix>/tile/<L>/<N>[.p/<W>]` serves the hashes of the tree at the size the spec sets, computed by RFC 6962 §2.1
 * from the log's leaf hashes. Every request is recorded, and a spec can replace any answer by URL.
 */
export class FixtureTiles {
  /** Every URL fetched, in order. */
  readonly requested: string[] = []

  /** The init each request carried. */
  readonly inits: (RequestInit | undefined)[] = []

  /** Answers that replace the computed ones, by URL. */
  readonly answers = new Map<string, () => Response>()

  /** The cosigned note `/checkpoint` serves. */
  note = ''

  readonly prefix: string
  readonly hashes: readonly Buffer[]
  public size: number

  /**
   * @param prefix - the tiles prefix, `https://<origin>`.
   * @param hashes - the leaf hashes of the log's tree.
   * @param size - the tree size the tiles are served for; every leaf by default.
   */
  constructor(prefix: string, hashes: readonly Buffer[], size: number = hashes.length) {
    this.prefix = prefix
    this.hashes = hashes
    this.size = size
  }

  /** The fetch to inject. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    this.requested.push(url)
    this.inits.push(init)
    const answer = this.answers.get(url)
    if (answer !== undefined) return answer()
    if (url === `${this.prefix}/checkpoint`) return new Response(this.note)
    const match = new RegExp(`^${this.prefix.replaceAll('.', '\\.')}/tile/(\\d+)/((?:x\\d{3}/)*\\d{3})(?:\\.p/(\\d+))?$`, 'u').exec(url)
    if (match === null) return new Response('not found', { status: 404 })
    const level = Number(match[1])
    const index = Number(match[2]!.replaceAll('x', '').replaceAll('/', ''))
    const span = 256 ** level
    const filled = Math.min(256, Math.floor(this.size / span) - index * 256)
    const width = match[3] === undefined ? 256 : Number(match[3])
    if (filled < width || (match[3] === undefined && filled < 256)) return new Response('not found', { status: 404 })
    const tile = Array.from({ length: width }, (_, at) => treeRoot(this.hashes.slice((index * 256 + at) * span, (index * 256 + at + 1) * span)))
    return new Response(Buffer.concat(tile))
  }
}

/**
 * Leaf hashes for a tree of any size, without entry bodies: the hash of each index.
 * @param count - the number of leaves.
 * @returns the hashes.
 */
export function syntheticLeaves(count: number): Buffer[] {
  return Array.from({ length: count }, (_, at) => createHash('sha256').update(Buffer.from([0x00])).update(`leaf ${String(at)}`).digest())
}
