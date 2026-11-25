import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listChanges, showChange, undoChange, type ChangesContext, type ReloadHost, type ReloadOutcome } from '../src/actions.ts'
import { openWorkSession, readActiveRecord, readChangeLog, setProtection, writeChangeLog } from '../src/records.ts'
import { activeDirectory, versionsDirectory } from '../src/paths.ts'
import { holdsVersion } from '../src/store.ts'
import { declinedByPerson, loadUnreviewed, unreviewedFolders, unreviewedWords, type UnreviewedSync } from '../src/unreviewed.ts'
import type { ChangeEntry, ContentVersion } from '../src/types.ts'
import { approvedVersion, folder, history, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { lockOut } from './support.ts'

// Each case writes real git histories and scans folders.
vi.setConfig({ testTimeout: 30_000 })

/**
 * @param fx - the fixture.
 * @returns the profile's context.
 */
function contextOf(fx: Fixture): ChangesContext {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW, lockWaitMs: 5_000 }
}

/**
 * A reload that answers each call with the next outcome.
 * @param outcomes - the answers, in order; undefined means Delorun is not running.
 * @returns the reload and its calls.
 */
function reloads(...outcomes: (ReloadOutcome | undefined)[]): { readonly reload: ReloadHost, readonly calls: () => number } {
  const answers = [...outcomes]
  let calls = 0
  return {
    reload: async () => {
      calls += 1
      return Promise.resolve(answers.shift())
    },
    calls: () => calls,
  }
}

/**
 * @param fx - the fixture.
 * @param plugin - a package name.
 * @returns what `active.json` records for the plugin.
 */
async function activeOf(fx: Fixture, plugin: string): Promise<ContentVersion | undefined> {
  return (await readActiveRecord(fx.home, PROFILE)).plugins[plugin]?.version
}

