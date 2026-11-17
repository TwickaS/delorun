/**
 * Phone powers' record: what a home with no choice, a choice and a damaged record apply, and the Host's reader taking a
 * command's write at the next check.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhonePowersReader, phonePowersPath, readPhonePowers, recordUpgradePhonePowers, UNCHOSEN_PHONE_POWERS, writePhonePowers } from '../src/phone-powers.ts'

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
