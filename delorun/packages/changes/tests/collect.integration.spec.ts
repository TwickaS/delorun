import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import { COLLECT_GRACE_MS, COLLECT_TIME_LIMIT_MS, collectStore, type CollectRequest } from '../src/collect.ts'
import { changesDirectory, objectsDirectory, profileChangesDirectory, versionsDirectory } from '../src/paths.ts'
import { attestTerminal, noteFailed, noteLoaded, openWorkSession, writeActiveRecord, writeApproved, writeChangeLog, writeHarnessLog, writeHarnessRecord } from '../src/records.ts'
import { storeFolder, withStoreLock } from '../src/store.ts'
import { ACTIVE_RECORD_SCHEMA, APPROVED_RECORD_SCHEMA, CHANGE_LOG_SCHEMA, HARNESS_RECORD_SCHEMA, type ChangeEntry, type ChangeId, type ChangeState, type ContentVersion } from '../src/types.ts'
import { lockOut, temporaryDirectory, writeFiles } from './support.ts'

// The cases write real files; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/** A time well past the grace period, in seconds since the epoch, for `utimesSync`. */
const OLD = (Date.now() - 2 * COLLECT_GRACE_MS) / 1000

/**
 * The SHA-256 of a text.
 * @param text - the text.
 * @returns its digest.
 */
function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A home and the directory its profiles' directories are in. */
interface Setup {
  readonly home: string
  readonly profiles: string
  readonly request: CollectRequest
}

/**
 * @returns a new home whose profile directories are under another temporary directory.
 */
function setUp(): Setup {
  const home = temporaryDirectory('delorun-changes-home-')
  const profiles = temporaryDirectory('delorun-changes-profiles-')
  return { home, profiles, request: { home, profileDirectory: profile => join(profiles, profile) } }
}

/**
 * Store a folder holding `own.js` with a name and `shared.js`, which every such version shares.
 * @param home - the Delorun home.
 * @param name - the text of `own.js`.
 * @param link - whether the folder also holds a symbolic link.
 * @returns the stored version.
 */
async function stored(home: string, name: string, link = false): Promise<ContentVersion> {
  const folder = temporaryDirectory('delorun-changes-folder-')
  writeFiles(folder, { 'own.js': name, 'shared.js': 'shared' })
  if (link) symlinkSync('own.js', join(folder, 'main'))
  return (await storeFolder(home, folder)).version
}

/**
 * Set every store file's times past the grace period.
 * @param home - the Delorun home.
 */
function age(home: string): void {
  for (const directory of [versionsDirectory(home), objectsDirectory(home)]) {
    for (const name of readdirSync(directory)) utimesSync(join(directory, name), OLD, OLD)
  }
}

/**
 * @param home - the Delorun home.
 * @returns the names in the version and object directories, sorted.
 */
function remaining(home: string): { versions: string[], objects: string[] } {
  return { versions: readdirSync(versionsDirectory(home)).sort(), objects: readdirSync(objectsDirectory(home)).sort() }
}

/**
 * @param versions - version ids.
 * @returns their version file names, sorted.
 */
function versionFiles(...versions: ContentVersion[]): string[] {
  return versions.map(version => `${version}.json`).sort()
}

/**
 * @param names - texts of `own.js`.
 * @returns the object names of those files and of `shared.js`, sorted.
 */
function objectFiles(...names: string[]): string[] {
  return [...names, 'shared'].map(sha).sort()
}

/**
 * A change-log entry.
 * @param index - makes the id distinct.
 * @param state - the entry's state.
 * @param versions - its `from` and `to`.
 * @returns the entry.
 */
function entry(index: number, state: ChangeState, versions: Pick<ChangeEntry, 'from' | 'to'>): ChangeEntry {
  const id = brandString<ChangeId>(`c${index.toString(16).padStart(10, '0')}`)
  return { id, kind: 'plugin-edit', state, subject: { plugin: 'p', source: '/src/p' }, summary: 'Edits p', createdAt: '2026-11-10T10:00:00.000Z', ...versions }
}

/**
 * Give a profile a directory whose `package.json` approves one version.
 * @param setup - the home and the profiles' directory.
 * @param profile - the profile's name.
 * @param version - the approved version.
 */
async function approve(setup: Setup, profile: string, version: ContentVersion): Promise<void> {
  const profileDir = setup.request.profileDirectory(profile)
  writeFiles(profileDir, { 'package.json': '{"name":"profile"}\n' })
  await writeApproved(profileDir, { schema: APPROVED_RECORD_SCHEMA, plugins: { p: { source: '/src/p', version, approvedAt: '2026-11-10T10:00:00.000Z' } } })
}

