/**
 * The session-data copy and its restore over a temporary home: a real copy under a temporary name renamed into place,
 * the copies kept until an update commits or ends, the restore that sets the newer data aside behind a journal, the
 * completion of a restore killed at any point, and the listing and guarded removal of kept data.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCopyFits,
  changedChats,
  DATA_COPIES_DIRECTORY,
  DATA_SET_ASIDE_DIRECTORY,
  discardCopy,
  discardKeptData,
  isDataSafetyError,
  keepOnlyCopy,
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
  it('copies sessions and storages under the target version with a record, and keeps copies for other versions', async () => {
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
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY)).sort()).toEqual(['1.1.0', '1.2.0'])
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

  it('refuses a sessions/ that is a symbolic link or a storages/ that is a file, before anything is written', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'delo-data-copy-outside-'))
    try {
      writeFileSync(join(outside, 'log.jsonl'), 'elsewhere\n')
      symlinkSync(outside, join(home, 'sessions'))
      await expect(copy()).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_NOT_A_DIRECTORY') && /symbolic link/u.test(error.message))
      expect(existsSync(join(home, DATA_COPIES_DIRECTORY))).toBe(false)
      renameSync(join(home, 'sessions'), join(home, 'sessions-link'))
      put('storages', 'a file')
      await expect(copy()).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_NOT_A_DIRECTORY') && /not a directory/u.test(error.message))
      expect(existsSync(join(home, DATA_COPIES_DIRECTORY))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('surfaces a home it cannot inspect', async () => {
    put('file', 'not a home')
    await expect(saveDataCopy({ home: join(home, 'file'), from: '1.0.0', to: '1.1.0', formats: { from: undefined, to: undefined }, now: NOW })).rejects.toThrow(/ENOTDIR/u)
  })

  it('copies a symbolic link inside sessions/ as the link, and never the data it points to outside the home', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'delo-data-copy-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside the home\n')
      put('sessions/a/log.jsonl', 'one\n')
      symlinkSync(outside, join(home, 'sessions/a/link'))
      const record = await copy()
      const link = join(home, 'data-copies/1.1.0/sessions/a/link')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(outside)
      expect(record).toMatchObject({ files: 1, bytes: 4 })
      expect(readdirSync(join(home, 'data-copies/1.1.0/sessions/a')).sort()).toEqual(['link', 'log.jsonl'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
    expect(existsSync(join(home, 'data-copies/1.1.0/sessions/a/link/secret.txt'))).toBe(false)
  })
})

describe('keepOnlyCopy and discardCopy', () => {
  it('keepOnlyCopy keeps the committed update\'s copy and removes the others and unfinished copies', async () => {
    await keepOnlyCopy(home, '1.2.0')
    await copy(NOW, '1.1.0')
    await copy(NOW, '1.2.0')
    put('data-copies/.tmp-0123456789abcdef/sessions/x', 'unfinished')
    await keepOnlyCopy(home, '1.2.0')
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY))).toEqual(['1.2.0'])
    await expect(keepOnlyCopy(home, '../x')).rejects.toThrow(/not a version/u)
  })

  it('discardCopy removes the ended update\'s copy and nothing else', async () => {
    await copy(NOW, '1.1.0')
    await copy(NOW, '1.2.0')
    await discardCopy(home, '1.2.0')
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY))).toEqual(['1.1.0'])
    await discardCopy(home, '1.3.0')
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY))).toEqual(['1.1.0'])
    await expect(discardCopy(home, '..')).rejects.toThrow(/not a version/u)
  })

  it('both refuse while a restore journal exists, and remove nothing', async () => {
    await copy(NOW, '1.1.0')
    await copy(NOW, '1.2.0')
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, '{}')
    await expect(keepOnlyCopy(home, '1.2.0')).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    await expect(discardCopy(home, '1.1.0')).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    expect(readdirSync(join(home, DATA_COPIES_DIRECTORY)).sort()).toEqual(['1.1.0', '1.2.0', RESTORE_JOURNAL_FILE])
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
    put('sessions/same.json', 'same')
    utimesSync(join(home, 'sessions/same.json'), NOW, new Date(NOW.getTime() - 1000))
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
    const journal = { schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }, { kind: 'set-aside', directory: 'storages' }, { kind: 'restore', directory: 'sessions' }, { kind: 'record' }], done: 0 }
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
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '../../etc', steps: [], done: 0 }))
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }], done: 0 }))
    put('sessions/a', 'live')
    put('data-set-aside/1.1.0-20261110T130000Z/sessions/a', 'set aside')
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    expect(read('sessions/a')).toBe('live')
  })

  it('refuses a journal that counts more steps than it holds, or a next step whose directories are both gone', async () => {
    const journal = { schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }] }
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ ...journal, done: 2 }))
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT'))
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ ...journal, done: 0 }))
    await expect(recoverDataCopies(home)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_RESTORE_INCONSISTENT') && /neither/u.test(error.message))
    expect(existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))).toBe(true)
  })

  it('surfaces a journal it cannot read, and a home it cannot inspect', async () => {
    mkdirSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE), { recursive: true })
    await expect(recoverDataCopies(home)).rejects.toThrow(/EISDIR/u)
    put('file', 'not a home')
    await expect(recoverDataCopies(join(home, 'file'))).rejects.toThrow(/ENOTDIR/u)
  })

  it('keeps a file someone left in the emptied copy, and surfaces the restore it stops', async () => {
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [], done: 0 }))
    put('data-copies/1.1.0/notes.txt', 'left by hand')
    await expect(recoverDataCopies(home)).rejects.toThrow(/ENOTEMPTY|EEXIST/u)
    expect(read('data-copies/1.1.0/notes.txt')).toBe('left by hand')
    expect(existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))).toBe(true)
  })
})

/** The set-aside directory the restores below write. */
const SET_ASIDE = `${DATA_SET_ASIDE_DIRECTORY}/1.1.0-20261110T130000Z`

