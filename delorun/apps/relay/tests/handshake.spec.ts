/**
 * The tunnel handshake: the token check before the upgrade, the challenge, the home key's proof,
 * the live check and C6's 10-second limit. Each refusal names the close code or HTTP status C6
 * gives it, and each is paired with the attempt that succeeds, so removing the check turns its
 * spec red: drop the live check and `a second valid-key tunnel for a live name is refused and
 * announced` opens a second live tunnel; drop the proof comparison and a proof by another key is
 * accepted; drop the token's signature check and the token whose signature is all `A`s, or the one
 * another token key signed, is accepted with 200 instead of refused with 401.
 */
import { RELAY_LIMITS, TUNNEL_PROOF_LABEL, type RelayId } from '@delorun/contract-relay-protocol'
import type { KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { concatBytes, fromBase64Url, generateEd25519, signBytes, toBase64Url, utf8 } from '../src/keys.ts'
import { TunnelTokens } from '../src/token.ts'
import { connectHome, issueToken, makeRelay, tokenRequestBody, type RelayFixture } from './support.ts'

const fixtures: RelayFixture[] = []
afterEach(() => {
  for (const fixture of fixtures) fixture.core.dispose()
  fixtures.length = 0
})

function relay(names?: readonly string[]): RelayFixture {
  const fixture = makeRelay(names === undefined ? {} : { names })
  fixtures.push(fixture)
  return fixture
}

describe('becoming live', () => {
  it('answers a token and a proof of the bound key with ready, the tunnel id and the limits', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test' })
    expect(home.accepted).toBe(true)
    expect(home.ready).toBe(true)
    const ready = home.socket.lastText()
    expect(ready?.type).toBe('ready')
    expect(ready?.tunnelId).toBe(home.tunnelId)
    expect(JSON.parse(home.socket.texts.at(-1) ?? '{}')).toMatchObject({ type: 'ready', limits: RELAY_LIMITS })
    expect(fixture.core.isLive('studio.example.test')).toBe(true)
  })

  it('sends a challenge with this relay\'s id and 32 random bytes before it accepts anything', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    const challenge = JSON.parse(home.socket.texts[0] ?? '{}') as { type: string; relayId: string; nonce: string }
    expect(challenge.type).toBe('challenge')
    expect(challenge.relayId).toBe(fixture.settings.relayId)
    expect(Buffer.from(challenge.nonce, 'base64url')).toHaveLength(RELAY_LIMITS.challengeNonceBytes)
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })
})

describe('the upgrade refusal', () => {
  it('refuses a missing token with 401 before any upgrade', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', authorization: '', token: issueToken(fixture, 'studio.example.test') })
    expect(home.accepted).toBe(false)
    expect(home.status).toBe(401)
    expect(home.code).toBe('TUNNEL_TOKEN_INVALID')
    expect(home.socket.texts).toEqual([])
  })

  it('refuses an upgrade that does not ask for the protocol\'s subprotocol', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', subprotocol: 'other.v1' })
    expect(home.accepted).toBe(false)
    expect(home.status).toBe(400)
    expect(home.code).toBe('SUBPROTOCOL_MISSING')
    expect(home.socket.texts).toEqual([])
  })

  it('refuses a token issued by another relay', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    const elsewhere = new TunnelTokens({ tokenKey: fixture.tokenKey, relayId: 'another-relay' as RelayId, bindings: fixture.settings.bindings, now: fixture.now, startedAt: 0 })
    const foreign = elsewhere.issue(tokenRequestBody(homeKey, 'studio.example.test', fixture.now())).token
    const home = connectHome(fixture, { name: 'studio.example.test', token: foreign })
    expect(home.accepted).toBe(false)
    expect(home.status).toBe(401)
    expect(home.code).toBe('TUNNEL_TOKEN_INVALID')
  })

  it('refuses a token that already opened a tunnel', () => {
    const fixture = relay()
    const token = issueToken(fixture, 'studio.example.test')
    expect(connectHome(fixture, { name: 'studio.example.test', token }).accepted).toBe(true)
    const replay = connectHome(fixture, { name: 'studio.example.test', token })
    expect(replay.accepted).toBe(false)
    expect(replay.status).toBe(401)
    expect(replay.code).toBe('TUNNEL_TOKEN_REPLAYED')
  })

  it('refuses a token whose signature is all As with 401 before any upgrade', () => {
    const fixture = relay()
    const [claims = ''] = issueToken(fixture, 'studio.example.test').split('.')
    // 86 base64url characters decode to the 64 bytes a token signature must hold, so this token
    // reaches the signature check and is refused there rather than by the decoder.
    const signature = 'A'.repeat(86)
    expect(fromBase64Url(signature, 64)).toHaveLength(64)
    const home = connectHome(fixture, { name: 'studio.example.test', token: `${claims}.${signature}` })
    expect(home.accepted).toBe(false)
    expect(home.status).toBe(401)
    expect(home.code).toBe('TUNNEL_TOKEN_INVALID')
    expect(home.socket.texts).toEqual([])
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })

  it('refuses a token signed by another token key with 401 before any upgrade', () => {
    const fixture = relay()
    const homeKey = fixture.homes.get('studio.example.test')
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    const stranger = new TunnelTokens({ tokenKey: generateEd25519(), relayId: fixture.settings.relayId, bindings: fixture.settings.bindings, now: fixture.now, startedAt: 0 })
    const foreign = stranger.issue(tokenRequestBody(homeKey, 'studio.example.test', fixture.now())).token
    const home = connectHome(fixture, { name: 'studio.example.test', token: foreign })
    expect(home.accepted).toBe(false)
    expect(home.status).toBe(401)
    expect(home.code).toBe('TUNNEL_TOKEN_INVALID')
    expect(home.socket.texts).toEqual([])
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })
})

