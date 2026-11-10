/**
 * The relay's tunnel tokens (C6, "Tunnel token"): `POST /v1/tunnel-token` with a home-signed
 * request, the token the issuer's Ed25519 key signs, and the checks every presented token
 * passes before an upgrade. A token authorises one attempt: it names one bound name and one
 * home key id, expires 60 seconds after it was issued, is usable once, and is refused when it
 * was issued before the relay started. Every signed object is signed over its RFC 8785
 * serialization without its `signature` field.
 *
 * @module @delo/relay/token
 */
import { RELAY_LIMITS, RELAY_PROTOCOL_VERSION, type Base64Url, type RelayId, type TunnelTokenClaims } from '@delo/contract-relay-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalJson, parseStrictJson, toJsonValue } from '@delo/release-formats/sign/json'
import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import type { RelayBindingView } from './config.ts'
import { RelayError } from './errors.ts'
import { fromBase64Url, keyIdOf, randomBase64Url, signBytes, toBase64Url, utf8, verifyBytes } from './keys.ts'

/** The most bytes a token request body may hold. */
export const TOKEN_REQUEST_MAX_BYTES = 16_384

/** The most bytes a presented token's claims may hold. */
export const TOKEN_MAX_BYTES = 4_096

const requestSchema = z.strictObject({
  v: z.literal(RELAY_PROTOCOL_VERSION),
  name: z.string().min(1).max(253),
  homePublicKey: z.string().min(1).max(128),
  timestamp: z.number().int(),
  signature: z.string().min(1).max(128),
})

const claimsSchema = z.strictObject({
  v: z.literal(RELAY_PROTOCOL_VERSION),
  iss: z.string().min(1).max(128),
  name: z.string().min(1).max(253),
  homeKeyId: z.string().min(1).max(128),
  jti: z.string().min(1).max(128),
  iat: z.number().int(),
  exp: z.number().int(),
})

/** A token request body, as the issuer reads it. */
export type TokenRequest = z.infer<typeof requestSchema>

/** The options of {@link TunnelTokens}. */
export interface TunnelTokensOptions {
  /** The issuer's Ed25519 token key. */
  readonly tokenKey: KeyObject
  /** The relay id the claims name. */
  readonly relayId: RelayId
  /** The bound names, by lowercase name. */
  readonly bindings: ReadonlyMap<string, RelayBindingView>
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
  /** The instant the relay started; a token issued earlier is refused. */
  readonly startedAt: number
}

/** The bytes a signature covers: the RFC 8785 serialization of a value without its `signature` field. */
function signedBytes(value: object): Uint8Array {
  return utf8(canonicalJson(toJsonValue(value)))
}

/**
 * Turns a home-signed request into a tunnel token and verifies the tokens presented at the
 * tunnel path. One instance belongs to one running relay: it holds the ids of the tokens it has
 * accepted, so a second presentation is refused until the token expires.
 */
export class TunnelTokens {
  private readonly options: TunnelTokensOptions
  private readonly accepted = new Map<string, number>()

  /**
   * @param options - the token key, the relay id, the bindings, the clock and the start instant.
   */
  constructor(options: TunnelTokensOptions) {
    this.options = options
  }

  /**
   * Answer `POST /v1/tunnel-token`: check the request's shape, its clock, its binding and its
   * home-key signature, then issue a token for that name and key.
   * @param body - the request body.
   * @returns the token.
   * @throws RelayError `TOKEN_REQUEST_INVALID` for a malformed body or a signature that does not
   *   verify, `TOKEN_REQUEST_STALE` for a timestamp more than 60 seconds from the clock, and
   *   `NAME_NOT_BOUND` when the name is not bound to the presented key.
   */
  issue(body: Uint8Array): { readonly token: string } {
    const request = this.request(body)
    const now = this.options.now()
    const skew = Math.abs(now - request.timestamp)
    if (skew > RELAY_LIMITS.tokenClockSkewMs) throw new RelayError('TOKEN_REQUEST_STALE', `the request's timestamp is ${String(skew)} ms from the relay's clock`)
    const name = request.name.toLowerCase()
    const binding = this.options.bindings.get(name)
    if (binding === undefined) throw new RelayError('NAME_NOT_BOUND', `${name} is not a bound name`)
    const raw = (() => {
      try {
        return fromBase64Url(request.homePublicKey, 32)
      } catch (_error: unknown) {
        throw new RelayError('TOKEN_REQUEST_INVALID', 'the request carries no 32-byte base64url home public key')
      }
    })()
    if (keyIdOf(raw) !== binding.homeKeyId) throw new RelayError('NAME_NOT_BOUND', `${name} is not bound to the presented key`)
    const signature = (() => {
      try {
        return fromBase64Url(request.signature, 64)
      } catch (_error: unknown) {
        throw new RelayError('TOKEN_REQUEST_INVALID', 'the request carries no 64-byte base64url signature')
      }
    })()
    const signed = signedBytes({ name: request.name, homePublicKey: request.homePublicKey, timestamp: request.timestamp, v: request.v })
    if (!verifyBytes(binding.homePublicKey, signed, signature)) throw new RelayError('TOKEN_REQUEST_INVALID', 'the request signature does not verify with the presented key')
    return { token: this.mint(name, binding.homeKeyId, now) }
  }

