/**
 * The device list (C5's "Keys and storage" and "Removal"): the owner's record and every trusted device, the typed
 * `NO_OWNER` refusal an unclaimed home answers instead of an empty list, the cross-check that keeps `owner.json` and
 * `devices.json` describing one home, and the bound on the records a home keeps.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { DeviceStore, MAX_TRUSTED_DEVICES } from '../src/devices.ts'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf, recordOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')

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

  it('refuses an owner record that names a device the list does not hold', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      // A copy of another home's owner record transplanted over this one: its first device is not in this home's list,
      // so the record describes a home these devices do not belong to.
      await writeFile(join(home.directory, 'owner.json'), JSON.stringify({
        v: 1, claimedAt: claimed.owner.claimedAt, firstDeviceId: deviceIdOf(keyOf(9)), identities: [],
      }), { mode: 0o600 })
      // Pins the cross-check of the two records: without it the listing serves a foreign owner over this home's devices,
      // and an owner-only operation acts for a device nobody approved here.
      await expect(home.auth.devices()).rejects.toMatchObject({ code: 'STORE_INVALID', status: 500 })
      await expect(home.auth.revokeDevice(claimed.device.id)).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await expect(home.auth.openSession({ deviceId: claimed.device.id, address: ADDRESS, lifetimeMs: 60 * 1000 }))
        .rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a claim on a home that records devices but no owner', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      // `devices reset` removes the owner record with every device record; a home that kept its devices would let the
      // next claim become the owner of a device nobody approved here.
      await unlink(join(home.directory, 'owner.json'))
      const next = await home.auth.issueOwnerCode()
      // Pins "a claim starts a home, it does not join one": without the check the claim appends its device to a list it
      // does not own and writes an owner over records the person never reset.
      await expect(home.auth.claim(claimOf(next.code, { devicePublicKey: keyOf(2) })))
        .rejects.toMatchObject({ code: 'STORE_INVALID', status: 500 })
      const file = JSON.parse(await readFile(join(home.directory, 'devices.json'), 'utf8')) as { devices: { id: string }[] }
      expect(file.devices.map(device => device.id)).toEqual([deviceIdOf(keyOf(1))])
      await expect(home.auth.owner()).resolves.toBeUndefined()
      // The code a refused claim carried is not spent: the person prints one and claims again once the home is reset.
      await expect(home.auth.ownerCodeOutstanding()).resolves.toBe(true)
    } finally {
      await home.dispose()
    }
  })
})

describe('the records one home keeps', () => {
  it('refuses a device past the bound of a home\'s device list', async () => {
    const home = await homeFixture()
    try {
      const store = new DeviceStore({ file: join(home.directory, 'devices.json') })
      for (let index = 0; index < MAX_TRUSTED_DEVICES; index += 1) await store.add(recordOf(200 + index, ADDRESS))
      // Pins the bound: without it a run of approvals grows the list and the sessions it carries without limit.
      await expect(store.add(recordOf(1, ADDRESS))).rejects.toMatchObject({ code: 'DEVICE_LIMIT_REACHED', status: 429 })
      await expect(store.list()).resolves.toHaveLength(MAX_TRUSTED_DEVICES)
      // A removal makes room again, so the bound is on the list and never a home nobody can add to.
      await store.remove(recordOf(200, ADDRESS).id)
      await expect(store.add(recordOf(1, ADDRESS))).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })
})
