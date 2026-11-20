/**
 * Denial specs for how long Face ID grants and holds live: they end with the device's session (idle expiry, the expiry
 * timer, the end of a rolled session's grace), with the device's removal and with a rotation of every session. A hold
 * also ends with the Peer that opened it (`authenticator.spec.ts`); a Peer is one device and page, not one browser tab.
 * Each test's comment names the check whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type DeviceId, type StudioAddress } from '@delorun/contract-admission'
import { claimOf, homeFixture, type Home } from '../fixtures/home.ts'
import { hashArgs } from '../../src/grants.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const CREATE = { request: { id: 't-1', cols: 80, rows: 24 } }

let home: Home
let deviceId: DeviceId = brandString<DeviceId>('')
let token = ''
let holder: { deviceId: string; listener: typeof LISTENER }

beforeEach(async () => {
  home = await homeFixture()
  home.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  const issued = await home.auth.issueOwnerCode()
  const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  deviceId = claimed.device.id
  token = (await home.auth.openSession({ deviceId, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 24 * 60 * 60 * 1000 })).token
  holder = { deviceId, listener: LISTENER }
  home.auth.grants.mint(holder, [
    { action: 'terminal/create', hash: hashArgs(CREATE) ?? '', hold: { feature: 'terminal', id: 't-1' } },
    { action: 'pluginManager/installBundle', hash: hashArgs({ id: 'p' }) ?? '' },
  ], 'passkey')
  home.auth.grants.consume(holder, 'terminal/create', hashArgs(CREATE) ?? '', { feature: 'terminal', id: 't-1', scope: 'session:s-1' })
})
afterEach(async () => { await home.dispose() })

/**
 * Open a terminal hold for a device on its auth home now. A hold idles out in 5 minutes and lasts at most 60, so a
 * spec that shows a session's end ending it opens one just before the end.
 * @param auth - the home.
 * @param who - the device and listener.
 */
function openHold(auth: Home['auth'], who: { readonly deviceId: string; readonly listener: typeof LISTENER }): void {
  auth.grants.mint(who, [{ action: 'terminal/create', hash: 'hold', hold: { feature: 'terminal', id: 't-2' } }], 'passkey')
  auth.grants.consume(who, 'terminal/create', 'hold', { feature: 'terminal', id: 't-2', scope: 'session:s-1' })
}

describe('Face ID grants and holds', () => {
  // Removing the endDevice call in admit leaves a live action grant after the idle session expired (A1 round-3 P3-2). The grant is minted 20 s before the end, inside its 30 s life, so expiry alone cannot end it.
  it('end a live action grant when the device\'s session expires from idleness', () => {
    home.clock.advance(SESSION_LIMITS.reach.idleMs - 20_000)
    const hash = hashArgs({ id: 'live' }) ?? ''
    home.auth.grants.mint(holder, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hash)).toBe(true)
    home.clock.advance(21_000)
    expect(home.auth.admitToken(token, LISTENER).kind).toBe('refused')
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hash)).toBe(false)
  })

  // Removing the endDevice call in admit leaves a hold open after the idle session expired.
  it('end when the device\'s session expires from idleness', () => {
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-1', 'session:s-1')).toBe(true)
    home.clock.advance(SESSION_LIMITS.reach.idleMs - 60_000)
    openHold(home.auth, holder)
    home.clock.advance(61_000)
    expect(home.auth.admitToken(token, LISTENER).kind).toBe('refused')
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-2', 'session:s-1')).toBe(false)
  })

  // Removing the endAll in rotateAll lets a grant survive the rotation of every session.
  it('end when every session is rotated, as any device removal does', async () => {
    await home.auth.revokeDevice(brandString<DeviceId>('someone-else'))
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-1', 'session:s-1')).toBe(false)
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hashArgs({ id: 'p' }) ?? '')).toBe(false)
  })
})

describe('Face ID grants and holds, through home-auth', () => {
  // Removing the endDevice call from revokeDevice fails the spy: rotateAll's endAll would end the same holds and grants, so the outcome alone cannot show it (A1 round-3 P3-1).
  it('end when the device is removed, by endDevice for that device', async () => {
    const ended = vi.spyOn(home.auth.grants, 'endDevice')
    await home.auth.revokeDevice(deviceId)
    expect(ended).toHaveBeenCalledWith(deviceId, 'device-removed')
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-1', 'session:s-1')).toBe(false)
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hashArgs({ id: 'p' }) ?? '')).toBe(false)
  })

  // Removing the endDevice call after the grace of a rolled session leaves a hold when its old token is refused.
  it('end when a rolled session\'s old token passes its grace', async () => {
    // A session that outlives the roll threshold, used every 6 hours so its idle limit never ends it first.
    token = (await home.auth.openSession({ deviceId, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 3 * 24 * 60 * 60 * 1000 })).token
    for (let elapsed = 0; elapsed < SESSION_LIMITS.reach.rollAfterMs; elapsed += 6 * 60 * 60_000) {
      home.clock.advance(6 * 60 * 60_000)
      expect(home.auth.admitToken(token, LISTENER).kind).toBe('admitted')
    }
    expect(home.auth.admitToken(token, LISTENER, { roll: true }).kind).toBe('admitted')
    openHold(home.auth, holder)
    home.clock.advance(SESSION_LIMITS.reach.rollGraceMs)
    expect(home.auth.admitToken(token, LISTENER)).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-2', 'session:s-1')).toBe(false)
  })
})

describe('Face ID grants and holds, at the session\'s expiry timer', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.UTC(2026, 0, 1) }) })
  afterEach(() => { vi.useRealTimers() })

  // Removing the endDevice call in expire() leaves a hold after the timer closed the session's connections.
  it('end when the timer fires with no request since', async () => {
    const timed = await homeFixture({ now: () => Date.now() })
    try {
      timed.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
      const issued = await timed.auth.issueOwnerCode()
      const claimed = await timed.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      await timed.auth.openSession({ deviceId: claimed.device.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 24 * 60 * 60 * 1000 })
      const owner = { deviceId: claimed.device.id, listener: LISTENER } as const
      timed.auth.grants.mint(owner, [{ action: 'terminal/create', hash: 'h', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
      timed.auth.grants.consume(owner, 'terminal/create', 'h', { feature: 'terminal', id: 't-1', scope: 'session:s-1' })
      expect(timed.auth.grants.holdCount(claimed.device.id)).toBe(1)
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.reach.idleMs - 60_000)
      openHold(timed.auth, owner)
      expect(timed.auth.grants.holdAdmits(owner, 'terminal', 't-2', 'session:s-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(61_000)
      expect(timed.closed.length).toBeGreaterThan(0)
      expect(timed.auth.grants.holdAdmits(owner, 'terminal', 't-2', 'session:s-1')).toBe(false)
    } finally {
      await timed.dispose()
    }
  })
})
