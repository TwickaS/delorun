/**
 * Elevation in the home: a signed-in device's request, the approval at the computer with the minutes of the listener
 * it arrived on, the binding of an unlock to its device, listener and profile, every way the home ends an elevation (the
 * device's own lock, the computer's revoke, the end of the session that asked, a roll that continues it, the device's
 * removal, the listener stopping and a stop), and the device's connections closing when one ends.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type DeviceId, type StudioAddress } from '@delorun/contract-admission'
import { ELEVATION_LIMITS } from '@delorun/contract-oidc-passkeys'
import type { ElevationChange } from '../src/elevation.ts'
import type { SessionRecord } from '../src/sessions.ts'
import { HomeAuth } from '../src/home-auth.ts'
import { claimOf, homeFixture, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const SERVED = { listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' } as const
const MINUTE = 60_000

let home: Home
let changes: ElevationChange[]
let stopServing: () => void

/** Claim the home with one device and sign it in on the reach listener. */
async function signedIn(lifetimeMs: number = SESSION_LIMITS.reach.absoluteMs): Promise<{ readonly deviceId: DeviceId; readonly token: string; readonly sessionId: string; readonly session: SessionRecord }> {
  const issued = await home.auth.issueOwnerCode()
  const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs })
  const admitted = home.auth.admitToken(opened.token, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  return { deviceId: claimed.device.id, token: opened.token, sessionId: admitted.sessionId, session: admitted.session }
}

/** Ask for an elevation as the device and approve it at the computer. */
function elevate(sessionId: string, session: SessionRecord): string {
  const state = home.auth.requestElevation(sessionId, session)
  if (state.kind !== 'pending') throw new Error('no request is waiting')
  return home.auth.approveElevation(state.requestId, state.code).id
}

const ended = (): string[] => changes.flatMap(change => (change.kind === 'ended' ? [change.reason] : []))

beforeEach(async () => {
  home = await homeFixture()
  changes = []
  home.auth.onElevationChange((change) => { changes.push(change) })
  stopServing = home.auth.serve({ ...SERVED, elevationMinutes: 20 })
})

afterEach(async () => {
  await home.dispose()
})

