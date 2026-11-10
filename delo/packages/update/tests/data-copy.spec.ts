/**
 * The session-data copy and its restore over a temporary home: a real copy under a temporary name renamed into place,
 * one copy kept, the restore that sets the newer data aside behind a journal, the completion of a killed restore,
 * and the listing and removal of kept data.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCopyFits,
  changedChats,
  DATA_COPIES_DIRECTORY,
  DATA_SET_ASIDE_DIRECTORY,
  discardKeptData,
  isDataSafetyError,
  listKeptData,
  planDataCopy,
  readCopyRecord,
  recoverDataCopies,
  RESTORE_JOURNAL_FILE,
  restoreDataCopy,
  saveDataCopy,
} from '../src/index.ts'
import { FORMATS } from './support.ts'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const LATER = new Date('2026-11-10T13:00:00.000Z')

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'delo-data-copy-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

/**
 * Write a file under the home, creating its directories.
 * @param path - the path relative to the home.
 * @param text - its text.
 */
function put(path: string, text: string): void {
  mkdirSync(join(home, path, '..'), { recursive: true })
  writeFileSync(join(home, path), text)
}

/**
 * Read a file under the home.
 * @param path - the path relative to the home.
 * @returns its text.
 */
function read(path: string): string {
  return readFileSync(join(home, path), 'utf8')
}

/**
 * Take a copy for 1.1.0 from 1.0.0.
 * @param now - the copy's time.
 * @returns the record.
 */
async function copy(now = NOW, to = '1.1.0'): Promise<Awaited<ReturnType<typeof saveDataCopy>>> {
  return saveDataCopy({ home, from: '1.0.0', to, formats: { from: FORMATS, to: undefined }, now })
}

describe('saveDataCopy', () => {
  it('copies sessions and storages under the target version with a record, and keeps one copy', async () => {
    put('sessions/a/log.jsonl', 'one\n')
    put('storages/workspace.json', '{"v":2}\n')
    put('attachments/blob', 'not copied')
    const record = await copy()
    expect(record).toMatchObject({ from: '1.0.0', to: '1.1.0', files: 2, bytes: 12, formats: { from: FORMATS, to: null } })
    expect(read('data-copies/1.1.0/sessions/a/log.jsonl')).toBe('one\n')
    expect(read('data-copies/1.1.0/storages/workspace.json')).toBe('{"v":2}\n')
    expect(existsSync(join(home, 'data-copies/1.1.0/attachments'))).toBe(false)
    expect(statSync(join(home, 'data-copies/1.1.0/sessions/a/log.jsonl')).ino).not.toBe(statSync(join(home, 'sessions/a/log.jsonl')).ino)
    expect(await readCopyRecord(home, '1.1.0')).toEqual(record)
    await copy(LATER, '1.2.0')
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY))).toEqual(['1.2.0'])
  })

  it('copies a home with no chat data, and replaces an earlier copy for the same version', async () => {
    expect(await copy()).toMatchObject({ files: 0, bytes: 0 })
    put('sessions/a/log.jsonl', 'one\n')
    expect(await copy(LATER)).toMatchObject({ files: 1 })
    expect(read('data-copies/1.1.0/sessions/a/log.jsonl')).toBe('one\n')
  })

  it('refuses a target that cannot name a copy, and leaves no temporary copy after a failure', async () => {
    await expect(saveDataCopy({ home, from: '1.0.0', to: '../x', formats: { from: undefined, to: undefined }, now: NOW })).rejects.toThrow(/not a version/u)
    put('sessions/a', 'x')
    mkdirSync(join(home, DATA_COPIES_DIRECTORY), { recursive: true })
    writeFileSync(join(home, DATA_COPIES_DIRECTORY, '1.1.0'), 'a file where the copy goes')
    await expect(saveDataCopy({ home, from: '1.0.0', to: '1.1.0', formats: { from: undefined, to: undefined }, now: new Date(Number.NaN) })).rejects.toThrow()
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY)).filter(name => name.startsWith('.tmp-'))).toEqual([])
  })

  it('c03-copy-without-space-refuses: a copy larger than the free space is refused before anything is written', async () => {
    expect(() => { assertCopyFits({ files: 1, bytes: 2, free: 1 }) }).toThrow(expect.objectContaining({ code: 'DATA_COPY_NO_SPACE' }))
    expect(() => { assertCopyFits({ files: 1, bytes: 1, free: 1 }) }).not.toThrow()
    const size = await planDataCopy(home)
    expect(size.free).toBeGreaterThan(0)
  })
})

describe('readCopyRecord', () => {
  it('reads no record for a missing copy or a name that is not a version, and refuses a foreign record', async () => {
    expect(await readCopyRecord(home, '1.1.0')).toBeUndefined()
    expect(await readCopyRecord(home, '../1.1.0')).toBeUndefined()
    put('data-copies/1.1.0/copy.json', '{"schema":"delo.session-data-copy/1"}')
    await expect(readCopyRecord(home, '1.1.0')).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    put('data-copies/1.1.0/copy.json', JSON.stringify({ schema: 'delo.session-data-copy/1', from: '1.0.0', to: '1.1.0', formats: { from: { schema: 'x' }, to: null }, files: 0, bytes: 0, created: NOW.toISOString() }))
    await expect(readCopyRecord(home, '1.1.0')).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    mkdirSync(join(home, 'data-copies/1.2.0/copy.json'), { recursive: true })
    await expect(readCopyRecord(home, '1.2.0')).rejects.toThrow(/EISDIR/u)
  })
})

