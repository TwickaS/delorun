/**
 * The signature of contract C8. `signature.json` covers the exact bytes of
 * `manifest.json`, and its algorithm is Ed25519. A signature that verifies
 * against the archive's own origin key but whose key the importing home does
 * not vouch for leaves the archive in the unverified state, which an import
 * accepts only once the person confirms the key. A signature that does not
 * verify is reported as `signature-invalid`, and an import refuses that
 * archive outright. The verified state therefore needs both a
 * signature that verifies and a key the home vouches for — one it already
 * holds, or one the person confirmed by its fingerprint. A confirmation names
 * the key itself, never the identifier alone: `homeKeyId` is a string the
 * archive carries, so an impostor key that reuses a confirmed identifier would
 * otherwise pass the check.
 *
 * @module @delo/archive/signature
 */
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { ARCHIVE_SIGNATURE_ALGORITHM, type ArchiveOrigin, type ArchiveSignature } from '@delo/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { SIGNATURE_PATH } from './manifest.ts'

/** Whether an import may show an archive as signed by a home it trusts. */
export type SignatureState = 'verified' | 'unverified'

/** Why an archive is in the unverified state. */
export type SignatureReason = 'absent' | 'signature-invalid' | 'key-not-trusted'

/** What one signature check found. */
export interface SignatureCheck {
  /** `verified` when the signature verifies and its key is vouched for, `unverified` otherwise. */
  readonly state: SignatureState
  /** Why the state is `unverified`; absent when the state is `verified`. */
  readonly reason?: SignatureReason | undefined
}

/** The facts one signature check reads. */
export interface SignatureCheckInput {
  /** The exact bytes of `manifest.json`, which the signature covers. */
  readonly manifestBytes: Uint8Array
  /** The origin the manifest declares. */
  readonly origin: ArchiveOrigin
  /** The parsed `signature.json`, or absent when the archive carries none. */
  readonly signature?: ArchiveSignature | undefined
  /** The base64url Ed25519 keys the importing home already vouches for. */
  readonly trustedPublicKeys?: readonly string[] | undefined
  /** The key identifier the person confirmed by its fingerprint at import, when they did. */
  readonly confirmedHomeKeyId?: string | undefined
  /** The base64url key the person confirmed by its fingerprint at import, which is what the confirmation binds. */
  readonly confirmedPublicKey?: string | undefined
}

/** The two keys of one Ed25519 key pair, in the encodings the archive uses. */
export interface Ed25519KeyPair {
  /** The base64url public key, which an archive's origin carries. */
  readonly publicKey: string
  /** The private key, which signs the manifest. */
  readonly privateKey: KeyObject
}

/**
 * Parse one `signature.json`.
 * @param bytes - the bytes of the document.
 * @returns the parsed signature.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for a document the format does not define, and `ARCHIVE_UNSUPPORTED_VERSION` for another algorithm.
 */
