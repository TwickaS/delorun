/**
 * Tokens for the confirmation and unsubscribe links. The database keeps only each token's hash, so a copy of the
 * database cannot confirm or unsubscribe anyone.
 *
 * @module @delo/website/worker/tokens
 */

/** Bytes of randomness in a token. */
const TOKEN_BYTES = 32

/** The shape of a token: 32 bytes in unpadded base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * Makes a token.
 * @returns 32 random bytes in base64url.
 */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Tells whether text could be a token, so a malformed one is refused before it reaches the database.
 * @param value - text from a link or form.
 * @returns true when the text has a token's shape.
 */
export function isTokenShape(value: string | null): value is string {
  return value !== null && TOKEN_SHAPE.test(value)
}

/**
 * Hashes a token for storage and lookup.
 * @param token - the token.
 * @returns the SHA-256 digest in hexadecimal.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
