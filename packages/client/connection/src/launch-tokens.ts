/**
 * One-time launch tokens: the launch-token mode Connection runs in when its
 * `oneTimeLaunchTokens` Config field is on. Each token is minted for one
 * opening of the application URL, expires {@link LAUNCH_TOKEN_LIFETIME_MS}
 * after it is minted and stops working at its first presentation, whatever
 * that presentation's outcome. At most {@link LAUNCH_TOKEN_LIMIT} tokens wait
 * at once; minting another drops the oldest. Only SHA-256 digests are held,
 * and a presented value is compared with each in constant time. A request
 * with more than {@link LAUNCH_TOKEN_VALUES_MAX} `token` values is refused
 * before any value is hashed.
 * @module @deepseek-ai/dsh-client-connection/src/launch-tokens
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Lifetime of a one-time launch token, in milliseconds. */
export const LAUNCH_TOKEN_LIFETIME_MS = 60_000

/** One-time launch tokens that may wait for their exchange at once. */
export const LAUNCH_TOKEN_LIMIT = 5

/** The most `token` values one request may present; a request with more is refused without hashing any. */
export const LAUNCH_TOKEN_VALUES_MAX = 4

/**
 * The outcome of presenting launch tokens.
 * - `accepted`: exactly one value, a waiting token that has not expired, presented at the host it was minted for.
 * - `other-host`: that token, presented at another host; `host` is the one it was minted for.
 * - `refused`: anything else.
 */
export type LaunchTokenRedemption =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'other-host'; readonly host: string }
  | { readonly kind: 'refused' }

const REFUSED: LaunchTokenRedemption = { kind: 'refused' }

const TOKEN_BYTES = 32

interface PendingToken {
  readonly digest: Buffer
  /** The `protocol` and `host` of the URL the token was minted into. */
  readonly protocol: string
  readonly host: string
  readonly expiresAt: number
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** The `host` a `Host` header names when read with the minted URL's protocol, or `undefined` when it is not one. */
function hostOf(protocol: string, header: string): string | undefined {
  try {
    return new URL(`${protocol}//${header}`).host
  } catch {
    return undefined
  }
}

/** The waiting one-time launch tokens of one process. */
export class OneTimeLaunchTokens {
  private pending: PendingToken[] = []

  /**
   * @param now - the clock; `Date.now` in production.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Mint a token for one opening of `url`, bound to its protocol and host.
   * @param url - the application URL the token is added to.
   * @returns the token, 32 random bytes as base64url.
   */
  mint(url: URL): string {
    this.prune()
    if (this.pending.length >= LAUNCH_TOKEN_LIMIT) this.pending.shift()
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    this.pending.push({ digest: digestOf(token), protocol: url.protocol, host: url.host, expiresAt: this.now() + LAUNCH_TOKEN_LIFETIME_MS })
    return token
  }

  /** The number of tokens waiting now, expired ones included until the next mint drops them. */
  get waiting(): number {
    return this.pending.length
  }

  /**
   * Consume every waiting token among the presented values, and say whether the presentation signs in. A request
   * with more than {@link LAUNCH_TOKEN_VALUES_MAX} values is refused and nothing is consumed.
   * @param presented - every `token` value of the request.
   * @param hostHeader - the request's `Host` header, or `undefined` to only consume, as a refused presentation does.
   * @returns the outcome; only `accepted` may exchange the token.
   */
  redeem(presented: readonly string[], hostHeader: string | undefined): LaunchTokenRedemption {
    if (presented.length > LAUNCH_TOKEN_VALUES_MAX) return REFUSED
    const now = this.now()
    const digests = presented.map(digestOf)
    const matched: PendingToken[] = []
    this.pending = this.pending.filter((entry) => {
      // Every presented value is compared with every waiting digest, so the time taken does not tell which matched.
      const hit = digests.reduce((found, digest) => timingSafeEqual(digest, entry.digest) || found, false)
      if (hit) matched.push(entry)
      return !hit
    })
    const [entry] = matched
    if (presented.length !== 1 || entry === undefined || entry.expiresAt <= now || hostHeader === undefined) return REFUSED
    return hostOf(entry.protocol, hostHeader) === entry.host ? { kind: 'accepted' } : { kind: 'other-host', host: entry.host }
  }

  /** Drop expired tokens. */
  private prune(): void {
    const now = this.now()
    this.pending = this.pending.filter(entry => entry.expiresAt > now)
  }
}
