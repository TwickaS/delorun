/**
 * The byte-level primitives of a home's sign-in: the RFC 4648 base32 alphabet an owner code is written in, the
 * generation and normalisation of an owner code, the SHA-256 digest that every stored secret (owner code, session
 * credential) is kept as, and the constant-time comparison a presented secret is checked with.
 *
 * Nothing here writes a secret: a caller passes a freshly minted value to the person who must see it once, and hands
 * the digest to a store. The digest is what `~/.delo/secrets/home-auth/` keeps.
 *
 * @module @delo/home-auth/secret
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DEVICE_APPROVAL_LIMITS } from '@delo/contract-device-approval'

/** The RFC 4648 base32 alphabet an owner code is written in, as C5 spells it: `A`–`Z` and `2`–`7`. */
export const OWNER_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Bytes of randomness in an owner code: 128 bits, C5's decided value. */
export const OWNER_CODE_BYTES = DEVICE_APPROVAL_LIMITS.ownerCodeBytes

/** Characters of an owner code: 26, the 128 bits written in whole base32 characters. */
export const OWNER_CODE_CHARS = DEVICE_APPROVAL_LIMITS.ownerCodeChars

/** Bytes of randomness in a reach session token: the secret whose digest is a session id. */
export const SESSION_TOKEN_BYTES = 32

/** Bytes of randomness in an approval request's secret. */
export const REQUEST_SECRET_BYTES = 16

/** A source of random bytes, so a spec can pass a fixed sequence. */
export type RandomBytes = (size: number) => Uint8Array

/**
 * The operating system's random source.
 * @param size - how many bytes to read.
 * @returns the bytes.
 */
export const systemRandom: RandomBytes = size => randomBytes(size)

/**
 * Write bytes as RFC 4648 base32 without padding, in [`OWNER_CODE_ALPHABET`](./codes.ts).
 * @param bytes - the bytes to write.
 * @returns the base32 text, one character per 5 bits with the last character zero-filled.
 */
export function base32Encode(bytes: Uint8Array): string {
  let pending = 0
  let bits = 0
  let text = ''
  for (const byte of bytes) {
    pending = (pending << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += OWNER_CODE_ALPHABET[(pending >>> bits) & 31]
    }
  }
  if (bits > 0) text += OWNER_CODE_ALPHABET[(pending << (5 - bits)) & 31]
  return text
}

/**
 * Mint an owner code: 128 bits from the random source, written as 26 base32 characters.
 * @param random - the random source.
 * @returns the code, in upper case and without separators, which is the form a person reads and types.
 */
export function newOwnerCode(random: RandomBytes = systemRandom): string {
  return base32Encode(random(OWNER_CODE_BYTES))
}

/**
 * Read a presented owner code as the form that is compared: upper case, with spaces and hyphens ignored, because a
 * person copies the code from a terminal by hand (C5's owner claim).
 * @param presented - what the person typed, or what a client sent.
 * @returns the normalised code, or undefined when it cannot be an owner code.
 */
export function normaliseOwnerCode(presented: string): string | undefined {
  const text = presented.replaceAll(/[\s-]/g, '').toUpperCase()
  if (text.length !== OWNER_CODE_CHARS) return undefined
  for (const character of text) {
    if (!OWNER_CODE_ALPHABET.includes(character)) return undefined
  }
  return text
}

/**
 * The digest a secret is stored as: SHA-256, base64url without padding.
 * @param secret - the secret, such as an owner code or a session token.
 * @returns the digest, which names the secret without holding it.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url')
}

/**
 * Mint a fresh secret of the given size, base64url without padding.
 * @param size - how many random bytes the secret holds.
 * @param random - the random source.
 * @returns the secret.
 */
export function newSecret(size: number, random: RandomBytes = systemRandom): string {
  return Buffer.from(random(size)).toString('base64url')
}

/**
 * Compare a presented secret with a stored digest in constant time, so that a wrong secret costs the same as a
 * missing one.
 * @param presented - the secret as presented.
 * @param storedHash - the digest the store holds.
 * @returns whether the presented secret is the one the digest names.
 */
export function secretMatches(presented: string, storedHash: string): boolean {
  const digest = Buffer.from(hashSecret(presented), 'base64url')
  const stored = Buffer.from(storedHash, 'base64url')
  if (stored.length !== digest.length) return false
  return timingSafeEqual(digest, stored)
}