describe('the proof', () => {
  it('refuses a proof by another key with 4401, and the name stays without a tunnel', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', proofKey: generateEd25519() })
    expect(home.accepted).toBe(true)
    expect(home.ready).toBe(false)
    expect(home.socket.closeCode).toBe(4401)
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })

  it('refuses a proof that is not a 64-byte base64url signature with 4401', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    home.socket.deliverText(JSON.stringify({ type: 'proof', signature: 'not-a-signature' }))
    expect(home.socket.closeCode).toBe(4401)
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })

  it('refuses an answer that is not a proof with 4400', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    home.socket.deliverText(JSON.stringify({ type: 'ready' }))
    expect(home.socket.closeCode).toBe(4400)
  })

  it('closes a handshake that sends no proof within 10 seconds with 4408', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    fixture.timers.advance(RELAY_LIMITS.handshakeTimeoutMs - 1)
    expect(home.socket.closeCode).toBeUndefined()
    fixture.timers.advance(1)
    expect(home.socket.closeCode).toBe(4408)
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
  })
})

describe('one live tunnel per name', () => {
  it('a second valid-key tunnel for a live name is refused and announced', () => {
    const fixture = relay()
    const first = connectHome(fixture, { name: 'studio.example.test' })
    expect(first.ready).toBe(true)
    const secondToken = issueToken(fixture, 'studio.example.test')
    const second = connectHome(fixture, { name: 'studio.example.test', token: secondToken })
    expect(second.ready).toBe(false)
    expect(second.socket.texts.at(-1)).toContain('TUNNEL_ALREADY_LIVE')
    expect(second.socket.closeCode).toBe(4409)
    const announcements = first.socket.announcements()
    expect(announcements).toHaveLength(1)
    expect(announcements[0]).toMatchObject({ type: 'announce', kind: 'second-tunnel-refused', clientAddress: '198.51.100.9' })
    expect(announcements[0]?.jti).toBe(JSON.parse(Buffer.from(secondToken.split('.')[0] ?? '', 'base64url').toString('utf8')).jti)
    expect(fixture.core.isLive('studio.example.test')).toBe(true)
  })

  it('a tunnel that closes frees the name for the next handshake', () => {
    const fixture = relay()
    const first = connectHome(fixture, { name: 'studio.example.test' })
    first.socket.remoteClose()
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
    const second = connectHome(fixture, { name: 'studio.example.test' })
    expect(second.ready).toBe(true)
  })
})

describe('cross-name attempts', () => {
  it('a token for one name cannot open another', () => {
    const fixture = relay(['studio.example.test', 'other.example.test'])
    const otherKey = fixture.homes.get('other.example.test')
    if (otherKey === undefined) throw new Error('the fixture binds no home key')
    const token = issueToken(fixture, 'studio.example.test')
    const attempt = connectHome(fixture, { name: 'studio.example.test', token, proofKey: otherKey })
    expect(attempt.socket.closeCode).toBe(4401)
    expect(fixture.core.isLive('studio.example.test')).toBe(false)
    expect(fixture.core.isLive('other.example.test')).toBe(false)
  })

  it('opens the tunnel under the token\'s name, so the other name stays without one', () => {
    const fixture = relay(['studio.example.test', 'other.example.test'])
    const home = connectHome(fixture, { name: 'studio.example.test' })
    expect(home.ready).toBe(true)
    expect(fixture.core.isLive('studio.example.test')).toBe(true)
    expect(fixture.core.isLive('other.example.test')).toBe(false)
  })

  it('refuses a proof that names another name than the token, because the home signs the token\'s fields', () => {
    const fixture = relay(['studio.example.test', 'other.example.test'])
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    const nonce = home.socket.lastText()?.nonce ?? ''
    const otherKey = fixture.homes.get('other.example.test')
    if (otherKey === undefined) throw new Error('the fixture binds no home key')
    const token = issueToken(fixture, 'studio.example.test')
    const claims = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { jti: string }
    const signature = toBase64Url(signBytesWith(otherKey, { relayId: fixture.settings.relayId, name: 'other.example.test', jti: claims.jti, nonce }))
    home.socket.deliverText(JSON.stringify({ type: 'proof', signature }))
    expect(home.socket.closeCode).toBe(4401)
    expect(fixture.core.isLive('other.example.test')).toBe(false)
  })
})

describe('frames before ready', () => {
  it('closes a tunnel that sends a frame before its handshake completed with 4400', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test', answer: 'none' })
    home.socket.deliverBinary(Uint8Array.of(0x02, 0, 0, 0, 1, 0x41))
    expect(home.socket.closeCode).toBe(4400)
  })

  it('closes a tunnel that sends a text message after its handshake with 4400', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: 'studio.example.test' })
    home.socket.deliverText('{"type":"proof"}')
    expect(home.socket.closeCode).toBe(4400)
  })
})

/** A proof signature by another key over a name the token does not carry, for the cross-name case. */
function signBytesWith(key: KeyObject, parts: { readonly relayId: string; readonly name: string; readonly jti: string; readonly nonce: string }): Uint8Array {
  return signBytes(key, concatBytes(utf8(TUNNEL_PROOF_LABEL), Uint8Array.of(0), utf8(parts.relayId), utf8(parts.name), utf8(parts.jti), utf8(parts.nonce)))
}
