/**
 * Denial specs for Face ID enrolment and assertion (`src/passkey-auth.ts`) against a software authenticator: enrolment
 * needs the computer's ticket, an assertion counts only for the device and session it was asked for, and every failed
 * check is a wrong try in the PIN's counters. Each test's comment names the check whose removal makes it fail.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, ReachListenerId } from '@delorun/contract-admission'
import { HomeAuthError } from '../../src/errors.ts'
import { GrantStore, hashArgs } from '../../src/grants.ts'
import { PasskeyAuth, type PasskeyAuthOptions } from '../../src/passkey-auth.ts'
import { PasskeyStore } from '../../src/passkeys.ts'
import { VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts'

const ADDRESS = 'https://studio.tail1234.ts.net'
const ORIGIN = 'https://studio.tail1234.ts.net'
const LISTENER: ReachListenerId = 'reach-tailscale-private'
const PHONE = brandString<DeviceId>(Buffer.from('phone-one-device!').toString('base64url'))
const OTHER = brandString<DeviceId>(Buffer.from('phone-two-device!').toString('base64url'))
const asker = (deviceId: DeviceId, sessionId = 'session-1'): { deviceId: DeviceId; listener: ReachListenerId; sessionId: string } => ({ deviceId, listener: LISTENER, sessionId })
const ACTIONS = { kind: 'actions', entries: [{ action: 'pluginManager/installBundle', hash: hashArgs({ id: 'p' }) ?? '' }] } as const

let directory: string
let clock: { at: number }
let misses: string[]
let cleared: string[]
let store: PasskeyStore
let grants: GrantStore
let auth: PasskeyAuth
let flag: boolean

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passkey-auth-'))
  clock = { at: 10_000_000 }
  misses = []
  cleared = []
  flag = true
  let counter = 0
  const random = (size: number): Uint8Array => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1)
  store = new PasskeyStore({ file: join(directory, 'passkeys.json') })
  await store.load()
  grants = new GrantStore({ now: () => clock.at, random })
  const pin: PasskeyAuthOptions['pin'] = {
    missed: (who, reason, code = 'PASSKEY_ASSERTION_INVALID') => { misses.push(`${who.deviceId}:${reason}`); return Promise.reject(new HomeAuthError(code, reason)) },
    cleared: (deviceId) => { cleared.push(deviceId); return Promise.resolve() },
    verify: (_who, secret) => (secret === '1234' ? Promise.resolve() : Promise.reject(new HomeAuthError('PIN_INVALID', 'wrong'))),
  }
  auth = new PasskeyAuth({ store, grants, pin, now: () => clock.at, random, sameSession: (a, b) => a === b, enabled: () => flag, log: () => {} })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Enrol a software passkey for a device through a ticket, as a pairing approval would. */
async function enrol(deviceId: DeviceId = PHONE, options: { be?: boolean } = {}): Promise<VirtualAuthenticator> {
  const authenticator = new VirtualAuthenticator()
  auth.mintTicket(deviceId, LISTENER)
  const creation = await auth.registrationOptions(asker(deviceId), ADDRESS, 'Phone')
  await auth.register(asker(deviceId), ADDRESS, authenticator.create(creation, { origin: ORIGIN, be: options.be ?? false }))
  return authenticator
}

const code = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try { await run() } catch (error) { return error instanceof HomeAuthError ? error.code : String(error) }
  return undefined
}

