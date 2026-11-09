/**
 * The tunnel token: the home-signed request, the claims the issuer signs, the expiry, the
 * single-use id, the restart rule and the binding. Each refusal spec is paired with the
 * acceptance it must not break, so removing the check it covers turns the spec red: drop the
 * `exp` comparison and `a token presented 61 seconds after it was issued is refused` accepts the
 * token; drop the `accepted` map lookup and the replay case opens a second tunnel.
 */
import { RELAY_LIMITS, RELAY_PROTOCOL_VERSION, type Base64Url, type RelayId } from '@delo/contract-relay-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it } from 'vitest'
import { isRelayError } from '../src/errors.ts'
import { fromBase64Url, generateEd25519, keyIdOf, rawPublicKey, signBytes, toBase64Url, utf8 } from '../src/keys.ts'
import { TunnelTokens } from '../src/token.ts'
import { claimsOf, issueToken, makeRelay, tokenRequestBody, type RelayFixture } from './support.ts'

const fixtures: RelayFixture[] = []
afterEach(() => {
  fixtures.length = 0
})

function relay(options: { readonly names?: readonly string[]; readonly startedAt?: number } = {}): RelayFixture {
  const fixture = makeRelay(options)
  fixtures.push(fixture)
  return fixture
}

/** The relay's own issuer, rebuilt from the fixture's key and configuration. */
function tokensOf(fixture: RelayFixture): TunnelTokens {
  return new TunnelTokens({ tokenKey: fixture.tokenKey, relayId: fixture.settings.relayId, bindings: fixture.settings.bindings, now: fixture.now, startedAt: fixture.settings.startedAt })
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (!isRelayError(error)) throw error
    return error.code
  }
  throw new Error('the token was accepted')
}

describe('issuing', () => {
  it('answers a home-signed request with a token whose claims name the name, the home key and this relay', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    const token = fixture.core.tokenRequest(tokenRequestBody(homeKey, 'studio.example.test', fixture.now())).token
    const claims = claimsOf(token)
    expect(claims.v).toBe(RELAY_PROTOCOL_VERSION)
    expect(claims.name).toBe('studio.example.test')
    expect(claims.iss).toBe(fixture.settings.relayId)
    expect(claims.homeKeyId).toBe(keyIdOf(Buffer.from(rawPublicKey(homeKey))))
    expect(claims.exp - claims.iat).toBe(RELAY_LIMITS.tokenLifetimeMs)
    expect(fromBase64Url(claims.jti, RELAY_LIMITS.tokenIdBytes)).toHaveLength(RELAY_LIMITS.tokenIdBytes)
  })

  it('mints a new token id for every request', () => {
    const fixture = relay()
    const first = claimsOf(issueToken(fixture, 'studio.example.test')).jti
    const second = claimsOf(issueToken(fixture, 'studio.example.test')).jti
    expect(first).not.toBe(second)
  })

  it('refuses a request whose timestamp is more than 60 seconds from the relay\'s clock', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    expect(codeOf(() => fixture.core.tokenRequest(tokenRequestBody(homeKey, 'studio.example.test', fixture.now() - RELAY_LIMITS.tokenClockSkewMs - 1)))).toBe('TOKEN_REQUEST_STALE')
    expect(fixture.core.tokenRequest(tokenRequestBody(homeKey, 'studio.example.test', fixture.now() - RELAY_LIMITS.tokenClockSkewMs)).token).toContain('.')
  })

  it('refuses a request whose signature does not verify', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    const other = relay().homes.get('studio.example.test')
    if (homeKey === undefined || other === undefined) throw new Error('the fixtures bind no home key')
    const body = JSON.parse(Buffer.from(tokenRequestBody(homeKey, 'studio.example.test', fixture.now())).toString('utf8')) as { signature: string }
    const forged = utf8(JSON.stringify({ ...body, signature: toBase64Url(signBytes(other, utf8('another message'))) }))
    expect(codeOf(() => fixture.core.tokenRequest(forged))).toBe('TOKEN_REQUEST_INVALID')
    expect(fixture.core.tokenRequest(tokenRequestBody(homeKey, 'studio.example.test', fixture.now())).token).toContain('.')
  })

  it('refuses a request whose name is bound to another key', () => {
    const fixture = relay({ names: ['studio.example.test', 'other.example.test'] })
    const otherKey = fixture.homes.get('other.example.test')
    if (otherKey === undefined) throw new Error('the fixture binds no home key')
    expect(codeOf(() => fixture.core.tokenRequest(tokenRequestBody(otherKey, 'studio.example.test', fixture.now())))).toBe('NAME_NOT_BOUND')
  })

  it('refuses a request for a name it does not bind', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    expect(codeOf(() => fixture.core.tokenRequest(tokenRequestBody(homeKey, 'unbound.example.test', fixture.now())))).toBe('NAME_NOT_BOUND')
  })

  it('refuses a malformed request body', () => {
    const fixture = relay()
    expect(codeOf(() => fixture.core.tokenRequest(utf8('{')))).toBe('TOKEN_REQUEST_INVALID')
    expect(codeOf(() => fixture.core.tokenRequest(utf8(JSON.stringify({ v: 2 }))))).toBe('TOKEN_REQUEST_INVALID')
  })
})

