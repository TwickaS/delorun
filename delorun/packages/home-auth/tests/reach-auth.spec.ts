/**
 * Reach sign-in in the coordinator: the listeners a provider asks the home to serve with their declared factor, the
 * approval window and the local approval, the match code, sign-in's challenge and signature, and the synchronous
 * admission of a session token with C4's limits and rotation.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, SESSION_STORE_PERSIST_MS, type DeviceId, type StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_LIMITS, type Base64Url, type DevicePublicKeyJwk } from '@delorun/contract-device-approval'
import { formatMatchCode, matchCode, typedCodeMatches } from '../src/match-code.ts'
import { loadHomeKey } from '../src/home-key.ts'
import { CHALLENGE_LIMIT_DEFAULTS } from '../src/pairing.ts'
import { Challenges, signInMessage, signInVerifies } from '../src/sign-in.ts'
import { deviceIdOf } from '../src/records.ts'
import { SESSIONS_FILE } from '../src/sessions.ts'
import { HomeAuth, type SignedIn } from '../src/home-auth.ts'
import { homeFixture, type Home } from './fixtures/home.ts'
// @ts-expect-error -- the sign-in page's browser module is JavaScript without declarations.
import { deviceIdOf as browserDeviceIdOf, fromBase64Url, matchCodeOf, signInMessage as browserSignInMessage, toBase64Url } from '../assets/sign-in.js'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const SOURCE = '127.0.0.1'
const SERVED = { listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' } as const

/** A real P-256 device key, as a browser makes one. */
function device(): { readonly jwk: DevicePublicKeyJwk; readonly id: DeviceId; readonly sign: (address: string, challenge: string) => string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  const jwk: DevicePublicKeyJwk = { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(exported.x ?? ''), y: brandString<Base64Url>(exported.y ?? '') }
  return {
    jwk,
    id: deviceIdOf(jwk),
    sign: (address, challenge) => sign('sha256', signInMessage(address, challenge), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }
}

/** Approve a device through the window and the local approval. */
async function approve(auth: HomeAuth, phone: ReturnType<typeof device>): Promise<void> {
  await auth.openApprovalWindow()
  const deviceNonce = brandString<Base64Url>(Buffer.alloc(16, 3).toString('base64url'))
  const accepted = await auth.requestApproval({ devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce, label: 'Phone', platform: 'iOS' }, { listener: 'reach-tailscale-private', source: '127.0.0.1' })
  const homeKey = Buffer.from(accepted.homePublicKey, 'base64url')
  await auth.approveLocally(accepted.requestId, matchCode({ homePublicKey: homeKey, deviceId: phone.id, homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS }))
}

/** Sign a phone in. */
async function signIn(auth: HomeAuth, phone: ReturnType<typeof device>, rotate?: string): Promise<SignedIn> {
  const challenge = await auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
  return auth.signIn({ deviceId: phone.id, challenge, signature: phone.sign(ADDRESS, challenge), listener: 'reach-tailscale-private', ...(rotate === undefined ? {} : { rotate }) })
}

async function served(): Promise<Home> {
  const home = await homeFixture()
  home.auth.serve(SERVED)
  return home
}

describe('the listeners a provider asks the home to serve', () => {
  it('tailnet-membership is refused on a Funnel or own-domain address', async () => {
    const home = await homeFixture()
    try {
      // Pins the option check: without it a Funnel listener's sessions need no second factor.
      expect(() => home.auth.serve({ ...SERVED, listener: 'reach-tailscale-funnel', address: brandString<StudioAddress>('https://home.example.ts.net:8443') })).toThrow(expect.objectContaining({ code: 'TAILNET_IDENTITY_UNAVAILABLE' }))
      // Pins the address check: a private listener on an own-domain address.
      expect(() => home.auth.serve({ ...SERVED, address: brandString<StudioAddress>('https://studio.example.org') })).toThrow(expect.objectContaining({ code: 'TAILNET_IDENTITY_UNAVAILABLE' }))
      expect(() => home.auth.serve({ ...SERVED, factor: 'passkey' })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
      const off = home.auth.serve(SERVED)
      expect(() => home.auth.serve(SERVED)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
      expect(home.auth.servedListener('reach-tailscale-private')).toEqual(SERVED)
      off()
      off()
      expect(home.auth.servedListener('reach-tailscale-private')).toBeUndefined()
    } finally {
      await home.dispose()
    }
  })
})

describe('the approval window', () => {
  it('a request outside a window is refused, and a window lasts 5 minutes', async () => {
    const home = await served()
    try {
      const phone = device()
      const input = { devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce: brandString<Base64Url>('AAAAAAAAAAAAAAAAAAAAAA'), label: 'Phone', platform: '' }
      const where = { listener: 'reach-tailscale-private', source: '127.0.0.1' } as const
      // Pins the window check: without it any tailnet device fills the pending requests.
      await expect(home.auth.requestApproval(input, where)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED', status: 403 })
      const closesAt = await home.auth.openApprovalWindow()
      expect(closesAt).toBe(home.clock.now + DEVICE_APPROVAL_LIMITS.approvalWindowMs)
      // The local claim: a home with no owner is claimed by the person who opened the window.
      await expect(home.auth.owner()).resolves.toMatchObject({ firstDeviceId: 'local' })
      await home.auth.openApprovalWindow()
      await expect(home.auth.owner()).resolves.toMatchObject({ firstDeviceId: 'local' })
      await expect(home.auth.requestApproval(input, where)).resolves.toMatchObject({ expiresAt: home.clock.now + DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs })
      home.clock.advance(DEVICE_APPROVAL_LIMITS.approvalWindowMs)
      await expect(home.auth.requestApproval(input, where)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
      await expect(home.auth.requestApproval(input, { ...where, listener: 'reach-tailscale-funnel' })).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
      await home.auth.openApprovalWindow()
      await expect(home.auth.requestApproval(input, { ...where, listener: 'reach-tailscale-funnel' })).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a local claim over device records with no owner', async () => {
    const home = await served()
    try {
      await writeFile(join(home.directory, 'devices.json'), JSON.stringify({ v: 1, devices: [{ v: 1, id: 'x', publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, address: ADDRESS, label: 'X', platform: '', approvedAt: 0, approvedBy: null, lastSignInAt: null }] }), { mode: 0o600 })
      await expect(home.auth.openApprovalWindow()).rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('holds C5\'s limits: 5 pending, 10 a minute per source, one state read every 2 seconds', async () => {
    const home = await served()
    try {
      await home.auth.openApprovalWindow()
      const ask = (source: string): Promise<unknown> => {
        const phone = device()
        return home.auth.requestApproval({ devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce: brandString<Base64Url>('AAAAAAAAAAAAAAAAAAAAAA'), label: 'P', platform: '' }, { listener: 'reach-tailscale-private', source })
      }
      const first = await ask('a') as { requestId: string; requestSecret: string }
      for (let index = 0; index < 4; index += 1) await ask('a')
      await expect(ask('b')).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT' })
      for (let index = 0; index < 5; index += 1) await ask('a').catch(() => undefined)
      await expect(ask('a')).rejects.toMatchObject({ code: 'APPROVAL_RATE_LIMITED' })
      expect(home.auth.approvalState(first.requestId, first.requestSecret)).toBe('pending')
      expect(() => home.auth.approvalState(first.requestId, first.requestSecret)).toThrow(expect.objectContaining({ code: 'APPROVAL_RATE_LIMITED' }))
      // Pins the secret check: a wrong secret reads as an unknown request.
      expect(() => home.auth.approvalState(first.requestId, 'wrong')).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
      expect(() => home.auth.approvalState('unknown', first.requestSecret)).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
      expect(home.auth.pendingApprovals()).toHaveLength(5)
      home.clock.advance(DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs)
      expect(home.auth.pendingApprovals()).toHaveLength(0)
      expect(home.auth.approvalState(first.requestId, first.requestSecret)).toBe('expired')
      home.clock.advance(DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs)
      expect(() => home.auth.approvalState(first.requestId, first.requestSecret)).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    } finally {
      await home.dispose()
    }
  })

  it('an approval with a wrong typed code is refused and the third cancels', async () => {
    const home = await served()
    try {
      await home.auth.openApprovalWindow()
      const phone = device()
      const accepted = await home.auth.requestApproval({ devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce: brandString<Base64Url>('AAAAAAAAAAAAAAAAAAAAAA'), label: 'P', platform: '' }, { listener: 'reach-tailscale-private', source: 's' })
      await expect(home.auth.approveLocally(accepted.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH' })
      await expect(home.auth.approveLocally(accepted.requestId, 'abc')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH' })
      await expect(home.auth.approveLocally(accepted.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH', detail: expect.stringMatching(/cancelled/) })
      await expect(home.auth.approveLocally(accepted.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
      expect((await home.auth.devices()).devices).toEqual([])
    } finally {
      await home.dispose()
    }
  })
})

describe('the match code', () => {
  it('is C5\'s derivation, and the browser module computes the same digits', async () => {
    const inputs = { homePublicKey: new Uint8Array(32).fill(1), deviceId: 'A'.repeat(43), homeNonce: 'B'.repeat(22), deviceNonce: 'C'.repeat(22), address: ADDRESS }
    const code = matchCode(inputs)
    expect(code).toMatch(/^\d{8}$/)
    await expect(matchCodeOf({ ...inputs, homePublicKey: Buffer.from(inputs.homePublicKey).toString('base64url') })).resolves.toBe(code)
    expect(matchCode({ ...inputs, address: 'https://other.example.ts.net' })).not.toBe(code)
    expect(formatMatchCode('12345678')).toBe('1234 5678')
    expect([typedCodeMatches('1234 5678', '12345678'), typedCodeMatches('1234-5678', '12345678'), typedCodeMatches('1234567', '12345678'), typedCodeMatches('12345679', '12345678')]).toEqual([true, true, false, false])
    expect(toBase64Url(fromBase64Url('AQID'))).toBe('AQID')
    const phone = device()
    await expect(browserDeviceIdOf(phone.jwk)).resolves.toBe(phone.id)
    expect(Buffer.from(browserSignInMessage(ADDRESS, 'AQID') as Uint8Array)).toEqual(signInMessage(ADDRESS, 'AQID'))
  })
})

describe('sign-in', () => {
  it('creates a full session with factor tailnet-membership from an approved device\'s signature alone', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const devices = await home.auth.devices()
      expect(devices.devices).toEqual([expect.objectContaining({ id: phone.id, approvedBy: 'local', platform: 'iOS', address: ADDRESS })])
      const session = await signIn(home.auth, phone)
      expect(session.expiresAt).toBe(home.clock.now + SESSION_LIMITS.reach.absoluteMs)
      const admitted = home.auth.admitToken(session.token, 'reach-tailscale-private')
      expect(admitted).toMatchObject({ kind: 'admitted', session: { factor: 'tailnet-membership', deviceId: phone.id } })
      expect((await home.auth.devices()).devices[0]?.lastSignInAt).toBe(home.clock.now)
      // The token is never on file.
      expect(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')).not.toContain(session.token)
    } finally {
      await home.dispose()
    }
  })

  it('an unapproved device on the tailnet route gets no session', async () => {
    const home = await served()
    try {
      await home.auth.openApprovalWindow()
      const phone = device()
      // Pins the device check: without it any key signs in.
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
      await expect(home.auth.signIn({ deviceId: phone.id, challenge: 'x', signature: 'y', listener: 'reach-tailscale-private' })).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-funnel', SOURCE)).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a reused, expired or unsigned challenge', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const challenge = await home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
      const signature = phone.sign(ADDRESS, challenge)
      // Pins the signature check: a challenge signed by another key.
      await expect(home.auth.signIn({ deviceId: phone.id, challenge, signature: device().sign(ADDRESS, challenge), listener: 'reach-tailscale-private' })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' })
      // Pins single use: the failed attempt used the challenge up.
      await expect(home.auth.signIn({ deviceId: phone.id, challenge, signature, listener: 'reach-tailscale-private' })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' })
      const late = await home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
      home.clock.advance(DEVICE_APPROVAL_LIMITS.challengeExpiryMs)
      await expect(home.auth.signIn({ deviceId: phone.id, challenge: late, signature: phone.sign(ADDRESS, late), listener: 'reach-tailscale-private' })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('limits the challenges issued to one trusted device a minute, and lets the honest sign-in through', async () => {
    const home = await served()
    try {
      const phone = device()
      const other = device()
      await approve(home.auth, phone)
      await approve(home.auth, other)
      for (let issued = 0; issued < CHALLENGE_LIMIT_DEFAULTS.perDevicePerMinute; issued += 1) await home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
      // Pins the device limit: without it a tailnet member who knows a device id evicts its unused challenges at will.
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)).rejects.toMatchObject({ code: 'CHALLENGE_RATE_LIMITED' })
      // Another device is not held back by it, and a made-up id is refused as untrusted, not counted.
      await expect(home.auth.challenge(other.id, 'reach-tailscale-private', SOURCE)).resolves.toEqual(expect.any(String))
      await expect(home.auth.challenge(device().id, 'reach-tailscale-private', SOURCE)).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
      home.clock.advance(60_000 + 1)
      const challenge = await home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
      await expect(home.auth.signIn({ deviceId: phone.id, challenge, signature: phone.sign(ADDRESS, challenge), listener: 'reach-tailscale-private' })).resolves.toMatchObject({ token: expect.any(String) })
    } finally {
      await home.dispose()
    }
  })

  it('limits the challenges one source asks for a minute, from the configured value', async () => {
    const home = await homeFixture({ challengeLimits: { perSourcePerMinute: 3, perDevicePerMinute: 100 } })
    try {
      home.auth.serve(SERVED)
      const phone = device()
      await approve(home.auth, phone)
      for (let issued = 0; issued < 3; issued += 1) await home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)
      // Pins the source limit and that it reads the configured value, not the default.
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)).rejects.toMatchObject({ code: 'CHALLENGE_RATE_LIMITED' })
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-private', '192.0.2.9')).resolves.toEqual(expect.any(String))
      home.clock.advance(60_000 + 1)
      await expect(home.auth.challenge(phone.id, 'reach-tailscale-private', SOURCE)).resolves.toEqual(expect.any(String))
    } finally {
      await home.dispose()
    }
  })

  it('keeps at most 5 unused challenges per device', () => {
    let now = 0
    let fill = 0
    const challenges = new Challenges(() => now, size => new Uint8Array(size).fill(fill++))
    const id = brandString<DeviceId>('d')
    const issued = Array.from({ length: 6 }, () => challenges.issue(id))
    expect(challenges.consume(id, issued[0] ?? '')).toBe(false)
    expect(challenges.consume(id, issued[5] ?? '')).toBe(true)
    expect(challenges.consume(id, issued[5] ?? '')).toBe(false)
    now = DEVICE_APPROVAL_LIMITS.challengeExpiryMs
    expect(challenges.consume(id, issued[4] ?? '')).toBe(false)
    expect(challenges.consume(brandString<DeviceId>('other'), 'x')).toBe(false)
    expect(signInVerifies({ kty: 'EC', crv: 'P-256', x: brandString<Base64Url>('bad'), y: brandString<Base64Url>('bad') }, ADDRESS, 'AAAA', 'AAAA')).toBe(false)
  })
})

describe('admitting a session token', () => {
  it('admits on its own listener only, until its idle and absolute limits', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      expect(home.auth.admitToken('unknown', 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      // Pins the listener check: a session of one listener is not admitted on another.
      expect(home.auth.admitToken(session.token, 'reach-tailscale-funnel')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      home.clock.advance(SESSION_LIMITS.reach.idleMs - 1)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      // Pins the idle limit: 12 hours unused.
      home.clock.advance(SESSION_LIMITS.reach.idleMs)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      await home.auth.stop()
      expect(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')).not.toContain(session.sessionId)
      // Pins the absolute limit: used every 11 hours, it still ends 14 days after creation.
      const second = await signIn(home.auth, phone)
      for (let at = 0; at < SESSION_LIMITS.reach.absoluteMs; at += 11 * 60 * 60 * 1000) {
        expect(home.auth.admitToken(second.token, 'reach-tailscale-private').kind).toBe('admitted')
        home.clock.advance(11 * 60 * 60 * 1000)
      }
      expect(home.auth.admitToken(second.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
    } finally {
      await home.dispose()
    }
  })

  it('writes the last use within the persistence delay and at stop', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      home.clock.advance(1000)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      await home.auth.stop()
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, { lastUsedAt: number }> }
      expect(Object.values(file.sessions)[0]?.lastUsedAt).toBe(home.clock.now)
      await home.auth.stop()
    } finally {
      await home.dispose()
    }
  })

  it('a roll decided before a rotation does not write its new token unrotated', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      const hour = 60 * 60 * 1000
      for (const hours of [11, 11, 2]) {
        home.clock.advance(hours * hour)
        if (hours === 11) expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      }
      // The removal is queued first and rotates every session before the roll's write runs.
      const removal = home.auth.revokeDevice(device().id)
      const rolled = home.auth.admitToken(session.token, 'reach-tailscale-private', { roll: true })
      if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
      await removal
      await home.auth.stop()
      // Pins the rotation mark the store carries to the new record, and the roll's place in the change queue.
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, { rotated?: boolean }> }
      expect(Object.values(file.sessions).map(record => record.rotated)).toEqual([true, true])
      expect(home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'ROTATION_REQUIRED' })
    } finally {
      await home.dispose()
    }
  })

  it('a revoked session stays revoked across a roll that was already in flight', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      const hour = 60 * 60 * 1000
      for (const hours of [11, 11, 2]) {
        home.clock.advance(hours * hour)
        if (hours === 11) expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      }
      // The revocation is queued first and removes the session record before the roll's write runs.
      const revoked = home.auth.revokeDevice(phone.id)
      const rolled = home.auth.admitToken(session.token, 'reach-tailscale-private', { roll: true })
      if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
      await revoked
      await home.auth.stop()
      // Pins the old-record check: without it the roll writes the new token back and the device is signed in again.
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(Object.keys(file.sessions)).toEqual([])
      expect(home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      await home.dispose()
    }
  })

  it('a rotation needs a fresh device-key proof', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const other = device()
      await approve(home.auth, other)
      // Pins C4's rotation on a device approval.
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'ROTATION_REQUIRED' })
      home.clock.advance(1000)
      const rotated = await signIn(home.auth, phone, first.token)
      expect(rotated.expiresAt).toBe(first.expiresAt)
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.admitToken(rotated.token, 'reach-tailscale-private').kind).toBe('admitted')
      // Another device's cookie is no session this device rotates: the signature creates a fresh one.
      const fresh = await signIn(home.auth, other, rotated.token)
      expect(fresh.expiresAt).toBe(home.clock.now + SESSION_LIMITS.reach.absoluteMs)
      expect(home.auth.admitToken(rotated.token, 'reach-tailscale-private').kind).toBe('admitted')
    } finally {
      await home.dispose()
    }
  })

  it('signing every device out ends their sessions and passes, keeps the device list, and restores nothing when access is turned on again', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const holder = { deviceId: phone.id, listener: 'reach-tailscale-private' } as const
      home.auth.grants.openPass(holder, 15)
      expect(home.auth.grants.passOf(holder)).toBeDefined()
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private').kind).toBe('admitted')
      // Pins `signAllDevicesOut`: a home that only stopped listening would keep the cookie and the pass for the next turn-on.
      expect(await home.auth.signAllDevicesOut()).toBe(1)
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.grants.passOf(holder)).toBeUndefined()
      expect((await home.auth.devices()).devices.map(listed => listed.id)).toEqual([phone.id])
      expect(JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }).toMatchObject({ sessions: {} })
      // Access is turned on again, which serves the same listener: the old cookie and pass stay refused until a fresh sign-in.
      home.clock.advance(1000)
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.grants.passOf(holder)).toBeUndefined()
      const again = await signIn(home.auth, phone, first.token)
      expect(again.token).not.toBe(first.token)
      expect(home.auth.admitToken(again.token, 'reach-tailscale-private').kind).toBe('admitted')
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.grants.passOf(holder)).toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('removal ends the device\'s sessions at once and calls the removal listeners', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      const removed: string[] = []
      const off = home.auth.onDeviceRemoved((deviceId) => { removed.push(deviceId) })
      await home.auth.revokeDevice(phone.id)
      off()
      expect(removed).toEqual([phone.id])
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses every token while the stores cannot be read', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      await writeFile(join(home.directory, SESSIONS_FILE), 'not json', { mode: 0o600 })
      // A change re-reads the stores; a failed read leaves no copy, so admit refuses rather than reading a stale one.
      await expect(home.auth.revokeDevice(brandString<DeviceId>('nobody'))).rejects.toMatchObject({ code: 'STORE_INVALID' })
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      await home.dispose()
    }
  })
})

describe('the home key', () => {
  it('is generated once at mode 0600 and read back, and an unreadable or foreign key is refused', async () => {
    const home = await homeFixture()
    try {
      const first = await loadHomeKey(home.directory)
      const again = await loadHomeKey(home.directory)
      expect(again).toEqual(first)
      expect(first.publicKey).toHaveLength(32)
      const file = join(home.directory, 'home-key.pem')
      await chmod(file, 0o644)
      await expect(loadHomeKey(home.directory)).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await writeFile(file, 'not a key', { mode: 0o600 })
      await chmod(file, 0o600)
      await expect(loadHomeKey(home.directory)).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await writeFile(file, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      await expect(loadHomeKey(home.directory)).rejects.toMatchObject({ code: 'STORE_INVALID', detail: expect.stringMatching(/Ed25519/) })
    } finally {
      await home.dispose()
    }
  })
})

describe('the coordinator\'s edges', () => {
  it('reads no request as loopback without a loopback port, and closes nothing without a closer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delorun-home-auth-bare-'))
    try {
      const auth = new HomeAuth({ directory })
      await auth.start()
      expect(auth.arrivalOf({ headers: { host: '127.0.0.1:3080' }, socket: { localAddress: '127.0.0.1', localPort: 3080 } })).toEqual({ listener: undefined, host: '127.0.0.1:3080', source: 'unknown' })
      await auth.openApprovalWindow()
      await expect(auth.revokeDevice(brandString<DeviceId>('nobody'))).resolves.toEqual({ removed: false, sessions: 0, connections: 0 })
      expect(() => auth.serve({ ...SERVED, address: brandString<StudioAddress>('not an address') })).toThrow(expect.objectContaining({ code: 'TAILNET_IDENTITY_UNAVAILABLE' }))
      await auth.stop()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('answers no request before the home key is loaded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delorun-home-auth-unstarted-'))
    try {
      const auth = new HomeAuth({ directory })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      auth.serve(SERVED)
      await auth.openApprovalWindow()
      const phone = device()
      await expect(auth.requestApproval({ devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce: brandString<Base64Url>('AAAAAAAAAAAAAAAAAAAAAA'), label: 'P', platform: '' }, { listener: 'reach-tailscale-private', source: 's' }))
        .rejects.toMatchObject({ code: 'STORE_INVALID' })
      // Pins "admit refuses until the stores were read".
      expect(auth.admitToken('anything', 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('admits no session whose device is recorded at another address now', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      const file = join(home.directory, 'devices.json')
      const devices = JSON.parse(await readFile(file, 'utf8')) as { v: number; devices: { address: string }[] }
      for (const entry of devices.devices) entry.address = 'https://other.example.ts.net'
      await writeFile(file, JSON.stringify(devices), { mode: 0o600 })
      await home.auth.revokeDevice(brandString<DeviceId>('nobody'))
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      await home.dispose()
    }
  })

  it('writes the last use from a timer within 5 seconds, and survives a store that cannot be written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      home.clock.advance(1000)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      await vi.advanceTimersByTimeAsync(SESSION_STORE_PERSIST_MS)
      await home.auth.stop()
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, { lastUsedAt: number }> }
      expect(Object.values(file.sessions)[0]?.lastUsedAt).toBe(home.clock.now)
      home.clock.advance(1000)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private').kind).toBe('admitted')
      await writeFile(join(home.directory, SESSIONS_FILE), 'broken', { mode: 0o600 })
      await vi.advanceTimersByTimeAsync(SESSION_STORE_PERSIST_MS)
      // An expired session's removal that cannot be written leaves the refusal in place.
      home.clock.advance(SESSION_LIMITS.reach.absoluteMs)
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
      await home.auth.stop()
      expect(home.auth.admitToken(session.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    } finally {
      vi.useRealTimers()
      await rm(home.directory, { recursive: true, force: true })
    }
  })
})

describe('rolling a session', () => {
  it('a rolled token stops after its grace', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const step = 11 * 60 * 60 * 1000
      for (const by of [step, step, SESSION_LIMITS.reach.rollAfterMs - 2 * step - 1]) {
        home.clock.advance(by)
        expect(home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: true })).not.toHaveProperty('rolled')
      }
      home.clock.advance(1)
      // An upgrade does not roll: its 101 response cannot carry the new cookie.
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: false })).not.toHaveProperty('rolled')
      const rolled = home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: true })
      if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
      // Pins "rolling never extends the absolute limit".
      expect(rolled.rolled.expiresAt).toBe(first.expiresAt)
      await home.auth.stop()
      expect(home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private').kind).toBe('admitted')
      // The old token admits for 30 seconds, and rolls no second time.
      home.clock.advance(SESSION_LIMITS.reach.rollGraceMs - 1)
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: true })).toMatchObject({ kind: 'admitted' })
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: true })).not.toHaveProperty('rolled')
      home.clock.advance(1)
      // Pins the grace: without it the old token admits until the absolute limit.
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.admitToken(first.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      await home.auth.stop()
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(Object.keys(file.sessions)).toHaveLength(1)
    } finally {
      await home.dispose()
    }
  })

  it('rolls and ends a grace in memory when the store cannot be written', async () => {
    const home = await served()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const step = 11 * 60 * 60 * 1000
      for (const by of [step, step, SESSION_LIMITS.reach.rollAfterMs - 2 * step]) {
        home.clock.advance(by)
        expect(home.auth.admitToken(first.token, 'reach-tailscale-private').kind).toBe('admitted')
      }
      const rolled = home.auth.admitToken(first.token, 'reach-tailscale-private', { roll: true })
      if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
      await home.auth.stop()
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      // The old record in its grace and the new token's record are written.
      expect(Object.keys(file.sessions)).toHaveLength(2)
      await writeFile(join(home.directory, SESSIONS_FILE), 'broken', { mode: 0o600 })
      for (const by of [step, step, SESSION_LIMITS.reach.rollAfterMs - 2 * step]) {
        home.clock.advance(by)
        expect(home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private').kind).toBe('admitted')
      }
      const again = home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private', { roll: true })
      if (again.kind !== 'admitted' || again.rolled === undefined) throw new Error('the session did not roll again')
      home.clock.advance(SESSION_LIMITS.reach.rollGraceMs)
      // The grace ends in memory even though neither write reaches the file.
      expect(home.auth.admitToken(rolled.rolled.token, 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(home.auth.admitToken(again.rolled.token, 'reach-tailscale-private').kind).toBe('admitted')
      // Stopping writes the last use, which reports the store it cannot write.
      await expect(home.auth.stop()).rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })
})

// Each test signs devices in with real key operations and store writes, which take longer than the default 5 s on a
// loaded machine; a test that timed out would leave its home's work running into the next.
describe('a session\'s reach connections end when its token stops admitting', { timeout: 30_000 }, () => {
  const HOUR = 60 * 60 * 1000
  const LISTENER = 'reach-tailscale-private'

  // The home reads the fake `Date`, so each timer fires with the home's clock at the timer's own time.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.UTC(2026, 0, 1) }) })
  afterEach(() => { vi.useRealTimers() })

  /** A served home whose clock is the fake `Date`. */
  async function timedHome(): Promise<Home> {
    const home = await homeFixture({ now: () => Date.now() })
    home.auth.serve(SERVED)
    return home
  }

  /** Let time pass for a running home: its timers fire in order, each at its own time. */
  async function pass(by: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(by)
  }

  /** How many times the closer was asked to close one session's connections. */
  function closedFor(home: Home, sessionId: string): number {
    return home.closed.filter(match => match.sessionId === sessionId).length
  }

  it('a rotation closes every session\'s connections at once', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const second = await signIn(home.auth, phone)
      expect(home.closed).toEqual([])
      const other = device()
      await approve(home.auth, other)
      // Pins the close in the rotation: without it a rotated session's open streams outlive the device approval.
      expect(home.closed).toHaveLength(2)
      expect(home.closed).toEqual(expect.arrayContaining([{ sessionId: first.sessionId }, { sessionId: second.sessionId }]))
      const kept = await signIn(home.auth, other)
      await home.auth.revokeDevice(phone.id)
      // A removal closes the removed device's connections by device and rotates every other session, closing its own.
      expect(home.closed.slice(2)).toEqual([{ deviceId: phone.id }, { sessionId: kept.sessionId }])
      // A rotated session has no expiry timer left: its limits pass with no second close.
      await pass(SESSION_LIMITS.reach.idleMs)
      expect(home.closed).toHaveLength(4)
    } finally {
      await home.dispose()
    }
  })

  it('the idle limit closes a session\'s connections with no request arriving, once', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      await pass(SESSION_LIMITS.reach.idleMs - 1)
      expect(closedFor(home, session.sessionId)).toBe(0)
      // Pins the expiry timer: without it a connection outlives its session until some request presents the token.
      await pass(1)
      expect(closedFor(home, session.sessionId)).toBe(1)
      // A later sign-in reads the stores again, which still hold the expired record for admit's refusal.
      const next = await signIn(home.auth, phone)
      await pass(SESSION_LIMITS.reach.idleMs)
      // Pins the deadline check when the stores are read: without it the expired session is armed and closed again.
      expect(closedFor(home, session.sessionId)).toBe(1)
      expect(closedFor(home, next.sessionId)).toBe(1)
      expect(home.auth.admitToken(session.token, LISTENER)).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
    } finally {
      await home.dispose()
    }
  })

  it('the absolute limit closes the connections of a session in use', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      const step = 11 * HOUR
      while (Date.now() + step < session.expiresAt) {
        await pass(step)
        expect(home.auth.admitToken(session.token, LISTENER).kind).toBe('admitted')
      }
      await pass(session.expiresAt - Date.now() - 1)
      expect(closedFor(home, session.sessionId)).toBe(0)
      // Pins the absolute limit in the deadline: without it the connections close only 12 hours after the last request.
      await pass(1)
      expect(closedFor(home, session.sessionId)).toBe(1)
    } finally {
      await home.dispose()
    }
  })

  it('an open stream that carries no request from the client does not extend the idle limit', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      await pass(HOUR)
      // The upgrade that opens a WebSocket is the session's last use; the open socket's frames never reach admit.
      expect(home.auth.admitToken(session.token, LISTENER, { roll: false }).kind).toBe('admitted')
      // The last-use write, and the re-read of the stores a second sign-in makes, move nothing while the stream is open.
      await pass(SESSION_STORE_PERSIST_MS)
      await signIn(home.auth, phone)
      await pass(SESSION_LIMITS.reach.idleMs - SESSION_STORE_PERSIST_MS - 1)
      expect(closedFor(home, session.sessionId)).toBe(0)
      // Pins the idle limit measured from the last admitted request: the stream closes 12 hours after its upgrade.
      await pass(1)
      expect(closedFor(home, session.sessionId)).toBe(1)
    } finally {
      await home.dispose()
    }
  })

  it('a request from the client extends the idle limit of the session\'s open connections', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      await pass(6 * HOUR)
      expect(home.auth.admitToken(session.token, LISTENER).kind).toBe('admitted')
      await pass(SESSION_LIMITS.reach.idleMs - 6 * HOUR)
      // Pins the re-check when the timer fires: without it the timer armed at sign-in closes a session in use.
      expect(closedFor(home, session.sessionId)).toBe(0)
      await pass(6 * HOUR - 1)
      expect(closedFor(home, session.sessionId)).toBe(0)
      await pass(1)
      expect(closedFor(home, session.sessionId)).toBe(1)
    } finally {
      await home.dispose()
    }
  })

  it('a roll closes the old token\'s connections when its grace ends, and arms the new token\'s limits', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const first = await signIn(home.auth, phone)
      const step = 11 * HOUR
      for (const by of [step, step, SESSION_LIMITS.reach.rollAfterMs - 2 * step]) {
        await pass(by)
        expect(home.auth.admitToken(first.token, LISTENER).kind).toBe('admitted')
      }
      const rolled = home.auth.admitToken(first.token, LISTENER, { roll: true })
      if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
      await pass(SESSION_LIMITS.reach.rollGraceMs - 1)
      expect(closedFor(home, first.sessionId)).toBe(0)
      // Pins the old token's timer moved to its grace: without it its connections stay until 12 hours after its last use.
      await pass(1)
      expect(closedFor(home, first.sessionId)).toBe(1)
      expect(closedFor(home, rolled.sessionId)).toBe(0)
      // Pins the new token's timer: no re-read of the stores follows a roll, so nothing else arms it.
      await pass(SESSION_LIMITS.reach.idleMs - SESSION_LIMITS.reach.rollGraceMs)
      expect(closedFor(home, rolled.sessionId)).toBe(1)
    } finally {
      await home.dispose()
    }
  })

  it('a session admit deleted before its timer ran still has its connections closed', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      const session = await signIn(home.auth, phone)
      // The clock passes the idle limit before the timer runs, and a request presents the token first.
      vi.setSystemTime(Date.now() + SESSION_LIMITS.reach.idleMs)
      expect(home.auth.admitToken(session.token, LISTENER)).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
      expect(closedFor(home, session.sessionId)).toBe(0)
      // Pins closing a session the in-memory copy no longer holds: without it these connections stay open for good.
      await vi.runOnlyPendingTimersAsync()
      expect(closedFor(home, session.sessionId)).toBe(1)
    } finally {
      await home.dispose()
    }
  })

  it('stopping the home clears every expiry timer', async () => {
    const home = await timedHome()
    try {
      const phone = device()
      await approve(home.auth, phone)
      await signIn(home.auth, phone)
      expect(vi.getTimerCount()).toBe(1)
      await home.auth.stop()
      // Pins the clear in stop: without it a stopped home keeps a timer per session and still calls the closer.
      expect(vi.getTimerCount()).toBe(0)
      await pass(SESSION_LIMITS.reach.absoluteMs)
      expect(home.closed).toEqual([])
    } finally {
      await home.dispose()
    }
  })
})
