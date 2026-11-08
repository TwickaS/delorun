/**
 * The device list (C5's "Keys and storage" and "Removal"): the owner's record and every trusted device, and the typed
 * `NO_OWNER` refusal an unclaimed home answers instead of an empty list.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf } from './fixtures/home.ts'

describe('the device list of an unclaimed home', () => {
  it('refuses with NO_OWNER instead of answering an empty list', async () => {
    const home = await homeFixture()
    try {
      // Pins "an unclaimed home refuses owner-only operations": a guard that returned an empty listing would answer
      // 200 with no devices, and a caller could not tell an unclaimed home from a claimed one.
      await expect(home.auth.devices()).rejects.toMatchObject({ code: 'NO_OWNER', status: 403 })
      await expect(home.auth.assertOwner()).rejects.toMatchObject({ code: 'NO_OWNER' })
      await expect(stat(join(home.directory, 'devices.json'))).rejects.toThrow(/ENOENT/)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a revocation with NO_OWNER, closing no connection', async () => {
    const home = await homeFixture()
    try {
      // Pins the guard on the revocation path: without it a revocation runs against a home nobody owns and closes
      // connections on the strength of a list that does not exist.
      await expect(home.auth.revokeDevice(deviceIdOf(keyOf(1)))).rejects.toMatchObject({ code: 'NO_OWNER' })
      expect(home.closed).toEqual([])
    } finally {
      await home.dispose()
    }
  })
})

describe('the device list of a claimed home', () => {
  it('names the owner and the trusted device, without the device public key', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
      const listing = await home.auth.devices()
      expect(listing.owner).toEqual({ claimedAt: claimed.owner.claimedAt, firstDeviceId: claimed.device.id })
      expect(listing.devices).toEqual([{
        id: claimed.device.id,
        label: 'This computer',
        platform: '',
        address: 'http://127.0.0.1:3080',
        approvedAt: claimed.device.approvedAt,
        approvedBy: null,
        lastSignInAt: null,
      }])
      // The listing is the studio's, so it carries no key material.
      expect(JSON.stringify(listing)).not.toContain(keyOf(1).x)
    } finally {
      await home.dispose()
    }
  })

  it('drops a device the list no longer holds', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code))
      await expect(home.auth.revokeDevice(claimed.device.id)).resolves.toMatchObject({ removed: true })
      // Pins "a removed device leaves the list": a store that rewrote the old list would still show it.
      await expect(home.auth.devices()).resolves.toMatchObject({ devices: [] })
      const file = JSON.parse(await readFile(join(home.directory, 'devices.json'), 'utf8')) as { devices: unknown[] }
      expect(file.devices).toEqual([])
    } finally {
      await home.dispose()
    }
  })

  it('refuses a corrupt device file instead of reading it as an empty list', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code))
      await writeFile(join(home.directory, 'devices.json'), JSON.stringify({ v: 1, devices: [{ v: 1, id: 'x' }] }), { mode: 0o600 })
      // Pins "a corrupt store refuses": a reader that skipped a malformed entry would show a home whose devices had
      // silently vanished, and an approval would trust a device nobody recorded.
      await expect(home.auth.devices()).rejects.toMatchObject({ code: 'STORE_INVALID', status: 500 })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a device file that another user can read', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code))
      const file = join(home.directory, 'devices.json')
      // `writeFile`'s mode applies only when it creates the file, so the existing 0600 record needs an explicit chmod.
      await chmod(file, 0o644)
      // Pins C1's protected-file check on the read path.
      await expect(home.auth.devices()).rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })
})
