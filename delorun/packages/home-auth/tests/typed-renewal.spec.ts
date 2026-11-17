/**
 * The person typing in an attached terminal renews the device's sliding unlock, at most once a minute; output, a Peer no
 * reach listener admitted and typing within the interval renew nothing.
 *
 * Each test's comment names the check whose removal makes it fail.
 */
import { describe, expect, it, vi } from 'vitest'
import { typedInputRenewal, TYPED_RENEWAL_INTERVAL_MS } from '../src/typed-renewal.ts'
import { homeFixture } from './fixtures/home.ts'
import { SESSION_LIMITS, type StudioAddress } from '@delorun/contract-admission'
import { brandString } from '@deepseek-ai/dsh-brand'
import { claimOf } from './fixtures/home.ts'

const LISTENER = 'reach-tailscale-private'

describe('typed terminal input', () => {
  it('renews a reach device at most once an interval, and never the owner\'s Peer', () => {
    let now = 1_000_000
    const touch = vi.fn()
    const renew = typedInputRenewal({ reachPeer: id => (id === 'phone' ? { deviceId: 'device-1', listener: LISTENER } : undefined), touchDevice: touch, now: () => now })
    renew({ id: 'owner' })
    expect(touch).not.toHaveBeenCalled()
    renew({ id: 'phone' })
    now += TYPED_RENEWAL_INTERVAL_MS - 1
    renew({ id: 'phone' })
    // Pins the throttle: keystrokes within the interval touch once.
    expect(touch).toHaveBeenCalledTimes(1)
    now += 1
    renew({ id: 'phone' })
    expect(touch).toHaveBeenCalledTimes(2)
    expect(touch).toHaveBeenLastCalledWith('device-1', LISTENER)
  })

  it('keeps a device\'s sliding unlock alive while it types, and leaves a grace or no unlock alone', async () => {
    const home = await homeFixture({ unlockCapMinutes: 480 })
    try {
      const address = brandString<StudioAddress>('https://home.example.ts.net')
      home.auth.serve({ listener: LISTENER, address, factor: 'tailnet-membership', elevationMinutes: 15 })
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address }))
      const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: LISTENER, address, factor: 'tailnet-membership', lifetimeMs: SESSION_LIMITS.reach.absoluteMs })
      // No unlock: typing changes nothing.
      expect(() => { home.auth.touchDeviceUnlock(claimed.device.id, LISTENER) }).not.toThrow()
      const admitted = home.auth.admitToken(opened.token, LISTENER)
      if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
      const asked = home.auth.requestElevation(admitted.sessionId, admitted.session)
      if (asked.kind !== 'pending') throw new Error('no request is waiting')
      const record = home.auth.approveElevation(asked.requestId, asked.code)
      home.clock.advance(14 * 60_000)
      home.auth.touchDeviceUnlock(claimed.device.id, LISTENER)
      // Pins the renewal: typing at minute 14 keeps the unlock past minute 15.
      expect(home.auth.elevationOf(claimed.device.id, LISTENER)?.endsAt).toBe(record.startedAt + 29 * 60_000)
    } finally {
      await home.dispose()
    }
  })
})
