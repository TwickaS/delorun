/**
 * The sessions of a home: which device a token may be minted for, when a token stops answering, and how many sessions
 * one device may hold.
 *
 * Three checks keep a session bound to the device the home trusts: a session is minted only for a home that has an owner,
 * only for a device the home records, and only at the address that device is recorded at (C5's "Binding to an address").
 * A live session is then read together with the same record, so a token whose device was removed answers nothing even
 * when its own record survives, and one device cannot fill the store with sessions.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { DeviceStore } from '../src/devices.ts'
import { MAX_LIVE_SESSIONS_PER_DEVICE, SESSIONS_FILE } from '../src/sessions.ts'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf, recordOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const ELSEWHERE = brandString<StudioAddress>('http://home.example.ts.net')
const HOUR = 60 * 60 * 1000

describe('minting a session', () => {
  it('mints one for a device the home records at the request\'s address', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      await expect(home.auth.sessionOf(opened.token)).resolves.toMatchObject({ deviceId: claimed.device.id, address: ADDRESS })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a session on a home that has no owner', async () => {
    const home = await homeFixture()
    try {
      // Pins the owner check: without it a token is minted for a key nobody decided to trust on a home nobody claimed.
      await expect(home.auth.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'NO_OWNER', status: 403 })
      await expect(readFile(join(home.directory, SESSIONS_FILE), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a session on an owner record that cannot be read', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      await writeFile(join(home.directory, 'owner.json'), '{"v":1,"claimedAt":"yesterday"}', { mode: 0o600 })
      // Pins "a corrupt owner refuses a session": a reader that treated a broken owner record as no owner would mint a
      // token for a home whose owner nobody can name.
      await expect(home.auth.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a session for a device that was just revoked', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      await home.auth.revokeDevice(claimed.device.id)
      // Pins the device-record check: without it a revoked device's key mints a fresh token, and the removal it just
      // ended means nothing.
      await expect(home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED', status: 401 })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a session for a device the home does not record', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      // Pins the same check for a key that was never approved here, which is what a key of another home looks like.
      await expect(home.auth.openSession({ deviceId: deviceIdOf(keyOf(9)), listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a session for a device recorded at another address', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      // Pins "a device is trusted on one address": without the address comparison a key approved on loopback signs in on
      // the reach address it was never approved for.
      await expect(home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ELSEWHERE, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED' })
      await expect(home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .resolves.toMatchObject({ sessionId: expect.any(String) })
    } finally {
      await home.dispose()
    }
  })
})

describe('reading a live session', () => {
  it('answers nothing once the device record is gone, even while the session record is there', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      // The record is removed without the session, as an approval-time removal or a hand-written store leaves it, so the
      // token's own record is still in the file and only the device check can refuse it.
      await new DeviceStore({ file: join(home.directory, 'devices.json') }).remove(claimed.device.id)
      const store = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(Object.keys(store.sessions)).toEqual([opened.sessionId])
      // Pins the device-record half of a live session: without it a removed device's token answers for as long as its
      // session lives.
      await expect(home.auth.sessionOf(opened.token)).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('answers nothing once the device is recorded at another address', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      // A device record whose address moved, as C5's "Changing an address" leaves it: the session was minted at the old
      // address and is not a session at the new one.
      await new DeviceStore({ file: join(home.directory, 'devices.json') })
        .write([recordOf(1, ELSEWHERE, { id: claimed.device.id })])
      // Pins the address half of a live session: a session left usable after its device moved is a session on an address
      // the home no longer trusts the device on.
      await expect(home.auth.sessionOf(opened.token)).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('answers nothing for a token whose session record was deleted', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      // A missing session file is what a reset leaves; the fast path of a removal deletes the record the same way.
      await unlink(join(home.directory, SESSIONS_FILE))
      await expect(home.auth.sessionOf(opened.token)).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })
})

describe('the sessions one device holds', () => {
  it('stops a device at its live-session bound and lets it sign in again once they expired', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      for (let count = 0; count < MAX_LIVE_SESSIONS_PER_DEVICE; count += 1) {
        await home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      }
      // Pins the bound: without it one device fills the session store with tokens that never stop answering.
      await expect(home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED', status: 429 })
      home.clock.advance(HOUR)
      // Pins the pruning before the bound: a count over expired records refuses every later sign-in for good.
      await expect(home.auth.openSession({ deviceId: claimed.device.id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR }))
        .resolves.toMatchObject({ sessionId: expect.any(String) })
      const store = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(Object.keys(store.sessions)).toHaveLength(1)
    } finally {
      await home.dispose()
    }
  })
})
