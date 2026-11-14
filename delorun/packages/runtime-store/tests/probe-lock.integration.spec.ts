/**
 * Review probes (not part of the package): `store.lock` takeover and release guards — a release must remove only
 * the record its own holder wrote, and a dead holder's record must be replaceable by one contender at a time.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireStoreLock } from '../src/lock.ts'
import { fixtureHome, REPOSITORY, version, type FixtureHome } from './support.ts'

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

describe('probe: store.lock guards', () => {
  it('a release removes only the record its own holder wrote, not a successor record', async () => {
    const path = join(fixture.home, 'runtimes', 'store.lock')
    const lock = await acquireStoreLock(path, 300)
    // the record is replaced by another holder's (a takeover or a second holder's creation)
    const successor = JSON.stringify({ v: 1, pid: 999_999, id: 'd'.repeat(32) })
    writeFileSync(path, successor, { mode: 0o600 })
    lock.release()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(successor)
  })

  it('a stale lock whose process is gone is taken over, and the takeover leaves no guard behind', async () => {
    const path = join(fixture.home, 'runtimes', 'store.lock')
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', timeout: 30_000 })
    expect(dead.status, `signal ${String(dead.signal)}: ${dead.stderr}`).toBe(0)
    writeFileSync(path, JSON.stringify({ v: 1, pid: Number(dead.stdout.trim()), id: 'e'.repeat(32) }), { mode: 0o600 })
    const lock = await acquireStoreLock(path, 300)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.takeover-` + 'e'.repeat(32))).toBe(false)
  })

  it('a switch child over a stale lock from a killed switcher commits (the crash specs rely on this)', async () => {
    await fixture.install(version('0.1.0'))
    await fixture.install(version('0.2.0'))
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', 'delorun/packages/runtime-store/tests/fixtures/race-child.ts', 'switch', fixture.home, '0.1.0', '0.2.0'], { cwd: REPOSITORY, encoding: 'utf8', timeout: 45_000 })
    expect(child.stdout.trim()).toContain('switched')
  })
})
