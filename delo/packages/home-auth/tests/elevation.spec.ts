/**
 * Elevation over a fake clock and random source: requests, the code typed at the computer, the minutes, and every way
 * an elevation ends.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, ReachListenerId } from '@delo/contract-admission'
import { ELEVATION_LIMITS } from '@delo/contract-oidc-passkeys'
import { Elevations, isElevationMinutes, type ElevationChange, type ElevationAsker } from '../src/elevation.ts'

const LISTENER: ReachListenerId = 'reach-tailscale-private'
const OTHER_LISTENER: ReachListenerId = 'reach-tailscale-funnel'
const MINUTE = 60_000

let clock = 0
let counter = 0
let changes: ElevationChange[] = []

/** A random source whose bytes count up, so ids differ and codes are known. */
function random(size: number): Uint8Array {
  counter += 1
  return new Uint8Array(size).fill(counter)
}

function asker(device: string, overrides: Partial<ElevationAsker> = {}): ElevationAsker {
  return { deviceId: brandString<DeviceId>(device), listener: LISTENER, sessionId: `session-${device}`, label: `Phone ${device}`, ...overrides }
}

function elevations(): Elevations {
  return new Elevations({ now: () => clock, random, changed: (change) => { changes.push(change) } })
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
  counter = 0
  changes = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isElevationMinutes', () => {
  it('accepts whole minutes from 1 to the cap', () => {
    // Pins the cap: a reach row may not hand out more than an hour.
    expect([1, 15, ELEVATION_LIMITS.maxMinutes].map(isElevationMinutes)).toEqual([true, true, true])
    expect([0, -1, 1.5, ELEVATION_LIMITS.maxMinutes + 1, Number.NaN].map(isElevationMinutes)).toEqual([false, false, false, false, false])
  })
})

