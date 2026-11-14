/**
 * The refusals of home-auth's store readers and helpers: a record a store file holds is accepted only when every field is
 * well-formed, and a file that is exposed, unreadable or not this package's JSON is a typed `STORE_INVALID` failure. The
 * specs cover the owner and device records, the session store's entries, the owner code store, the device list's
 * duplicate refusal, a refusal code that has no HTTP status, and the base32 writer's two lengths.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { chmod, mkdir, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_VERSION, LOCAL_APPROVER } from '@delorun/contract-device-approval'
import { DeviceStore } from '../src/devices.ts'
import { HomeAuthError } from '../src/errors.ts'
import { readStoreFile } from '../src/files.ts'
import { OwnerCodeStore } from '../src/owner-code.ts'
import { claimLabelOf, deviceRecordsOf, ownerRecordOf } from '../src/records.ts'
import { OWNER_CODE_ALPHABET, base32Encode } from '../src/secret.ts'
import { SessionStore } from '../src/sessions.ts'
import { homeFixture, recordOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const HOUR = 60 * 60 * 1000

/** What the mocked protected-file read throws while armed; a spec arms it with the failure it needs. */
const failure = vi.hoisted(() => ({ armed: false, thrown: undefined } as { armed: boolean, thrown: Error | string | undefined }))

vi.mock('@delorun/home', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delorun/home')>()
  return {
    ...actual,
    readProtectedFile: async (path: string) => {
      if (failure.armed) throw failure.thrown
      return actual.readProtectedFile(path)
    },
  }
})

