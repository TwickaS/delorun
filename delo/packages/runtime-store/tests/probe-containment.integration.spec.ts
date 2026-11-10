/**
 * Review probes (not part of the package): what a switch, a rollback, a restore and a retention change outside
 * `runtimes/` and the installations' identity records under `trust/runtime-files/`, the pointer files' modes, and the
 * shape of a `previous` that is malformed or dangling.
 */
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureHome, snapshotTree, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

/** The store's own entries: `runtimes/` and the identity records. */
const STORE_OWNED = ['runtimes', 'trust/runtime-files']

function outsideRuntimes(): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshotTree(fixture.home)).filter(([path]) => !STORE_OWNED.some(owned => path === owned || path.startsWith(`${owned}/`))))
}

function runtimes(): string {
  return join(fixture.home, 'runtimes')
}

describe('probe: store containment', () => {
  it('install, switch, rollback, restore and retention change nothing outside runtimes/ and the identity records', async () => {
    await fixture.install(V1)
    // canaries beside the store, including files the store never owns
    mkdirSync(join(fixture.home, 'profiles/default'), { recursive: true })
    mkdirSync(join(fixture.home, 'run/default'), { recursive: true })
    writeFileSync(join(fixture.home, 'profiles/default/cordis.patch.yml'), 'plugins: {}\n')
    writeFileSync(join(fixture.home, 'run/default/home.lock'), '{"v":1}\n', { mode: 0o600 })
    writeFileSync(join(fixture.home, '.env'), 'UPSTREAM=1\n', { mode: 0o600 })
    const before = outsideRuntimes()
    await fixture.install(V2)
    expect(outsideRuntimes()).toEqual(before)
    await fixture.store.switchTo(V1, V2)
    expect(outsideRuntimes()).toEqual(before)
    const switched = await fixture.store.pointers()
    await fixture.store.switchTo(V2, V1)
    expect(outsideRuntimes()).toEqual(before)
    await fixture.store.restore(switched)
    expect(outsideRuntimes()).toEqual(before)
    await fixture.store.retain()
    expect(outsideRuntimes()).toEqual(before)
    expect(readdirSync(join(fixture.home, 'trust/runtime-files')).sort()).toEqual(['delorun-0.1.0-linux-x64.json', 'delorun-0.2.0-linux-x64.json'])
    // pointer and lock modes are the contract's 0600, and no pointer is a symbolic link
    expect(lstatSync(join(runtimes(), 'current')).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(runtimes(), 'previous')).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(runtimes(), 'current')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(runtimes(), 'previous')).isSymbolicLink()).toBe(false)
  })
})

describe('probe: pointer refusal shapes', () => {
  it('a previous pointer that is malformed or names a removed version reads as absent', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    writeFileSync(join(runtimes(), 'previous'), 'garbage\n')
    expect(await fixture.store.pointers()).toEqual({ current: V2 })
    writeFileSync(join(runtimes(), 'previous'), '0.9.9\n')
    expect(await fixture.store.pointers()).toEqual({ current: V2 })
  })

  it('restore refuses when a named version is no longer installed, and leaves the pointers switched', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    const before = await fixture.store.pointers()
    await fixture.store.switchTo(V1, V2)
    await expect(fixture.store.restore({ current: V1, previous: version('9.9.9') })).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
    expect(before).toBeDefined()
  })
})
