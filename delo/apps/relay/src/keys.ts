/**
 * The key and byte-string primitives the relay protocol uses: base64url without padding for
 * every byte string, SHA-256 ids of raw Ed25519 public keys, Ed25519 signature verification
 * that answers false instead of throwing, and the length-checked decoders that every value of
 * an untrusted message passes through. C6 signs over the RFC 8785 serialization of a value
 * without its `signature` field; this module supplies only the key side of that rule.
 *
 * @module @delo/relay/keys
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { RelayError } from './errors.ts'

/** Base64url without padding, as C6 writes every byte string. */
const BASE64URL = /^[A-Za-z0-9_-]*$/

/**
 * Encode bytes as base64url without padding.
 * @param bytes - the bytes.
 * @returns the text.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Decode base64url without padding, checking the length the field requires.
 * @param text - the presented text.
 * @param length - the byte length the field requires, or `undefined` for any length.
 * @returns the bytes.
 * @throws RelayError `PROTOCOL_ERROR` for text that is not base64url or has another length.
 */
export function fromBase64Url(text: string, length?: number): Uint8Array {
  if (!BASE64URL.test(text)) throw new RelayError('PROTOCOL_ERROR', 'a base64url field holds another character')
  const bytes = Buffer.from(text, 'base64url')
  if (length !== undefined && bytes.byteLength !== length) throw new RelayError('PROTOCOL_ERROR', `a base64url field holds ${String(bytes.byteLength)} bytes where the protocol fixes ${String(length)}`)
  return bytes
}

/**
 * Random bytes as base64url, for a challenge nonce or a token id.
 * @param length - the number of random bytes.
 * @returns the text.
 */
export function randomBase64Url(length: number): string {
  return toBase64Url(randomBytes(length))
}

/**
 * A key id: the SHA-256 hash of the 32-byte raw public key, base64url without padding, as
 * C6's relay id and its token claims write it.
 * @param raw - the 32-byte raw public key.
 * @returns the id.
 */
export function keyIdOf(raw: Uint8Array): string {
  return toBase64Url(createHash('sha256').update(raw).digest())
}

/**
 * The raw 32-byte public key of an Ed25519 key.
 * @param key - an Ed25519 public or private key.
 * @returns the raw public key.
 * @throws Error when the key is another type.
 */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`the key is ${String(publicKey.asymmetricKeyType)}, not Ed25519`)
  return Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
}

/**
 * An Ed25519 public key from its 32 raw bytes, as a relay binding holds it.
 * @param raw - the 32 raw bytes.
 * @returns the key.
 * @throws RelayError `CONFIG_INVALID` when the bytes are not a 32-byte Ed25519 public key.
 */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) throw new RelayError('CONFIG_INVALID', `a home public key holds ${String(raw.byteLength)} bytes where the protocol requires 32`)
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(raw) }, format: 'jwk' })
}

/**
 * A fresh Ed25519 key pair, for the relay's token key at its first start.
 * @returns the private key.
 */
export function generateEd25519(): KeyObject {
  return generateKeyPairSync('ed25519').privateKey
}

/**
 * An Ed25519 private key from its PKCS #8 PEM text.
 * @param pem - the PEM text.
 * @returns the key.
 * @throws RelayError `CONFIG_INVALID` when the text is not an Ed25519 PKCS #8 key.
 */
export function privateKeyFromPem(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error: unknown) {
    throw new RelayError('CONFIG_INVALID', `the token key is not a readable PKCS #8 private key: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new RelayError('CONFIG_INVALID', `the token key is ${String(key.asymmetricKeyType)}, not Ed25519`)
  return key
}

/**
 * Sign bytes with an Ed25519 private key.
 * @param key - the private key.
 * @param message - the bytes to sign.
 * @returns the 64-byte signature.
 */
export function signBytes(key: KeyObject, message: Uint8Array): Uint8Array {
  return sign(null, message, key)
}

/**
 * Verify an Ed25519 signature over bytes.
 * @param key - the public key.
 * @param message - the signed bytes.
 * @param signature - the presented signature.
 * @returns true only when the signature verifies; a malformed or wrong-length signature answers false.
 */
export function verifyBytes(key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, message, key, signature)
  } catch (_error: unknown) {
    // A signature of the wrong length or a key that cannot verify answers false: a malformed
    // value from the wire is a refusal, not a crash.
    return false
  }
}

/**
 * Concatenate byte strings, for the domain-separated proof message.
 * @param parts - the parts, in order.
 * @returns their concatenation.
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map(part => Buffer.from(part)))
}

/**
 * The UTF-8 bytes of a text, for a message a signature covers.
 * @param text - the text.
 * @returns its bytes.
 */
export function utf8(text: string): Uint8Array {
  return Buffer.from(text, 'utf8')
}