describe('a live reload with protection off', () => {
  it('loads a saved folder, approves it, logs it as unreviewed, and list, show and undo reach it', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const host = reloads({ ok: true })
    const sync = await loadUnreviewed(ctx, 'plug', host.reload)
    expect(sync.kind).toBe('loaded')
    const entry = (sync as { readonly entry: ChangeEntry }).entry
    const saved = await approvedVersion(fx, 'plug')
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', decidedFrom: 'unreviewed', from: approved, to: saved, historyVersion: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(host.calls()).toBe(1)
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default "saved"\n')
    expect(await activeOf(fx, 'plug')).toBe(saved)
    expect((await history(fx))[0]).toBe(`Loaded without review: plug: changes in ${source}`)
    expect((await listChanges(ctx)).entries[0]).toMatchObject({ id: entry.id, decidedFrom: 'unreviewed' })
    expect(await showChange(ctx, entry.id)).toMatchObject({ kind: 'logged', entry: { id: entry.id } })

    // The folder holds what loaded: nothing more loads.
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    expect(host.calls()).toBe(1)

    // Undoing it brings back the content before, and the same folder content is not loaded again.
    await undoChange(ctx, entry.id, terminal(), { reload: async () => Promise.resolve({ ok: true }) })
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('goes back when the reload fails, logs the failure, and does not try the same content again', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    writeFileSync(join(source, 'index.js'), 'export default "broken"\n')
    const host = reloads({ ok: false, error: 'SyntaxError: nope' }, { ok: true })
    const sync = await loadUnreviewed(ctx, 'plug', host.reload)
    expect(sync).toMatchObject({ kind: 'went-back', plugin: 'plug', failure: 'SyntaxError: nope', again: { ok: true }, entry: { state: 'pending', lastFailure: { at: NOW.toISOString(), failure: 'SyntaxError: nope' } } })
    // The entry goes back to pending with no decision: neither when, where nor on which device, nor a history version.
    if (sync.kind !== 'went-back') throw new Error(`expected went-back, got ${sync.kind}`)
    for (const field of ['decidedAt', 'decidedFrom', 'decidedOn', 'historyVersion']) expect(sync.entry, field).not.toHaveProperty(field)
    expect(host.calls()).toBe(2)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect(await activeOf(fx, 'plug')).toBe(approved)
    expect((await history(fx)).slice(0, 2)).toEqual([`Went back: Loaded without review: plug: changes in ${source} failed to load`, `Loaded without review: plug: changes in ${source}`])
    expect((await listChanges(ctx)).pending[0]).toMatchObject({ lastFailure: { failure: 'SyntaxError: nope' } })
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    expect(host.calls()).toBe(2)

    writeFileSync(join(source, 'index.js'), 'export default "fixed"\n')
    expect((await loadUnreviewed(ctx, 'plug', reloads({ ok: true }).reload)).kind).toBe('loaded')
  })

  /**
   * Start a load while another writer holds the profile write lock, wait until the folder's content is in the store, run
   * `meanwhile` still under that lock, then release it.
   * @param fx - the fixture.
   * @param reload - the Host's reload.
   * @param meanwhile - what the other writer does after the read.
   * @returns what the load did.
   */
  async function loadWhileLocked(fx: Fixture, reload: ReloadHost, meanwhile: () => Promise<void>): Promise<UnreviewedSync> {
    const versions = versionsDirectory(fx.home)
    const stored = readdirSync(versions).length
    const lock = join(fx.profileDir, 'package.json')
    // Another writer, in another process, as an install or `delorun changes` holds it: the load waits for that hold,
    // because a live foreign process's lock is never taken over and a load started from the watcher is no part of it.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    try {
      writeFileSync(`${lock}.lock`, `${String(holder.pid)}\n`, { mode: 0o600 })
      const started = loadUnreviewed(contextOf(fx), 'plug', reload)
      await vi.waitFor(() => { expect(readdirSync(versions)).toHaveLength(stored + 1) }, { timeout: 4_000 })
      await meanwhile()
      // The other writer releases: the load takes the freed lock and commits.
      rmSync(`${lock}.lock`, { force: true })
      return await started
    } finally {
      holder.kill('SIGKILL')
      rmSync(`${lock}.lock`, { force: true })
    }
  }

  it('reads the folder without the profile write lock and commits once the lock is free', async () => {
    const { fx, source } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const host = reloads({ ok: true })
    const sync = await loadWhileLocked(fx, host.reload, async () => {
      // Nothing is committed while the other writer holds the lock.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(host.calls()).toBe(0)
    })
    expect(sync.kind).toBe('loaded')
    expect(host.calls()).toBe(1)
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default "saved"\n')
  })

  it('decides with the records as they are under the lock, so protection turned on after the read loads nothing', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const host = reloads({ ok: true })
    const sync = await loadWhileLocked(fx, host.reload, async () => { await setProtection(fx.home, 'on', terminal()) })
    expect(sync).toEqual({ kind: 'protected', plugin: 'plug' })
    expect(host.calls()).toBe(0)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
    expect((await readChangeLog(fx.home, PROFILE)).entries.some(entry => entry.decidedFrom === 'unreviewed')).toBe(false)
  })

  it('leaves a plugin alone when a work session opened on it after the read', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const host = reloads({ ok: true })
    const sync = await loadWhileLocked(fx, host.reload, async () => {
      await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    })
    expect(sync).toEqual({ kind: 'skipped', plugin: 'plug' })
    expect(host.calls()).toBe(0)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
  })

  it('keeps the approved content and logs it when Delorun is not running', async () => {
    const { fx, source } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const sync = await loadUnreviewed(contextOf(fx), 'plug', reloads(undefined).reload)
    expect(sync).toMatchObject({ kind: 'not-running', entry: { state: 'applied', decidedFrom: 'unreviewed' } })
  })

  it('loads nothing with protection on: turning it on takes effect at the next save', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    await setProtection(fx.home, 'on', terminal())
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    const host = reloads({ ok: true })
    expect(await loadUnreviewed(contextOf(fx), 'plug', host.reload)).toEqual({ kind: 'protected', plugin: 'plug' })
    expect(host.calls()).toBe(0)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
    expect((await readChangeLog(fx.home, PROFILE)).entries.some(entry => entry.decidedFrom === 'unreviewed')).toBe(false)
  })

  it('leaves a plugin in a work session, an unlinked one and one whose folder is gone to others', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    const host = reloads({ ok: true })
    expect(await loadUnreviewed(ctx, 'other', host.reload)).toEqual({ kind: 'skipped', plugin: 'other' })
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    writeFileSync(join(source, 'index.js'), 'export default "saved"\n')
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'skipped', plugin: 'plug' })
    rmSync(join(fx.home, 'changes', 'profiles', PROFILE, 'work-session.json'))
    rmSync(source, { recursive: true })
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'skipped', plugin: 'plug' })
    expect(host.calls()).toBe(0)
  })

  it('reports a folder that cannot be read and loads nothing', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    const host = reloads({ ok: true })
    lockOut(source)
    const sync = await loadUnreviewed(contextOf(fx), 'plug', host.reload)
    chmodSync(source, 0o700)
    expect(sync).toEqual({ kind: 'unreadable', plugin: 'plug', detail: expect.stringContaining('EACCES') })
    expect(host.calls()).toBe(0)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
  })

  it('keeps a change a failed start left out while the folder still holds it, and loads new content', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    writeFileSync(join(source, 'index.js'), 'export default "bad"\n')
    await start(fx)
    const log = await readChangeLog(fx.home, PROFILE)
    const loaded = log.entries.find(entry => entry.decidedFrom === 'unreviewed')!
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: log.entries.map(entry => entry.id === loaded.id ? { ...entry, state: 'left-out-at-start', decidedFrom: 'start', leftOut: { at: NOW.toISOString(), failure: 'boom' } } : entry) })
    const host = reloads({ ok: true })
    expect(await loadUnreviewed(ctx, 'plug', host.reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    expect((await start(fx)).leftOut).toEqual([expect.objectContaining({ id: loaded.id })])
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    writeFileSync(join(source, 'index.js'), 'export default "fixed"\n')
    expect((await loadUnreviewed(ctx, 'plug', host.reload)).kind).toBe('loaded')
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default "fixed"\n')
  })

  it('loads a plugin with no approved content from its newest install\'s folder, and goes back to nothing when it fails', async () => {
    const { fx } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    await start(fx)
    const install = (await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.subject.plugin === 'added')!
    await undoChange(ctx, install.id, terminal(), { reload: async () => Promise.resolve({ ok: true }) })
    writeFileSync(join(added, 'index.js'), 'export default "broken"\n')
    const sync = await loadUnreviewed(ctx, 'added', reloads({ ok: false, error: 'boom' }, undefined).reload)
    expect(sync).toMatchObject({ kind: 'went-back', entry: { kind: 'plugin-install', state: 'pending' } })
    expect('again' in sync).toBe(false)
    expect(await activeOf(fx, 'added')).toBeUndefined()
    writeFileSync(join(added, 'index.js'), 'export default "fixed"\n')
    expect(await loadUnreviewed(ctx, 'added', reloads({ ok: true }).reload)).toMatchObject({ kind: 'loaded', entry: { kind: 'plugin-install', decidedFrom: 'unreviewed' } })
  })

  it('loads a plugin whose install was undone once its folder holds something else', async () => {
    const { fx } = await migrated({ protection: 'off' })
    const ctx = contextOf(fx)
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    await start(fx)
    const install = (await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.subject.plugin === 'added')!
    await undoChange(ctx, install.id, terminal(), { reload: async () => Promise.resolve({ ok: true }) })
    expect(declinedByPerson(await readChangeLog(fx.home, PROFILE), 'added', install.to!)).toBe(true)
    expect((await start(fx)).unreviewed).toEqual([])
    expect(await activeOf(fx, 'added')).toBeUndefined()
    writeFileSync(join(added, 'index.js'), 'export default "two"\n')
    expect((await start(fx)).unreviewed).toEqual([expect.objectContaining({ plugin: 'added', kind: 'plugin-install' })])
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'added'), 'index.js'), 'utf8')).toBe('export default "two"\n')
  })
})