describe('enrolment', () => {
  // Removing the ticket check lets any signed-in device add a passkey.
  it('is refused without the ticket the computer\'s approval minted', async () => {
    expect(await code(() => auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone'))).toBe('ELEVATION_REQUIRED')
  })

  it('records a passkey bound to the device, with the address host as relying-party id', async () => {
    await enrol()
    expect(store.forDevice(PHONE)).toHaveLength(1)
    expect(store.forDevice(PHONE)[0]?.rpId).toBe('studio.tail1234.ts.net')
    expect(store.forDevice(OTHER)).toHaveLength(0)
  })

  // Removing the removal of the ticket on use lets one approval enrol passkeys for ever.
  it('uses the ticket up', async () => {
    await enrol()
    expect(await code(() => auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone'))).toBe('ELEVATION_REQUIRED')
  })

  // The ticket names the device: another device's session never uses it.
  it('is refused to another device', async () => {
    auth.mintTicket(PHONE, LISTENER)
    expect(await code(() => auth.registrationOptions(asker(OTHER), ADDRESS, 'Phone'))).toBe('ELEVATION_REQUIRED')
  })

  // Removing the flag check leaves enrolment open while the preview is off.
  it('answers PASSKEY_UNAVAILABLE while the flag is off and mints no ticket', async () => {
    flag = false
    auth.mintTicket(PHONE, LISTENER)
    expect(await code(() => auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone'))).toBe('PASSKEY_UNAVAILABLE')
    flag = true
    expect(await code(() => auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone'))).toBe('ELEVATION_REQUIRED')
  })

  // The creation options ask for what the plan fixes.
  it('asks for a resident, user-verified platform credential with no attestation', async () => {
    auth.mintTicket(PHONE, LISTENER)
    const options = await auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone')
    expect(options.rp.id).toBe('studio.tail1234.ts.net')
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' })
    expect(options.attestation).toBe('none')
  })

  // Removing the user-verification requirement lets an unverified credential in.
  it('refuses a credential whose user was not verified, a wrong relying party and a wrong origin, and keeps the ticket', async () => {
    const authenticator = new VirtualAuthenticator()
    auth.mintTicket(PHONE, LISTENER)
    for (const ceremony of [{ origin: ORIGIN, uv: false }, { origin: ORIGIN, rpId: 'tail1234.ts.net' }, { origin: 'https://evil.example' }]) {
      const creation = await auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone')
      const failure = await code(() => auth.register(asker(PHONE), ADDRESS, authenticator.create(creation, ceremony)))
      expect(failure, JSON.stringify(ceremony)).toMatch(/^PASSKEY_/)
    }
    expect(store.any()).toBe(false)
  })

  // Removing the challenge's single use lets a created credential be replayed.
  it('refuses a replayed registration challenge', async () => {
    const authenticator = new VirtualAuthenticator()
    auth.mintTicket(PHONE, LISTENER)
    const creation = await auth.registrationOptions(asker(PHONE), ADDRESS, 'Phone')
    const response = authenticator.create(creation, { origin: ORIGIN })
    await auth.register(asker(PHONE), ADDRESS, response)
    auth.mintTicket(PHONE, LISTENER)
    expect(await code(() => auth.register(asker(PHONE), ADDRESS, response))).toBe('PASSKEY_ASSERTION_INVALID')
  })
})

describe('adding a passkey to a paired device', () => {
  // Removing the code check lets a wrong code mint the ticket; removing the cap lets the code be guessed.
  it('needs the code typed at the computer and ends after three wrong codes', async () => {
    const { requestId, code: shown } = auth.requestAdd(asker(PHONE), ADDRESS)
    expect(shown).toMatch(/^\d{8}$/)
    expect(() => { auth.approveAdd(requestId, '00000000') }).toThrow(HomeAuthError)
    expect(auth.stateOf(PHONE).ticket).toBe(false)
    auth.approveAdd(requestId, `${shown.slice(0, 4)} ${shown.slice(4)}`)
    expect(auth.stateOf(PHONE).ticket).toBe(true)
    const second = auth.requestAdd(asker(OTHER), ADDRESS)
    for (let at = 0; at < 3; at++) expect(() => { auth.approveAdd(second.requestId, '11111111') }).toThrow(HomeAuthError)
    expect(() => { auth.approveAdd(second.requestId, second.code) }).toThrow(HomeAuthError)
  })

  // The code commits to the device and session: a different session derives a different code.
  it('derives a different code for another device', () => {
    expect(auth.requestAdd(asker(PHONE), ADDRESS).code).not.toBe(auth.requestAdd(asker(OTHER), ADDRESS).code)
  })
})

describe('assertion', () => {
  async function options(who = asker(PHONE)): Promise<Awaited<ReturnType<PasskeyAuth['assertionOptions']>>> {
    return auth.assertionOptions(who, ADDRESS, ACTIONS)
  }

  it('mints a one-action grant for the device and the listed action, and clears its wrong tries', async () => {
    const phone = await enrol()
    const minted = await auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN }))
    expect(minted.grantId).not.toBe('')
    expect(grants.has({ deviceId: PHONE, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(true)
    expect(grants.has({ deviceId: OTHER, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(false)
    expect(cleared).toEqual([PHONE])
    expect(misses).toEqual([])
  })

  // allowCredentials holds only this device's ids.
  it('lists only the asking device\'s credentials', async () => {
    const phone = await enrol(PHONE)
    await enrol(OTHER)
    const listed = (await options()).allowCredentials?.map(entry => entry.id)
    expect(listed).toEqual([phone.id])
  })

  // Removing the challenge's single use lets an assertion be replayed for a second grant.
  it('refuses a replayed challenge and counts it as a wrong try', async () => {
    const phone = await enrol()
    const response = phone.get(await options(), { origin: ORIGIN })
    await auth.verify(asker(PHONE), ADDRESS, response)
    expect(await code(() => auth.verify(asker(PHONE), ADDRESS, response))).toBe('PASSKEY_ASSERTION_INVALID')
    expect(misses).toHaveLength(1)
  })

  // Removing the expiry lets an old challenge answer.
  it('refuses an expired challenge', async () => {
    const phone = await enrol()
    const asked = await options()
    clock.at += 60_001
    expect(await code(() => auth.verify(asker(PHONE), ADDRESS, phone.get(asked, { origin: ORIGIN })))).toBe('PASSKEY_ASSERTION_INVALID')
  })

  // Removing the relying-party check lets an assertion for another site count.
  it('refuses a wrong relying-party id and a wrong origin', async () => {
    const phone = await enrol()
    expect(await code(async () => auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN, rpId: 'tail1234.ts.net' })))).toBe('PASSKEY_ASSERTION_INVALID')
    expect(await code(async () => auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: 'https://evil.example' })))).toBe('PASSKEY_ASSERTION_INVALID')
    expect(misses).toHaveLength(2)
  })

  // Removing the user-verification requirement lets a touch without the face count.
  it('refuses an assertion whose user was not verified', async () => {
    const phone = await enrol()
    expect(await code(async () => auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN, uv: false })))).toBe('PASSKEY_USER_VERIFICATION_REQUIRED')
    expect(grants.holdCount(PHONE)).toBe(0)
  })

  // Removing the device binding lets a copy of another device's passkey, signed in on this session, count.
  it('refuses a passkey that belongs to another device', async () => {
    await enrol(PHONE)
    const theirs = await enrol(OTHER)
    expect(await code(async () => auth.verify(asker(PHONE), ADDRESS, theirs.get(await options(), { origin: ORIGIN })))).toBe('PASSKEY_ASSERTION_INVALID')
    expect(grants.has({ deviceId: PHONE, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(false)
  })

  // Removing the session binding lets a challenge asked on one session be answered on another.
  it('refuses a challenge asked on another session or another device', async () => {
    const phone = await enrol()
    const asked = await options(asker(PHONE, 'session-1'))
    expect(await code(() => auth.verify(asker(PHONE, 'session-2'), ADDRESS, phone.get(asked, { origin: ORIGIN })))).toBe('PASSKEY_ASSERTION_INVALID')
    const again = await options(asker(PHONE, 'session-1'))
    expect(await code(() => auth.verify(asker(OTHER, 'session-1'), ADDRESS, phone.get(again, { origin: ORIGIN })))).toBe('PASSKEY_ASSERTION_INVALID')
  })

  // Removing the counter check lets a cloned passkey count.
  it('refuses a sign count that goes backwards', async () => {
    const phone = await enrol()
    await auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN, counter: 5 }))
    expect(await code(async () => auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN, counter: 3 })))).toBe('PASSKEY_COUNTER_REGRESSED')
  })

  // Removing the store removal leaves a removed passkey usable.
  it('refuses a removed passkey', async () => {
    const phone = await enrol()
    const asked = await options()
    expect(await auth.remove(PHONE, phone.id)).toBe(true)
    expect(await code(() => auth.verify(asker(PHONE), ADDRESS, phone.get(asked, { origin: ORIGIN })))).toBe('PASSKEY_ASSERTION_INVALID')
    expect(await code(() => options())).toBe('PASSKEY_UNAVAILABLE')
  })

  // Another device may not remove this device's passkey through the removal rule.
  it('does not let one device remove another device\'s passkey through remove(deviceId)', async () => {
    const phone = await enrol(PHONE)
    expect(await auth.remove(OTHER, phone.id)).toBe(false)
    expect(store.forDevice(PHONE)).toHaveLength(1)
  })

  // Removing the device removal cascade leaves passkeys, grants and challenges of a removed device.
  it('ends with the device: passkeys and grants go together', async () => {
    const phone = await enrol()
    await auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN }))
    await auth.forgetDevice(PHONE)
    expect(store.any()).toBe(false)
    expect(grants.has({ deviceId: PHONE, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(false)
  })

  // A synced passkey is allowed; a change of the backup state is logged, never a refusal.
  it('accepts a synced passkey', async () => {
    const phone = await enrol(PHONE, { be: true })
    expect(store.forDevice(PHONE)[0]?.backupEligible).toBe(true)
    await auth.verify(asker(PHONE), ADDRESS, phone.get(await options(), { origin: ORIGIN, be: true }))
  })

  // Removing the address filter offers a passkey whose relying-party id the page can no longer use.
  it('offers no passkey enrolled on another address', async () => {
    await enrol()
    expect(await code(() => auth.assertionOptions(asker(PHONE), 'https://renamed.tail1234.ts.net', ACTIONS))).toBe('PASSKEY_UNAVAILABLE')
  })

  // The flag gates assertion as well.
  it('answers PASSKEY_UNAVAILABLE while the flag is off', async () => {
    await enrol()
    flag = false
    expect(await code(() => options())).toBe('PASSKEY_UNAVAILABLE')
  })
})

describe('a PIN on a device', () => {
  // Removing the verify call mints a grant for a wrong PIN.
  it('mints the one-action grant of the listed actions, for a device with or without a passkey', async () => {
    await auth.pinGrant(asker(OTHER), '1234', ACTIONS)
    expect(grants.has({ deviceId: OTHER, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(true)
    expect(await code(() => auth.pinGrant(asker(PHONE), '0000', ACTIONS))).toBe('PIN_INVALID')
    expect(grants.has({ deviceId: PHONE, listener: LISTENER }, 'pluginManager/installBundle', ACTIONS.entries[0].hash)).toBe(false)
  })

  // Face ID for "Allow once" is not a persistent allow.
  it('mints an answer grant bound to the request id and the value', async () => {
    await auth.pinGrant(asker(PHONE), '1234', { kind: 'answer', requestId: 'call-1', answer: 'allowed-once' })
    expect(grants.consumeAnswer({ deviceId: PHONE, listener: LISTENER }, 'call-1', 'allowed-always')).toBeUndefined()
    expect(grants.consumeAnswer({ deviceId: PHONE, listener: LISTENER }, 'call-1', 'allowed-once')).toBeDefined()
  })
})
