/**
 * The match code of contract C5: 8 decimal digits derived from both public keys, both nonces and the address.
 *
 * `SHA-256("delo-match-v1" ‖ 0x00 ‖ home public key ‖ device id ‖ homeNonce ‖ deviceNonce ‖ address)`, where the home
 * public key is its 32 raw bytes, the device id, `homeNonce` and `deviceNonce` are the bytes their base64url text
 * decodes to, and the address is its UTF-8 text. The first 8 bytes of the digest, read as an unsigned big-endian
 * integer modulo 10⁸, are written with leading zeros. The new device shows it as `1234 5678`; a typed code is compared
 * after removing spaces and hyphens.
 *
 * @module @delo/home-auth/match-code
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { MATCH_CODE_DIGITS, MATCH_CODE_LABEL } from '@delo/contract-device-approval'

/** What the match code commits to. */
export interface MatchCodeInputs {
  /** The 32-byte raw home public key. */
  readonly homePublicKey: Uint8Array
  /** The new device's id, base64url. */
  readonly deviceId: string
  /** The home's nonce, base64url. */
  readonly homeNonce: string
  /** The new device's nonce, base64url. */
  readonly deviceNonce: string
  /** The studio address the request was bound to. */
  readonly address: string
}

/**
 * The match code of one approval request.
 * @param inputs - the keys, nonces and address.
 * @returns the 8 digits, with leading zeros and no separator.
 */
export function matchCode(inputs: MatchCodeInputs): string {
  const digest = createHash('sha256')
    .update(MATCH_CODE_LABEL, 'utf8')
    .update(Buffer.of(0))
    .update(inputs.homePublicKey)
    .update(Buffer.from(inputs.deviceId, 'base64url'))
    .update(Buffer.from(inputs.homeNonce, 'base64url'))
    .update(Buffer.from(inputs.deviceNonce, 'base64url'))
    .update(inputs.address, 'utf8')
    .digest()
  const value = digest.readBigUInt64BE(0) % 10n ** BigInt(MATCH_CODE_DIGITS)
  return value.toString().padStart(MATCH_CODE_DIGITS, '0')
}

/**
 * Whether a typed code is the match code, compared in constant time.
 * @param typed - what the person typed, with or without spaces and hyphens.
 * @param expected - the match code.
 * @returns whether they are the same 8 digits.
 */
export function typedCodeMatches(typed: string, expected: string): boolean {
  const digits = typed.replace(/[\s-]/g, '')
  if (!/^\d+$/.test(digits) || digits.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(digits), Buffer.from(expected))
}

/**
 * The match code as a device shows it: two groups of four digits.
 * @param code - the 8 digits.
 * @returns the code with a space in the middle.
 */
export function formatMatchCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`
}