/**
 * Write a store file at mode 0600.
 * @param path - the file.
 * @param value - the value, written as JSON.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
}

describe('the owner record', () => {
  const owner = { v: DEVICE_APPROVAL_VERSION, claimedAt: 5, firstDeviceId: 'device-1', identities: ['subject'] }

  it('reads a record whose first device is a device id or the local approver', () => {
    // Pins both sides of the local-approver brand: a device id stays a device id and `local` stays `local`.
    expect(ownerRecordOf(owner)).toEqual({ v: DEVICE_APPROVAL_VERSION, claimedAt: 5, firstDeviceId: 'device-1', identities: ['subject'] })
    expect(ownerRecordOf({ ...owner, firstDeviceId: LOCAL_APPROVER })).toMatchObject({ firstDeviceId: LOCAL_APPROVER })
    expect(ownerRecordOf(undefined)).toBeUndefined()
  })

  it.each([
    ['no first device', { ...owner, firstDeviceId: undefined }, /names no first device/],
    ['an empty first device', { ...owner, firstDeviceId: '' }, /names no first device/],
    ['identities that are no list', { ...owner, identities: 'subject' }, /no list of pinned identities/],
    ['an identity that is no string', { ...owner, identities: ['subject', 7] }, /no list of pinned identities/],
  ])('refuses a record with %s', (_name, value, message) => {
    // Pins each owner field check: without it a half-written owner.json reads as an owner with no way to be matched.
    expect(() => ownerRecordOf(value)).toThrow(HomeAuthError)
    expect(() => ownerRecordOf(value)).toThrow(message)
  })
})

describe('the device records', () => {
  const entry = { ...recordOf(1, ADDRESS) }
  const list = (overrides: Readonly<Record<string, unknown>>): unknown => ({ v: DEVICE_APPROVAL_VERSION, devices: [{ ...entry, ...overrides }] })

  it('reads the approving device as null, the local approver or a device id', () => {
    // Pins the approver brand: each of the three stored forms reads back as itself.
    expect(deviceRecordsOf(list({ approvedBy: null }))[0]?.approvedBy).toBeNull()
    expect(deviceRecordsOf(list({ approvedBy: LOCAL_APPROVER }))[0]?.approvedBy).toBe(LOCAL_APPROVER)
    expect(deviceRecordsOf(list({ approvedBy: 'device-2' }))[0]?.approvedBy).toBe('device-2')
    expect(deviceRecordsOf(list({ lastSignInAt: 9 }))[0]?.lastSignInAt).toBe(9)
    expect(deviceRecordsOf(undefined)).toEqual([])
  })

  it.each([
    ['a file that is no version 1 list', { v: 2, devices: [] }, /not a version 1 device list/],
    ['a file whose devices are no list', { v: DEVICE_APPROVAL_VERSION, devices: {} }, /not a version 1 device list/],
    ['an entry that is no record', { v: DEVICE_APPROVAL_VERSION, devices: ['device'] }, /not a version 1 device record/],
    ['an entry of another version', list({ v: 2 }), /not a version 1 device record/],
    ['an entry with no id', list({ id: '' }), /no id/],
    ['an entry with no address', list({ address: undefined }), /no address/],
    ['an entry with no label', list({ label: '' }), /no label/],
    ['an entry whose platform is no string', list({ platform: 3 }), /no platform/],
    ['an entry with no approval time', list({ approvedAt: 'yesterday' }), /no approval time/],
    ['an entry whose approver is a number', list({ approvedBy: 4 }), /neither an id nor null/],
    ['an entry whose approver is empty', list({ approvedBy: '' }), /neither an id nor null/],
    ['an entry whose last sign-in is no time', list({ lastSignInAt: 'never' }), /neither a time nor null/],
  ])('refuses %s', (_name, value, message) => {
    // Pins each device field check: a record with a missing field would be trusted with a half-known identity.
    expect(() => deviceRecordsOf(value)).toThrow(HomeAuthError)
    expect(() => deviceRecordsOf(value)).toThrow(message)
  })

  it('refuses a claim label that is no string', () => {
    // Pins the label type check: a claim without a label must not reach the trim.
    expect(() => claimLabelOf(undefined)).toThrow(/carries its label/)
    expect(claimLabelOf('  Laptop ')).toBe('Laptop')
  })
})

describe('the device store', () => {
  it('refuses to add a device whose id is recorded already', async () => {
    const home = await homeFixture()
    try {
      const store = new DeviceStore({ file: join(home.directory, 'devices.json') })
      await store.add(recordOf(1, ADDRESS))
      // Pins the duplicate check: without it a second record for one key doubles the device in every listing.
      await expect(store.add(recordOf(1, ADDRESS))).rejects.toMatchObject({ code: 'DEVICE_NOT_TRUSTED', status: 401 })
      await expect(store.list()).resolves.toHaveLength(1)
    } finally {
      await home.dispose()
    }
  })
})

describe('the session store file', () => {
  const session = {
    deviceId: 'device-1', listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', rotated: false,
    createdAt: 1, lastUsedAt: 2, expiresAt: 3,
  }

  it.each([
    ['a file of another version', { v: 2, sessions: {} }, /not a version 1 session store/],
    ['sessions that are no map', { v: 1, sessions: [] }, /not a version 1 session store/],
    ['an entry that is no record', { v: 1, sessions: { a: 'session' } }, /not a session/],
    ['an entry with no device', { v: 1, sessions: { a: { ...session, deviceId: '' } } }, /no device/],
    ['an entry with no address', { v: 1, sessions: { a: { ...session, address: undefined } } }, /no address/],
    ['an entry with no times', { v: 1, sessions: { a: { ...session, expiresAt: 'later' } } }, /without its times/],
    ['an entry with a missing creation time', { v: 1, sessions: { a: { ...session, createdAt: undefined } } }, /without its times/],
    ['an entry with a missing last use', { v: 1, sessions: { a: { ...session, lastUsedAt: null } } }, /without its times/],
  ])('refuses %s', async (_name, value, message) => {
    const home = await homeFixture()
    try {
      const file = join(home.directory, 'sessions.json')
      await writeJson(file, value)
      // Pins each session field check: a malformed entry must refuse the store rather than admit a half-known session.
      await expect(new SessionStore({ file, now: home.clock.read }).all()).rejects.toMatchObject({ code: 'STORE_INVALID', detail: message })
    } finally {
      await home.dispose()
    }
  })

  it('lists the session ids of one device only', async () => {
    const home = await homeFixture()
    try {
      const store = new SessionStore({ file: join(home.directory, 'sessions.json'), now: home.clock.read, random: home.random })
      const request = { listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR } as const
      const first = await store.open({ ...request, deviceId: brandString<DeviceId>('device-1') })
      const second = await store.open({ ...request, deviceId: brandString<DeviceId>('device-1') })
      await store.open({ ...request, deviceId: brandString<DeviceId>('device-2') })
      // Pins the device filter: another device's session id must not be listed as this device's.
      await expect(store.idsOf(brandString<DeviceId>('device-1'))).resolves.toEqual([first.sessionId, second.sessionId])
      await expect(store.idsOf(brandString<DeviceId>('device-3'))).resolves.toEqual([])
    } finally {
      await home.dispose()
    }
  })
})

describe('the owner code store', () => {
  it('keeps the outstanding code when a presented code cannot be a code', async () => {
    const home = await homeFixture()
    try {
      const store = new OwnerCodeStore({ file: join(home.directory, 'owner-code.json'), now: home.clock.read, random: home.random })
      const issued = await store.issue()
      // Pins the normalisation check: a malformed code is refused without consuming the outstanding one.
      await expect(store.consume('too short')).resolves.toBe(false)
      await expect(store.outstanding()).resolves.toBe(true)
      await expect(store.consume(issued.code)).resolves.toBe(true)
    } finally {
      await home.dispose()
    }
  })

  it.each([
    ['no digest', { v: 1, hash: '', issuedAt: 0, expiresAt: 1 }],
    ['a digest that is no string', { v: 1, hash: 4, issuedAt: 0, expiresAt: 1 }],
    ['no issue time', { v: 1, hash: 'digest', expiresAt: 1 }],
    ['no expiry', { v: 1, hash: 'digest', issuedAt: 0 }],
  ])('refuses a file with %s', async (_name, value) => {
    const home = await homeFixture()
    try {
      const file = join(home.directory, 'owner-code.json')
      await writeJson(file, value)
      // Pins the field check: a record without a digest or expiry must not read as a code that never expires.
      await expect(new OwnerCodeStore({ file, now: home.clock.read }).outstanding()).rejects.toMatchObject({ code: 'STORE_INVALID', detail: 'owner-code.json holds no digest or expiry' })
    } finally {
      await home.dispose()
    }
  })

  it('raises a removal failure other than a missing file', async () => {
    const home = await homeFixture()
    try {
      const file = join(home.directory, 'owner-code.json')
      await mkdir(file)
      // Pins the ENOENT-only tolerance: a failure to remove the code must not read as a cleared home.
      await expect(new OwnerCodeStore({ file }).clear()).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) as string })
      await rmdir(file)
      await expect(new OwnerCodeStore({ file }).clear()).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })
})

describe('reading a store file', () => {
  it('names the system code of a file that others can read', async () => {
    const home = await homeFixture()
    try {
      const file = join(home.directory, 'owner.json')
      await writeFile(file, '{}')
      await chmod(file, 0o644)
      // Pins the protected-file check: a file readable by others must refuse instead of being read as the owner record.
      await expect(readStoreFile(file)).rejects.toMatchObject({
        code: 'STORE_INVALID',
        detail: 'owner.json is not a protected file this home can read (SECRET_FILE_MODE)',
      })
    } finally {
      await home.dispose()
    }
  })

  it.each([
    ['an error without a code', new Error('no code')],
    ['a value that is no error', 'plain text'],
  ])('reports %s as unreadable', async (_name, thrown) => {
    const home = await homeFixture()
    try {
      failure.armed = true
      failure.thrown = thrown
      // Pins the default: a failure with no system code still refuses, and names no path.
      await expect(readStoreFile(join(home.directory, 'owner.json'))).rejects.toMatchObject({
        code: 'STORE_INVALID',
        detail: 'owner.json is not a protected file this home can read (unreadable)',
      })
    } finally {
      failure.armed = false
      failure.thrown = undefined
      await home.dispose()
    }
  })
})

describe('a refusal with no HTTP status', () => {
  it('is answered with 500', () => {
    // Pins the fallback: a code no route maps must not be answered with an undefined status.
    expect(new HomeAuthError('HOME_RUNNING', 'the home is running').status).toBe(500)
    expect(new HomeAuthError('NO_OWNER', 'no owner').status).toBe(403)
  })
})

describe('the base32 writer', () => {
  it('zero-fills the last character of a length that leaves bits over, and adds none to a whole number of characters', () => {
    // Pins the remainder branch: one byte leaves 3 bits that become a character, and 5 bytes leave none.
    expect(base32Encode(Uint8Array.of(0xff))).toBe(`${OWNER_CODE_ALPHABET[31]}${OWNER_CODE_ALPHABET[28]}`)
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB')
  })
})
