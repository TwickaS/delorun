/**
 * C2SP signed notes as the release log uses them (contract C18): checkpoints (`tlog-checkpoint`) signed by the log's
 * Ed25519 note key, and witness cosignatures (`tlog-cosignature`, `cosignature/v1`) over them. A verifier key is
 * `<name>+<8 hex key hash>+<base64 of the type byte and the 32-byte public key>`; type 0x01 is a plain Ed25519 note
 * signature and type 0x04 a cosignature, whose signed message is `cosignature/v1\ntime <seconds>\n` followed by the
 * checkpoint body.
 *
 * @module @delo/release/log/note
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { rawPublicKey } from '../sign/envelope.ts'

/** The signature type of a plain Ed25519 note signature, as the log signs checkpoints. */
export const NOTE_ED25519 = 0x01

/** The signature type of a `cosignature/v1` witness cosignature. */
export const NOTE_COSIGNATURE = 0x04

const SIGNATURE_LINE = /^— (\S+) ([A-Za-z0-9+/]+={0,2})$/u

/** A parsed verifier key. */
export interface NoteVerifier {
  readonly name: string
  readonly type: number
  readonly keyHash: Buffer
  readonly key: KeyObject
}

/** A checkpoint's parsed body. */
export interface Checkpoint {
  readonly origin: string
  readonly size: number
  readonly rootHash: Buffer
  /** The body text the signatures cover, ending with a newline. */
  readonly body: string
}

/** One signature line of a note. */
export interface NoteSignature {
  readonly name: string
  readonly keyHash: Buffer
  readonly signature: Buffer
}

function keyHash(name: string, type: number, raw: Uint8Array): Buffer {
  return createHash('sha256').update(name, 'utf8').update('\n').update(Buffer.from([type])).update(raw).digest().subarray(0, 4)
}

/**
 * Parse a verifier key.
 * @param vkey - the key in signed-note verifier format.
 * @returns the parsed key.
 * @throws Error when the format, the key hash or the key type is wrong.
 */
export function parseVerifier(vkey: string): NoteVerifier {
  const match = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/u.exec(vkey)
  if (match === null) throw new Error(`verifier key ${JSON.stringify(vkey)} is malformed`)
  const name = match[1]!
  const hash = match[2]!
  const encoded = match[3]!
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength !== 33 || (bytes[0] !== NOTE_ED25519 && bytes[0] !== NOTE_COSIGNATURE)) throw new Error(`verifier key ${name} is not an Ed25519 note or cosignature key`)
  const raw = bytes.subarray(1)
  if (!keyHash(name, bytes[0]!, raw).equals(Buffer.from(hash, 'hex'))) throw new Error(`verifier key ${name} has a key hash that does not match its key`)
  return { name, type: bytes[0]!, keyHash: Buffer.from(hash, 'hex'), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }) }
}

/**
 * The verifier key of a signing key.
 * @param name - the key's name.
 * @param type - {@link NOTE_ED25519} or {@link NOTE_COSIGNATURE}.
 * @param key - an Ed25519 key.
 * @returns the verifier key string.
 */
export function verifierKey(name: string, type: number, key: KeyObject): string {
  const raw = rawPublicKey(key)
  return `${name}+${keyHash(name, type, raw).toString('hex')}+${Buffer.concat([Buffer.from([type]), raw]).toString('base64')}`
}

/**
 * Split a note into its body and signature lines.
 * @param note - the note text.
 * @returns the body (ending with a newline) and the signatures.
 * @throws Error when the note has no blank line before its signatures or a malformed signature line.
 */
export function splitNote(note: string): { body: string, signatures: NoteSignature[] } {
  const separator = note.lastIndexOf('\n\n')
  if (separator < 0 || !note.endsWith('\n')) throw new Error('the note has no signature block')
  const body = note.slice(0, separator + 1)
  const signatures = note.slice(separator + 2, -1).split('\n').map((line) => {
    const match = SIGNATURE_LINE.exec(line)
    if (match === null) throw new Error(`the note has a malformed signature line ${JSON.stringify(line)}`)
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.byteLength < 5) throw new Error('the note has a signature too short to hold a key hash')
    return { name: match[1]!, keyHash: bytes.subarray(0, 4), signature: bytes.subarray(4) }
  })
  return { body, signatures }
}

/**
 * Parse a checkpoint body.
 * @param body - the body text.
 * @returns the origin, size and root hash.
 * @throws Error when the body is not a checkpoint.
 */
export function parseCheckpoint(body: string): Checkpoint {
  const lines = body.split('\n')
  const [origin, size, root] = lines
  if (origin === undefined || origin === '' || size === undefined || !/^(0|[1-9]\d*)$/u.test(size) || root === undefined) throw new Error('the checkpoint body is malformed')
  const rootHash = Buffer.from(root, 'base64')
  if (rootHash.byteLength !== 32 || rootHash.toString('base64') !== root) throw new Error('the checkpoint root hash is not 32 bytes of base64')
  return { origin, size: Number(size), rootHash, body }
}

/**
 * Write a checkpoint body.
 * @param origin - the log's origin line.
 * @param size - the tree size.
 * @param rootHash - the tree's root hash.
 * @returns the body text.
 */
export function checkpointBody(origin: string, size: number, rootHash: Uint8Array): string {
  return `${origin}\n${String(size)}\n${Buffer.from(rootHash).toString('base64')}\n`
}

function cosignedMessage(body: string, time: bigint): Buffer {
  return Buffer.from(`cosignature/v1\ntime ${time.toString()}\n${body}`, 'utf8')
}

/**
 * A signature line over a body.
 * @param name - the signer's key name.
 * @param key - the signer's Ed25519 private key.
 * @param body - the note body.
 * @param cosignTime - for a cosignature, the cosigning time in Unix seconds.
 * @returns the line, ending with a newline.
 */
export function signatureLine(name: string, key: KeyObject, body: string, cosignTime?: number): string {
  const type = cosignTime === undefined ? NOTE_ED25519 : NOTE_COSIGNATURE
  const hash = keyHash(name, type, rawPublicKey(key))
  if (cosignTime === undefined) return `— ${name} ${Buffer.concat([hash, sign(null, Buffer.from(body, 'utf8'), key)]).toString('base64')}\n`
  const time = Buffer.alloc(8)
  time.writeBigUInt64BE(BigInt(cosignTime))
  return `— ${name} ${Buffer.concat([hash, time, sign(null, cosignedMessage(body, BigInt(cosignTime)), key)]).toString('base64')}\n`
}

/**
 * Whether a signature line verifies with a verifier key.
 * @param verifier - the key.
 * @param body - the note body.
 * @param line - the signature.
 * @returns for a note signature, `true`; for a cosignature, its cosigning time in Unix seconds; `false` when it does
 * not verify or names another key.
 */
export function verifySignature(verifier: NoteVerifier, body: string, line: NoteSignature): boolean | number {
  if (line.name !== verifier.name || !line.keyHash.equals(verifier.keyHash)) return false
  if (verifier.type === NOTE_ED25519) return line.signature.byteLength === 64 && verify(null, Buffer.from(body, 'utf8'), verifier.key, line.signature)
  if (line.signature.byteLength !== 72) return false
  const time = line.signature.readBigUInt64BE(0)
  return verify(null, cosignedMessage(body, time), verifier.key, line.signature.subarray(8)) ? Number(time) : false
}