describe('unreviewedWords', () => {
  it('names the plugin, that protection is off and how to see the change', () => {
    expect(unreviewedWords({ id: 'c0123456789' as ChangeEntry['id'], plugin: 'p', kind: 'plugin-install' })).toBe('p loaded without review, because protection is off: delorun changes show c0123456789')
    expect(unreviewedWords({ id: 'c0123456789' as ChangeEntry['id'], plugin: 'p', kind: 'plugin-edit' })).toBe('p loaded changes without review, because protection is off: delorun changes show c0123456789')
  })
})

describe('unreviewedFolders', () => {
  it('names each linked plugin\'s folder with protection off, and none with protection on', async () => {
    const { fx, source } = await migrated({ protection: 'off' })
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    await start(fx)
    expect(await unreviewedFolders(contextOf(fx))).toEqual([{ plugin: 'plug', source }, { plugin: 'added', source: added }])
    // An agent's request names a spec, not a folder; a plugin linked to its active directory with no folder on record is not watched.
    const log = await readChangeLog(fx.home, PROFILE)
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: [...log.entries, { id: 'c0000000001' as ChangeEntry['id'], kind: 'plugin-install', state: 'pending', subject: { spec: 'some-plugin@1.0.0' }, summary: 's', createdAt: NOW.toISOString() }, { id: 'c0000000002' as ChangeEntry['id'], kind: 'plugin-install', state: 'pending', subject: { plugin: 'named', spec: 'named@1.0.0' }, summary: 's', createdAt: NOW.toISOString() }] })
    linkAs(fx, 'orphan', activeDirectory(fx.home, PROFILE, 'orphan'))
    expect(await unreviewedFolders(contextOf(fx))).toEqual([{ plugin: 'plug', source }, { plugin: 'added', source: added }])
    await setProtection(fx.home, 'on', terminal())
    expect(await unreviewedFolders(contextOf(fx))).toEqual([])
  })
  it('leaves out an unpacked plugin pack, which no one edits live and whose load would queue for the profile lock', async () => {
    const { fx, source } = await migrated({ protection: 'off' })
    const pack = join(fx.home, 'packs', 'current', 'packed', 'package')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'package.json'), '{"name":"packed","version":"1.0.0"}\n')
    writeFileSync(join(pack, 'index.js'), 'export default "one"\n')
    linkAs(fx, 'packed', pack)
    await start(fx)
    expect(await unreviewedFolders(contextOf(fx))).toEqual([{ plugin: 'plug', source }])
    writeFileSync(join(pack, 'index.js'), 'export default "two"\n')
    const host = reloads({ ok: true })
    expect(await loadUnreviewed(contextOf(fx), 'packed', host.reload)).toEqual({ kind: 'skipped', plugin: 'packed' })
    expect(host.calls()).toBe(0)
  })
})
