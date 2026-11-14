import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessRecordPath, harnessRuntimeDirectory } from '../src/paths.ts'
import { isHarnessPath, readHarnessLog, readHarnessRecord, withHarnessLock, writeHarnessLog, writeHarnessRecord } from '../src/records.ts'
import { readObject, readVersion, storeFileVersion } from '../src/store.ts'
import { CHANGE_LOG_SCHEMA, HARNESS_RECORD_SCHEMA, type ChangeId, type ContentVersion, type HarnessRecord } from '../src/types.ts'
import { modeOf, rejection, temporaryDirectory } from './support.ts'

const FILE = 'app/node_modules/@delorun/cli/src/start.js'

describe('harness records', () => {
  it('a runtime without a record runs its signed files', async () => {
    const home = temporaryDirectory()
    expect(await readHarnessRecord(home, '1.2.3')).toEqual({ schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.3', files: {} })
    expect(await readHarnessLog(home)).toEqual({ schema: CHANGE_LOG_SCHEMA, entries: [] })
  })

  it('a written record reads back and is a protected file', async () => {
    const home = temporaryDirectory()
    const version = await storeFileVersion(home, FILE, Buffer.from('edited\n'), false)
    const signed = await storeFileVersion(home, FILE, Buffer.from('signed\n'), false)
    const record: HarnessRecord = { schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.3', files: { [FILE]: { version, signed, change: 'c0123456789' as ChangeId, approvedAt: '2026-11-11T00:00:00.000Z' } } }
    await withHarnessLock(home, () => writeHarnessRecord(home, record))
    expect(await readHarnessRecord(home, '1.2.3')).toEqual(record)
    expect(modeOf(harnessRecordPath(home, '1.2.3'))).toBe(0o600)
    await withHarnessLock(home, () => writeHarnessLog(home, { schema: CHANGE_LOG_SCHEMA, entries: [] }))
    expect((await readHarnessLog(home)).entries).toEqual([])
  })

  it('a record that names another runtime is refused', async () => {
    const home = temporaryDirectory()
    await writeHarnessRecord(home, { schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.4', files: {} })
    const path = harnessRecordPath(home, '1.2.3')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({ schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.4', files: {} }), { mode: 0o600 })
    await rejection(readHarnessRecord(home, '1.2.3'), 'RECORD_UNREADABLE')
  })

  it('a record that names a file outside app/ is refused on read and on write', async () => {
    const home = temporaryDirectory()
    const path = harnessRecordPath(home, '1.2.3')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const entry = { version: 'a'.repeat(64) as ContentVersion, change: 'c0123456789' as ChangeId, approvedAt: '2026-11-11T00:00:00.000Z' }
    writeFileSync(path, JSON.stringify({ schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.3', files: { 'node/bin/node': entry } }), { mode: 0o600 })
    await rejection(readHarnessRecord(home, '1.2.3'), 'RECORD_UNREADABLE')
    await rejection(writeHarnessRecord(home, { schema: HARNESS_RECORD_SCHEMA, runtime: '1.2.3', files: { 'app/../node/bin/node': entry } }), 'INVALID_REQUEST')
  })

  it('a runtime version that is not one C1 names builds no path', () => {
    expect(() => harnessRuntimeDirectory(temporaryDirectory(), '../1.2.3')).toThrow(/not a Delorun runtime version/u)
  })

  it('harness paths are under app/ without a dot segment', () => {
    expect(isHarnessPath(FILE)).toBe(true)
    for (const path of ['node/bin/node', 'app', 'app/', 'app//x', 'app/./x', 'app/../x', '/app/x', 'app\\x']) expect(isHarnessPath(path)).toBe(false)
  })

  it('a stored file version holds one entry whose object has the bytes', async () => {
    const home = temporaryDirectory()
    const version = await storeFileVersion(home, FILE, Buffer.from('#!/bin/sh\n'), true)
    const manifest = await readVersion(home, version)
    expect(manifest.entries).toHaveLength(1)
    const [entry] = manifest.entries
    expect(entry).toMatchObject({ type: 'file', path: FILE, size: 10, executable: true })
    if (entry?.type === 'file') expect((await readObject(home, entry.digest)).toString()).toBe('#!/bin/sh\n')
    await rejection(storeFileVersion(home, '../x', Buffer.from(''), false), 'INVALID_REQUEST')
  })
})
