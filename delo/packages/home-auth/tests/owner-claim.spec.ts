/**
 * The owner claim (C5's "Owner claim" and its security requirements): loopback only, one owner per home, a code that is
 * single-use and expiring, the per-source limit, and the records the claim writes.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ListenerId } from '@delo/contract-admission'
import { claimLabelOf, deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf } from './fixtures/home.ts'

const MINUTE = 60 * 1000

describe('claiming a home', () => {
  it('records the owner and the first trusted device', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const result = await home.auth.claim(claimOf(issued.code))
      expect(result.owner.firstDeviceId).toBe(deviceIdOf(keyOf(1)))
      expect(result.device.id).toBe(deviceIdOf(keyOf(1)))
      expect(result.device.approvedBy).toBeNull()
      expect(result.owner.claimedAt).toBe(home.clock.now)
      const owner = JSON.parse(await readFile(join(home.directory, 'owner.json'), 'utf8')) as Record<string, unknown>
      expect(owner).toMatchObject({ v: 1, firstDeviceId: deviceIdOf(keyOf(1)), identities: [] })
      const devices = JSON.parse(await readFile(join(home.directory, 'devices.json'), 'utf8')) as { devices: unknown[] }
      expect(devices.devices).toHaveLength(1)
      expect((await stat(join(home.directory, 'owner.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(home.directory, 'devices.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(home.directory)).mode & 0o777).toBe(0o700)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a claim on a reach listener with a valid code, and claims nothing', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      for (const listener of ['reach-tailscale-private', 'reach-tailscale-funnel', 'reach-self-hosted-relay'] as const) {
        await expect(home.auth.claim(claimOf(issued.code, { listener: listener as ListenerId })))
          .rejects.toMatchObject({ code: 'OWNER_CLAIM_LOOPBACK_ONLY' })
      }
      // Pins "loopback only": without the listener check a reach claim with a valid code takes the owner seat.
      await expect(home.auth.owner()).resolves.toBeUndefined()
      await expect(stat(join(home.directory, 'owner.json'))).rejects.toThrow(/ENOENT/)
      // The code is untouched: a reach request never burns the code the person printed.
      await expect(home.auth.ownerCodeOutstanding()).resolves.toBe(true)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a claim whose Host names a reach address even when nothing stamped the request', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      // Pins the second, independent arrival check: a dispatcher that forgets the stamp cannot turn a reach claim
      // into a loopback one.
      await expect(home.auth.claim(claimOf(issued.code, { host: 'home.example.ts.net' })))
        .rejects.toMatchObject({ code: 'OWNER_CLAIM_LOOPBACK_ONLY' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
      await expect(home.auth.claim(claimOf(issued.code, { host: undefined })))
        .rejects.toMatchObject({ code: 'OWNER_CLAIM_LOOPBACK_ONLY' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a second claimant with a fresh valid code and keeps the first owner', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const first = await home.auth.claim(claimOf(issued.code, { source: '127.0.0.1' }))
      const next = await home.auth.issueOwnerCode()
      // Pins "one home, one owner": without the owner check the second claim writes a second owner and a second
      // device, and the home changes hands.
      await expect(home.auth.claim(claimOf(next.code, { devicePublicKey: keyOf(2), source: '127.0.0.2' })))
        .rejects.toMatchObject({ code: 'ALREADY_OWNED' })
      await expect(home.auth.assertOwner()).resolves.toMatchObject({ firstDeviceId: first.device.id })
      const listing = await home.auth.devices()
      expect(listing.devices.map(device => device.id)).toEqual([first.device.id])
      // The fresh code is not consumed by a claim that could never use it.
      await expect(home.auth.ownerCodeOutstanding()).resolves.toBe(true)
    } finally {
      await home.dispose()
    }
  })

  it('lets exactly one of two racing claims win the owner seat', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claims = await Promise.allSettled([
        home.auth.claim(claimOf(issued.code, { source: '127.0.0.1' })),
        home.auth.claim(claimOf(issued.code, { devicePublicKey: keyOf(3), source: '127.0.0.3' })),
      ])
      // Pins the queue around the owner check and the writes: two claims that both read "no owner" both succeed.
      expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1)
      const listing = await home.auth.devices()
      expect(listing.devices).toHaveLength(1)
      expect((await home.auth.owner())?.firstDeviceId).toBe(listing.devices[0]?.id)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a wrong code and an expired code with OWNER_CODE_INVALID', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      // Pins "a wrong code is refused": without the comparison any code claims the home.
      await expect(home.auth.claim(claimOf('A'.repeat(26)))).rejects.toMatchObject({ code: 'OWNER_CODE_INVALID' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
      home.clock.advance(10 * MINUTE)
      // Pins "a code expires": without the expiry the expired code still claims the home.
      await expect(home.auth.claim(claimOf(issued.code))).rejects.toMatchObject({ code: 'OWNER_CODE_INVALID' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('refuses a claim with no code printed at all', async () => {
    const home = await homeFixture()
    try {
      // Pins "a home with no outstanding code refuses every code": a missing record must not read as a match.
      await expect(home.auth.claim(claimOf('A'.repeat(26)))).rejects.toMatchObject({ code: 'OWNER_CODE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('limits a source to 10 claims a minute, and counts another source separately', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(home.auth.claim(claimOf('A'.repeat(26), { source: '127.0.0.1' }))).rejects.toMatchObject({ code: 'OWNER_CODE_INVALID' })
      }
      // Pins the per-source limit: without it the eleventh attempt is answered with OWNER_CODE_INVALID instead.
      await expect(home.auth.claim(claimOf(issued.code, { source: '127.0.0.1' }))).rejects.toMatchObject({ code: 'OWNER_CLAIM_RATE_LIMITED' })
      // Another source is unaffected, and the window has not passed.
      await expect(home.auth.claim(claimOf(issued.code, { source: '198.51.100.9' }))).resolves.toBeDefined()
      await expect(home.auth.owner()).resolves.toBeDefined()
    } finally {
      await home.dispose()
    }
  })

  it('lets a source claim again once the minute has passed', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(home.auth.claim(claimOf('A'.repeat(26), { source: '127.0.0.1' }))).rejects.toMatchObject({ code: 'OWNER_CODE_INVALID' })
      }
      home.clock.advance(MINUTE)
      // Pins the sliding window: a fixed counter that never forgets refuses this claim for good.
      await expect(home.auth.claim(claimOf(issued.code, { source: '127.0.0.1' }))).resolves.toBeDefined()
    } finally {
      await home.dispose()
    }
  })

  it('refuses a message that is not a claim', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await expect(home.auth.claim(claimOf(issued.code, { label: '' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(home.auth.claim(claimOf(issued.code, { label: 'x'.repeat(65) }))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(home.auth.claim(claimOf(issued.code, {
        devicePublicKey: { kty: 'EC', crv: 'P-256', x: 'short', y: keyOf(1).y } as never,
      }))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(home.auth.claim(claimOf(issued.code, {
        devicePublicKey: { kty: 'OKP', crv: 'Ed25519' } as never,
      }))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('reads a label of 1 to 64 characters, and derives a stable device id', () => {
    expect(claimLabelOf('  This computer  ')).toBe('This computer')
    expect(claimLabelOf('a'.repeat(64))).toHaveLength(64)
    expect(() => claimLabelOf('a'.repeat(65))).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    expect(deviceIdOf(keyOf(1))).toBe(deviceIdOf({ ...keyOf(1) }))
    expect(deviceIdOf(keyOf(1))).not.toBe(deviceIdOf(keyOf(2)))
    expect(deviceIdOf(keyOf(1))).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