/** The restore's steps for a home with both directories live and copied, each with the paths it renames. */
const RESTORE_STEPS = [
  { step: { kind: 'set-aside', directory: 'sessions' }, source: 'sessions', destination: `${SET_ASIDE}/sessions` },
  { step: { kind: 'set-aside', directory: 'storages' }, source: 'storages', destination: `${SET_ASIDE}/storages` },
  { step: { kind: 'restore', directory: 'sessions' }, source: 'data-copies/1.1.0/sessions', destination: 'sessions' },
  { step: { kind: 'restore', directory: 'storages' }, source: 'data-copies/1.1.0/storages', destination: 'storages' },
  { step: { kind: 'record' }, source: 'data-copies/1.1.0/copy.json', destination: `${SET_ASIDE}/copy.json` },
] as const

/** One point a kill can interrupt a restore at. */
interface KillPoint {
  /** The renames that ran. */
  readonly renamed: number
  /** The journal's `done` count on disk. */
  readonly counted: number
  /** Whether the emptied copy directory was removed. */
  readonly copyRemoved: boolean
}

/** Every kill point: before and after each rename's journal update, and between removing the copy and the journal. */
const KILL_POINTS: readonly KillPoint[] = [
  ...RESTORE_STEPS.flatMap((_step, index) => [
    { renamed: index, counted: index, copyRemoved: false },
    { renamed: index + 1, counted: index, copyRemoved: false },
  ]),
  { renamed: RESTORE_STEPS.length, counted: RESTORE_STEPS.length, copyRemoved: false },
  { renamed: RESTORE_STEPS.length, counted: RESTORE_STEPS.length, copyRemoved: true },
]

/**
 * Write a home's chat data, take its copy at {@link NOW}, and change the live data after it.
 * @param root - the home.
 * @returns the copy's record.
 */
async function restorableHome(root: string): Promise<Awaited<ReturnType<typeof saveDataCopy>>> {
  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write('sessions/old/log.jsonl', 'old\n')
  write('storages/workspace.json', '{"v":1}\n')
  const record = await saveDataCopy({ home: root, from: '1.0.0', to: '1.1.0', formats: { from: FORMATS, to: undefined }, now: NOW })
  write('sessions/new/log.jsonl', 'new\n')
  write('storages/workspace.json', '{"v":2}\n')
  return record
}

/**
 * Every entry under a directory: each directory, file text and link target by its relative path.
 * @param root - the directory.
 * @returns the entries.
 */
function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    entries[relative(root, path)] = entry.isSymbolicLink() ? `link ${readlinkSync(path)}` : entry.isDirectory() ? 'directory' : `file ${readFileSync(path, 'utf8')}`
  }
  return entries
}

