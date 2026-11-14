/**
 * A session record names the reach listener and the identity factor it was created with, which is what the home reads
 * where it grants an action reserved for the home's own computer, and a record that does not name both is refused.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { SESSIONS_FILE, SessionStore } from '../src/sessions.ts'
import { DeviceStore } from '../src/devices.ts'
import { claimOf, homeFixture, recordOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const REACH = brandString<StudioAddress>('https://home.example.ts.net')
const HOUR = 60 * 60 * 1000

describe('a session record', () => {
  it('names its listener and its identity factor', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
      const store = new DeviceStore({ file: join(home.directory, 'devices.json') })
      await store.add(recordOf(2, REACH))
      const opened = await home.auth.openSession({
        deviceId: recordOf(2, REACH).id, listener: 'reach-tailscale-private', address: REACH, factor: 'tailnet-membership', lifetimeMs: HOUR,
      })
      await expect(home.auth.sessionOf(opened.token)).resolves.toMatchObject({
        listener: 'reach-tailscale-private', factor: 'tailnet-membership', rotated: false,
      })
      const file = JSON.parse(await readFile(join(home.directory, SESSIONS_FILE), 'utf8')) as { sessions: Record<string, Record<string, unknown>> }
      expect(Object.values(file.sessions)[0]).toMatchObject({ factor: 'tailnet-membership', listener: 'reach-tailscale-private' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a stored session without its factor, listener or rotation mark', async () => {
    const home = await homeFixture()
    try {
      const store = new SessionStore({ file: join(home.directory, SESSIONS_FILE) })
      const base = { deviceId: 'd', listener: 'reach-tailscale-private', address: REACH, factor: 'tailnet-membership', rotated: false, createdAt: 0, lastRolledAt: 0, lastUsedAt: 0, expiresAt: HOUR }
      const write = (record: Record<string, unknown>): Promise<void> =>
        writeFile(join(home.directory, SESSIONS_FILE), JSON.stringify({ v: 1, sessions: { id: record } }), { mode: 0o600 })
      await write(base)
      await expect(store.all()).resolves.toHaveProperty('id')
      // Pins the factor check: a record that names no factor would leave the home unable to refuse its session.
      await write({ ...base, factor: undefined })
      await expect(store.all()).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await write({ ...base, factor: 'trust-me' })
      await expect(store.all()).rejects.toMatchObject({ code: 'STORE_INVALID' })
      // Pins the listener check: a loopback listener id is no reach session's.
      await write({ ...base, listener: 'loopback' })
      await expect(store.all()).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await write({ ...base, rotated: 'no' })
      await expect(store.all()).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await write({ ...base, graceUntil: 'soon' })
      await expect(store.all()).rejects.toMatchObject({ code: 'STORE_INVALID' })
      await write({ ...base, graceUntil: 5 })
      await expect(store.all()).resolves.toMatchObject({ id: { graceUntil: 5 } })
    } finally {
      await home.dispose()
    }
  })

  it('keeps the absolute expiry and creation time of the session a rotation replaces', async () => {
    const home = await homeFixture()
    try {
      const store = new SessionStore({ file: join(home.directory, SESSIONS_FILE), now: home.clock.read, random: home.random })
      const request = { deviceId: recordOf(2, REACH).id, listener: 'reach-tailscale-private', address: REACH, factor: 'tailnet-membership', lifetimeMs: HOUR } as const
      const first = await store.open(request)
      home.clock.advance(HOUR / 2)
      await expect(store.rotateAll()).resolves.toBe(1)
      await expect(store.authenticate(first.token)).resolves.toMatchObject({ rotated: true })
      const second = await store.open({ ...request, replaces: first.sessionId })
      await expect(store.authenticate(first.token)).resolves.toBeUndefined()
      // Pins "a rotation never extends the absolute limit".
      await expect(store.authenticate(second.token)).resolves.toMatchObject({ rotated: false, expiresAt: Date.UTC(2026, 0, 1) + HOUR, createdAt: Date.UTC(2026, 0, 1) })
      await store.touch(new Map([[second.sessionId, home.clock.now + 5], [first.sessionId, home.clock.now]]))
      await expect(store.authenticate(second.token)).resolves.toMatchObject({ lastUsedAt: home.clock.now + 5 })
      await store.touch(new Map([[second.sessionId, 0]]))
      await expect(store.authenticate(second.token)).resolves.toMatchObject({ lastUsedAt: home.clock.now + 5 })
      await expect(store.remove([second.sessionId])).resolves.toBe(1)
      await expect(store.remove([second.sessionId])).resolves.toBe(0)
      await expect(store.rotateAll()).resolves.toBe(0)
    } finally {
      await home.dispose()
    }
  })
})
