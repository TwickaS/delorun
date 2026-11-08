/**
 * Revocation (C5's "Removal" and its security requirement that removing a device ends its sessions): the stored
 * credential is a digest, revoking a device invalidates every live session of its tokens, closes the reach connections
 * those sessions admitted, and leaves another device's sessions alone.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { HomeAuth } from '../src/home-auth.ts'
import { SESSIONS_FILE } from '../src/sessions.ts'
import { hashSecret } from '../src/secret.ts'
import { claimOf, homeFixture, keyOf } from './fixtures/home.ts'
import { deviceIdOf } from '../src/records.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const HOUR = 60 * 60 * 1000

/**
 * Claim a home and return the first device's id.
 * @param home - the fixture.
 * @returns the device id.
 */
async function claimed(home: Awaited<ReturnType<typeof homeFixture>>) {
  const issued = await home.auth.issueOwnerCode()
  const result = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  return result.device.id
}

describe('a device credential at rest', () => {
  it('is stored as the digest of its token, never as the token', async () => {
    const home = await homeFixture()
    try {
      const deviceId = await claimed(home)
      const opened = await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      const file = join(home.directory, SESSIONS_FILE)
      const text = await readFile(file, 'utf8')
      // Pins "stored hashed": a store that keyed the session by its token would put the token in this file.
      expect(text).not.toContain(opened.token)
      expect(opened.sessionId).toBe(hashSecret(opened.token))
      const store = JSON.parse(text) as { v: number; sessions: Record<string, { deviceId: string }> }
      expect(store.v).toBe(1)
      expect(Object.keys(store.sessions)).toEqual([opened.sessionId])
      expect(store.sessions[opened.sessionId]?.deviceId).toBe(deviceId)
      // The token is what signs in, and only the digest names it.
      await expect(home.auth.sessionOf(opened.token)).resolves.toMatchObject({ deviceId, address: ADDRESS })
      await expect(home.auth.sessionOf('some other token')).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })

  it('stops being live when its lifetime passed', async () => {
    const home = await homeFixture()
    try {
      const deviceId = await claimed(home)
      const opened = await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      home.clock.advance(HOUR - 1)
      await expect(home.auth.sessionOf(opened.token)).resolves.toBeDefined()
      home.clock.advance(1)
      // Pins the expiry comparison: without it a token never stops being live.
      await expect(home.auth.sessionOf(opened.token)).resolves.toBeUndefined()
    } finally {
      await home.dispose()
    }
  })
})

describe('revoking a device', () => {
  it('invalidates every live session of its tokens before it returns', async () => {
    const home = await homeFixture()
    try {
      const deviceId = await claimed(home)
      const first = await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      const second = await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      const result = await home.auth.revokeDevice(deviceId)
      expect(result).toEqual({ removed: true, sessions: 2, connections: 1 })
      // Pins "revoking a device invalidates its live sessions": without the session revocation both tokens stay live.
      await expect(home.auth.sessionOf(first.token)).resolves.toBeUndefined()
      await expect(home.auth.sessionOf(second.token)).resolves.toBeUndefined()
      const store = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(Object.keys(store.sessions)).toEqual([])
      expect(home.closed).toEqual([{ deviceId }])
    } finally {
      await home.dispose()
    }
  })

  it('leaves another device\'s sessions live', async () => {
    const home = await homeFixture()
    try {
      const firstDevice = await claimed(home)
      const secondDevice = deviceIdOf(keyOf(9))
      const kept = await home.auth.openSession({ deviceId: secondDevice, address: ADDRESS, lifetimeMs: HOUR })
      await home.auth.openSession({ deviceId: firstDevice, address: ADDRESS, lifetimeMs: HOUR })
      // Pins the per-device filter: revoking every session instead of this device's makes the kept session fail.
      await expect(home.auth.revokeDevice(firstDevice)).resolves.toMatchObject({ sessions: 1 })
      await expect(home.auth.sessionOf(kept.token)).resolves.toMatchObject({ deviceId: secondDevice })
    } finally {
      await home.dispose()
    }
  })

  it('closes the reach connections of the device after its sessions are gone, before it answers', async () => {
    const home = await homeFixture()
    try {
      const deviceId = await claimed(home)
      await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      let sessionsAtClose: string | undefined
      const auth = new HomeAuth({
        directory: home.directory,
        now: home.clock.read,
        closeReachConnections: (match) => {
          sessionsAtClose = readFileSync(join(home.directory, SESSIONS_FILE), 'utf8')
          home.closed.push(match)
          return 1
        },
      })
      const result = await auth.revokeDevice(deviceId)
      // Pins the order of a removal: the sessions are already gone when the connections close, so no connection is
      // closed while its session still answers.
      expect(JSON.parse(sessionsAtClose ?? '{}')).toMatchObject({ sessions: {} })
      expect(result).toEqual({ removed: true, sessions: 1, connections: 1 })
      expect(home.closed).toEqual([{ deviceId }])
      // A second revocation is idempotent: no record and no session left, and the closer still hears about the device.
      await expect(auth.revokeDevice(deviceId)).resolves.toEqual({ removed: false, sessions: 0, connections: 1 })
      expect(home.closed).toEqual([{ deviceId }, { deviceId }])
    } finally {
      await home.dispose()
    }
  })
})