describe('Elevations', () => {
  it('starts an elevation only with the code the device shows, and ends it after its minutes', () => {
    const home = elevations()
    const request = home.request(asker('a'))
    expect(request.code).toMatch(/^\d{8}$/)
    expect(home.stateOf('a', LISTENER)).toEqual({ kind: 'pending', requestId: request.requestId, code: request.code, expiresAt: clock + ELEVATION_LIMITS.requestLifetimeMs })
    // The computer's list never carries the code, which the person reads from the device.
    expect(home.pending()).toEqual([expect.not.objectContaining({ code: expect.anything() })])
    const record = home.approve(request.requestId, `${request.code.slice(0, 4)} ${request.code.slice(4)}`, 15)
    expect(record).toMatchObject({ deviceId: 'a', listener: LISTENER, sessionId: 'session-a', endsAt: clock + 15 * MINUTE })
    expect(home.stateOf('a', LISTENER)).toEqual({ kind: 'elevated', elevationId: record.id, endsAt: record.endsAt })
    expect(home.pending()).toEqual([])
    expect(changes).toEqual([{ kind: 'started', elevation: record }])
    // Pins the expiry timer: the elevation ends on its own when its minutes run out.
    vi.advanceTimersByTime(15 * MINUTE)
    expect(changes.at(-1)).toEqual({ kind: 'ended', elevation: record, reason: 'expired' })
    expect(home.of('a', LISTENER)).toBeUndefined()
  })

  it('ends an elevation past its end when asked, before its timer fires', () => {
    const home = elevations()
    const request = home.request(asker('a'))
    const record = home.approve(request.requestId, request.code, 1)
    clock += MINUTE
    // Pins the read-time expiry check: the policy never admits an action after the end, whatever the timer does.
    expect(home.of('a', LISTENER)).toBeUndefined()
    expect(changes.at(-1)).toEqual({ kind: 'ended', elevation: record, reason: 'expired' })
    expect(home.list()).toEqual([])
  })

  it('binds an elevation to its device and listener', () => {
    const home = elevations()
    const request = home.request(asker('a'))
    home.approve(request.requestId, request.code, 15)
    // Pins the device and listener match: device B and another listener hold nothing.
    expect(home.of('b', LISTENER)).toBeUndefined()
    expect(home.of('a', OTHER_LISTENER)).toBeUndefined()
    expect(home.stateOf('b', LISTENER)).toEqual({ kind: 'none' })
    expect(home.list().map(record => record.deviceId)).toEqual(['a'])
    // Pins the device match when ending: locking device B leaves device A's elevation running.
    expect(home.endFor('b', LISTENER, 'locked-from-device')).toBe(0)
    expect(home.of('a', LISTENER)).toBeDefined()
  })

  it('cancels a request after the third wrong code', () => {
    const home = elevations()
    const request = home.request(asker('a'))
    const wrong = request.code === '00000000' ? '11111111' : '00000000'
    expect(() => home.approve(request.requestId, wrong, 15)).toThrow(/Type it again/)
    expect(() => home.approve(request.requestId, '123', 15)).toThrow(/Type it again/)
    // Pins the wrong-code limit: the third wrong code cancels the request, so guessing ends.
    expect(() => home.approve(request.requestId, wrong, 15)).toThrow(/cancelled/)
    expect(() => home.approve(request.requestId, request.code, 15)).toThrow(/expired or was answered/)
    expect(changes).toEqual([])
  })

  it('refuses minutes outside the limits, and a request that expired or was declined', () => {
    const home = elevations()
    const request = home.request(asker('a'))
    // Pins the cap at approval: no listener's minutes extend an elevation beyond an hour.
    expect(() => home.approve(request.requestId, request.code, ELEVATION_LIMITS.maxMinutes + 1)).toThrow(/whole number of minutes/)
    expect(home.decline(request.requestId)).toBe(true)
    expect(home.decline(request.requestId)).toBe(false)
    const late = home.request(asker('a'))
    clock += ELEVATION_LIMITS.requestLifetimeMs
    // Pins the request lifetime: an old code on the device's screen approves nothing.
    expect(() => home.approve(late.requestId, late.code, 15)).toThrow(/expired or was answered/)
    expect(home.requestOf('a', LISTENER)).toBeUndefined()
  })

  it('holds at most the limit of waiting requests, one per device and listener', () => {
    const home = elevations()
    const first = home.request(asker('a'))
    // A second request from the same device replaces its first.
    const second = home.request(asker('a'))
    expect(home.pending().map(request => request.requestId)).toEqual([second.requestId])
    expect(first.requestId).not.toBe(second.requestId)
    for (let index = 1; index < ELEVATION_LIMITS.pendingPerHome; index += 1) {
      clock += 1
      home.request(asker(`d${String(index)}`))
    }
    // The computer lists the oldest first.
    expect(home.pending().map(request => request.deviceId)).toEqual(['a', 'd1', 'd2', 'd3', 'd4'])
    // Pins the home-wide limit: requests cannot flood the computer's list.
    expect(() => home.request(asker('flood'))).toThrow(/requests to unlock already/)
  })

  it('replaces an elevation with a new one approved for the same device and listener, and never extends one', () => {
    const home = elevations()
    const first = home.request(asker('a'))
    const old = home.approve(first.requestId, first.code, 15)
    clock += 10 * MINUTE
    const next = home.request(asker('a'))
    // A running elevation is still the device's state while a new request waits.
    expect(home.stateOf('a', LISTENER)).toMatchObject({ kind: 'elevated', elevationId: old.id })
    const renewed = home.approve(next.requestId, next.code, 15)
    expect(changes).toEqual([{ kind: 'started', elevation: old }, { kind: 'ended', elevation: old, reason: 'replaced' }, { kind: 'started', elevation: renewed }])
    expect(renewed.endsAt).toBe(clock + 15 * MINUTE)
    expect(home.list()).toEqual([renewed])
  })

  it('ends elevations by device and listener, id, device, session, listener and all, with the reason', () => {
    const home = elevations()
    const start = (who: ElevationAsker) => {
      const request = home.request(who)
      return home.approve(request.requestId, request.code, 15)
    }
    const a = start(asker('a'))
    expect(home.endFor('a', LISTENER, 'locked-from-device')).toBe(1)
    expect(home.endFor('a', LISTENER, 'locked-from-device')).toBe(0)
    const b = start(asker('b'))
    expect(home.endById(b.id, 'revoked-at-computer')).toBe(true)
    expect(home.endById(b.id, 'revoked-at-computer')).toBe(false)
    const c = start(asker('c'))
    home.request(asker('c', { listener: OTHER_LISTENER }))
    home.endDevice('c', 'device-removed')
    expect(home.requestOf('c', OTHER_LISTENER)).toBeUndefined()
    const d = start(asker('d'))
    home.request(asker('d2', { sessionId: 'session-d' }))
    home.endSession('session-d', 'session-ended')
    expect(home.pending()).toEqual([])
    const e = start(asker('e', { listener: OTHER_LISTENER }))
    home.request(asker('e2', { listener: OTHER_LISTENER }))
    home.endListener(OTHER_LISTENER, 'listener-stopped')
    expect(home.pending()).toEqual([])
    const f = start(asker('f'))
    home.request(asker('g'))
    home.endAll('home-stopped')
    expect(home.pending()).toEqual([])
    // Pins each ending and its reason, which the home's log names.
    expect(changes.filter(change => change.kind === 'ended').map(change => [change.elevation.id, change.kind === 'ended' ? change.reason : ''])).toEqual([
      [a.id, 'locked-from-device'],
      [b.id, 'revoked-at-computer'],
      [c.id, 'device-removed'],
      [d.id, 'session-ended'],
      [e.id, 'listener-stopped'],
      [f.id, 'home-stopped'],
    ])
    expect(home.list()).toEqual([])
    // An ended elevation's timer no longer fires.
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes.filter(change => change.kind === 'ended')).toHaveLength(6)
  })

  it('draws every code uniformly, retrying a value above the largest multiple', () => {
    let calls = 0
    const home = new Elevations({
      now: () => clock,
      // The first 4 bytes are 0xffffffff, above 4_200_000_000; the next are 0x00000001.
      random: (size) => {
        calls += 1
        if (size === 4) return calls === 2 ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array([0, 0, 0, 1])
        return new Uint8Array(size).fill(calls)
      },
      changed: () => {},
    })
    // Pins the rejection step: without it a code would come from the biased top of the range.
    expect(home.request(asker('a')).code).toBe('00000001')
  })
})
