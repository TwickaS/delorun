import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { BOOT_RECORD_SCHEMA, bootRecordPath, managedPlugins, readBootRecord, writeBootRecord, type BootRow } from '../src/boot-record.ts'
import { APPROVED_RECORD_SCHEMA, CHANGE_LOG_SCHEMA, type ApprovedRecord, type ChangeEntry, type ChangeId, type ChangeLog, type ContentVersion } from '../src/types.ts'
import { fixture, folder, linkAs, migrated, NOW, PROFILE, start } from './profile-fixture.ts'
import { rejection } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

const ROWS: readonly BootRow[] = [
  { id: 'plug', name: 'plug', disabled: false, state: 'active' },
  { id: 'plug-client', name: 'plug/client', disabled: false, state: 'active' },
  { id: 'plugin-other', name: 'plugin-other', disabled: false, state: 'failed' },
  { id: 'off-1', name: 'off', disabled: true, state: 'not-imported' },
  { id: 'half-1', name: '@x/half', disabled: false, state: 'active' },
  { id: 'half-2', name: '@x/half/extra', disabled: false, state: 'failed' },
  { id: 'half-3', name: '@x/half/more', disabled: false, state: 'pending' },
]

describe('writeBootRecord and readBootRecord', () => {
  it('records each plugin under Changes with its rows, and whether every enabled row became active', async () => {
    const fx = fixture()
    for (const name of ['plug', 'off', '@x/half', 'gone']) linkAs(fx, name, folder(fx, name.replace('/', '-').replace('@', '')))
    await start(fx)
    linkAs(fx, 'waiting', folder(fx, 'waiting'))
    await start(fx)

    const record = await writeBootRecord({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, rows: ROWS, now: () => NOW })
    expect(record).toEqual({
      schema: BOOT_RECORD_SCHEMA,
      at: NOW.toISOString(),
      plugins: [
        { plugin: '@x/half', rows: [{ id: 'half-1', state: 'active' }, { id: 'half-2', state: 'failed' }, { id: 'half-3', state: 'pending' }], loaded: false, error: 'row half-2 is failed, row half-3 is pending' },
        { plugin: 'gone', rows: [], loaded: false, error: 'the profile has no row for it' },
        { plugin: 'off', rows: [{ id: 'off-1', state: 'not-imported' }], loaded: false, error: 'every row of it is disabled' },
        { plugin: 'plug', rows: [{ id: 'plug', state: 'active' }, { id: 'plug-client', state: 'active' }], loaded: true },
        { plugin: 'waiting', rows: [], loaded: false, error: 'the profile has no row for it' },
      ],
    })
    expect(statSync(bootRecordPath(fx.home, PROFILE)).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(bootRecordPath(fx.home, PROFILE))).mode & 0o777).toBe(0o700)
    expect(await readBootRecord(fx.home, PROFILE)).toEqual(record)
  })

  it('records a start that failed: every plugin not loaded, and the failure', async () => {
    const { fx } = await migrated()
    const record = await writeBootRecord({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, rows: [], failure: 'plug threw at load' })
    expect(record.plugins).toEqual([{ plugin: 'plug', rows: [], loaded: false }])
    expect(record.failure).toBe('plug threw at load')
    expect(Date.parse(record.at)).not.toBeNaN()
    expect(await readBootRecord(fx.home, PROFILE)).toEqual(record)
  })

  it('reads no record before a start wrote one', async () => {
    const fx = fixture()
    expect(await readBootRecord(fx.home, PROFILE)).toBeUndefined()
  })

  it('refuses to record when the profile has no manifest', async () => {
    const fx = fixture()
    await rejection(writeBootRecord({ home: fx.home, profile: PROFILE, profileDir: join(fx.root, 'missing'), rows: [] }), 'RECORD_UNREADABLE')
  })

  it('refuses a record that other users can read', async () => {
    const { fx } = await migrated()
    await writeBootRecord({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, rows: [] })
    chmodSync(bootRecordPath(fx.home, PROFILE), 0o644)
    const error = await rejection(readBootRecord(fx.home, PROFILE), 'RECORD_UNREADABLE')
    expect(error.detail).toContain('it cannot be read')
  })

  const valid = { schema: BOOT_RECORD_SCHEMA, at: NOW.toISOString(), plugins: [{ plugin: 'plug', rows: [{ id: 'plug', state: 'failed' }], loaded: false, error: 'row plug is failed' }], failure: 'boom' }
  it.each([
    ['not JSON', '{', 'it is not JSON'],
    ['not an object', '[]', 'is not a delorun.changes-boot/1 record'],
    ['an unknown field', { ...valid, extra: 1 }, 'record'],
    ['a missing field', { schema: valid.schema, at: valid.at }, 'record'],
    ['another schema', { ...valid, schema: 'delorun.changes-boot/2' }, 'record'],
    ['a time that is not one', { ...valid, at: 'yesterday' }, 'record'],
    ['plugins that are not a list', { ...valid, plugins: {} }, 'record'],
    ['a plugin name that is not one', { ...valid, plugins: [{ ...valid.plugins[0], plugin: 'Not A Name' }] }, 'record'],
    ['rows that are not a list', { ...valid, plugins: [{ ...valid.plugins[0], rows: 'plug' }] }, 'record'],
    ['a row state that is not one', { ...valid, plugins: [{ ...valid.plugins[0], rows: [{ id: 'plug', state: 'loaded' }] }] }, 'record'],
    ['a row id that is not text', { ...valid, plugins: [{ ...valid.plugins[0], rows: [{ id: 1, state: 'active' }] }] }, 'record'],
    ['a loaded flag that is not one', { ...valid, plugins: [{ ...valid.plugins[0], loaded: 'yes' }] }, 'record'],
    ['an error that is not text', { ...valid, plugins: [{ ...valid.plugins[0], error: 1 }] }, 'record'],
    ['a failure that is not text', { ...valid, failure: 1 }, 'record'],
  ])('refuses a record with %s', async (_case, content, words) => {
    const fx = fixture()
    const path = bootRecordPath(fx.home, PROFILE)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 })
    expect((await rejection(readBootRecord(fx.home, PROFILE), 'RECORD_UNREADABLE')).detail).toContain(words)
  })

  it('reads a valid record with every optional field', async () => {
    const fx = fixture()
    const path = bootRecordPath(fx.home, PROFILE)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(valid), { mode: 0o600 })
    expect(await readBootRecord(fx.home, PROFILE)).toEqual(valid)
  })
})

