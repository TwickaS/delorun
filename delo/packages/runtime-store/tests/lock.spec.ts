import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPidNamespace, readProcessStart } from '@delo/home'
import { acquireStoreLock, withStoreLock } from '../src/lock.ts'
import { fixtureHome, type FixtureHome } from './support.ts'

let fixture: FixtureHome
let path: string

beforeEach(() => {
  fixture = fixtureHome()
  path = join(fixture.home, 'runtimes', 'store.lock')
})

afterEach(() => {
  fixture.remove()
})

/**
 * A start identity of this platform's form that no live process has: this process's, with its time changed.
 * @returns the identity, or `undefined` where the platform has no reader.
 */
function otherStart(): string | undefined {
  return readProcessStart(process.pid)?.replace(/\d+$/u, digits => String(Number(digits) + 1))
}

describe('store.lock holders', () => {
  it('records this process with its start identity, and releases once', async () => {
    await withStoreLock(path, 300, async () => {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, pid: process.pid, id: expect.stringMatching(/^[0-9a-f]{32}$/u) as string, processStart: readProcessStart(process.pid), pidNamespace: readPidNamespace() })
    })
    expect(existsSync(path)).toBe(false)
  })

  it.skipIf(otherStart() === undefined)('takes over a lock whose process id now names another process, as after a reboot', async () => {
    writeFileSync(path, JSON.stringify({ v: 1, pid: process.pid, id: 'a'.repeat(32), processStart: otherStart() }), { mode: 0o600 })
    const lock = await acquireStoreLock(path, 300)
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toMatchObject({ id: 'a'.repeat(32) })
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  it('waits for a holder whose recorded start identity is the live process\'s, then refuses with STORE_BUSY', async () => {
    writeFileSync(path, JSON.stringify({ v: 1, pid: process.pid, id: 'b'.repeat(32), processStart: readProcessStart(process.pid) }), { mode: 0o600 })
    await expect(acquireStoreLock(path, 300)).rejects.toMatchObject({ code: 'STORE_BUSY' })
  })

  it('refuses a record of another version, and a second release does nothing', async () => {
    const lock = await acquireStoreLock(path, 300)
    lock.release()
    writeFileSync(path, JSON.stringify({ v: 2, pid: process.pid, id: 'd'.repeat(32) }), { mode: 0o600 })
    lock.release()
    await expect(acquireStoreLock(path, 300)).rejects.toThrow(`${path} is not a store lock record; remove it once no delorun process changes the runtime store`)
  })

  it('judges a record without a start identity, as older Delo wrote, by its process id', async () => {
    writeFileSync(path, JSON.stringify({ v: 1, pid: process.pid, id: 'c'.repeat(32) }), { mode: 0o600 })
    await expect(acquireStoreLock(path, 300)).rejects.toMatchObject({ code: 'STORE_BUSY' })
  })
})
