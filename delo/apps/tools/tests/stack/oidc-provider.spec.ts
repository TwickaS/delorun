import { ID_TOKEN_ALGORITHMS, IDENTITY_LIMITS } from '@delo/contract-oidc-passkeys'
import { decodeProtectedHeader } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestAuthority, requestOverTls, startOidcStandIn, type OidcClient, type OidcStandIn, type OidcStandInOptions, type TestAuthority } from '../../src/stack/index.ts'
import { authorize, checkDiscovery, checkIdToken, discover, exchange, keySet, REDIRECT_URI, type IdTokenExpectation } from './c14-relying-party.ts'

const SUBJECT = 'owner-at-provider'

let authority: TestAuthority
const running: OidcStandIn[] = []

beforeAll(async () => {
  authority = await createTestAuthority('oidc spec TLS')
})

afterEach(async () => {
  await Promise.all(running.splice(0).map(async provider => provider.close()))
})

async function provider(options: Partial<OidcStandInOptions> = {}): Promise<OidcStandIn> {
  const started = await startOidcStandIn({ authority, subject: SUBJECT, ...options })
  running.push(started)
  return started
}

// A full flow; returns the ID token and what C14 checks it against.
async function signIn(standIn: OidcStandIn, client: OidcClient, reauth = false): Promise<{ readonly idToken: string, readonly expected: IdTokenExpectation, readonly body: Record<string, unknown> }> {
  const flow = await authorize(standIn, client, { reauth })
  expect(flow.callback.get('state')).toBe(flow.state)
  const response = await exchange(standIn, client, flow.callback.get('code') ?? '', flow.verifier)
  expect(response.status).toBe(200)
  const body = response.json() as Record<string, unknown>
  return { idToken: String(body.id_token), body, expected: { issuer: standIn.issuer, clientId: client.clientId, nonce: flow.nonce, jwks: await keySet(standIn), subject: SUBJECT, reauth } }
}

