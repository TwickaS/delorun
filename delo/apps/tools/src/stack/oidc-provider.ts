/**
 * An OpenID Connect provider stand-in on loopback HTTPS, standing in for the person's own
 * provider of contract C14. It serves discovery, a JSON Web Key Set, the authorization code
 * flow with S256 PKCE, `nonce` and the RFC 9207 `iss` response parameter, a token endpoint
 * with `client_secret_basic`, and RFC 7591/7592 dynamic registration. It has no login page:
 * every authorization signs in its configured subject at once, with `auth_time` now.
 *
 * Hooks for the refusals C14 requires of a relying party change only the next response they
 * name: an ID token with changed or missing claims (wrong audience, another issuer, another
 * subject, stale `auth_time`), a forged ID token (`alg: none`, HS256 keyed by the public key,
 * an unknown key, no `kid`, a broken signature), an authorization response with another or no
 * `iss`, and any endpoint's raw answer or silence. Keys can be published, used, rotated and
 * retired. Two instances give the two issuers of a mix-up test.
 *
 * @module @delo/tools/stack/oidc-provider
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OIDC_AUTHORIZATION_PARAMETERS, OIDC_CLIENT_AUTH_METHOD, type ID_TOKEN_ALGORITHMS } from '@delo/contract-oidc-passkeys'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT, type JWK, type JWTPayload } from 'jose'
import type { TestAuthority } from './certificates.ts'
import { listenHttps, readBody, sendJson, type LoopbackServer } from './loopback.ts'

/** An ID token signing algorithm C14 allows. */
export type IdTokenAlgorithm = (typeof ID_TOKEN_ALGORITHMS)[number]

/** Paths of the stand-in's endpoints under its issuer URL. */
export const OIDC_STAND_IN_PATHS = {
  discovery: '/.well-known/openid-configuration',
  jwks: '/jwks',
  authorization: '/authorize',
  token: '/token',
  registration: '/register',
} as const

/** Lifetime of an authorization code, in seconds. */
export const AUTHORIZATION_CODE_SECONDS = 60
/** Lifetime of an ID token and access token, in seconds. */
export const ID_TOKEN_SECONDS = 3600

/** A registered client. */
export interface OidcClient {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUris: readonly string[]
  /** Present for a dynamically registered client. */
  readonly registrationAccessToken?: string
}

/** How an ID token is forged instead of signed with the current key. */
export type IdTokenForgery =
  /** An unsecured JWT with `alg: none` and an empty signature. */
  | 'alg-none'
  /** HS256 keyed by the SPKI PEM of the current public key, under the current `kid`. */
  | 'hs256-public-key'
  /** Signed by a new key of the current algorithm under a `kid` the key set never lists. */
  | 'unknown-key'
  /** Signed by the current key with no `kid` in the header. */
  | 'missing-kid'
  /** Signed by the current key with the first signature byte inverted. */
  | 'bad-signature'

/** A change to the next ID token. */
export interface IdTokenOverride {
  /** Claims to set or replace, such as `aud`, `azp`, `iss`, `sub`, `nonce`, `iat`, `exp` or `auth_time`. */
  readonly claims?: Readonly<Record<string, unknown>>
  /** Claims to leave out. */
  readonly omit?: readonly string[]
  readonly forgery?: IdTokenForgery
  /** Sign with this `kid`, which may be a retired key. */
  readonly signWith?: string
}

/** A change to the next authorization response. */
export interface AuthorizationOverride {
  /** The `iss` parameter: a string replaces it, null leaves it out. */
  readonly iss?: string | null
  /** Answer with this OAuth error instead of a code. */
  readonly error?: string
}

/** A raw answer, or `'hang'` to hold the request open until the stand-in closes. */
export type ResponseOverride = 'hang' | { readonly status: number, readonly body: unknown, readonly headers?: Readonly<Record<string, string>> }

/** One request the stand-in received. */
export interface RecordedRequest {
  readonly method: string
  /** The path without its query. */
  readonly path: string
  /** The stand-in's clock, in milliseconds. */
  readonly at: number
}

/** How to start the stand-in. */
export interface OidcStandInOptions {
  /** The stack's test authority, which signs the server certificate. */
  readonly authority: TestAuthority
  /** The `sub` of the person the stand-in signs in. */
  readonly subject: string
  /** The algorithm of the first signing key; ES256 when absent. */
  readonly algorithm?: IdTokenAlgorithm
  /** Whether metadata sets `authorization_response_iss_parameter_supported` and responses carry `iss`; true when absent. */
  readonly issParameter?: boolean
  /** Offer RFC 7591 registration, optionally requiring an initial access token; absent means no `registration_endpoint`. */
  readonly dynamicRegistration?: { readonly initialAccessToken?: string }
  /** The clock in milliseconds; `Date.now` when absent. */
  readonly clock?: () => number
}