describe('collectStore', () => {
  it('collection keeps every referenced version and removes the rest', async () => {
    const setup = setUp()
    const { home } = setup
    const approved = await stored(home, 'approved', true)
    const pending = await stored(home, 'pending')
    const appliedFrom = await stored(home, 'applied-from')
    const appliedTo = await stored(home, 'applied-to')
    const leftOut = await stored(home, 'left-out')
    const active = await stored(home, 'active')
    const sessionFrom = await stored(home, 'session-from')
    const sessionLoaded = await stored(home, 'session-loaded')
    const sessionFailed = await stored(home, 'session-failed')
    const discarded = await stored(home, 'discarded')
    const undone = await stored(home, 'undone')
    await stored(home, 'unreferenced')
    await approve(setup, 'default', approved)
    await writeChangeLog(home, 'default', {
      schema: CHANGE_LOG_SCHEMA,
      entries: [
        entry(1, 'pending', { to: pending }),
        entry(2, 'applied', { from: appliedFrom, to: appliedTo }),
        entry(3, 'left-out-at-start', { from: leftOut }),
        entry(4, 'discarded', { to: discarded }),
        entry(5, 'undone', { from: undone }),
      ],
    })
    await writeActiveRecord(home, 'default', { schema: ACTIVE_RECORD_SCHEMA, plugins: { p: { version: active, kind: 'approved' } } })
    await openWorkSession(home, 'second', { plugin: 'p', source: '/src/p', from: sessionFrom, minutes: 60 }, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
    await noteLoaded(home, 'second', sessionLoaded)
    await noteFailed(home, 'second', sessionFailed)
    age(home)

    expect(await collectStore(setup.request)).toEqual({ complete: true, removedVersions: 3, removedObjects: 3 })
    expect(remaining(home)).toEqual({
      versions: versionFiles(approved, pending, appliedFrom, appliedTo, leftOut, active, sessionFrom, sessionLoaded, sessionFailed),
      objects: objectFiles('approved', 'pending', 'applied-from', 'applied-to', 'left-out', 'active', 'session-from', 'session-loaded', 'session-failed'),
    })
  })

  it('keeps the versions the harness records of every runtime and the harness log name', async () => {
    const setup = setUp()
    const approved = await stored(setup.home, 'approved')
    const signed = await stored(setup.home, 'signed')
    const logged = await stored(setup.home, 'logged')
    const discarded = await stored(setup.home, 'discarded')
    await writeHarnessRecord(setup.home, { schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.3', files: { 'app/x.js': { version: approved, signed, change: entry(1, 'applied', {}).id, approvedAt: '2026-11-10T10:00:00.000Z' } } })
    await writeHarnessLog(setup.home, { schema: CHANGE_LOG_SCHEMA, entries: [entry(2, 'pending', { to: logged }), entry(3, 'discarded', { to: discarded })] })
    age(setup.home)
    await collectStore(setup.request)
    expect(remaining(setup.home).versions).toEqual(versionFiles(approved, signed, logged))
  })

  it('keeps an unreferenced version modified within the grace period, with its objects', async () => {
    const setup = setUp()
    const old = await stored(setup.home, 'old')
    age(setup.home)
    const fresh = await stored(setup.home, 'fresh')
    expect(await collectStore(setup.request)).toEqual({ complete: true, removedVersions: 1, removedObjects: 1 })
    expect(remaining(setup.home)).toEqual({ versions: versionFiles(fresh), objects: objectFiles('fresh') })
    expect(existsSync(join(versionsDirectory(setup.home), `${old}.json`))).toBe(false)
  })

  it.each([
    ['a change log that is not JSON', (setup: Setup) => { writeFiles(profileChangesDirectory(setup.home, 'default'), { 'log.json': '{' }) }],
    ['a profile directory without package.json', (setup: Setup) => {
      mkdirSync(profileChangesDirectory(setup.home, 'default'), { recursive: true })
      mkdirSync(setup.request.profileDirectory('default'))
    }],
    ['a profile directory that cannot be looked up', (setup: Setup) => {
      mkdirSync(profileChangesDirectory(setup.home, 'default'), { recursive: true })
      writeFileSync(join(setup.profiles, 'file'), '')
      return { ...setup.request, profileDirectory: () => join(setup.profiles, 'file', 'default') }
    }],
    ['a profiles directory that cannot be listed', (setup: Setup) => {
      mkdirSync(join(changesDirectory(setup.home), 'profiles'), { recursive: true })
      lockOut(join(changesDirectory(setup.home), 'profiles'))
    }],
  ])('removes nothing when a record cannot be read: %s', async (_name, prepare: (setup: Setup) => CollectRequest | void) => {
    const setup = setUp()
    const version = await stored(setup.home, 'unreferenced')
    age(setup.home)
    const request = prepare(setup) ?? setup.request
    const result = await collectStore(request)
    expect(result).toMatchObject({ complete: false, removedVersions: 0, removedObjects: 0 })
    expect(result.skipped).toMatch(/^a record or kept version cannot be read: /)
    expect(remaining(setup.home)).toEqual({ versions: versionFiles(version), objects: objectFiles('unreferenced') })
  })

  it('removes nothing when a kept version cannot be read', async () => {
    const setup = setUp()
    const approved = await stored(setup.home, 'approved')
    const unreferenced = await stored(setup.home, 'unreferenced')
    await approve(setup, 'default', approved)
    await writeActiveRecord(setup.home, 'default', { schema: ACTIVE_RECORD_SCHEMA, plugins: {} })
    writeFileSync(join(versionsDirectory(setup.home), `${approved}.json`), '{}\n')
    age(setup.home)
    const result = await collectStore(setup.request)
    expect(result).toMatchObject({ complete: false, removedVersions: 0, removedObjects: 0 })
    expect(result.skipped).toMatch(/is not a version Delorun wrote/)
    expect(remaining(setup.home)).toEqual({ versions: versionFiles(approved, unreferenced), objects: objectFiles('approved', 'unreferenced') })
  })

  it('removes nothing when the store lock is held', async () => {
    const setup = setUp()
    const version = await stored(setup.home, 'unreferenced')
    age(setup.home)
    // Another task holds the lock: the collection runs outside its call chain, where the lock is not reentrant.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = (): void => {}
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const holder = withStoreLock(setup.home, async () => { entered(); await gate })
    await inside
    const result = await collectStore(setup.request)
    release()
    await holder
    expect(result).toEqual({ complete: false, removedVersions: 0, removedObjects: 0, skipped: 'the store is in use' })
    expect(remaining(setup.home).versions).toEqual(versionFiles(version))
  })

  it('stops removing at the time limit and leaves the rest for the next collection', async () => {
    const setup = setUp()
    for (const name of ['one', 'two', 'three']) await stored(setup.home, name)
    age(setup.home)
    const base = Date.now()
    let calls = 0
    const now = (): number => base + calls++ * 1_000
    expect(await collectStore({ ...setup.request, now, timeLimitMs: 3_500 })).toEqual({ complete: false, removedVersions: 1, removedObjects: 0 })
    expect(remaining(setup.home).versions).toHaveLength(2)
    expect(await collectStore({ ...setup.request, timeLimitMs: COLLECT_TIME_LIMIT_MS })).toEqual({ complete: true, removedVersions: 2, removedObjects: 4 })
    expect(remaining(setup.home)).toEqual({ versions: [], objects: [] })
  })

  it('stops at the time limit while removing objects', async () => {
    const setup = setUp()
    await stored(setup.home, 'one')
    age(setup.home)
    const base = Date.now()
    let calls = 0
    const now = (): number => base + calls++ * 1_000
    expect(await collectStore({ ...setup.request, now, timeLimitMs: 3_500 })).toEqual({ complete: false, removedVersions: 1, removedObjects: 0 })
    expect(remaining(setup.home).objects).toEqual(objectFiles('one'))
  })

  it('removes old temporary files and leaves every other name alone', async () => {
    const setup = setUp()
    await stored(setup.home, 'unreferenced')
    const objects = objectsDirectory(setup.home)
    const versions = versionsDirectory(setup.home)
    const hex = 'a'.repeat(64)
    writeFiles(objects, { '.x.delorun-tmp-0123456789abcdef': 'old', 'notes.txt': 'n', '.x.delorun-tmp-short': 's' })
    writeFiles(versions, { '.y.json.delorun-tmp-0123456789abcdef': 'old', 'README': 'r' })
    mkdirSync(join(objects, hex))
    mkdirSync(join(versions, `${hex}.json`))
    writeFiles(join(changesDirectory(setup.home), 'profiles'), { 'stray.txt': '' })
    age(setup.home)
    writeFiles(objects, { '.z.delorun-tmp-fedcba9876543210': 'young' })
    expect(await collectStore(setup.request)).toEqual({ complete: true, removedVersions: 1, removedObjects: 2 })
    expect(remaining(setup.home)).toEqual({
      versions: [`${hex}.json`, 'README'].sort(),
      objects: ['.x.delorun-tmp-short', '.z.delorun-tmp-fedcba9876543210', hex, 'notes.txt'].sort(),
    })
  })

  it('treats a missing store as empty', async () => {
    const setup = setUp()
    expect(await collectStore(setup.request)).toEqual({ complete: true, removedVersions: 0, removedObjects: 0 })
  })

  it('keeps the versions a profile names after its directory is gone', async () => {
    const setup = setUp()
    const active = await stored(setup.home, 'active')
    await stored(setup.home, 'unreferenced')
    await writeActiveRecord(setup.home, 'gone', { schema: ACTIVE_RECORD_SCHEMA, plugins: { p: { version: active, kind: 'work-session' } } })
    age(setup.home)
    expect(await collectStore(setup.request)).toEqual({ complete: true, removedVersions: 1, removedObjects: 1 })
    expect(remaining(setup.home)).toEqual({ versions: versionFiles(active), objects: objectFiles('active') })
  })

  it('rethrows a failure to take the store lock other than its being held', async () => {
    const setup = setUp()
    const home = join(setup.profiles, 'home-file')
    writeFileSync(home, '')
    await expect(collectStore({ ...setup.request, home })).rejects.toThrow(/ENOTDIR|EEXIST/)
  })

  it('rethrows a failure to remove a file', async () => {
    const setup = setUp()
    await stored(setup.home, 'unreferenced')
    age(setup.home)
    chmodSync(versionsDirectory(setup.home), 0o500)
    await expect(collectStore(setup.request)).rejects.toThrow(/EACCES/)
  })
})
