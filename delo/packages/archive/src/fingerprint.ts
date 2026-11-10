/**
 * The fingerprint of an Ed25519 public key, which contract C5 also uses as a
 * home key id: the SHA-256 of the raw 32-byte key, base64url. A manifest's
 * declared key id must equal its key's fingerprint, and a person confirms an
 * unknown signer by this value, which the archive cannot choose apart from
 * its key.
 *
 * @module @delo/archive/fingerprint
 */
import { createHash } from 'node:crypto'

/**
 * The fingerprint of one public key.
 * @param publicKey - the base64url raw public key.
 * @returns the base64url SHA-256 of the raw key.
 */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')
}