/** A running OpenID Connect provider stand-in. */
export interface OidcStandIn {
  /** The issuer URL, `https://127.0.0.1:<port>`. */
  readonly issuer: string
  /** The PEM certificate of the authority a client trusts for this stand-in. */
  readonly ca: string
  /** The `kid` that signs the next ID token. */
  readonly signingKid: () => string
  /**
   * The `kid`s the key set publishes.
   * @returns them, in publication order.
   */
  readonly publishedKids: () => readonly string[]
  /**
   * Register a client as a person does at their provider.
   * @param redirectUris - the redirect URIs to accept.
   * @returns the client's ID and secret.
   */
  readonly registerClient: (redirectUris: readonly string[]) => OidcClient
  /**
   * The registered clients, including dynamically registered ones.
   * @returns them, in registration order.
   */
  readonly clients: () => readonly OidcClient[]
  /**
   * Publish a new key in the key set without signing with it.
   * @param algorithm - its algorithm; the current signing algorithm when absent.
   * @returns its `kid`.
   */
  readonly addKey: (algorithm?: IdTokenAlgorithm) => Promise<string>
  /**
   * Sign later ID tokens with a key this stand-in holds.
   * @param kid - the key, which must be published.
   */
  readonly useKey: (kid: string) => void
  /**
   * Remove a key from the key set; it no longer signs unless an override names it.
   * @param kid - the key.
   */
  readonly retireKey: (kid: string) => void
  /**
   * Publish a new key and sign with it from now on.
   * @param options - its algorithm, and whether to retire the previous signing key at once.
   * @returns the new `kid`.
   */
  readonly rotateKey: (options?: { readonly algorithm?: IdTokenAlgorithm, readonly retirePrevious?: boolean }) => Promise<string>
  /**
   * Change discovery metadata for every later discovery response.
   * @param patch - fields to set; an `undefined` value removes the field.
   */
  readonly overrideMetadata: (patch: Readonly<Record<string, unknown>>) => void
  /**
   * Change the next ID token the token endpoint issues.
   * @param override - the claims, omissions, forgery or key.
   */
  readonly nextIdToken: (override: IdTokenOverride) => void
  /**
   * Change the next authorization response.
   * @param override - the `iss` parameter or an error.
   */
  readonly nextAuthorizationResponse: (override: AuthorizationOverride) => void
  /**
   * Answer the next request to a path with a raw response or silence.
   * @param path - one of {@link OIDC_STAND_IN_PATHS}' values.
   * @param override - the response.
   */
  readonly nextResponse: (path: string, override: ResponseOverride) => void
  /**
   * Mint an ID token directly, as the token endpoint would with this override, for a check that needs no flow.
   * @param claims - the full claim set.
   * @param override - a forgery or key.
   * @returns the compact JWT.
   */
  readonly mintIdToken: (claims: JWTPayload, override?: Pick<IdTokenOverride, 'forgery' | 'signWith'>) => Promise<string>
  /** Every request received, in order. */
  readonly requests: readonly RecordedRequest[]
  /** Stop listening. */
  readonly close: () => Promise<void>
}

interface SigningKey {
  readonly kid: string
  readonly algorithm: IdTokenAlgorithm
  readonly privateKey: CryptoKey
  readonly publicKey: CryptoKey
  readonly jwk: JWK
  published: boolean
}

interface PendingCode {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly nonce: string | undefined
  readonly authTime: number
  readonly expiresAt: number
  used: boolean
}

function random(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function newKey(algorithm: IdTokenAlgorithm): Promise<SigningKey> {
  const pair = await generateKeyPair(algorithm, { extractable: true, ...(algorithm === 'EdDSA' ? { crv: 'Ed25519' } : {}) })
  const kid = random(12)
  return { kid, algorithm, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: algorithm, use: 'sig' }, published: true }
}

/**
 * Start an OpenID Connect provider stand-in on `127.0.0.1`.
 * @param options - the authority, subject, first key algorithm, `iss` parameter support, registration and clock.
 * @returns the running stand-in.
 */