describe('an elevation in the home', () => {
  it('waits for the code at the computer, then lasts the listener\'s minutes', async () => {
    const device = await signedIn()
    const state = home.auth.requestElevation(device.sessionId, device.session)
    expect(state).toMatchObject({ kind: 'pending', code: expect.stringMatching(/^\d{8}$/) })
    expect(home.auth.elevationState(device.deviceId, LISTENER)).toEqual(state)
    // The computer lists the request by the device's name, and without the code.
    expect(home.auth.elevationsAtComputer().pending).toEqual([expect.objectContaining({ deviceId: device.deviceId })])
    expect(home.auth.elevationsAtComputer().pending[0]).not.toHaveProperty('code')
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toBeUndefined()
    if (state.kind !== 'pending') throw new Error('no request is waiting')
    const record = home.auth.approveElevation(state.requestId, state.code)
    // Pins the listener's minutes: the served listener's 20, not the default 15.
    expect(record.endsAt - record.startedAt).toBe(20 * MINUTE)
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toEqual(record)
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toEqual(record)
    expect(home.auth.elevationsAtComputer().running).toEqual([record])
  })

  it('lasts the default minutes on a listener that names none', async () => {
    stopServing()
    home.auth.serve(SERVED)
    const device = await signedIn()
    const id = elevate(device.sessionId, device.session)
    expect(home.auth.elevationsAtComputer().running).toEqual([expect.objectContaining({ id, endsAt: expect.any(Number) })])
    const [record] = home.auth.elevationsAtComputer().running
    expect((record?.endsAt ?? 0) - (record?.startedAt ?? 0)).toBe(ELEVATION_LIMITS.defaultMinutes * MINUTE)
  })

  it('refuses a listener whose minutes are outside the limits', () => {
    stopServing()
    // Pins the minutes check at serve: a reach row that asks for more than an hour is refused, not capped quietly.
    for (const elevationMinutes of [0, ELEVATION_LIMITS.maxMinutes + 1, 2.5]) {
      expect(() => home.auth.serve({ ...SERVED, elevationMinutes })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    }
  })

  it('refuses an approval whose listener is no longer served', async () => {
    const device = await signedIn()
    const state = home.auth.requestElevation(device.sessionId, device.session)
    if (state.kind !== 'pending') throw new Error('no request is waiting')
    stopServing()
    // Pins the served check: stopping the listener cancelled the request, and nothing elevates a device on it.
    expect(() => home.auth.approveElevation(state.requestId, state.code)).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    expect(() => home.auth.approveElevation('unknown', '00000000')).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
  })

  it('ends when the device locks it, and when the computer revokes it or declines its request', async () => {
    const device = await signedIn()
    elevate(device.sessionId, device.session)
    home.auth.lockElevation(device.deviceId, LISTENER)
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toBeUndefined()
    const id = elevate(device.sessionId, device.session)
    expect(home.auth.revokeElevation(id)).toBe(true)
    const state = home.auth.requestElevation(device.sessionId, device.session)
    if (state.kind !== 'pending') throw new Error('no request is waiting')
    expect(home.auth.revokeElevation(state.requestId)).toBe(true)
    expect(home.auth.revokeElevation('unknown')).toBe(false)
    expect(home.auth.elevationState(device.deviceId, LISTENER)).toEqual({ kind: 'none' })
    expect(ended()).toEqual(['locked-from-device', 'revoked-at-computer'])
  })

  it('follows a session that rolled while the request was in flight: the request carries the new id', async () => {
    const device = await signedIn(72 * 60 * MINUTE)
    // Idle time stays short of the session's limit, so the session is still admitted when it is due to roll.
    for (const hours of [11, 11, 2]) {
      home.clock.advance(hours * 60 * MINUTE)
      if (hours === 11) home.auth.admitToken(device.token, LISTENER)
    }
    const rolled = home.auth.admitToken(device.token, LISTENER, { roll: true })
    if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
    // The page's request still presents the old id when it asks, inside the grace.
    const id = elevate(device.sessionId, device.session)
    // Pins the successor lookup: the elevation would sit on the old id and end when its grace does.
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toMatchObject({ id, sessionId: rolled.sessionId })
    home.clock.advance(SESSION_LIMITS.reach.rollGraceMs + 1)
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toBeDefined()
    expect(rolled.sessionId).not.toBe(device.sessionId)
  })

  it('admits nothing on another listener', async () => {
    const device = await signedIn()
    elevate(device.sessionId, device.session)
    // Pins the listener in the lookup: an unlock approved for the private listener is not the device's on another one.
    expect(home.auth.elevationOf(device.deviceId, 'reach-tailscale-funnel')).toBeUndefined()
    expect(home.auth.elevationState(device.deviceId, 'reach-tailscale-funnel')).toEqual({ kind: 'none' })
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toBeDefined()
  })

  it('admits nothing in another profile\'s home that shares the device list', async () => {
    const device = await signedIn()
    // A second profile's Host reads the same secrets directory, so it knows the same device and its sessions.
    const other = new HomeAuth({ directory: home.directory, now: home.clock.read, random: home.random })
    await other.start()
    try {
      other.serve(SERVED)
      expect(other.admitToken(device.token, LISTENER)).toMatchObject({ kind: 'admitted' })
      elevate(device.sessionId, device.session)
      // Pins the profile: an unlock lives in the memory of the Host that approved it, never in the shared files.
      expect(other.elevationOf(device.deviceId, LISTENER)).toBeUndefined()
      expect(other.elevationsAtComputer()).toEqual({ pending: [], running: [] })
      expect(home.auth.elevationOf(device.deviceId, LISTENER)).toBeDefined()
    } finally {
      await other.stop()
    }
  })

  it('closes the device\'s connections when an unlock ends', async () => {
    const device = await signedIn()
    elevate(device.sessionId, device.session)
    const before = home.closed.length
    home.auth.lockElevation(device.deviceId, LISTENER)
    // Pins the close: the Gateway decides a stream once, so a terminal opened under the unlock would outlive it.
    expect(home.closed.slice(before)).toEqual([{ deviceId: device.deviceId }])
    expect(ended()).toEqual(['locked-from-device'])
  })

  it('follows a roll that continues the session that asked', async () => {
    const device = await signedIn()
    // A session rolls a day after its last roll; it is used within its idle limit on the way.
    const HOUR = 60 * MINUTE
    for (const hours of [11, 11, 2]) {
      home.clock.advance(hours * HOUR)
      if (hours === 11) home.auth.admitToken(device.token, LISTENER)
    }
    elevate(device.sessionId, device.session)
    const rolled = home.auth.admitToken(device.token, LISTENER, { roll: true })
    if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
    // Pins the move on a roll: the old token's grace ending would otherwise end the elevation the new token continues.
    home.clock.advance(SESSION_LIMITS.reach.rollGraceMs)
    expect(home.auth.admitToken(device.token, LISTENER)).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    expect(home.auth.elevationOf(device.deviceId, LISTENER)).toMatchObject({ sessionId: rolled.sessionId })
    expect(ended()).toEqual([])
  })

  it('ends when the session that asked reaches its limit', async () => {
    const device = await signedIn(10 * MINUTE)
    elevate(device.sessionId, device.session)
    home.clock.advance(10 * MINUTE)
    // Pins the session's end: a session that answers nothing takes its elevation with it, before the elevation's own end.
    expect(home.auth.admitToken(device.token, LISTENER)).toEqual({ kind: 'refused', code: 'SESSION_EXPIRED' })
    expect(ended()).toEqual(['session-ended'])
  })

  it('ends when the session\'s expiry timer fires', async () => {
    await home.dispose()
    vi.useFakeTimers()
    try {
      home = await homeFixture({ now: () => Date.now() })
      changes = []
      home.auth.onElevationChange((change) => { changes.push(change) })
      home.auth.serve(SERVED)
      const device = await signedIn(10 * MINUTE)
      elevate(device.sessionId, device.session)
      // Pins the timer's ending: the timer that closes an expired session's connections ends its elevation too.
      await vi.advanceTimersByTimeAsync(10 * MINUTE)
      expect(ended()).toEqual(['session-ended'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends when the device is removed, the listener stops, sessions rotate and the home stops', async () => {
    const device = await signedIn()
    elevate(device.sessionId, device.session)
    stopServing()
    expect(ended()).toEqual(['listener-stopped'])
    stopServing = home.auth.serve(SERVED)
    elevate(device.sessionId, device.session)
    await home.auth.revokeDevice(device.deviceId)
    // Pins the removal: the device's elevation ends with its reason before the rotation that follows.
    expect(ended()).toEqual(['listener-stopped', 'device-removed'])
    await home.auth.stop()
    expect(ended()).toEqual(['listener-stopped', 'device-removed'])
  })

  it('ends at a stop', async () => {
    const device = await signedIn()
    elevate(device.sessionId, device.session)
    await home.auth.stop()
    // Pins the stop: nothing outlives the Host.
    expect(ended()).toEqual(['home-stopped'])
  })
})
