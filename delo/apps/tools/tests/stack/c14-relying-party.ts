/**
 * The checks contract C14 puts on discovery metadata and ID tokens, written as a spec-side
 * reference relying party with jose, and the authorization code flow a home runs against a
 * provider. The OpenID Connect stand-in's specs use them to show that a well-behaved response
 * passes every check and that each hostile hook produces the response C14 refuses.
 *
 * @module @delo/tools/tests/stack/c14-relying-party
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  ID_TOKEN_ALGORITHMS, IDENTITY_LIMITS, OIDC_AUTHORIZATION_PARAMETERS, OIDC_REAUTH_PARAMETERS, REQUIRED_ID_TOKEN_CLAIMS,
  type IdentityErrorCode,
} from '@delo/contract-oidc-passkeys'
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose'
import { requestOverTls, type OidcClient, type OidcStandIn, type TlsResponse } from '../../src/stack/index.ts'

/** The redirect URI the specs register, an own-domain address's callback. */
export const REDIRECT_URI = 'https://studio.example.com/auth/oidc/callback'

/**
 * Discovery metadata and its byte length, read over TLS from the stand-in.
 * @param issuer - the issuer URL.
 * @param ca - the authority to trust.
 * @returns the document and its size.
 */
export async function discover(issuer: string, ca: string): Promise<{ readonly document: Record<string, unknown>, readonly bytes: number }> {
  const response = await requestOverTls(`${issuer}/.well-known/openid-configuration`, { ca })
  return { document: response.json() as Record<string, unknown>, bytes: response.body.length }
}

/**
 * C14's discovery checks.
 * @param document - the metadata.
 * @param bytes - its size.
 * @param issuer - the issuer the person entered.
 * @returns the refusal code, or undefined when the metadata passes.
 */
export function checkDiscovery(document: Record<string, unknown>, bytes: number, issuer: string): IdentityErrorCode | undefined {
  const list = (field: string): readonly unknown[] => (Array.isArray(document[field]) ? document[field] as readonly unknown[] : [])
  if (bytes > IDENTITY_LIMITS.documentBytes || document.issuer !== issuer) return 'OIDC_DISCOVERY_FAILED'
  if (!list('response_types_supported').includes(OIDC_AUTHORIZATION_PARAMETERS.response_type)) return 'OIDC_DISCOVERY_FAILED'
  if (!list('code_challenge_methods_supported').includes(OIDC_AUTHORIZATION_PARAMETERS.code_challenge_method)) return 'OIDC_PKCE_UNSUPPORTED'
  if (!list('id_token_signing_alg_values_supported').some(alg => (ID_TOKEN_ALGORITHMS as readonly unknown[]).includes(alg))) return 'OIDC_ALGORITHM_UNSUPPORTED'
  return undefined
}

/** What an ID token is checked against. */
export interface IdTokenExpectation {
  readonly issuer: string
  readonly clientId: string
  readonly nonce: string
  readonly jwks: JSONWebKeySet
  /** The pinned owner subject. */
  readonly subject?: string
  /** Require `auth_time` within 120 seconds, as a `reauth` flow does. */
  readonly reauth?: boolean
}

/**
 * C14's ID token checks, with jose for the signature, algorithm and time checks.
 * @param token - the compact JWT.
 * @param expected - the issuer, client, nonce, key set and pinned subject.
 * @returns the claims, or the refusal code.
 */