export async function startOidcStandIn(options: OidcStandInOptions): Promise<OidcStandIn> {
  const clock = options.clock ?? Date.now
  const issParameter = options.issParameter ?? true
  const keys: SigningKey[] = [await newKey(options.algorithm ?? 'ES256')]
  let signing = keys[0] as SigningKey
  const clients = new Map<string, OidcClient>()
  const codes = new Map<string, PendingCode>()
  const requests: RecordedRequest[] = []
  const metadataPatches: Record<string, unknown>[] = []
  const idTokenOverrides: IdTokenOverride[] = []
  const authorizationOverrides: AuthorizationOverride[] = []
  const responseOverrides = new Map<string, ResponseOverride[]>()
  const hanging = new Set<ServerResponse>()
  let issuer = ''

  const keyById = (kid: string): SigningKey => {
    const key = keys.find(candidate => candidate.kid === kid)
    if (key === undefined) throw new Error(`no key ${kid}`)
    return key
  }

  const sign = async (claims: JWTPayload, override: Pick<IdTokenOverride, 'forgery' | 'signWith'> = {}): Promise<string> => {
    const key = override.signWith === undefined ? signing : keyById(override.signWith)
    switch (override.forgery) {
      case undefined:
        return new SignJWT(claims).setProtectedHeader({ alg: key.algorithm, kid: key.kid, typ: 'JWT' }).sign(key.privateKey)
      case 'alg-none':
        return new UnsecuredJWT(claims).encode()
      case 'hs256-public-key':
        return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'JWT' }).sign(new TextEncoder().encode(await exportSPKI(key.publicKey)))
      case 'unknown-key': {
        const stranger = await newKey(key.algorithm)
        return new SignJWT(claims).setProtectedHeader({ alg: stranger.algorithm, kid: stranger.kid, typ: 'JWT' }).sign(stranger.privateKey)
      }
      case 'missing-kid':
        return new SignJWT(claims).setProtectedHeader({ alg: key.algorithm, typ: 'JWT' }).sign(key.privateKey)
      case 'bad-signature': {
        const [header = '', payload = '', signature = ''] = (await new SignJWT(claims).setProtectedHeader({ alg: key.algorithm, kid: key.kid, typ: 'JWT' }).sign(key.privateKey)).split('.')
        const bytes = Buffer.from(signature, 'base64url')
        bytes[0] = (bytes[0] ?? 0) ^ 0xff
        return `${header}.${payload}.${bytes.toString('base64url')}`
      }
      default: {
        const unknownForgery: never = override.forgery
        throw new Error(`unknown forgery ${String(unknownForgery)}`)
      }
    }
  }

  const metadata = (): Record<string, unknown> => {
    const document: Record<string, unknown> = {
      issuer,
      authorization_endpoint: `${issuer}${OIDC_STAND_IN_PATHS.authorization}`,
      token_endpoint: `${issuer}${OIDC_STAND_IN_PATHS.token}`,
      jwks_uri: `${issuer}${OIDC_STAND_IN_PATHS.jwks}`,
      ...(options.dynamicRegistration === undefined ? {} : { registration_endpoint: `${issuer}${OIDC_STAND_IN_PATHS.registration}` }),
      scopes_supported: [OIDC_AUTHORIZATION_PARAMETERS.scope],
      response_types_supported: [OIDC_AUTHORIZATION_PARAMETERS.response_type],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [...new Set(keys.filter(key => key.published).map(key => key.algorithm))],
      token_endpoint_auth_methods_supported: [OIDC_CLIENT_AUTH_METHOD],
      code_challenge_methods_supported: [OIDC_AUTHORIZATION_PARAMETERS.code_challenge_method],
      claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'azp'],
      authorization_response_iss_parameter_supported: issParameter,
    }
    for (const patch of metadataPatches) {
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) Reflect.deleteProperty(document, field)
        else document[field] = value
      }
    }
    return document
  }

  const redirect = (response: ServerResponse, redirectUri: string, parameters: Record<string, string | undefined>): void => {
    const location = new URL(redirectUri)
    for (const [name, value] of Object.entries(parameters)) if (value !== undefined) location.searchParams.set(name, value)
    response.writeHead(302, { location: location.href, 'cache-control': 'no-store' })
    response.end()
  }

  const authorize = (url: URL, response: ServerResponse): void => {
    const query = url.searchParams
    const client = clients.get(query.get('client_id') ?? '')
    const redirectUri = query.get('redirect_uri') ?? ''
    // Never redirect to a URI the client did not register.
    if (client === undefined || !client.redirectUris.includes(redirectUri)) {
      sendJson(response, 400, { error: 'invalid_request', error_description: 'unknown client or unregistered redirect_uri' })
      return
    }
    const override = authorizationOverrides.shift() ?? {}
    const state = query.get('state') ?? undefined
    const iss = override.iss === null ? undefined : override.iss ?? (issParameter ? issuer : undefined)
    const scopes = (query.get('scope') ?? '').split(' ')
    const codeChallenge = query.get('code_challenge') ?? ''
    let error = override.error
    if (error === undefined && query.get('response_type') !== OIDC_AUTHORIZATION_PARAMETERS.response_type) error = 'unsupported_response_type'
    if (error === undefined && !scopes.includes(OIDC_AUTHORIZATION_PARAMETERS.scope)) error = 'invalid_scope'
    if (error === undefined && (query.get('code_challenge_method') !== OIDC_AUTHORIZATION_PARAMETERS.code_challenge_method || !/^[\w-]{43}$/.test(codeChallenge))) error = 'invalid_request'
    if (error !== undefined) {
      redirect(response, redirectUri, { error, state, iss })
      return
    }
    const code = random()
    const now = clock()
    codes.set(code, { clientId: client.clientId, redirectUri, codeChallenge, nonce: query.get('nonce') ?? undefined, authTime: Math.floor(now / 1000), expiresAt: now + AUTHORIZATION_CODE_SECONDS * 1000, used: false })
    redirect(response, redirectUri, { code, state, iss })
  }

  const authenticateClient = (request: IncomingMessage): OidcClient | undefined => {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.authorization ?? '')
    if (match === null) return undefined
    const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) return undefined
    const client = clients.get(decodeURIComponent(decoded.slice(0, separator)))
    if (client === undefined || !equalSecret(client.clientSecret, decodeURIComponent(decoded.slice(separator + 1)))) return undefined
    return client
  }

  const token = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const client = authenticateClient(request)
    if (client === undefined) {
      sendJson(response, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic realm="token"' })
      return
    }
    const form = new URLSearchParams((await readBody(request)).toString('utf8'))
    if (form.get('grant_type') !== 'authorization_code') {
      sendJson(response, 400, { error: 'unsupported_grant_type' })
      return
    }
    const pending = codes.get(form.get('code') ?? '')
    const now = clock()
    const verifier = form.get('code_verifier') ?? ''
    const invalid = pending === undefined || pending.used || pending.expiresAt <= now || pending.clientId !== client.clientId ||
      pending.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge
    if (pending !== undefined) pending.used = true
    if (invalid) {
      sendJson(response, 400, { error: 'invalid_grant' })
      return
    }
    const override = idTokenOverrides.shift() ?? {}
    const iat = Math.floor(now / 1000)
    const claims: JWTPayload = { iss: issuer, sub: options.subject, aud: client.clientId, iat, exp: iat + ID_TOKEN_SECONDS, auth_time: pending.authTime, ...(pending.nonce === undefined ? {} : { nonce: pending.nonce }), ...override.claims }
    for (const name of override.omit ?? []) Reflect.deleteProperty(claims, name)
    sendJson(response, 200, { access_token: random(), token_type: 'Bearer', expires_in: ID_TOKEN_SECONDS, scope: OIDC_AUTHORIZATION_PARAMETERS.scope, id_token: await sign(claims, override) }, { pragma: 'no-cache' })
  }

  const clientMetadata = (client: OidcClient): Record<string, unknown> => ({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    client_secret_expires_at: 0,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: OIDC_CLIENT_AUTH_METHOD,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    registration_client_uri: `${issuer}${OIDC_STAND_IN_PATHS.registration}/${encodeURIComponent(client.clientId)}`,
  })

  const redirectUrisOf = (body: Buffer): string[] | undefined => {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch (error) {
      // JSON.parse throws SyntaxError for a body that is not JSON; that is a refused registration.
      if (error instanceof SyntaxError) return undefined
      throw error
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const metadataFields = parsed as Record<string, unknown>
    const uris = metadataFields.redirect_uris
    const method = metadataFields.token_endpoint_auth_method
    if (method !== undefined && method !== OIDC_CLIENT_AUTH_METHOD) return undefined
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(uri => typeof uri === 'string' && uri.startsWith('https://'))) return undefined
    return uris as string[]
  }

  const register = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    const registration = options.dynamicRegistration
    if (registration === undefined) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (path === OIDC_STAND_IN_PATHS.registration && request.method === 'POST') {
      if (registration.initialAccessToken !== undefined && (bearer === undefined || !equalSecret(bearer, registration.initialAccessToken))) {
        sendJson(response, 401, { error: 'invalid_token' })
        return
      }
      const redirectUris = redirectUrisOf(await readBody(request))
      if (redirectUris === undefined) {
        sendJson(response, 400, { error: 'invalid_client_metadata' })
        return
      }
      const client: OidcClient = { clientId: random(16), clientSecret: random(), redirectUris, registrationAccessToken: random() }
      clients.set(client.clientId, client)
      sendJson(response, 201, { ...clientMetadata(client), client_id_issued_at: Math.floor(clock() / 1000), registration_access_token: client.registrationAccessToken })
      return
    }
    const client = clients.get(decodeURIComponent(path.slice(OIDC_STAND_IN_PATHS.registration.length + 1)))
    if (client?.registrationAccessToken === undefined || bearer === undefined || !equalSecret(bearer, client.registrationAccessToken)) {
      sendJson(response, 401, { error: 'invalid_token' })
      return
    }
    if (request.method === 'GET') {
      sendJson(response, 200, clientMetadata(client))
      return
    }
    if (request.method === 'PUT') {
      const redirectUris = redirectUrisOf(await readBody(request))
      if (redirectUris === undefined) {
        sendJson(response, 400, { error: 'invalid_client_metadata' })
        return
      }
      const updated: OidcClient = { ...client, redirectUris }
      clients.set(client.clientId, updated)
      sendJson(response, 200, clientMetadata(updated))
      return
    }
    sendJson(response, 405, { error: 'method_not_allowed' })
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', issuer)
    requests.push({ method: request.method ?? '', path: url.pathname, at: clock() })
    const override = responseOverrides.get(url.pathname)?.shift()
    if (override === 'hang') {
      hanging.add(response)
      return
    }
    if (override !== undefined) {
      const body = typeof override.body === 'string' ? override.body : JSON.stringify(override.body)
      response.writeHead(override.status, { 'content-type': 'application/json', ...override.headers })
      response.end(body)
      return
    }
    const route = `${request.method ?? ''} ${url.pathname}`
    if (route === `GET ${OIDC_STAND_IN_PATHS.discovery}`) sendJson(response, 200, metadata())
    else if (route === `GET ${OIDC_STAND_IN_PATHS.jwks}`) sendJson(response, 200, { keys: keys.filter(key => key.published).map(key => key.jwk) })
    else if (route === `GET ${OIDC_STAND_IN_PATHS.authorization}`) authorize(url, response)
    else if (route === `POST ${OIDC_STAND_IN_PATHS.token}`) await token(request, response)
    else if (url.pathname === OIDC_STAND_IN_PATHS.registration || url.pathname.startsWith(`${OIDC_STAND_IN_PATHS.registration}/`)) await register(request, response, url.pathname)
    else sendJson(response, 404, { error: 'not_found' })
  }

  const server: LoopbackServer = await listenHttps(options.authority, [], handle)
  issuer = server.origin

  return {
    issuer,
    ca: options.authority.certificate.pem,
    signingKid: () => signing.kid,
    publishedKids: () => keys.filter(key => key.published).map(key => key.kid),
    registerClient: redirectUris => {
      const client: OidcClient = { clientId: random(16), clientSecret: random(), redirectUris: [...redirectUris] }
      clients.set(client.clientId, client)
      return client
    },
    clients: () => [...clients.values()],
    addKey: async algorithm => {
      const key = await newKey(algorithm ?? signing.algorithm)
      keys.push(key)
      return key.kid
    },
    useKey: kid => {
      const key = keyById(kid)
      if (!key.published) throw new Error(`key ${kid} is retired`)
      signing = key
    },
    retireKey: kid => { keyById(kid).published = false },
    rotateKey: async (rotation = {}) => {
      const previous = signing
      const key = await newKey(rotation.algorithm ?? previous.algorithm)
      keys.push(key)
      signing = key
      if (rotation.retirePrevious === true) previous.published = false
      return key.kid
    },
    overrideMetadata: patch => { metadataPatches.push({ ...patch }) },
    nextIdToken: override => { idTokenOverrides.push(override) },
    nextAuthorizationResponse: override => { authorizationOverrides.push(override) },
    nextResponse: (path, override) => {
      const queue = responseOverrides.get(path) ?? []
      queue.push(override)
      responseOverrides.set(path, queue)
    },
    mintIdToken: async (claims, override) => sign(claims, override),
    requests,
    close: async () => {
      for (const response of hanging) response.destroy()
      await server.close()
    },
  }
}
