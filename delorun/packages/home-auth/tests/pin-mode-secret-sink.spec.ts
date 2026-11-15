/**
 * PIN mode with the home's real log-secret registry, which refuses a value under 8 characters: a 6-digit PIN, the
 * shortest the rules allow, must still be set and checked, and only a secret the redactor can match is registered.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_REGISTERED_SECRET_LENGTH, type SecretSink } from '@delorun/contract-operational-logs'
import { PinModeStore } from '../src/pin-mode.ts'

/** A sink that refuses what the home's registry refuses, and records what it keeps. */
function registry(): SecretSink & { readonly registered: string[] } {
  const registered: string[] = []
  return {
    registered,
    register(value) {
      if (value.length < MIN_REGISTERED_SECRET_LENGTH) throw new RangeError('shorter than the redactor matches')
      registered.push(value)
      return () => undefined
    },
  }
}

let directory = ''
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'delorun-pin-sink-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('a PIN shorter than the redactor matches', () => {
  // Removing the length check in PinModeStore.protect makes the sink throw and the set fail, as `delorun devices pin set` did.
  it('is set and checked without being registered', async () => {
    const secrets = registry()
    const store = new PinModeStore({ directory, now: () => 1_000, secrets })
    await store.load()
    expect(await store.set('482193')).toBe('pin')
    expect(await store.check('device-1', '482193')).toMatchObject({ kind: 'ok' })
    expect(secrets.registered).toEqual([])
  }, 60_000)

  // Registering only secrets of 8 characters or more keeps a long passcode redacted.
  it('registers a passcode the redactor can match', async () => {
    const secrets = registry()
    const store = new PinModeStore({ directory, now: () => 1_000, secrets })
    await store.load()
    expect(await store.set('a long pass phrase')).toBe('passcode')
    expect(secrets.registered).toEqual(['a long pass phrase'])
  }, 60_000)

  // Restoring protect() on the check path registers the guess while the hash runs.
  it('does not register a wrong guess of 8 characters or more while checking it', async () => {
    const secrets = registry()
    const store = new PinModeStore({ directory, now: () => 1_000, secrets })
    await store.load()
    await store.set('a long pass phrase')
    secrets.registered.length = 0
    expect(await store.check('device-1', 'another long phrase')).toMatchObject({ kind: 'wrong' })
    expect(await store.check('device-1', 'a long pass phrase')).toMatchObject({ kind: 'ok' })
    expect(secrets.registered).toEqual([])
  }, 60_000)
})