export async function checkIdToken(token: string, expected: IdTokenExpectation): Promise<{ readonly claims: JWTPayload } | { readonly refused: IdentityErrorCode }> {
  const [encodedHeader = ''] = token.split('.')
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: unknown, kid?: unknown }
  if (typeof header.alg !== 'string' || !(ID_TOKEN_ALGORITHMS as readonly string[]).includes(header.alg)) return { refused: 'OIDC_ALGORITHM_UNSUPPORTED' }
  if (typeof header.kid !== 'string' || !expected.jwks.keys.some(key => key.kid === header.kid)) return { refused: 'OIDC_UNKNOWN_KEY' }
  let claims: JWTPayload
  try {
    claims = (await jwtVerify(token, createLocalJWKSet(expected.jwks), {
      algorithms: [...ID_TOKEN_ALGORITHMS],
      clockTolerance: IDENTITY_LIMITS.idTokenClockSkewMs / 1000,
      maxTokenAge: (IDENTITY_LIMITS.idTokenMaxAgeMs + IDENTITY_LIMITS.idTokenClockSkewMs) / 1000,
      requiredClaims: [...REQUIRED_ID_TOKEN_CLAIMS],
    })).payload
  } catch (error) {
    if (error instanceof errors.JWSSignatureVerificationFailed) return { refused: 'OIDC_SIGNATURE_INVALID' }
    if (error instanceof errors.JWTExpired) return { refused: 'OIDC_TOKEN_EXPIRED' }
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'iat') return { refused: 'OIDC_TOKEN_EXPIRED' }
    throw error
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== expected.issuer) return { refused: 'OIDC_ISSUER_MISMATCH' }
  if (!audiences.includes(expected.clientId) || (audiences.length > 1 && claims.azp !== expected.clientId)) return { refused: 'OIDC_AUDIENCE_MISMATCH' }
  if (claims.nonce !== expected.nonce) return { refused: 'OIDC_NONCE_MISMATCH' }
  if (expected.subject !== undefined && claims.sub !== expected.subject) return { refused: 'OIDC_SUBJECT_MISMATCH' }
  if (expected.reauth === true && (typeof claims.auth_time !== 'number' || Date.now() / 1000 - claims.auth_time > IDENTITY_LIMITS.reauthMaxAgeMs / 1000)) return { refused: 'OIDC_REAUTH_TOO_OLD' }
  return { claims }
}

/** One authorization code flow's secrets and results. */
export interface Flow {
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  /** The redirect's query parameters. */
  readonly callback: URLSearchParams
}

/**
 * Run the authorization request of a flow and read the redirect, as the browser would deliver it.
 * @param provider - the stand-in.
 * @param client - the registered client.
 * @param options - `reauth` adds C14's re-authentication parameters; `parameters` replaces any request parameter.
 * @returns the flow's secrets and the redirect's parameters.
 */
export async function authorize(provider: OidcStandIn, client: OidcClient, options: { readonly reauth?: boolean, readonly parameters?: Record<string, string | undefined> } = {}): Promise<Flow> {
  const random = (): string => randomBytes(32).toString('base64url')
  const state = random()
  const nonce = random()
  const verifier = random()
  const url = new URL(`${provider.issuer}/authorize`)
  const parameters: Record<string, string | undefined> = {
    ...OIDC_AUTHORIZATION_PARAMETERS,
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(options.reauth === true ? OIDC_REAUTH_PARAMETERS : {}),
    ...options.parameters,
  }
  for (const [name, value] of Object.entries(parameters)) if (value !== undefined) url.searchParams.set(name, value)
  const response = await requestOverTls(url.href, { ca: provider.ca })
  if (response.status !== 302) return { state, nonce, verifier, callback: new URLSearchParams({ status: String(response.status) }) }
  return { state, nonce, verifier, callback: new URL(String(response.headers.location)).searchParams }
}

/**
 * Exchange a code at the token endpoint with `client_secret_basic`.
 * @param provider - the stand-in.
 * @param client - the client whose credentials authenticate.
 * @param code - the code.
 * @param verifier - the PKCE verifier.
 * @returns the response.
 */
export async function exchange(provider: OidcStandIn, client: Pick<OidcClient, 'clientId' | 'clientSecret' | 'redirectUris'>, code: string, verifier: string): Promise<TlsResponse> {
  const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')
  return requestOverTls(`${provider.issuer}/token`, {
    ca: provider.ca,
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUris[0] ?? '', code_verifier: verifier }).toString(),
  })
}

/**
 * The provider's key set.
 * @param provider - the stand-in.
 * @returns the JWKS.
 */
export async function keySet(provider: OidcStandIn): Promise<JSONWebKeySet> {
  return (await requestOverTls(`${provider.issuer}/jwks`, { ca: provider.ca })).json() as JSONWebKeySet
}