  /**
   * Verify a token presented at the tunnel path.
   * @param presented - the `Delo-Tunnel` credential's token.
   * @returns the token's claims.
   * @throws RelayError `TUNNEL_TOKEN_INVALID` for a malformed token, a signature that does not
   *   verify, another relay's id, a binding that changed, an expiry in the past or an issue time
   *   before this relay started; `TUNNEL_TOKEN_REPLAYED` for an id this relay accepted.
   */
  verify(presented: string): TunnelTokenClaims {
    const claims = this.claims(presented)
    if (claims.iss !== this.options.relayId) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token names another relay')
    const binding = this.options.bindings.get(claims.name)
    if (binding === undefined) throw new RelayError('TUNNEL_TOKEN_INVALID', `the token names ${claims.name}, which is no longer bound`)
    if (binding.homeKeyId !== claims.homeKeyId) throw new RelayError('TUNNEL_TOKEN_INVALID', `the binding of ${claims.name} changed since the token was issued`)
    const now = this.options.now()
    if (now > claims.exp) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token has expired')
    if (claims.iat < this.options.startedAt) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token was issued before this relay started')
    this.prune()
    if (this.accepted.has(claims.jti)) throw new RelayError('TUNNEL_TOKEN_REPLAYED', 'the token was already accepted')
    return claims
  }

  /**
   * Record a token as accepted, so a second presentation of its id is refused until it expires.
   * @param claims - the verified claims.
   */
  accept(claims: TunnelTokenClaims): void {
    this.accepted.set(claims.jti, claims.exp)
  }

  /**
   * The number of accepted token ids the relay holds after dropping the expired ones.
   * @returns the count.
   */
  acceptedCount(): number {
    this.prune()
    return this.accepted.size
  }

  /** Drop the ids of tokens whose expiry has passed. */
  private prune(): void {
    const now = this.options.now()
    for (const [jti, exp] of this.accepted) if (now > exp) this.accepted.delete(jti)
  }

  /** Mint the token for one name and key id. */
  private mint(name: string, homeKeyId: Base64Url, now: number): string {
    const claims: TunnelTokenClaims = {
      v: RELAY_PROTOCOL_VERSION,
      iss: this.options.relayId,
      name,
      homeKeyId,
      jti: brandString<Base64Url>(randomBase64Url(RELAY_LIMITS.tokenIdBytes)),
      iat: now,
      exp: now + RELAY_LIMITS.tokenLifetimeMs,
    }
    const canonical = signedBytes(claims)
    return `${toBase64Url(canonical)}.${toBase64Url(signBytes(this.options.tokenKey, canonical))}`
  }

  /** Parse a request body. */
  private request(body: Uint8Array): TokenRequest {
    let value: unknown
    try {
      value = parseStrictJson(body, TOKEN_REQUEST_MAX_BYTES)
    } catch (error: unknown) {
      throw new RelayError('TOKEN_REQUEST_INVALID', `the request body is not JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    const parsed = requestSchema.safeParse(value)
    if (!parsed.success) throw new RelayError('TOKEN_REQUEST_INVALID', `the request does not match its schema: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'the body'}: ${issue.message}`).join('; ')}`)
    return parsed.data
  }

  /** Parse a presented token and verify its signature over the canonical claims. */
  private claims(presented: string): TunnelTokenClaims {
    if (presented.length > TOKEN_MAX_BYTES) throw new RelayError('TUNNEL_TOKEN_INVALID', `the token holds ${String(presented.length)} bytes, above the ${String(TOKEN_MAX_BYTES)} it may hold`)
    const parts = presented.split('.')
    if (parts.length !== 2) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token is not a claims text, a dot and a signature')
    const claimsText = parts[0] ?? ''
    const signatureText = parts[1] ?? ''
    if (claimsText.length === 0 || signatureText.length === 0) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token carries no claims or no signature')
    const signature = (() => {
      try {
        return fromBase64Url(signatureText, 64)
      } catch (_error: unknown) {
        throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token carries no 64-byte base64url signature')
      }
    })()
    const claimsBytes = (() => {
      try {
        return fromBase64Url(claimsText)
      } catch (_error: unknown) {
        throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token claims are not base64url')
      }
    })()
    const claims = (() => {
      try {
        const parsed = claimsSchema.parse(parseStrictJson(claimsBytes, TOKEN_MAX_BYTES))
        return {
          v: parsed.v,
          iss: brandString<RelayId>(parsed.iss),
          name: parsed.name,
          homeKeyId: brandString<Base64Url>(parsed.homeKeyId),
          jti: brandString<Base64Url>(parsed.jti),
          iat: parsed.iat,
          exp: parsed.exp,
        }
      } catch (_error: unknown) {
        throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token claims are not the object the protocol defines')
      }
    })()
    if (!verifyBytes(this.options.tokenKey, signedBytes(claims), signature)) throw new RelayError('TUNNEL_TOKEN_INVALID', 'the token signature does not verify with the relay\'s token key')
    return claims
  }
}