export function parseSignature(bytes: Uint8Array): ArchiveSignature {
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SIGNATURE_PATH} is not UTF-8 JSON`)
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SIGNATURE_PATH} is not a JSON object`)
  }
  const fields = document as Record<string, unknown>
  const unknown = Object.keys(fields).filter(key => key !== 'algorithm' && key !== 'homeKeyId' && key !== 'signature')
  if (unknown.length > 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SIGNATURE_PATH} carries the field ${JSON.stringify(unknown[0])}, which the format does not define`)
  }
  if (fields.algorithm !== ARCHIVE_SIGNATURE_ALGORITHM) {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `${SIGNATURE_PATH} names the algorithm ${JSON.stringify(fields.algorithm)}, which the format does not use`)
  }
  if (typeof fields.homeKeyId !== 'string' || fields.homeKeyId.length === 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SIGNATURE_PATH} homeKeyId is not a non-empty string`)
  }
  if (typeof fields.signature !== 'string' || fields.signature.length === 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SIGNATURE_PATH} signature is not a non-empty string`)
  }
  return { algorithm: ARCHIVE_SIGNATURE_ALGORITHM, homeKeyId: fields.homeKeyId, signature: fields.signature }
}

/**
 * Verify one archive signature against the manifest bytes and the origin key,
 * and refuse an archive whose signature does not verify. The caller decides
 * whether the key is one it trusts; this function answers only whether the
 * signature is the origin key's signature over these bytes.
 * @param input - the manifest bytes, the origin and the signature.
 * @throws ArchiveError `ARCHIVE_SIGNATURE_INVALID` when the signature does not verify, names another key than the manifest's origin, or the origin key is not an Ed25519 key.
 */
export function verifyArchiveSignature(input: { readonly manifestBytes: Uint8Array, readonly origin: ArchiveOrigin, readonly signature: ArchiveSignature }): void {
  const { manifestBytes, origin, signature } = input
  if (signature.homeKeyId !== origin.homeKeyId) {
    throw new ArchiveError('ARCHIVE_SIGNATURE_INVALID', 'the signature names a home key that the manifest does not declare')
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: origin.publicKey }, format: 'jwk' })
  } catch {
    throw new ArchiveError('ARCHIVE_SIGNATURE_INVALID', 'the origin key is not an Ed25519 public key')
  }
  let signed: boolean
  try {
    signed = verify(null, manifestBytes, key, Buffer.from(signature.signature, 'base64url'))
  } catch {
    throw new ArchiveError('ARCHIVE_SIGNATURE_INVALID', 'the signature is not an Ed25519 signature over the manifest')
  }
  if (!signed) throw new ArchiveError('ARCHIVE_SIGNATURE_INVALID', 'the signature does not verify over the manifest bytes')
}

/**
 * Check one archive's signature and report the state the diff screen and the
 * import report show. The confirmation the person gave at import binds to the
 * key: `confirmedPublicKey` alone vouches for the origin key, and
 * `confirmedHomeKeyId` narrows the confirmation to an identifier it was given
 * with.
 * @param input - the manifest bytes, the origin, the signature, the keys the home vouches for and the confirmation the person gave.
 * @returns `verified` only when the signature verifies and its key is vouched for, and `unverified` with the reason otherwise.
 */
export function checkArchiveSignature(input: SignatureCheckInput): SignatureCheck {
  const { signature } = input
  if (signature === undefined) return { state: 'unverified', reason: 'absent' }
  try {
    verifyArchiveSignature({ manifestBytes: input.manifestBytes, origin: input.origin, signature })
  } catch (error: unknown) {
    // verifyArchiveSignature reports every failure as ARCHIVE_SIGNATURE_INVALID; anything else is a defect to surface, not a state.
    /* v8 ignore next */
    if (!(error instanceof ArchiveError) || error.code !== 'ARCHIVE_SIGNATURE_INVALID') throw error
    return { state: 'unverified', reason: 'signature-invalid' }
  }
  const vouched = input.trustedPublicKeys ?? []
  // The confirmation is bound to the key, not to the identifier: `homeKeyId` is an unauthenticated string the archive carries, so another key that reuses a confirmed identifier would otherwise be shown as verified.
  const confirmed = input.confirmedPublicKey === input.origin.publicKey
    && (input.confirmedHomeKeyId === undefined || input.confirmedHomeKeyId === input.origin.homeKeyId)
  if (!confirmed && !vouched.includes(input.origin.publicKey)) return { state: 'unverified', reason: 'key-not-trusted' }
  return { state: 'verified' }
}

/**
 * Sign one manifest with the exporting home's key.
 * @param manifestBytes - the exact bytes of `manifest.json`.
 * @param homeKeyId - the exporting home's key identifier.
 * @param privateKey - the exporting home's Ed25519 private key.
 * @returns the signature document.
 */
export function signManifest(manifestBytes: Uint8Array, homeKeyId: string, privateKey: KeyObject): ArchiveSignature {
  const signature = sign(null, manifestBytes, privateKey).toString('base64url')
  return { algorithm: ARCHIVE_SIGNATURE_ALGORITHM, homeKeyId, signature }
}

/**
 * The base64url encoding of an Ed25519 public key, which an archive's origin carries.
 * @param publicKey - the public key.
 * @returns the raw 32-byte key in base64url.
 * @throws Error when the key is not an Ed25519 key.
 */
export function encodePublicKey(publicKey: KeyObject): string {
  const exported = publicKey.export({ format: 'jwk' })
  if (typeof exported.x !== 'string') throw new Error('the key is not an Ed25519 public key, so it has no raw form')
  return exported.x
}

/**
 * Build the archive's `origin` field from a public key and its identifier.
 * @param homeKeyId - the home key's identifier.
 * @param publicKey - the home's Ed25519 public key.
 * @returns the origin.
 */
export function archiveOrigin(homeKeyId: string, publicKey: KeyObject): ArchiveOrigin {
  return { homeKeyId, publicKey: encodePublicKey(publicKey) }
}
