/**
 * Ed25519 keys and contract C2's signature envelope. A key's id is the SHA-256 of its 32-byte raw public key; a
 * signature is a pure Ed25519 signature over the RFC 8785 bytes of the envelope's `signed` value; an envelope verifies
 * when distinct keys of the role's key set reach the role's threshold, ignoring unknown keys and counting a repeated
 * key once. Private keys are read from PKCS #8 PEM files that only their owner can read; this module never creates
 * one.
 *
 * @module @delorun/release-formats/sign/envelope
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { EnvelopeSignature, KeyId, PublicKey, SignedEnvelope } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalJson, type JsonValue } from './json.ts'

/** A public key with its id. */
export interface VerifyingKey {
  /** The key's id. */
  readonly keyid: KeyId
  /** The key. */
  readonly key: KeyObject
}

/**
 * The raw 32-byte Ed25519 public key of a key object.
 * @param key - an Ed25519 public or private key.
 * @returns the raw public key.
 * @throws Error when the key is not Ed25519.
 */
export function rawPublicKey(key: KeyObject): Buffer {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`the key is ${String(publicKey.asymmetricKeyType)}, not Ed25519`)
  return Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
}

/**
 * A key's id.
 * @param raw - the 32-byte raw public key.
 * @returns the lowercase hex SHA-256 of the raw key.
 */
export function keyIdOf(raw: Uint8Array): KeyId {
  return brandString<KeyId>(createHash('sha256').update(raw).digest('hex'))
}

/**
 * The verifying key of a root metadata key entry.
 * @param keyid - the id the root metadata lists it under.
 * @param entry - the entry.
 * @returns the key.
 * @throws Error when the public key is not 32 bytes of base64 or its id differs from `keyid`.
 */
export function verifyingKey(keyid: string, entry: PublicKey): VerifyingKey {
  const raw = Buffer.from(entry.public, 'base64')
  if (raw.byteLength !== 32 || raw.toString('base64') !== entry.public) throw new Error(`key ${keyid} is not a 32-byte base64 Ed25519 public key`)
  if (keyIdOf(raw) !== keyid) throw new Error(`key ${keyid} is listed under an id that is not the SHA-256 of its public key`)
  return { keyid: brandString<KeyId>(keyid), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }) }
}

/**
 * The root metadata entry of a public key.
 * @param key - an Ed25519 key.
 * @returns the entry and its id.
 */
export function publicKeyEntry(key: KeyObject): { keyid: KeyId, entry: PublicKey } {
  const raw = rawPublicKey(key)
  return { keyid: keyIdOf(raw), entry: { algorithm: 'ed25519', public: raw.toString('base64') } }
}

/**
 * Read a private signing key that only its owner can read.
 * @param path - a PKCS #8 PEM file holding an Ed25519 private key.
 * @returns the key.
 * @throws Error when the file is readable or writable by its group or others, or holds no Ed25519 private key.
 */
export function readSigningKey(path: string): KeyObject {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8).padStart(4, '0')}; a signing key file must be readable by its owner only (chmod 600)`)
  const key = createPrivateKey(readFileSync(path))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${path} holds a ${String(key.asymmetricKeyType)} key, not Ed25519`)
  return key
}

/**
 * The canonical bytes a signature covers.
 * @param signed - the envelope's content.
 * @returns its RFC 8785 serialization as UTF-8.
 */
export function signedBytes(signed: JsonValue): Buffer {
  return Buffer.from(canonicalJson(signed), 'utf8')
}

/**
 * Sign content with one key.
 * @param signed - the content.
 * @param key - an Ed25519 private key.
 * @returns the signature entry.
 */
export function signContent(signed: JsonValue, key: KeyObject): EnvelopeSignature {
  return { keyid: keyIdOf(rawPublicKey(key)), sig: sign(null, signedBytes(signed), key).toString('base64') }
}

/**
 * Add signatures to an envelope, replacing earlier signatures by the same keys.
 * @param envelope - the envelope.
 * @param keys - the signing keys.
 * @returns the signed envelope.
 */
export function signEnvelope<T extends JsonValue>(envelope: SignedEnvelope<T>, keys: readonly KeyObject[]): SignedEnvelope<T> {
  const added = keys.map(key => signContent(envelope.signed, key))
  const replaced = new Set(added.map(signature => signature.keyid))
  return { signed: envelope.signed, signatures: [...envelope.signatures.filter(signature => !replaced.has(signature.keyid)), ...added] }
}

/**
 * The distinct allowed keys whose signatures verify over an envelope's content.
 * @param envelope - the envelope.
 * @param allowed - the role's current keys.
 * @returns the ids of the keys that signed it; unknown keys and invalid signatures are left out, and a key counts once.
 */
export function validSigners(envelope: SignedEnvelope<JsonValue>, allowed: readonly VerifyingKey[]): Set<KeyId> {
  const bytes = signedBytes(envelope.signed)
  const valid = new Set<KeyId>()
  for (const signature of envelope.signatures) {
    const key = allowed.find(candidate => candidate.keyid === signature.keyid)
    if (key === undefined || valid.has(key.keyid)) continue
    const sig = Buffer.from(signature.sig, 'base64')
    if (sig.byteLength === 64 && sig.toString('base64') === signature.sig && verify(null, bytes, key.key, sig)) valid.add(key.keyid)
  }
  return valid
}
