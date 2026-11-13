import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bootRecordPath, writeBootRecord } from '../src/boot-record.ts'
import { changeId } from '../src/ids.ts'
import { profileChangesDirectory, protectionPath, versionsDirectory } from '../src/paths.ts'
import { openWorkSession, readChangeLog, setProtection, writeChangeLog } from '../src/records.ts'
import { changesStatus, notApprovedCount, workSessionFact } from '../src/status.ts'
import { scanFolder, versionOf } from '../src/tree.ts'
import type { ChangeEntry, ChangeId, ContentVersion } from '../src/types.ts'
import { workFailurePath, writeWorkFailure } from '../src/work-record.ts'
import { approvedVersion, fixture, folder, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/**
 * @param fx - the fixture.
 * @returns the report of its profile.
 */
function status(fx: Fixture): ReturnType<typeof changesStatus> {
  return changesStatus({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })
}

/**
 * @param home - the Delo home.
 * @param path - a folder.
 * @returns its content version, read without storing it.
 */
async function versionOfFolder(home: string, path: string): Promise<ContentVersion> {
  return versionOf((await scanFolder(path, { home })).entries)
}

describe('changesStatus', () => {
  it('reports a profile whose plugins run what was approved: nothing pending, nothing unapproved, nothing broken', async () => {
    const { fx, source, approved } = await migrated()
    const report = await status(fx)
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    expect(report).toEqual({
      protection: 'on',
      approved: [{ plugin: 'plug', source, approvedAt: NOW.toISOString(), approvedAtUpgrade: true }],
      appliedCount: 1,
      pending: [],
      unreviewed: [],
      invariants: [],
      unshownAtUpgrade: [],
      plugins: [{ plugin: 'plug', source, approved, active: { version: approved, kind: 'approved' }, lastApplied: { id: upgrade.id, summary: upgrade.summary, at: NOW.toISOString() } }],
      leftOut: [],
    })
    expect(notApprovedCount(report)).toBe(0)
  })

  it('names the plugins approved at upgrade until a terminal showed them', async () => {
    const { fx, source } = await migrated()
    const log = await readChangeLog(fx.home, PROFILE)
    const upgrade = log.entries[0]!
    const { shownAt: _shownAt, ...unshown } = upgrade
    const sourceless: ChangeEntry = { ...unshown, id: brandString<ChangeId>('c1111111111'), subject: { plugin: 'other' } }
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: [unshown, sourceless] })
    expect((await status(fx)).unshownAtUpgrade).toEqual([{ plugin: 'plug', source }])
  })

  it('names a folder edited since the last start without an id, and writes nothing into the store', async () => {
    const { fx, source } = await migrated()
    const before = readdirSync(versionsDirectory(fx.home)).sort()
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const report = await status(fx)
    expect(report.pending).toEqual([{ plugin: 'plug', source, kind: 'plugin-edit' }])
    expect(readdirSync(versionsDirectory(fx.home)).sort()).toEqual(before)
    expect(notApprovedCount(report)).toBe(1)
  })

  it('gives the id of a pending change whose content a start stored, and of a new plugin waiting for review', async () => {
    const { fx, source, approved } = await migrated()
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const waiting = folder(fx, 'waiting')
    linkAs(fx, 'waiting', waiting)
    const atStart = await start(fx)
    const edited = await versionOfFolder(fx.home, source)
    const report = await status(fx)
    expect(report.pending).toEqual([
      { id: changeId('plugin-edit', { plugin: 'plug', source }, approved, edited), plugin: 'plug', source, kind: 'plugin-edit' },
      { id: changeId('plugin-install', { plugin: 'waiting', source: waiting }, undefined, await versionOfFolder(fx.home, waiting)), plugin: 'waiting', source: waiting, kind: 'plugin-install' },
    ])
    expect(report.pending.map(change => change.id)).toEqual(atStart.pending.map(change => change.id))
    expect(report.plugins.find(plugin => plugin.plugin === 'waiting')).toEqual({ plugin: 'waiting', source: waiting })
    expect(report.unreviewed).toEqual([])
  })

  it('reports the plugins whose approved content loaded without review, and counts none of them as not approved', async () => {
    const { fx, source } = await migrated()
    await setProtection(fx.home, 'off', terminal())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await start(fx)
    const report = await status(fx)
    expect(report.protection).toBe('off')
    const loaded = (await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.decidedFrom === 'unreviewed')!
    expect(report.unreviewed).toEqual([{ plugin: 'plug', id: loaded.id }])
    linkAs(fx, 'added', folder(fx, 'added'))
    await start(fx)
    expect((await status(fx)).unreviewed.map(({ plugin }) => plugin)).toEqual(['added', 'plug'])
    expect(report.pending).toEqual([])
    expect(notApprovedCount(report)).toBe(0)
  })

  it('reports the open work session', async () => {
    const { fx, source, approved } = await migrated()
    const session = await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    expect((await status(fx)).workSession).toEqual({ plugin: 'plug', source, startedAt: session.startedAt })
  })

  it('carries the last failed reload in a work session, and names its record when it cannot be read', async () => {
    const { fx } = await migrated()
    const failure = await writeWorkFailure(fx.home, PROFILE, { plugin: 'plug', at: NOW.toISOString(), error: 'plug threw' })
    expect((await status(fx)).workFailure).toEqual(failure)
    writeFileSync(workFailurePath(fx.home, PROFILE), '{}\n', { mode: 0o600 })
    const report = await status(fx)
    expect(report.workFailure).toBeUndefined()
    expect(report.workFailureUnreadable).toMatch(/changes-work\.json is not a record Delo wrote/)
  })

  it('leaves a folder that is gone out of the pending changes', async () => {
    const { fx, source } = await migrated()
    rmSync(source, { recursive: true })
    expect((await status(fx)).pending).toEqual([])
  })

  it('carries the record of the last start', async () => {
    const { fx } = await migrated()
    const boot = await writeBootRecord({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, rows: [{ id: 'plug', name: 'plug', disabled: false, state: 'active' }] })
    expect((await status(fx)).boot).toEqual(boot)
  })

  it('reports records and folders that cannot be read as broken, and a boot record that cannot be read apart', async () => {
    const { fx, source } = await migrated()
    writeFileSync(protectionPath(fx.home), '{}\n', { mode: 0o600 })
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'log.json'), '{"schema":"other"}\n', { mode: 0o600 })
    const boot = bootRecordPath(fx.home, PROFILE)
    mkdirSync(dirname(boot), { recursive: true, mode: 0o700 })
    writeFileSync(boot, '{}\n', { mode: 0o600 })
    chmodSync(source, 0o000)
    const report = await status(fx)
    chmodSync(source, 0o700)
    expect(report.protection).toBeUndefined()
    expect(report.invariants).toEqual([
      expect.stringMatching(/^The protection setting cannot be read: /),
      expect.stringMatching(/^The change log cannot be read: .*log\.json/),
      expect.stringMatching(/^The folder of plug cannot be read: .*EACCES/),
    ])
    expect(report.bootUnreadable).toMatch(/changes-boot\.json is not a record Delo wrote/)
    expect(report.boot).toBeUndefined()
    expect(report.pending).toEqual([])
  })

  it('names the newest applied change of each plugin, and lists approved plugins by name', async () => {
    const fx = fixture()
    linkAs(fx, 'zeta', folder(fx, 'zeta'))
    linkAs(fx, 'alpha', folder(fx, 'alpha'))
    await start(fx)
    const log = await readChangeLog(fx.home, PROFILE)
    const base = (id: string, fields: Partial<ChangeEntry>): ChangeEntry => ({ id: brandString<ChangeId>(id), kind: 'plugin-edit', state: 'applied', subject: { plugin: 'alpha' }, summary: id, createdAt: '2026-11-01T00:00:00.000Z', ...fields })
    await writeChangeLog(fx.home, PROFILE, {
      ...log,
      entries: [
        ...log.entries,
        base('c0000000001', { decidedAt: '2026-11-12T00:00:00.000Z' }),
        base('c0000000002', { decidedAt: '2026-11-11T00:00:00.000Z' }),
        base('c0000000003', {}),
        base('c0000000004', { state: 'undone', decidedAt: '2026-11-13T00:00:00.000Z' }),
      ],
    })
    const report = await status(fx)
    expect(report.approved.map(approval => approval.plugin)).toEqual(['alpha', 'zeta'])
    expect(report.appliedCount).toBe(5)
    expect(report.plugins.find(plugin => plugin.plugin === 'alpha')?.lastApplied).toEqual({ id: 'c0000000001', summary: 'c0000000001', at: '2026-11-12T00:00:00.000Z' })
    expect(await approvedVersion(fx, 'zeta')).toBe(report.plugins.find(plugin => plugin.plugin === 'zeta')?.approved)
  })
})

describe('workSessionFact', () => {
  it('gives the open session for the badge, with the last failed reload of its plugin', async () => {
    const { fx, source, approved } = await migrated()
    expect(await workSessionFact(fx.home, PROFILE)).toBeUndefined()
    const session = await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    expect(await workSessionFact(fx.home, PROFILE)).toEqual({ plugin: 'plug', source, startedAt: session.startedAt, endsAt: session.endsAt })
    await writeWorkFailure(fx.home, PROFILE, { plugin: 'other', at: NOW.toISOString(), error: 'other threw' })
    expect((await workSessionFact(fx.home, PROFILE))?.lastError).toBeUndefined()
    await writeWorkFailure(fx.home, PROFILE, { plugin: 'plug', at: NOW.toISOString(), error: 'plug threw' })
    expect((await workSessionFact(fx.home, PROFILE))?.lastError).toEqual({ at: NOW.toISOString(), error: 'plug threw' })
  })
})