describe('restoreDataCopy', () => {
  it('sets the live data aside, puts the copy back, and counts the chats set aside', async () => {
    put('sessions/old/log.jsonl', 'old\n')
    put('sessions/kept/log.jsonl', 'kept\n')
    put('storages/workspace.json', '{"v":2}\n')
    const record = await copy()
    put('sessions/new/log.jsonl', 'new\n')
    put('sessions/old/log.jsonl', 'old, changed\n')
    utimesSync(join(home, 'sessions/old/log.jsonl'), LATER, LATER)
    utimesSync(join(home, 'sessions/kept/log.jsonl'), NOW, new Date(NOW.getTime() - 1000))
    put('sessions/loose.json', 'loose')
    utimesSync(join(home, 'sessions/loose.json'), LATER, LATER)
    rmStorages()
    const result = await restoreDataCopy(home, record, LATER)
    expect(result).toEqual({ setAside: join(DATA_SET_ASIDE_DIRECTORY, '1.1.0-20261110T130000Z'), changedChats: 3 })
    expect(read('sessions/old/log.jsonl')).toBe('old\n')
    expect(existsSync(join(home, 'sessions/new'))).toBe(false)
    expect(read('storages/workspace.json')).toBe('{"v":2}\n')
    expect(read(`${result.setAside}/sessions/new/log.jsonl`)).toBe('new\n')
    expect(read(`${result.setAside}/copy.json`)).toContain('delo.session-data-copy/1')
    expect(existsSync(join(home, DATA_COPIES_DIRECTORY, '1.1.0'))).toBe(false)
    expect(existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))).toBe(false)
  })

  it('c03-second-rollback-keeps-both-set-asides: two restores at the same second keep two directories', async () => {
    put('sessions/a/log.jsonl', 'a\n')
    await restoreDataCopy(home, await copy(), LATER)
    put('sessions/b/log.jsonl', 'b\n')
    await restoreDataCopy(home, await copy(), LATER)
    expect(readdirSync(join(home, DATA_SET_ASIDE_DIRECTORY)).sort()).toEqual(['1.1.0-20261110T130000Z', '1.1.0-20261110T130000Z-1'])
    expect((await listKeptData(home)).map(entry => entry.kind)).toEqual(['set-aside', 'set-aside'])
  })

  it('counts no changed chats when the home has no sessions', async () => {
    const record = await copy()
    expect(await changedChats(home, record)).toBe(0)
  })
})

/** Remove the live storages, as a target that dropped them. */
function rmStorages(): void {
  renameSync(join(home, 'storages'), join(home, 'storages-gone'))
}

describe('recoverDataCopies', () => {
  it('c03-interrupted-restore-completes-before-a-host-starts: a restore killed after its first rename completes', async () => {
    put('sessions/old/log.jsonl', 'old\n')
    const record = await copy()
    put('sessions/new/log.jsonl', 'new\n')
    put('storages/workspace.json', 'newer\n')
    const journal = { schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }, { kind: 'set-aside', directory: 'storages' }, { kind: 'restore', directory: 'sessions' }, { kind: 'record' }] }
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify(journal))
    mkdirSync(join(home, 'data-set-aside/1.1.0-20261110T130000Z'), { recursive: true })
    renameSync(join(home, 'sessions'), join(home, 'data-set-aside/1.1.0-20261110T130000Z/sessions'))
    put('data-copies/.tmp-0123456789abcdef/sessions/x', 'unfinished')
    expect(await recoverDataCopies(home)).toBe(true)
    expect(read('sessions/old/log.jsonl')).toBe('old\n')
    expect(read('data-set-aside/1.1.0-20261110T130000Z/sessions/new/log.jsonl')).toBe('new\n')
    expect(read('data-set-aside/1.1.0-20261110T130000Z/storages/workspace.json')).toBe('newer\n')
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY))).toEqual([])
    expect(record.files).toBe(1)
    expect(await recoverDataCopies(home)).toBe(false)
  })

  it('does nothing on a home without copies, and refuses a journal it did not write or a state no restore leaves', async () => {
    expect(await recoverDataCopies(home)).toBe(false)
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, 'not json')
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '../../etc', steps: [] }))
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }] }))
    put('sessions/a', 'live')
    put('data-set-aside/1.1.0-20261110T130000Z/sessions/a', 'set aside')
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    expect(read('sessions/a')).toBe('live')
  })

  it('surfaces a journal it cannot read', async () => {
    mkdirSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE), { recursive: true })
    await expect(recoverDataCopies(home)).rejects.toThrow(/EISDIR/u)
  })
})

describe('kept data', () => {
  it('lists copies and set-aside directories with their sizes and removes only a named one', async () => {
    put('sessions/a', '12345')
    await copy()
    put('data-set-aside/1.0.0-20261110T120000Z/sessions/a', '123')
    put('data-set-aside/notes.txt', 'not a set-aside directory')
    expect(await listKeptData(home)).toEqual([
      { kind: 'copy', path: join(DATA_COPIES_DIRECTORY, '1.1.0'), bytes: expect.any(Number) as number },
      { kind: 'set-aside', path: join(DATA_SET_ASIDE_DIRECTORY, '1.0.0-20261110T120000Z'), bytes: 3 },
    ])
    await expect(discardKeptData(home, 'sessions')).rejects.toSatisfy(error => isDataSafetyError(error, 'NOT_KEPT_DATA'))
    await discardKeptData(home, join(DATA_SET_ASIDE_DIRECTORY, '1.0.0-20261110T120000Z'))
    expect((await listKeptData(home)).map(entry => entry.path)).toEqual([join(DATA_COPIES_DIRECTORY, '1.1.0')])
    expect(read('sessions/a')).toBe('12345')
  })
})
