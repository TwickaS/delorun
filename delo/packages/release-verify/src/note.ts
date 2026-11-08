/**
 * C2SP signed notes as a client of contract C18 reads them: Rekor's checkpoint signature over a `tlog-checkpoint` body
 * (signature type 0x01) and witness cosignatures over the same body (type 0x04, `cosignature/v1`). A verifier key is
 * `<name>+<8 hex key hash>+<base64 of the type byte and the 32-byte public key>`, and a signature line is
 * `— <name> <base64 of the 4-byte key hash and the signature>`; a cosignature's signature is the 8-byte big-endian
 * cosigning time followed by an Ed25519 signature over `cosignature/v1\ntime <seconds>\n<body>`.
 *
 * The client only verifies: it has no code that signs a note, so nothing here can mint a checkpoint.
 *
 * @module @delo/release-verify/note
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { refuse } from './errors.ts'

/** The signature type of a note signature, as the log signs a checkpoint. */
export const NOTE_SIGNATURE = 0x01

/** The signature type of a `cosignature/v1` witness cosignature. */
export const NOTE_COSIGNATURE = 0x04

/** The key type byte of every Ed25519 note key. */
const ED25519_KEY_BYTES = 32

/** The length of an Ed25519 signature. */
const ED25519_SIGNATURE_BYTES = 64

/** The length of a cosignature's body: the cosigning time and the signature. */
const COSIGNATURE_BYTES = 8 + ED25519_SIGNATURE_BYTES

const SIGNATURE_LINE = /^— (\S+) ([A-Za-z0-9+/]+={0,2})$/u

const VERIFIER_KEY = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/u

const CHECKPOINT_SIZE = /^(0|[1-9]\d{0,15})$/u

/** A parsed verifier key. */
export interface NoteVerifier {
  /** The signer's name, which a signature line must repeat. */
  readonly name: string
  /** {@link NOTE_SIGNATURE} or {@link NOTE_COSIGNATURE}. */
  readonly type: number
  /** The 4-byte key hash a signature line carries. */
  readonly keyHash: Buffer
  /** The Ed25519 public key. */
  readonly key: KeyObject
}

/** A checkpoint's parsed body. */
export interface Checkpoint {
  /** The origin line the trusted root's log names. */
  readonly origin: string
  /** The tree size. */
  readonly size: number
  /** The tree's 32-byte root hash. */
  readonly rootHash: Buffer
  /** The body text the signatures cover, ending with a newline. */
  readonly body: string
}

/** One signature line of a note. */
export interface NoteSignature {
  /** The name the line carries. */
  readonly name: string
  /** The key hash the line carries. */
  readonly keyHash: Buffer
  /** The signature, without the key hash. */
  readonly signature: Buffer
}

/**
 * The 4-byte key hash of a note key: the first four bytes of SHA-256 over the name, a newline, the type byte and the
 * raw public key.
 * @param name - the key's name.
 * @param type - the signature type.
 * @param raw - the 32-byte raw public key.
 * @returns the key hash.
 */
function keyHashOf(name: string, type: number, raw: Uint8Array): Buffer {
  return createHash('sha256').update(name, 'utf8').update('\n').update(Buffer.from([type])).update(raw).digest().subarray(0, 4)
}

/**
 * Parse a verifier key from the trusted root.
 * @param vkey - the key in signed-note verifier format.
 * @returns the parsed key.
 * @throws ReleaseLogRefusalError `log-origin-untrusted` when the trusted root carries a key this client cannot read;
 * such a root names no log or witness this client can trust.
 */
export function parseVerifierKey(vkey: string): NoteVerifier {
  const match = VERIFIER_KEY.exec(vkey)
  if (match === null) throw refuse('log-origin-untrusted', 'the trusted root names a verifier key that is not in signed-note format')
  const name = match[1]!
  const encoded = match[3]!
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength !== 1 + ED25519_KEY_BYTES) throw refuse('log-origin-untrusted', `the trusted root's key ${name} is not a 32-byte Ed25519 note key`)
  const type = bytes[0]!
  if (type !== NOTE_SIGNATURE && type !== NOTE_COSIGNATURE) throw refuse('log-origin-untrusted', `the trusted root's key ${name} is neither a note key nor a cosignature key`)
  const raw = bytes.subarray(1)
  if (!keyHashOf(name, type, raw).equals(Buffer.from(match[2]!, 'hex'))) throw refuse('log-origin-untrusted', `the trusted root's key ${name} has a key hash that does not match its key`)
  return {
    name,
    type,
    keyHash: Buffer.from(match[2]!, 'hex'),
    key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }),
  }
}