describe('presenting', () => {
  it('accepts the token it issued for the bound name and key', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const claims = tokensOf(fixture).verify(token)
    expect(claims.name).toBe('studio.example.test')
  })

  it('refuses a token presented 61 seconds after it was issued', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    fixture.timers.advance(61_000)
    expect(codeOf(() => tokensOf(fixture).verify(token))).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('refuses a token whose id it already accepted', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const tokens = tokensOf(fixture)
    tokens.accept(tokens.verify(token))
    expect(codeOf(() => tokens.verify(token))).toBe('TUNNEL_TOKEN_REPLAYED')
  })

  it('refuses a token issued before the relay started, so a restart accepts none that predate it', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const restarted = new TunnelTokens({
      tokenKey: fixture.tokenKey,
      relayId: fixture.settings.relayId,
      bindings: fixture.settings.bindings,
      now: fixture.now,
      startedAt: fixture.now() + 1,
    })
    expect(codeOf(() => restarted.verify(token))).toBe('TUNNEL_TOKEN_INVALID')
    const live = new TunnelTokens({ tokenKey: fixture.tokenKey, relayId: fixture.settings.relayId, bindings: fixture.settings.bindings, now: fixture.now, startedAt: fixture.now() - 1 })
    expect(live.verify(token).name).toBe('studio.example.test')
  })

  it('refuses a token another relay issued', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const otherRelay = 'another-relay-id' as RelayId
    const elsewhere = new TunnelTokens({ tokenKey: fixture.tokenKey, relayId: otherRelay, bindings: fixture.settings.bindings, now: fixture.now, startedAt: fixture.now() - 1 })
    expect(codeOf(() => elsewhere.verify(token))).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('refuses a token whose claims were edited after it was signed', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const [text = '', signature = ''] = token.split('.')
    const claims = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Record<string, unknown>
    const edited = toBase64Url(utf8(JSON.stringify({ ...claims, name: 'other.example.test' })))
    expect(codeOf(() => tokensOf(fixture).verify(`${edited}.${signature}`))).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('refuses a token whose binding changed since it was issued', () => {
    const fixture = relay({ names: ['studio.example.test', 'other.example.test'] })
    const token = issueToken(fixture, 'studio.example.test')
    const rebound = new Map(fixture.settings.bindings)
    const binding = rebound.get('studio.example.test')
    if (binding === undefined) throw new Error('the fixture binds no name')
    rebound.set('studio.example.test', { ...binding, homeKeyId: brandString<Base64Url>(keyIdOf(new Uint8Array(32))) })
    const changed = new TunnelTokens({ tokenKey: fixture.tokenKey, relayId: fixture.settings.relayId, bindings: rebound, now: fixture.now, startedAt: fixture.now() - 1 })
    expect(codeOf(() => changed.verify(token))).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('refuses a token that is not two base64url parts', () => {
    const fixture = relay()
    const tokens = tokensOf(fixture)
    expect(codeOf(() => tokens.verify('no-dot'))).toBe('TUNNEL_TOKEN_INVALID')
    expect(codeOf(() => tokens.verify('a.b.c'))).toBe('TUNNEL_TOKEN_INVALID')
    expect(codeOf(() => tokens.verify(`${'a'.repeat(10)}.`))).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('drops an accepted id once its token expires', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const tokens = tokensOf(fixture)
    tokens.accept(tokens.verify(token))
    expect(tokens.acceptedCount()).toBe(1)
    fixture.timers.advance(61_000)
    expect(tokens.acceptedCount()).toBe(0)
  })
})

describe('the signature', () => {
  it('covers the RFC 8785 serialization of the claims, so a reordered token still verifies', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const [text = '', signature = ''] = token.split('.')
    const claims = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Record<string, unknown>
    const reordered = toBase64Url(utf8(JSON.stringify(Object.fromEntries(Object.entries(claims).reverse()))))
    expect(tokensOf(fixture).verify(`${reordered}.${signature}`).name).toBe('studio.example.test')
  })

  it('verifies with the token public key and no other', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    const stranger = new TunnelTokens({ tokenKey: generateEd25519(), relayId: fixture.settings.relayId, bindings: fixture.settings.bindings, now: fixture.now, startedAt: 0 })
    expect(codeOf(() => stranger.verify(token))).toBe('TUNNEL_TOKEN_INVALID')
  })
})