describe('managedPlugins', () => {
  /**
   * @param fields - the entry's fields beyond the defaults.
   * @returns a change-log entry.
   */
  function entry(fields: Partial<ChangeEntry>): ChangeEntry {
    return { id: brandString<ChangeId>('c0000000000'), kind: 'plugin-install', state: 'pending', subject: {}, summary: 's', createdAt: NOW.toISOString(), ...fields }
  }

  it('lists approved plugins with their folder and pending installs with the newest folder, by name', () => {
    const approved: ApprovedRecord = { schema: APPROVED_RECORD_SCHEMA, plugins: { zeta: { source: '/approved/zeta', version: brandString<ContentVersion>('a'.repeat(64)), approvedAt: NOW.toISOString() } } }
    const log: ChangeLog = {
      schema: CHANGE_LOG_SCHEMA,
      entries: [
        entry({ subject: { plugin: 'alpha', source: '/old/alpha' } }),
        entry({ subject: { plugin: 'alpha', source: '/new/alpha' } }),
        entry({ subject: { plugin: 'zeta', source: '/pending/zeta' } }),
        entry({ subject: { plugin: 'done', source: '/done' }, state: 'discarded' }),
        entry({ subject: { plugin: 'edit', source: '/edit' }, kind: 'plugin-edit' }),
        entry({ subject: { plugin: 'nowhere' } }),
        entry({ subject: { source: '/nameless' } }),
      ],
    }
    expect(managedPlugins(approved, log)).toEqual([{ plugin: 'alpha', source: '/new/alpha' }, { plugin: 'zeta', source: '/approved/zeta' }])
  })
})