/**
 * Split a signed note into its body and its signature lines.
 * @param note - the note text.
 * @returns the body, ending with a newline, and every signature.
 * @throws ReleaseLogRefusalError `checkpoint-malformed` when the note has no signature block or a malformed line.
 */
export function splitNote(note: string): { readonly body: string, readonly signatures: readonly NoteSignature[] } {
  const separator = note.lastIndexOf('\n\n')
  if (separator < 0 || !note.endsWith('\n')) throw refuse('checkpoint-malformed', 'the checkpoint has no signature block')
  const body = note.slice(0, separator + 1)
  const signatures = note.slice(separator + 2, -1).split('\n').map((line) => {
    const match = SIGNATURE_LINE.exec(line)
    if (match === null) throw refuse('checkpoint-malformed', 'the checkpoint has a malformed signature line')
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.byteLength < 5) throw refuse('checkpoint-malformed', 'the checkpoint has a signature line too short to hold a key hash')
    return { name: match[1]!, keyHash: bytes.subarray(0, 4), signature: bytes.subarray(4) }
  })
  return { body, signatures }
}

/**
 * Parse a checkpoint body.
 * @param body - the body text.
 * @returns the origin, the size and the root hash.
 * @throws ReleaseLogRefusalError `checkpoint-malformed` when the body is not `origin`, size, base64 root hash.
 */
export function parseCheckpoint(body: string): Checkpoint {
  const lines = body.split('\n')
  const origin = lines[0]
  const size = lines[1]
  const root = lines[2]
  if (origin === undefined || origin === '' || size === undefined || !CHECKPOINT_SIZE.test(size) || root === undefined) {
    throw refuse('checkpoint-malformed', 'the checkpoint body is not an origin line, a tree size and a root hash')
  }
  const rootHash = Buffer.from(root, 'base64')
  if (rootHash.byteLength !== 32 || rootHash.toString('base64') !== root) throw refuse('checkpoint-malformed', 'the checkpoint root hash is not 32 bytes of base64')
  return { origin, size: Number(size), rootHash, body }
}

/**
 * Write a checkpoint body.
 * @param origin - the log's origin line.
 * @param size - the tree size.
 * @param rootHash - the tree's 32-byte root hash.
 * @returns the body text, ending with a newline.
 */
export function checkpointBody(origin: string, size: number, rootHash: Uint8Array): string {
  return `${origin}\n${String(size)}\n${Buffer.from(rootHash).toString('base64')}\n`
}

/**
 * The message a cosignature covers.
 * @param body - the note body.
 * @param time - the cosigning time in Unix seconds.
 * @returns the signed bytes.
 */
function cosignedMessage(body: string, time: bigint): Buffer {
  return Buffer.from(`cosignature/v1\ntime ${time.toString()}\n${body}`, 'utf8')
}

/**
 * Verify one signature line against one verifier key. A line that names another key, or that does not verify, matches
 * nothing: a cosignature from a key outside the trusted root's witnesses never counts, and an unlisted key is not an
 * error in itself.
 * @param verifier - the key from the trusted root.
 * @param body - the note body.
 * @param line - the signature line.
 * @returns `true` for a note signature that verifies, the cosigning time in Unix seconds for a cosignature that
 * verifies, and `false` otherwise.
 */
export function verifySignature(verifier: NoteVerifier, body: string, line: NoteSignature): boolean | number {
  if (line.name !== verifier.name || !line.keyHash.equals(verifier.keyHash)) return false
  if (verifier.type === NOTE_SIGNATURE) {
    return line.signature.byteLength === ED25519_SIGNATURE_BYTES && verify(null, Buffer.from(body, 'utf8'), verifier.key, line.signature)
  }
  if (line.signature.byteLength !== COSIGNATURE_BYTES) return false
  const time = line.signature.readBigUInt64BE(0)
  return verify(null, cosignedMessage(body, time), verifier.key, line.signature.subarray(8)) ? Number(time) : false
}