describe('the OpenID Connect provider stand-in', () => {
  describe('C14 discovery and token fixtures', () => {
    it.each(ID_TOKEN_ALGORITHMS)('publishes discovery metadata and %s ID tokens that pass every C14 check', async algorithm => {
      const standIn = await provider({ algorithm })
      const { document, bytes } = await discover(standIn.issuer, standIn.ca)
      expect(checkDiscovery(document, bytes, standIn.issuer)).toBeUndefined()
      expect(document).toMatchObject({ authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['client_secret_basic'], id_token_signing_alg_values_supported: [algorithm] })
      const jwks = await keySet(standIn)
      expect(jwks.keys.every(key => typeof key.kid === 'string' && key.use === 'sig')).toBe(true)

      const client = standIn.registerClient([REDIRECT_URI])
      const flow = await authorize(standIn, client)
      expect(flow.callback.get('iss')).toBe(standIn.issuer)
      const { idToken, expected, body } = await signIn(standIn, client)
      expect(body).not.toHaveProperty('refresh_token')
      expect(decodeProtectedHeader(idToken)).toMatchObject({ alg: algorithm, kid: standIn.signingKid() })
      const checked = await checkIdToken(idToken, expected)
      expect(checked).toMatchObject({ claims: { iss: standIn.issuer, sub: SUBJECT, aud: client.clientId, nonce: expected.nonce } })
    })

    it('answers a reauth flow with a fresh auth_time', async () => {
      let now = Date.now()
      const standIn = await provider({ clock: () => now })
      const client = standIn.registerClient([REDIRECT_URI])
      now += 1000
      const { idToken, expected } = await signIn(standIn, client, true)
      expect(await checkIdToken(idToken, expected)).toMatchObject({ claims: { auth_time: Math.floor(now / 1000) } })
    })
  })

  describe('the code exchange', () => {
    it('gives no token for another code_verifier, a reused code, a wrong secret or another client', async () => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      const other = standIn.registerClient([REDIRECT_URI])

      const wrongVerifier = await authorize(standIn, client)
      const refused = await exchange(standIn, client, wrongVerifier.callback.get('code') ?? '', 'another-verifier-of-sufficient-length-0000000')
      expect([refused.status, refused.json()]).toEqual([400, { error: 'invalid_grant' }])
      // The code is consumed by the failed attempt too.
      expect((await exchange(standIn, client, wrongVerifier.callback.get('code') ?? '', wrongVerifier.verifier)).status).toBe(400)

      const flow = await authorize(standIn, client)
      const code = flow.callback.get('code') ?? ''
      expect((await exchange(standIn, { ...client, clientSecret: 'wrong' }, code, flow.verifier)).status).toBe(401)
      expect((await exchange(standIn, other, code, flow.verifier)).json()).toEqual({ error: 'invalid_grant' })
      const replay = await authorize(standIn, client)
      expect((await exchange(standIn, client, replay.callback.get('code') ?? '', replay.verifier)).status).toBe(200)
      expect((await exchange(standIn, client, replay.callback.get('code') ?? '', replay.verifier)).json()).toEqual({ error: 'invalid_grant' })
    })

    it('never redirects to an unregistered URI and refuses an authorization request without S256 PKCE', async () => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      expect((await authorize(standIn, client, { parameters: { redirect_uri: 'https://elsewhere.example/callback' } })).callback.get('status')).toBe('400')
      for (const parameters of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { scope: 'profile' }, { response_type: 'token' }]) {
        const flow = await authorize(standIn, client, { parameters })
        expect(flow.callback.get('code')).toBeNull()
        expect(flow.callback.get('error')).toMatch(/^(invalid_request|invalid_scope|unsupported_response_type)$/)
      }
    })
  })

  describe('hostile hooks', () => {
    it('issues a correctly signed token with a wrong audience, or several audiences without azp', async () => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      standIn.nextIdToken({ claims: { aud: 'another-home' } })
      const wrong = await signIn(standIn, client)
      expect(await checkIdToken(wrong.idToken, wrong.expected)).toEqual({ refused: 'OIDC_AUDIENCE_MISMATCH' })
      standIn.nextIdToken({ claims: { aud: [client.clientId, 'another-home'] } })
      const several = await signIn(standIn, client)
      expect(await checkIdToken(several.idToken, several.expected)).toEqual({ refused: 'OIDC_AUDIENCE_MISMATCH' })
      standIn.nextIdToken({ claims: { aud: [client.clientId, 'another-home'], azp: client.clientId } })
      const withAzp = await signIn(standIn, client)
      expect(await checkIdToken(withAzp.idToken, withAzp.expected)).toHaveProperty('claims')
    })

    it('mixes up issuers: another iss parameter, a code from issuer B, and a token from B claiming A', async () => {
      const issuerA = await provider()
      const issuerB = await provider()
      const clientA = issuerA.registerClient([REDIRECT_URI])
      const clientB = issuerB.registerClient([REDIRECT_URI])

      issuerA.nextAuthorizationResponse({ iss: issuerB.issuer })
      expect((await authorize(issuerA, clientA)).callback.get('iss')).toBe(issuerB.issuer)
      issuerA.nextAuthorizationResponse({ iss: null })
      expect((await authorize(issuerA, clientA)).callback.has('iss')).toBe(false)

      // A flow started with A whose callback carries B's code: A's token endpoint does not know it.
      const fromB = await authorize(issuerB, clientB)
      expect((await exchange(issuerA, clientA, fromB.callback.get('code') ?? '', fromB.verifier)).json()).toEqual({ error: 'invalid_grant' })

      // B signs a token claiming A's issuer; checked against A's key set it names an unknown key.
      issuerB.nextIdToken({ claims: { iss: issuerA.issuer, aud: clientA.clientId } })
      const forged = await signIn(issuerB, clientB)
      expect(await checkIdToken(forged.idToken, { ...forged.expected, issuer: issuerA.issuer, clientId: clientA.clientId, jwks: await keySet(issuerA) })).toEqual({ refused: 'OIDC_UNKNOWN_KEY' })
      // Against B's own keys the signature holds and the issuer check refuses it.
      expect(await checkIdToken(forged.idToken, { ...forged.expected, clientId: clientA.clientId })).toEqual({ refused: 'OIDC_ISSUER_MISMATCH' })
    })

    it.each([
      ['alg-none', 'OIDC_ALGORITHM_UNSUPPORTED', 'none'],
      ['hs256-public-key', 'OIDC_ALGORITHM_UNSUPPORTED', 'HS256'],
      ['unknown-key', 'OIDC_UNKNOWN_KEY', 'ES256'],
      ['missing-kid', 'OIDC_UNKNOWN_KEY', 'ES256'],
      ['bad-signature', 'OIDC_SIGNATURE_INVALID', 'ES256'],
    ] as const)('forges an ID token as %s, which C14 refuses with %s', async (forgery, code, alg) => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      standIn.nextIdToken({ forgery })
      const { idToken, expected } = await signIn(standIn, client)
      expect(decodeProtectedHeader(idToken).alg).toBe(alg)
      if (forgery === 'hs256-public-key') expect(decodeProtectedHeader(idToken).kid).toBe(standIn.signingKid())
      expect(await checkIdToken(idToken, expected)).toEqual({ refused: code })
    })

    it('changes the subject, nonce, issue time and auth_time of the next token', async () => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      const now = Math.floor(Date.now() / 1000)
      const cases = [
        [{ claims: { sub: 'someone-else' } }, false, 'OIDC_SUBJECT_MISMATCH'],
        [{ claims: { nonce: 'another-nonce' } }, false, 'OIDC_NONCE_MISMATCH'],
        [{ claims: { iat: now - 3600, exp: now - 60 } }, false, 'OIDC_TOKEN_EXPIRED'],
        [{ claims: { auth_time: now - 300 } }, true, 'OIDC_REAUTH_TOO_OLD'],
        [{ omit: ['auth_time'] }, true, 'OIDC_REAUTH_TOO_OLD'],
      ] as const
      for (const [override, reauth, code] of cases) {
        standIn.nextIdToken(override)
        const { idToken, expected } = await signIn(standIn, client, reauth)
        expect.soft(await checkIdToken(idToken, expected), JSON.stringify(override)).toEqual({ refused: code })
      }
    })

    it('rotates keys: a new key signs while the old stays published, then a retired key stops verifying', async () => {
      const standIn = await provider()
      const client = standIn.registerClient([REDIRECT_URI])
      const first = standIn.signingKid()
      const published = await standIn.addKey()
      expect(standIn.publishedKids()).toEqual([first, published])
      expect(standIn.signingKid()).toBe(first)

      const second = await standIn.rotateKey()
      expect(standIn.publishedKids()).toEqual([first, published, second])
      const rotated = await signIn(standIn, client)
      expect(decodeProtectedHeader(rotated.idToken).kid).toBe(second)
      expect(await checkIdToken(rotated.idToken, rotated.expected)).toHaveProperty('claims')

      standIn.retireKey(first)
      standIn.nextIdToken({ signWith: first })
      const retired = await signIn(standIn, client)
      expect(standIn.publishedKids()).not.toContain(first)
      expect(await checkIdToken(retired.idToken, retired.expected)).toEqual({ refused: 'OIDC_UNKNOWN_KEY' })

      await standIn.rotateKey({ algorithm: 'RS256', retirePrevious: true })
      expect(standIn.publishedKids()).toEqual([published, standIn.signingKid()])
      expect((await discover(standIn.issuer, standIn.ca)).document.id_token_signing_alg_values_supported).toEqual(['ES256', 'RS256'])
    })

    it('changes discovery metadata, which C14 then refuses', async () => {
      const standIn = await provider()
      const cases = [
        [{ issuer: 'https://127.0.0.1:1' }, 'OIDC_DISCOVERY_FAILED'],
        [{ code_challenge_methods_supported: ['plain'] }, 'OIDC_PKCE_UNSUPPORTED'],
        [{ id_token_signing_alg_values_supported: ['HS256', 'none'] }, 'OIDC_ALGORITHM_UNSUPPORTED'],
        [{ padding: 'x'.repeat(IDENTITY_LIMITS.documentBytes) }, 'OIDC_DISCOVERY_FAILED'],
        [{ response_types_supported: undefined }, 'OIDC_DISCOVERY_FAILED'],
      ] as const
      for (const [patch, code] of cases) {
        const fresh = await provider()
        fresh.overrideMetadata(patch)
        const { document, bytes } = await discover(fresh.issuer, fresh.ca)
        expect.soft(checkDiscovery(document, bytes, fresh.issuer), JSON.stringify(patch).slice(0, 80)).toBe(code)
      }
      expect(checkDiscovery((await discover(standIn.issuer, standIn.ca)).document, 0, standIn.issuer)).toBeUndefined()
    })

    it('answers the next request to a path with a raw error, or holds it open', async () => {
      const standIn = await provider()
      standIn.nextResponse('/jwks', { status: 500, body: { error: 'server_error' } })
      expect((await requestOverTls(`${standIn.issuer}/jwks`, { ca: standIn.ca })).status).toBe(500)
      expect((await requestOverTls(`${standIn.issuer}/jwks`, { ca: standIn.ca })).status).toBe(200)

      standIn.nextResponse('/.well-known/openid-configuration', 'hang')
      const held = requestOverTls(`${standIn.issuer}/.well-known/openid-configuration`, { ca: standIn.ca })
      const outcome = await Promise.race([held.then(() => 'answered', () => 'failed'), new Promise(resolve => { setTimeout(() => { resolve('held') }, 200) })])
      expect(outcome).toBe('held')
      await standIn.close()
      await expect(held).rejects.toThrow()
      running.splice(running.indexOf(standIn), 1)
    })
  })

  describe('dynamic registration', () => {
    it('registers a client with the initial access token, updates its redirect URIs with the registration token, and signs it in', async () => {
      const standIn = await provider({ dynamicRegistration: { initialAccessToken: 'initial-token' } })
      const registrationEndpoint = String((await discover(standIn.issuer, standIn.ca)).document.registration_endpoint)
      const request = (token: string | undefined, url = registrationEndpoint, method = 'POST', redirectUris: readonly string[] = [REDIRECT_URI]): ReturnType<typeof requestOverTls> => requestOverTls(url, {
        ca: standIn.ca,
        method,
        headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ client_name: 'Delo', redirect_uris: redirectUris, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic', application_type: 'web' }),
      })
      expect((await request(undefined)).status).toBe(401)
      expect((await request('wrong')).status).toBe(401)
      const created = await request('initial-token')
      expect(created.status).toBe(201)
      const registration = created.json() as { client_id: string, client_secret: string, registration_access_token: string, registration_client_uri: string }

      const added = 'https://studio-two.example.com/auth/oidc/callback'
      expect((await request('initial-token', registration.registration_client_uri, 'PUT', [REDIRECT_URI, added])).status).toBe(401)
      const updated = await request(registration.registration_access_token, registration.registration_client_uri, 'PUT', [REDIRECT_URI, added])
      expect(updated.json()).toMatchObject({ redirect_uris: [REDIRECT_URI, added] })

      const client = standIn.clients().find(candidate => candidate.clientId === registration.client_id)
      expect(client).toBeDefined()
      const { idToken, expected } = await signIn(standIn, { clientId: registration.client_id, clientSecret: registration.client_secret, redirectUris: [added] })
      expect(await checkIdToken(idToken, expected)).toHaveProperty('claims')
    })

    it('offers no registration endpoint unless asked', async () => {
      const standIn = await provider()
      expect((await discover(standIn.issuer, standIn.ca)).document).not.toHaveProperty('registration_endpoint')
    })
  })
})
