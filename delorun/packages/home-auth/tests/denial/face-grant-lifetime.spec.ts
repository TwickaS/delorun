/**
 * Denial specs for how long Face ID grants and holds live: they end with the device's session (idle expiry, expiry
 * timer) and with a rotation of every session, never outliving the connection they were made on. Each test's comment
 * names the check whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('Face ID grants and holds', () => {
  // Removing the endDevice call in admit leaves a hold open after the idle session expired.
  it('end when the device\'s session expires from idleness', () => {
    expect(home.auth.grants.holdAdmits(holder, 'terminal', 't-1', 'session:s-1')).toBe(true)
    home.clock.advance(SESSION_LIMITS.reach.idleMs + 1)
    expect(home.auth.admitToken(token, LISTENER).kind).toBe('refused')
    expect(home.auth.grants.holdCount(deviceId)).toBe(0)
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hashArgs({ id: 'p' }) ?? '')).toBe(false)
  })

  // Removing the endAll in rotateAll lets a grant survive the rotation of every session.
  it('end when every session is rotated, as any device removal does', async () => {
    await home.auth.revokeDevice(brandString<DeviceId>('someone-else'))
    expect(home.auth.grants.holdCount(deviceId)).toBe(0)
    expect(home.auth.grants.has(holder, 'pluginManager/installBundle', hashArgs({ id: 'p' }) ?? '')).toBe(false)
  })
})
