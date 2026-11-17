/**
 * Phone powers' record: what a home with no choice, a choice and a damaged record apply, and the Host's reader taking a
 * command's write at the next check.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhonePowersReader, phonePowersPath, readPhonePowers, recordUpgradePhonePowers, UNCHOSEN_PHONE_POWERS, writePhonePowers } from '../src/phone-powers.ts'
import { gateByUnlock } from '../src/computer-only.ts'
import { reachDevicePrincipal } from '../src/reach-access.ts'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'phone-powers-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('Phone powers', () => {
  it('applies the unchosen level, Careful, while no choice is recorded', async () => {
    expect(UNCHOSEN_PHONE_POWERS).toBe('careful')
    expect(await readPhonePowers(directory)).toEqual({ level: 'careful', chosen: false })
    expect(new PhonePowersReader(directory).current()).toEqual({ level: 'careful', chosen: false })
  })

  it('reads a recorded choice, and the reader takes a later write at its next check', async () => {
    const reader = new PhonePowersReader(directory)
    await writePhonePowers(directory, 'full', () => 1)
    expect(await readPhonePowers(directory)).toEqual({ level: 'full', chosen: true })
    expect(reader.current()).toEqual({ level: 'full', chosen: true })
    await writePhonePowers(directory, 'careful', () => 2)
    expect(reader.current()).toEqual({ level: 'careful', chosen: true })
  })

  it('applies Careful and says why for a record it cannot read, and reads a repaired one', async () => {
    const reader = new PhonePowersReader(directory)
    await writeFile(phonePowersPath(directory), JSON.stringify({ v: 1, level: 'everything', setAt: 1, chosen: true }), { mode: 0o600 })
    expect(reader.current()).toMatchObject({ level: 'careful', chosen: false, problem: expect.stringContaining('phone-powers.json') })
    await expect(readPhonePowers(directory)).rejects.toMatchObject({ code: 'STORE_INVALID' })
    await writePhonePowers(directory, 'full')
    expect(reader.current()).toEqual({ level: 'full', chosen: true })
  })

  it('refuses a record whose mode is laxer than 0600', async () => {
    const reader = new PhonePowersReader(directory)
    await writePhonePowers(directory, 'full')
    await chmod(phonePowersPath(directory), 0o644)
    // Pins the protected-file check: a record the home did not keep private never grants Full.
    expect(reader.current()).toMatchObject({ level: 'careful', chosen: false })
  })

  it('records the upgrade level once, as not chosen, and never over an existing record', async () => {
    // A home with no record gets the configured level, marked as not chosen so the studio tells the person.
    expect(await recordUpgradePhonePowers(directory, 'careful', () => 1)).toEqual({ level: 'careful', chosen: false })
    expect(await readPhonePowers(directory)).toEqual({ level: 'careful', chosen: false })
    // Pins the existence check: a later start, with the setting changed to Full, leaves the recorded level alone.
    expect(await recordUpgradePhonePowers(directory, 'full')).toBeUndefined()
    expect(await readPhonePowers(directory)).toEqual({ level: 'careful', chosen: false })
    await writePhonePowers(directory, 'full')
    expect(await recordUpgradePhonePowers(directory, 'careful')).toBeUndefined()
    expect(await readPhonePowers(directory)).toEqual({ level: 'full', chosen: true })
    // A damaged record is kept, and applies Careful, rather than replaced by the upgrade level.
    await writeFile(phonePowersPath(directory), 'not json', { mode: 0o600 })
    expect(await recordUpgradePhonePowers(directory, 'full')).toBeUndefined()
    expect(new PhonePowersReader(directory).current()).toMatchObject({ level: 'careful', chosen: false })
  })
})

describe('a route at level F', () => {
  /**
   * A home whose device `device-1` holds an unlock on its listener.
   * @param level - the Phone powers level, or undefined for a home that cannot say it.
   * @param grace - whether the unlock is the approval grace.
   * @returns the part of the service the gate reads.
   */
  const home = (level: 'careful' | 'full' | undefined, grace = false) => ({
    pinEnabled: () => false, pageUnlockOf: () => undefined, dangerousMode: () => false,
    elevationOf: () => (grace ? { id: 'unlock-1', grace: true as const } : { id: 'unlock-1' }),
    ...level === undefined ? {} : { phonePowers: () => ({ level, chosen: true }) },
  }) as never
  const peer = { principal: reachDevicePrincipal('device-1', 'reach-tailscale-private') }

  /**
   * @param gated - the home the gate reads.
   * @returns the status and body a device's request gets.
   */
  async function answer(gated: never): Promise<readonly [number, string]> {
    const route = gateByUnlock(() => gated, () => Promise.resolve(new Response('ran')), { renews: true, phonePowers: 'full' })
    const request = new Request('http://localhost/x', { method: 'POST' })
    expect(route.admitPeer(request, peer)).toBe(true)
    const reply = await route.fetch(request)
    return [reply.status, await reply.text()]
  }

  it('runs for an unlocked phone only under Full, and never on the approval grace', async () => {
    expect(await answer(home('full'))).toEqual([200, 'ran'])
    // Pins the level: under Careful, or in a home that cannot say its level, the unlock does not open the route.
    for (const gated of [home('careful'), home(undefined)]) {
      const [status, body] = await answer(gated)
      expect([status, JSON.parse(body)]).toEqual([403, expect.objectContaining({ error: 'LOOPBACK_REQUIRED' })])
    }
    // Pins the fresh unlock: under Full the grace does not open it.
    const [status, body] = await answer(home('full', true))
    expect([status, JSON.parse(body)]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
  })
})