describe('a restore killed at any point', { timeout: 30_000 }, () => {
  /** The home an uninterrupted restore of the same data leaves. */
  let uninterrupted: Record<string, string>
  beforeAll(async () => {
    const reference = await mkdtemp(join(tmpdir(), 'delo-data-copy-reference-'))
    try {
      await restoreDataCopy(reference, await restorableHome(reference), LATER)
      uninterrupted = tree(reference)
    } finally {
      await rm(reference, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(KILL_POINTS)('c03-restore-replays-from-any-kill-point: $renamed rename(s) ran, the journal counts $counted, copy removed: $copyRemoved', async point => {
    await restorableHome(home)
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: RESTORE_STEPS.map(entry => entry.step), done: point.counted }))
    if (point.renamed > 0) mkdirSync(join(home, SET_ASIDE), { recursive: true })
    for (const entry of RESTORE_STEPS.slice(0, point.renamed)) renameSync(join(home, entry.source), join(home, entry.destination))
    if (point.copyRemoved) await rm(join(home, DATA_COPIES_DIRECTORY, '1.1.0'), { recursive: true })
    expect(await recoverDataCopies(home)).toBe(true)
    expect(tree(home)).toEqual(uninterrupted)
    expect(await recoverDataCopies(home)).toBe(false)
  })

  it('a second restore refuses while a journal exists, and changes nothing', async () => {
    const record = await restorableHome(home)
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, '{}')
    await expect(restoreDataCopy(home, record, LATER)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    expect(read('sessions/new/log.jsonl')).toBe('new\n')
    expect(existsSync(join(home, DATA_SET_ASIDE_DIRECTORY))).toBe(false)
  })
})

describe('kept data', () => {
  it('lists copies and set-aside directories with their sizes and removes only a named one', async () => {
    expect(await listKeptData(home)).toEqual([])
    put('sessions/a', '12345')
    await copy()
    put('data-set-aside/1.0.0-20261110T120000Z/sessions/a', '123')
    put('data-set-aside/notes.txt', 'not a set-aside directory')
    expect(await listKeptData(home)).toEqual([
      { kind: 'copy', path: join(DATA_COPIES_DIRECTORY, '1.1.0'), bytes: expect.any(Number) as number },
      { kind: 'set-aside', path: join(DATA_SET_ASIDE_DIRECTORY, '1.0.0-20261110T120000Z'), bytes: 3 },
    ])
    await expect(discardKeptData(home, 'sessions', FREE)).rejects.toSatisfy(error => isDataSafetyError(error, 'NOT_KEPT_DATA'))
    await discardKeptData(home, join(DATA_SET_ASIDE_DIRECTORY, '1.0.0-20261110T120000Z'), FREE)
    expect((await listKeptData(home)).map(entry => entry.path)).toEqual([join(DATA_COPIES_DIRECTORY, '1.1.0')])
    expect(read('sessions/a')).toBe('12345')
  })

  it('lists a program store that delorun repair set aside, beside the chat data, and removes it only when named', async () => {
    put('runtimes.set-aside-20261113T120000Z/store.json', '12345678')
    put('runtimes.set-aside-notes/store.json', 'not a set-aside store')
    put('runtimes/store.json', 'the live store')
    expect(await listKeptData(home)).toEqual([{ kind: 'runtimes', path: 'runtimes.set-aside-20261113T120000Z', bytes: 8 }])
    await expect(discardKeptData(home, 'runtimes', FREE)).rejects.toSatisfy(error => isDataSafetyError(error, 'NOT_KEPT_DATA'))
    await expect(discardKeptData(home, 'runtimes.set-aside-notes', FREE)).rejects.toSatisfy(error => isDataSafetyError(error, 'NOT_KEPT_DATA'))
    await discardKeptData(home, 'runtimes.set-aside-20261113T120000Z', FREE)
    expect(await listKeptData(home)).toEqual([])
    expect(read('runtimes/store.json')).toBe('the live store')
  })

  it('removes a set-aside program store whose directories are read-only, as C1 installs them', async () => {
    put('runtimes.set-aside-20261113T120000Z/0.1.0/app/file.js', 'program')
    for (const directory of ['0.1.0/app', '0.1.0']) chmodSync(join(home, 'runtimes.set-aside-20261113T120000Z', directory), 0o555)
    await discardKeptData(home, 'runtimes.set-aside-20261113T120000Z', FREE)
    expect(await listKeptData(home)).toEqual([])
  })

  it('refuses to remove anything while a restore journal exists or a rollback runs, and a copy an update record refers to', async () => {
    await copy(NOW, '1.1.0')
    await copy(NOW, '1.2.0')
    put('data-set-aside/1.0.0-20261110T120000Z/sessions/a', '123')
    const setAside = join(DATA_SET_ASIDE_DIRECTORY, '1.0.0-20261110T120000Z')
    await expect(discardKeptData(home, setAside, { referenced: [], rollingBack: true })).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    put(`data-copies/${RESTORE_JOURNAL_FILE}`, '{}')
    await expect(discardKeptData(home, setAside, FREE)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    await rm(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))
    const guard = { referenced: ['1.2.0'], rollingBack: false }
    await expect(discardKeptData(home, join(DATA_COPIES_DIRECTORY, '1.2.0'), guard)).rejects.toSatisfy(error => isDataSafetyError(error, 'DATA_IN_USE'))
    expect((await listKeptData(home)).map(entry => entry.path)).toEqual([join(DATA_COPIES_DIRECTORY, '1.1.0'), join(DATA_COPIES_DIRECTORY, '1.2.0'), setAside])
    await discardKeptData(home, join(DATA_COPIES_DIRECTORY, '1.1.0'), guard)
    await discardKeptData(home, setAside, guard)
    expect((await listKeptData(home)).map(entry => entry.path)).toEqual([join(DATA_COPIES_DIRECTORY, '1.2.0')])
  })
})

/** A guard naming no copy and no rollback. */
const FREE = { referenced: [], rollingBack: false } as const
