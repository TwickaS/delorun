import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHarnessChange, applyUnreviewedHarnessChanges, composedDigest, composedFiles, createHarnessCopy, discardAllHarnessChanges, discardHarnessChange, findHarnessChange, harnessChanges, listHarness, loggedHarnessChange, readSignedFile, removeTree, showHarnessChange, undoHarnessChange, type HarnessContext } from '../src/harness.ts'
import { harnessStatus } from '../src/harness-tree.ts'
import { leaveOutNewestChange, leftOutFact, newestLeavableChange } from '../src/left-out.ts'
import { harnessCopyDirectory, harnessRecordPath } from '../src/paths.ts'
import { readHarnessLog, readHarnessRecord, withEntry, writeChangeLog, writeHarnessLog, writeHarnessRecord, type AtComputer } from '../src/records.ts'
import { storeEmptyVersion } from '../src/store.ts'
import type { ChangeEntry, ChangeId, ContentVersion } from '../src/types.ts'
import { harnessFixture, RUNTIME, SIGNED_FILES, snapshotOf, START_FILE, terminal } from './harness-fixture.ts'
import { protect } from './profile-fixture.ts'
import { alterReads, makeFifo, modeOf, rejection, temporaryDirectory, understateSize } from './support.ts'

/**
 * @param ctx - the runtime.
 * @param path - a path relative to the runtime.
 * @returns the path in the runtime's copy.
 */
function inCopy(ctx: HarnessContext, path: string): string {
  return join(harnessCopyDirectory(ctx.home, ctx.runtime), ...path.split('/'))
}

/**
 * Make the copy and edit the start file in it.
 * @param ctx - the runtime.
 * @param text - the new text.
 * @returns the pending change of the start file.
 */
async function editStart(ctx: HarnessContext, text = 'export const start = 2\n'): Promise<ChangeId> {
  await createHarnessCopy(ctx, terminal())
  writeFileSync(inCopy(ctx, START_FILE), text)
  const change = (await harnessChanges(ctx)).changes.find(candidate => candidate.file === START_FILE)
  return change!.id
}

/** A proof the attest functions did not issue. */
const FORGED = { kind: 'terminal' } as AtComputer

describe('the writable copy of the harness', () => {
  it('edit-harness makes a writable copy of the signed app directory', async () => {
    const { ctx, signed } = harnessFixture()
    const copy = await createHarnessCopy(ctx, terminal())
    expect(copy).toEqual({ directory: join(harnessCopyDirectory(ctx.home, RUNTIME), 'app'), created: true })
    for (const [path, text] of Object.entries(SIGNED_FILES)) {
      if (!path.startsWith('app/')) {
        expect(existsSync(inCopy(ctx, path))).toBe(false)
        continue
      }
      expect(readFileSync(inCopy(ctx, path), 'utf8')).toBe(text)
      expect(lstatSync(inCopy(ctx, path)).ino).not.toBe(lstatSync(join(signed.directory, ...path.split('/'))).ino)
    }
    expect(modeOf(inCopy(ctx, START_FILE))).toBe(0o600)
    expect(modeOf(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))).toBe(0o700)
    expect(modeOf(inCopy(ctx, 'app/node_modules'))).toBe(0o700)
    expect((await harnessChanges(ctx)).changes).toEqual([])
    expect(await createHarnessCopy(ctx, terminal())).toEqual({ ...copy, created: false })
  })

  it('a second copy holds the approved files in place and leaves removed ones out', async () => {
    const { ctx } = harnessFixture()
    const edit = await editStart(ctx, 'approved\n')
    await applyHarnessChange(ctx, edit, terminal())
    rmSync(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))
    const removal = (await harnessChanges(ctx)).changes[0]!
    await applyHarnessChange(ctx, removal.id, terminal())
    await removeTree(harnessCopyDirectory(ctx.home, RUNTIME))
    await createHarnessCopy(ctx, terminal())
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe('approved\n')
    expect(existsSync(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))).toBe(false)
    expect((await harnessChanges(ctx)).changes).toEqual([])
  })

  it('a copy whose signed file differs from the signed list is refused and leaves no copy', async () => {
    const { ctx, signed } = harnessFixture()
    writeFileSync(join(signed.directory, START_FILE), 'tampered\n')
    await rejection(createHarnessCopy(ctx, terminal()), 'RUNTIME_CHANGED')
    rmSync(join(signed.directory, START_FILE))
    await rejection(createHarnessCopy(ctx, terminal()), 'RUNTIME_CHANGED')
    expect(existsSync(harnessCopyDirectory(ctx.home, RUNTIME))).toBe(false)
  })

  it('edit-harness and every harness decision refuse a proof the attest functions did not issue', async () => {
    const { ctx, home } = harnessFixture()
    const id = 'c0123456789' as ChangeId
    await rejection(createHarnessCopy(ctx, FORGED), 'NOT_AT_COMPUTER')
    await rejection(applyHarnessChange(ctx, id, FORGED), 'NOT_AT_COMPUTER')
    await rejection(discardHarnessChange(ctx, id, FORGED), 'NOT_AT_COMPUTER')
    await rejection(undoHarnessChange(ctx, id, FORGED), 'NOT_AT_COMPUTER')
    await rejection(discardAllHarnessChanges(ctx, FORGED), 'NOT_AT_COMPUTER')
    expect(existsSync(join(home, 'changes'))).toBe(false)
  })
})

describe('pending harness changes', () => {
  it('each saved file of the copy is one pending change; links, FIFOs and paths outside app/ are skipped and .mine files kept beside', async () => {
    const { ctx } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    writeFileSync(inCopy(ctx, START_FILE), 'export const start = 2\n')
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    rmSync(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))
    symlinkSync(join(ctx.home, 'runtimes'), inCopy(ctx, 'app/link'))
    symlinkSync('../package.json', inCopy(ctx, 'app/package.json.link'))
    makeFifo(inCopy(ctx, 'app/fifo'))
    writeFileSync(inCopy(ctx, 'app/start.js.mine'), 'mine\n')
    writeFileSync(inCopy(ctx, 'outside.txt'), 'not under app\n')
    const pending = await harnessChanges(ctx)
    expect(pending.changes.map(({ file, status }) => [file, status])).toEqual([
      ['app/added.js', 'added'],
      ['app/node_modules/@delo/cli/run.sh', 'removed'],
      [START_FILE, 'modified'],
    ])
    expect(pending.skipped).toEqual(['app/fifo', 'app/link', 'app/package.json.link', 'outside.txt'])
    expect(pending.keptBeside).toEqual(['app/start.js.mine'])
    expect(pending.copy).toBe(join(harnessCopyDirectory(ctx.home, RUNTIME), 'app'))
    expect((await harnessChanges(ctx)).changes.map(change => change.id)).toEqual(pending.changes.map(change => change.id))
  })

  it('a runtime without a copy has no pending harness change', async () => {
    const { ctx, reads } = harnessFixture()
    expect(await harnessChanges(ctx)).toEqual({ changes: [], skipped: [], keptBeside: [] })
    expect(reads()).toBe(0)
  })

  it('show reviews the change with its bounded diff, though the file is below node_modules', async () => {
    const { ctx } = harnessFixture()
    const id = await editStart(ctx, 'import { spawn } from "node:child_process"\nexport const start = spawn\n')
    const review = await showHarnessChange(ctx, id)
    expect(review?.files).toEqual([expect.objectContaining({ path: START_FILE, status: 'modified', dependency: false })])
    expect(review?.diff.text).toContain('+export const start = spawn')
    expect(review?.risk.kinds).toContain('commands')
    expect(await showHarnessChange(ctx, 'c0123456789' as ChangeId)).toBeUndefined()
    expect(await findHarnessChange(ctx, id)).toEqual({ kind: 'pending', change: expect.objectContaining({ id, file: START_FILE }) })
    expect(await findHarnessChange(ctx, 'c0123456789' as ChangeId)).toBeUndefined()
  })

  it('an added and a removed file are reviewed against the empty version', async () => {
    const { ctx } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    rmSync(inCopy(ctx, 'app/package.json'))
    const [added, removed] = (await harnessChanges(ctx)).changes
    expect((await showHarnessChange(ctx, added!.id))?.files[0]).toMatchObject({ status: 'added' })
    expect((await showHarnessChange(ctx, removed!.id))?.files[0]).toMatchObject({ status: 'removed' })
  })
})

describe('harness decisions', () => {
  it('applying a harness change never writes under runtimes/', async () => {
    const at = new Date('2026-11-11T10:00:00.000Z')
    const { ctx, home, signed } = harnessFixture(() => at)
    const before = snapshotOf(join(home, 'runtimes'))
    const inodes = Object.keys(SIGNED_FILES).map(path => lstatSync(join(signed.directory, ...path.split('/'))).ino)
    const id = await editStart(ctx)
    const entry = await applyHarnessChange(ctx, id, terminal())
    expect(entry).toMatchObject({ id, kind: 'harness-edit', state: 'applied', subject: { file: START_FILE, runtime: RUNTIME }, decidedFrom: 'terminal', decidedAt: at.toISOString() })
    const record = await readHarnessRecord(home, RUNTIME)
    expect(record.files[START_FILE]).toEqual({ version: entry.to, signed: entry.from, change: id, approvedAt: at.toISOString() })
    expect(snapshotOf(join(home, 'runtimes'))).toEqual(before)
    expect(readFileSync(join(signed.directory, START_FILE), 'utf8')).toBe(SIGNED_FILES[START_FILE])
    expect(Object.keys(SIGNED_FILES).map(path => lstatSync(join(signed.directory, ...path.split('/'))).ino)).toEqual(inodes)
    expect((await harnessChanges(ctx)).changes).toEqual([])
    expect((await readHarnessLog(home)).entries).toEqual([entry])
    await rejection(applyHarnessChange(ctx, id, terminal()), 'NOT_ALLOWED')
    await rejection(discardHarnessChange(ctx, id, terminal()), 'NOT_ALLOWED')
  })

  it('apply refuses an id whose file changed in the copy after it was shown, and an unknown id', async () => {
    const { ctx, home } = harnessFixture()
    const id = await editStart(ctx)
    await showHarnessChange(ctx, id)
    writeFileSync(inCopy(ctx, START_FILE), 'changed again\n')
    await rejection(applyHarnessChange(ctx, id, terminal()), 'CHANGED_SINCE_REVIEW')
    await rejection(applyHarnessChange(ctx, 'c0123456789' as ChangeId, terminal()), 'UNKNOWN_CHANGE')
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })

  it('applying the signed content again removes the record entry', async () => {
    const { ctx, home } = harnessFixture()
    await applyHarnessChange(ctx, await editStart(ctx), terminal())
    writeFileSync(inCopy(ctx, START_FILE), SIGNED_FILES[START_FILE]!)
    const back = (await harnessChanges(ctx)).changes[0]!
    await applyHarnessChange(ctx, back.id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    const added = (await harnessChanges(ctx)).changes[0]!
    await applyHarnessChange(ctx, added.id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files['app/added.js']).not.toHaveProperty('signed')
    rmSync(inCopy(ctx, 'app/added.js'))
    await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })

  it('discard writes what the runtime runs back into the copy', async () => {
    const { ctx, home } = harnessFixture()
    const edit = await editStart(ctx)
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    rmSync(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))
    for (const change of (await harnessChanges(ctx)).changes) {
      expect(await discardHarnessChange(ctx, change.id, terminal())).toMatchObject({ id: change.id, state: 'discarded', decidedFrom: 'terminal' })
    }
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe(SIGNED_FILES[START_FILE])
    expect(existsSync(inCopy(ctx, 'app/added.js'))).toBe(false)
    expect(modeOf(inCopy(ctx, 'app/node_modules/@delo/cli/run.sh'))).toBe(0o700)
    expect((await harnessChanges(ctx)).changes).toEqual([])
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    writeFileSync(inCopy(ctx, START_FILE), 'export const start = 2\n')
    expect((await harnessChanges(ctx)).changes[0]?.id).toBe(edit)
    await applyHarnessChange(ctx, edit, terminal())
    writeFileSync(inCopy(ctx, START_FILE), 'third\n')
    await discardHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe('export const start = 2\n')
  })

  it('undo sets the file back and refuses while a later change of the file is applied', async () => {
    const { ctx, home } = harnessFixture()
    const first = await editStart(ctx, 'first\n')
    await applyHarnessChange(ctx, first, terminal())
    writeFileSync(inCopy(ctx, START_FILE), 'second\n')
    const second = (await harnessChanges(ctx)).changes[0]!.id
    await applyHarnessChange(ctx, second, terminal())
    const refused = await rejection(undoHarnessChange(ctx, first, terminal()), 'NOT_ALLOWED')
    expect(refused.detail).toContain(second)
    expect(await undoHarnessChange(ctx, second, terminal())).toMatchObject({ id: second, state: 'undone' })
    expect((await readHarnessRecord(home, RUNTIME)).files[START_FILE]).toMatchObject({ change: first })
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe('first\n')
    await undoHarnessChange(ctx, first, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe(SIGNED_FILES[START_FILE])
    await rejection(undoHarnessChange(ctx, first, terminal()), 'NOT_ALLOWED')
    await rejection(undoHarnessChange(ctx, 'c0123456789' as ChangeId, terminal()), 'UNKNOWN_CHANGE')
  })

  it('undo refuses a change of another runtime and works without a copy', async () => {
    const { ctx, home } = harnessFixture()
    const id = await editStart(ctx)
    const entry = await applyHarnessChange(ctx, id, terminal())
    await removeTree(harnessCopyDirectory(home, RUNTIME))
    const other: ChangeEntry = { ...entry, id: 'c0000000001' as ChangeId, subject: { file: START_FILE, runtime: '9.9.9' } }
    await writeHarnessLog(home, withEntry(await readHarnessLog(home), other))
    await rejection(undoHarnessChange(ctx, other.id, terminal()), 'NOT_ALLOWED')
    await undoHarnessChange(ctx, id, terminal())
    expect(existsSync(harnessCopyDirectory(home, RUNTIME))).toBe(false)
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })

  it('discarding every harness change returns to the signed release', async () => {
    const { ctx, home } = harnessFixture()
    const applied = await editStart(ctx)
    await applyHarnessChange(ctx, applied, terminal())
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    const pending = (await harnessChanges(ctx)).changes[0]!.id
    const reset = await discardAllHarnessChanges(ctx, terminal())
    expect(reset.discarded.map(entry => entry.id)).toEqual([pending])
    expect(reset.undone.map(entry => [entry.id, entry.state])).toEqual([[applied, 'undone']])
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    expect(existsSync(harnessCopyDirectory(home, RUNTIME))).toBe(false)
    expect(composedFiles(await readHarnessLog(home), await readHarnessRecord(home, RUNTIME))).toEqual({})
    expect(await discardAllHarnessChanges(ctx, terminal())).toEqual({ discarded: [], undone: [] })
  })

  it('reads signed files only through the verified list', async () => {
    const { signed } = harnessFixture()
    const file = signed.files.find(candidate => candidate.path === START_FILE)!
    expect((await readSignedFile(signed, file)).toString()).toBe(SIGNED_FILES[START_FILE])
    await rejection(readSignedFile(signed, { ...file, sha256: '0'.repeat(64) }), 'RUNTIME_CHANGED')
    await rejection(readSignedFile(signed, { ...file, length: file.length + 1 }), 'RUNTIME_CHANGED')
  })
})

describe('a start that fails right after a harness change', () => {
  /**
   * A profile directory whose files a spec compares.
   * @param home - the Delo home.
   * @returns the context of profile `p`.
   */
  function profile(home: string): { readonly home: string, readonly profile: string, readonly profileDir: string } {
    const profileDir = join(home, 'profiles', 'p')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"p","dependencies":{}}\n')
    return { home, profile: 'p', profileDir }
  }

  it('the retry leaves out a newest harness change, marks it left out and writes nothing to the profile', async () => {
    let now = Date.parse('2026-11-11T10:00:00.000Z')
    const { ctx, home } = harnessFixture(() => new Date(now))
    const changes = { ...profile(home), now: () => new Date(now) }
    const before = snapshotOf(changes.profileDir)
    const id = await editStart(ctx)
    const applied = await applyHarnessChange(ctx, id, terminal())
    expect(await newestLeavableChange(changes)).toBeUndefined()
    expect(await newestLeavableChange(changes, RUNTIME)).toEqual(applied)
    now += 1000
    const left = await leaveOutNewestChange(changes, 'SyntaxError: Unexpected token', RUNTIME)
    expect(left).toMatchObject({ id, state: 'left-out-at-start', decidedFrom: 'start', leftOut: { failure: 'SyntaxError: Unexpected token' } })
    expect((await readHarnessLog(home)).entries).toEqual([left])
    expect(leftOutFact(left!).plugin).toBe(`Delo itself (${START_FILE})`)
    expect(snapshotOf(changes.profileDir)).toEqual(before)
    expect(existsSync(join(home, 'changes', 'profiles', 'p', 'log.json'))).toBe(false)
    const record = await readHarnessRecord(home, RUNTIME)
    expect(composedFiles(await readHarnessLog(home), record)).toEqual({})
    expect(await leaveOutNewestChange(changes, 'again', RUNTIME)).toBeUndefined()
    const listing = await listHarness(ctx, home)
    expect(listing.leftOut.map(entry => entry.id)).toEqual([id])
    expect(listing.entries).toEqual([])
    now += 1000
    expect(await applyHarnessChange(ctx, id, terminal())).toMatchObject({ id, state: 'applied' })
    expect(composedFiles(await readHarnessLog(home), record)).toEqual({ [START_FILE]: applied.to })
  })

  it('a left-out change of an approved file composes the content before it, and undo takes it back', async () => {
    let now = Date.parse('2026-11-11T10:00:00.000Z')
    const { ctx, home } = harnessFixture(() => new Date(now))
    const changes = { ...profile(home), now: () => new Date(now) }
    const first = await applyHarnessChange(ctx, await editStart(ctx, 'first\n'), terminal())
    now += 1000
    writeFileSync(inCopy(ctx, START_FILE), 'second\n')
    const second = await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    now += 1000
    await leaveOutNewestChange(changes, 'failed', RUNTIME)
    expect(composedFiles(await readHarnessLog(home), await readHarnessRecord(home, RUNTIME))).toEqual({ [START_FILE]: first.to })
    await undoHarnessChange(ctx, second.id, terminal())
    expect((await readHarnessLog(home)).entries.find(entry => entry.id === second.id)?.state).toBe('undone')
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe('first\n')
  })

  it('a newer plugin decision is left out instead of a harness change, and a change no longer approved is not applied again', async () => {
    const now = Date.parse('2026-11-11T10:00:00.000Z')
    const { ctx, home } = harnessFixture(() => new Date(now))
    const changes = profile(home)
    const id = await editStart(ctx)
    const applied = await applyHarnessChange(ctx, id, terminal())
    const plugin: ChangeEntry = { id: 'c0000000002' as ChangeId, kind: 'plugin-off', state: 'applied', subject: { plugin: 'x' }, summary: 'Turned off x', createdAt: '2026-11-11T11:00:00.000Z', decidedAt: '2026-11-11T11:00:00.000Z', decidedFrom: 'terminal' }
    await writeChangeLog(home, 'p', { schema: 'delo.changes-log/1', entries: [plugin] })
    expect(await newestLeavableChange(changes, RUNTIME)).toBeUndefined()
    const left: ChangeEntry = { ...applied, state: 'left-out-at-start', decidedAt: '2026-11-11T12:00:00.000Z', decidedFrom: 'start', leftOut: { at: '2026-11-11T12:00:00.000Z', failure: 'x' } }
    await writeHarnessLog(home, { schema: 'delo.changes-log/1', entries: [left] })
    await undoHarnessChange(ctx, id, terminal())
    await rejection(applyHarnessChange(ctx, id, terminal()), 'NOT_ALLOWED')
    await writeHarnessLog(home, { schema: 'delo.changes-log/1', entries: [{ ...left, subject: { file: START_FILE, runtime: '9.9.9' } }] })
    await rejection(applyHarnessChange(ctx, id, terminal()), 'NOT_ALLOWED')
  })
})

describe('composed files', () => {
  it('names a set of composed files by a digest of their paths and versions', () => {
    const a = 'a'.repeat(64) as ContentVersion
    const b = 'b'.repeat(64) as ContentVersion
    expect(composedDigest({ 'app/x': a, 'app/y': b })).toBe(composedDigest({ 'app/y': b, 'app/x': a }))
    expect(composedDigest({ 'app/x': a })).not.toBe(composedDigest({ 'app/x': b }))
  })

  it('a left-out added file composes nothing, and a left-out removal of a signed file composes the file again', async () => {
    const { home } = harnessFixture()
    const empty = await storeEmptyVersion(home)
    const v = 'a'.repeat(64) as ContentVersion
    const signed = 'b'.repeat(64) as ContentVersion
    const entry = (file: string, from: ContentVersion, to: ContentVersion): ChangeEntry => ({ id: `c${String(file.length).padStart(10, '0')}` as ChangeId, kind: 'harness-edit', state: 'left-out-at-start', subject: { file, runtime: RUNTIME }, from, to, summary: file, createdAt: '2026-11-11T10:00:00.000Z', decidedAt: '2026-11-11T10:00:00.000Z' })
    const record = { schema: 'delo.changes-harness/1' as const, runtime: RUNTIME, files: { 'app/added.js': { version: v, change: 'c0000000003' as ChangeId, approvedAt: '2026-11-11T10:00:00.000Z' }, 'app/node_modules/x/gone.js': { version: empty, signed, change: 'c0000000004' as ChangeId, approvedAt: '2026-11-11T10:00:00.000Z' } } }
    const log = { schema: 'delo.changes-log/1' as const, entries: [entry('app/added.js', empty, v), entry('app/node_modules/x/gone.js', signed, empty), { ...entry('app/other', v, v), subject: { file: 'app/other', runtime: '9.9.9' } }] }
    expect(composedFiles(log, record)).toEqual({})
    expect(composedFiles({ ...log, entries: [] }, record)).toEqual({ 'app/added.js': v, 'app/node_modules/x/gone.js': empty })
    expect(temporaryDirectory()).toBeTruthy()
  })
})

describe('harness decisions in every order', () => {
  it('an id whose copy went back to what runs is no longer current, and an id nothing ever showed is unknown', async () => {
    const { ctx } = harnessFixture()
    await applyHarnessChange(ctx, await editStart(ctx, 'approved\n'), terminal())
    await rejection(applyHarnessChange(ctx, 'c0123456789' as ChangeId, terminal()), 'UNKNOWN_CHANGE')
    writeFileSync(inCopy(ctx, START_FILE), 'shown, then taken back\n')
    const shown = (await harnessChanges(ctx)).changes[0]!.id
    await showHarnessChange(ctx, shown)
    writeFileSync(inCopy(ctx, START_FILE), 'approved\n')
    await rejection(applyHarnessChange(ctx, shown, terminal()), 'CHANGED_SINCE_REVIEW')
    writeFileSync(inCopy(ctx, START_FILE), 'a third content\n')
    await rejection(applyHarnessChange(ctx, shown, terminal()), 'CHANGED_SINCE_REVIEW')
    const fresh = harnessFixture()
    await createHarnessCopy(fresh.ctx, terminal())
    await rejection(applyHarnessChange(fresh.ctx, 'c0123456789' as ChangeId, terminal()), 'UNKNOWN_CHANGE')
  })

  it('a discarded change cannot be applied while the copy no longer holds it', async () => {
    const { ctx } = harnessFixture()
    const id = await editStart(ctx)
    await discardHarnessChange(ctx, id, terminal())
    const refused = await rejection(applyHarnessChange(ctx, id, terminal()), 'NOT_ALLOWED')
    expect(refused.detail).toContain('discarded')
  })

  it('undo of a change back to the signed file, and of a removed added file, restores what ran before it', async () => {
    const { ctx, home } = harnessFixture()
    const edit = await applyHarnessChange(ctx, await editStart(ctx, 'edited\n'), terminal())
    writeFileSync(inCopy(ctx, START_FILE), SIGNED_FILES[START_FILE]!)
    const back = await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    expect((await rejection(undoHarnessChange(ctx, edit.id, terminal()), 'NOT_ALLOWED')).detail).not.toContain('changed it later')
    await undoHarnessChange(ctx, back.id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files[START_FILE]?.version).toBe(edit.to)
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export {}\n')
    const added = await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    rmSync(inCopy(ctx, 'app/added.js'))
    const gone = await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
    expect(Object.keys((await readHarnessRecord(home, RUNTIME)).files)).toEqual([START_FILE])
    await undoHarnessChange(ctx, gone.id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files['app/added.js']?.version).toBe(added.to)
    expect(readFileSync(inCopy(ctx, 'app/added.js'), 'utf8')).toBe('export {}\n')
    const log = await readHarnessLog(home)
    const foreign: ChangeEntry[] = [{ ...edit, id: 'c00000000a1' as ChangeId, subject: { file: START_FILE, runtime: '9.9.9' } }, { ...edit, id: 'c00000000a2' as ChangeId, kind: 'plugin-off' }, { ...edit, id: 'c00000000a3' as ChangeId, subject: { file: 'app/missing.js', runtime: RUNTIME } }]
    await writeHarnessLog(home, { ...log, entries: [...log.entries, ...foreign] })
    const reset = await discardAllHarnessChanges(ctx, terminal())
    expect(reset.undone.map(entry => entry.id).sort()).toEqual([added.id, edit.id].sort())
    expect(leftOutFact({ ...edit, kind: 'plugin-off', subject: {} }).plugin).toBe('')
  })

  it('a record that names a version of more than one file is refused', async () => {
    const { ctx, home } = harnessFixture()
    const folder = temporaryDirectory()
    writeFileSync(join(folder, 'a.js'), 'a\n')
    writeFileSync(join(folder, 'b.js'), 'b\n')
    const { storeFolder } = await import('../src/store.ts')
    const two = (await storeFolder(home, folder)).version
    const record = { schema: 'delo.changes-harness/1' as const, runtime: RUNTIME, files: { [START_FILE]: { version: two, change: 'c0000000005' as ChangeId, approvedAt: '2026-11-11T10:00:00.000Z' } } }
    await writeHarnessRecord(home, record)
    await rejection(createHarnessCopy(ctx, terminal()), 'STORE_CORRUPT')
    await writeHarnessRecord(home, { ...record, files: {} })
    await createHarnessCopy(ctx, terminal())
    await writeHarnessRecord(home, record)
    await rejection(harnessChanges(ctx), 'STORE_CORRUPT')
  })

  it('a copy file that changes between its scan and its storing is refused', async () => {
    const { ctx } = harnessFixture()
    const id = await editStart(ctx, 'scanned\n')
    const restore = await alterReads(inCopy(ctx, START_FILE))
    try {
      await rejection(showHarnessChange(ctx, id), 'CHANGED_WHILE_READING')
    } finally {
      restore()
    }
  })

  it('a path the scan cannot reach, and a file instead of a tree, are reported or removed as they are', async () => {
    const { ctx, home } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    const directory = join(home, 'changes', 'harness', RUNTIME)
    chmodSync(directory, 0o000)
    try {
      const refused = await rejection(harnessChanges(ctx), 'HARNESS_COPY_UNREADABLE')
      expect(refused.cause).toMatchObject({ code: 'EACCES' })
      await expect(removeTree(join(directory, 'copy'))).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(directory, 0o700)
    }
    const file = join(home, 'a-file')
    writeFileSync(file, '')
    await removeTree(file)
    expect(existsSync(file)).toBe(false)
  })
})

describe('the harness listing', () => {
  it('lists the logged changes newest first outside the store, and a logged change reviews as its versions', async () => {
    const { home } = harnessFixture()
    const empty = await storeEmptyVersion(home)
    const v = 'a'.repeat(64) as ContentVersion
    const entry = (id: string, at: string | undefined, from: ContentVersion, to: ContentVersion): ChangeEntry => ({ id: id as ChangeId, kind: 'harness-edit', state: 'applied', subject: { file: START_FILE, runtime: RUNTIME }, from, to, summary: id, createdAt: '2026-11-11T09:00:00.000Z', ...at === undefined ? {} : { decidedAt: at } })
    await writeHarnessLog(home, { schema: 'delo.changes-log/1', entries: [entry('c0000000001', '2026-11-11T10:00:00.000Z', v, v), entry('c0000000002', '2026-11-11T10:00:00.000Z', empty, v), entry('c0000000003', undefined, v, empty)] })
    const listing = await listHarness(undefined, home)
    expect(listing.entries.map(logged => logged.id)).toEqual(['c0000000002', 'c0000000001', 'c0000000003'])
    expect(listing).not.toHaveProperty('runtime')
    expect(listing.leftOut).toEqual([])
    expect(listing.entries.map(logged => loggedHarnessChange(logged)?.status)).toEqual(['added', 'modified', 'removed'])
    expect(loggedHarnessChange({ ...entry('c0000000004', undefined, v, v), kind: 'plugin-edit' })).toBeUndefined()
    expect(loggedHarnessChange({ ...entry('c0000000004', undefined, v, v), subject: { file: START_FILE } })).toBeUndefined()
  })

  it('a change left out whose content the record no longer holds stays in the log only', () => {
    const v = 'a'.repeat(64) as ContentVersion
    const w = 'b'.repeat(64) as ContentVersion
    const left: ChangeEntry = { id: 'c0000000006' as ChangeId, kind: 'harness-edit', state: 'left-out-at-start', subject: { file: START_FILE, runtime: RUNTIME }, from: v, to: w, summary: 'x', createdAt: '2026-11-11T10:00:00.000Z', decidedAt: '2026-11-11T10:00:00.000Z' }
    const record = { schema: 'delo.changes-harness/1' as const, runtime: RUNTIME, files: { [START_FILE]: { version: v, change: 'c0000000007' as ChangeId, approvedAt: '2026-11-11T10:00:00.000Z' } } }
    expect(composedFiles({ schema: 'delo.changes-log/1', entries: [left] }, record)).toEqual({ [START_FILE]: v })
  })

  it('a runtime whose harness log has no decision leaves the plugin\'s change to the retry', async () => {
    const { home } = harnessFixture()
    const profileDir = join(home, 'profiles', 'p')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"p"}\n')
    expect(await newestLeavableChange({ home, profile: 'p', profileDir }, RUNTIME)).toBeUndefined()
  })
})

/** The fixture's signed files under `app/`. */
const APP_FILES = Object.entries(SIGNED_FILES).filter(([path]) => path.startsWith('app/'))

/** The bytes of the fixture's signed files under `app/`. */
const APP_BYTES = APP_FILES.reduce((total, [, text]) => total + Buffer.byteLength(text), 0)

/** The entries of the fixture's copy: `copy/` itself, five directories down to `src/`, and the four signed files. */
const COPY_ENTRIES = 10

describe('a copy past the scan\'s limits', () => {
  it('edit-harness refuses before copying anything when the copy would pass the limits of its scan', async () => {
    const { ctx, home, signed } = harnessFixture()
    const over = await rejection(createHarnessCopy({ ...ctx, limits: { entries: COPY_ENTRIES - 1, bytes: APP_BYTES } }, terminal()), 'CONTENT_TOO_LARGE')
    expect(over.subject).toBe(join(signed.directory, 'app'))
    expect(over.detail).toBe(`${join(signed.directory, 'app')} holds more than ${String(COPY_ENTRIES - 1)} files and directories, the most Delo reads in your copy of it, so changes to Delo ${RUNTIME} itself cannot be made for this release.`)
    const heavy = await rejection(createHarnessCopy({ ...ctx, limits: { entries: COPY_ENTRIES, bytes: APP_BYTES - 1 } }, terminal()), 'CONTENT_TOO_LARGE')
    expect(heavy.detail).toContain(`holds more than ${String(APP_BYTES - 1)} bytes, the most Delo reads in your copy of it, so changes to Delo ${RUNTIME} itself cannot be made for this release.`)
    expect(existsSync(join(home, 'changes', 'harness', RUNTIME))).toBe(false)
    const fits = { ...ctx, limits: { entries: COPY_ENTRIES, bytes: APP_BYTES } }
    expect((await createHarnessCopy(fits, terminal())).created).toBe(true)
    expect((await harnessChanges(fits, { cache: false })).changes).toEqual([])
  })

  it('counts the approved files in place of the signed ones, as the copy holds them', async () => {
    const { ctx, home } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    writeFileSync(inCopy(ctx, 'app/added.js'), 'export const added = 1\n')
    rmSync(inCopy(ctx, 'app/package.json'))
    for (const change of (await harnessChanges(ctx)).changes) await applyHarnessChange(ctx, change.id, terminal())
    rmSync(harnessCopyDirectory(home, RUNTIME), { recursive: true })
    const bytes = APP_BYTES - Buffer.byteLength(SIGNED_FILES['app/package.json']!) + Buffer.byteLength('export const added = 1\n')
    await rejection(createHarnessCopy({ ...ctx, limits: { entries: COPY_ENTRIES, bytes: bytes - 1 } }, terminal()), 'CONTENT_TOO_LARGE')
    const fits = { ...ctx, limits: { entries: COPY_ENTRIES, bytes } }
    await createHarnessCopy(fits, terminal())
    expect((await harnessChanges(fits, { cache: false })).changes).toEqual([])
  })

  it('a copy that cannot be scanned is refused with HARNESS_COPY_UNREADABLE naming the copy and the way back', async () => {
    const { ctx, home } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    const refused = await rejection(harnessChanges({ ...ctx, limits: { entries: COPY_ENTRIES - 1, bytes: APP_BYTES } }), 'HARNESS_COPY_UNREADABLE')
    expect(refused.subject).toBe(join(harnessCopyDirectory(home, RUNTIME), 'app'))
    expect(refused.detail).toContain(`holds more than ${String(COPY_ENTRIES - 1)} files, links and directories`)
    expect(refused.detail).toContain('delorun changes edit-harness --discard')
    expect(refused.cause).toMatchObject({ code: 'CONTENT_TOO_LARGE' })
  })
})

describe('discarding every harness change from a copy that cannot be read', () => {
  /**
   * A runtime with one applied change and one change waiting in its copy.
   * @returns the fixture and the applied change.
   */
  async function edited(): Promise<{ readonly fixture: ReturnType<typeof harnessFixture>, readonly applied: ChangeId }> {
    const fixture = harnessFixture()
    const applied = await editStart(fixture.ctx)
    await applyHarnessChange(fixture.ctx, applied, terminal())
    writeFileSync(inCopy(fixture.ctx, 'app/added.js'), 'export {}\n')
    return { fixture, applied }
  }

  /**
   * Discard every change and check that the harness returns to the signed release.
   * @param ctx - the runtime.
   * @param applied - the applied change, which is undone.
   * @returns why the copy could not be read.
   */
  async function discardedAll(ctx: HarnessContext, applied: ChangeId): Promise<string | undefined> {
    const reset = await discardAllHarnessChanges(ctx, terminal())
    expect(reset.discarded).toEqual([])
    expect(reset.undone.map(entry => [entry.id, entry.state])).toEqual([[applied, 'undone']])
    expect((await readHarnessRecord(ctx.home, RUNTIME)).files).toEqual({})
    expect(existsSync(harnessCopyDirectory(ctx.home, RUNTIME))).toBe(false)
    return reset.unread
  }

  it('a copy past the scan\'s limits is removed, its applied changes undone', async () => {
    const { fixture, applied } = await edited()
    const unread = await discardedAll({ ...fixture.ctx, limits: { entries: COPY_ENTRIES - 1, bytes: APP_BYTES } }, applied)
    expect(unread).toContain(`holds more than ${String(COPY_ENTRIES - 1)} files, links and directories`)
    expect(unread).not.toContain('edit-harness --discard')
  })

  it('a copy with entries that cannot be read, read-only files and directories included, is removed', async () => {
    const { fixture, applied } = await edited()
    const { ctx } = fixture
    chmodSync(inCopy(ctx, 'app/node_modules/@delo/cli/src/bin.js'), 0o400)
    chmodSync(inCopy(ctx, 'app/node_modules/@delo/cli/src'), 0o500)
    chmodSync(inCopy(ctx, 'app/node_modules/@delo'), 0o000)
    await rejection(harnessChanges(ctx), 'HARNESS_COPY_UNREADABLE')
    expect(await discardedAll(ctx, applied)).toContain('EACCES')
  })

  it('a link where the copy was is removed, never followed', async () => {
    const { fixture, applied } = await edited()
    const { ctx } = fixture
    const elsewhere = temporaryDirectory('delo-elsewhere-')
    writeFileSync(join(elsewhere, 'kept.txt'), 'kept\n')
    rmSync(harnessCopyDirectory(ctx.home, RUNTIME), { recursive: true })
    symlinkSync(join(elsewhere, 'kept.txt'), harnessCopyDirectory(ctx.home, RUNTIME))
    expect(await discardedAll(ctx, applied)).toContain(`${harnessCopyDirectory(ctx.home, RUNTIME)} is not a directory`)
    expect(readFileSync(join(elsewhere, 'kept.txt'), 'utf8')).toBe('kept\n')
  })

  it('a copy whose app directory is a link is scanned without following it and removed without touching its target', async () => {
    const { fixture, applied } = await edited()
    const { ctx } = fixture
    const elsewhere = temporaryDirectory('delo-elsewhere-')
    writeFileSync(join(elsewhere, 'kept.txt'), 'kept\n')
    rmSync(inCopy(ctx, 'app'), { recursive: true })
    symlinkSync(elsewhere, inCopy(ctx, 'app'))
    const reset = await discardAllHarnessChanges(ctx, terminal())
    expect(reset.unread).toBeUndefined()
    expect(reset.undone.map(entry => entry.id)).toEqual([applied])
    expect(existsSync(harnessCopyDirectory(ctx.home, RUNTIME))).toBe(false)
    expect(readFileSync(join(elsewhere, 'kept.txt'), 'utf8')).toBe('kept\n')
  })

  it('a file that grows while the copy is read does not stop it', async () => {
    const { fixture, applied } = await edited()
    const restore = await understateSize(inCopy(fixture.ctx, 'app/added.js'), 1)
    try {
      expect(await discardedAll(fixture.ctx, applied)).toContain('app/added.js grew while it was read')
    } finally {
      restore()
    }
  })

  it('a record Delo did not write, or a signed installation that cannot be read, still stops it', async () => {
    const { fixture } = await edited()
    const { ctx } = fixture
    await expect(discardAllHarnessChanges({ ...ctx, signed: () => Promise.reject(new Error('the installation cannot be read')) }, terminal())).rejects.toThrow('the installation cannot be read')
    writeFileSync(harnessRecordPath(ctx.home, RUNTIME), 'not json\n', { mode: 0o600 })
    await rejection(discardAllHarnessChanges(ctx, terminal()), 'RECORD_UNREADABLE')
    expect(existsSync(harnessCopyDirectory(ctx.home, RUNTIME))).toBe(true)
  })
})

describe('harness edits with protection off', () => {
  it('a start applies every edit of the copy without review, logs each as unreviewed, and undo takes it back', async () => {
    const { ctx, home, signed } = harnessFixture()
    const before = snapshotOf(signed.directory)
    const id = await editStart(ctx)
    const { applied } = await applyUnreviewedHarnessChanges(ctx)
    expect(applied).toEqual([expect.objectContaining({ id, kind: 'harness-edit', state: 'applied', decidedFrom: 'unreviewed', summary: `Loaded without review: Delo ${RUNTIME} itself: ${START_FILE}` })])
    expect(Object.keys((await readHarnessRecord(home, RUNTIME)).files)).toEqual([START_FILE])
    expect((await harnessStatus(home, RUNTIME, signed)).approved).toEqual([{ file: START_FILE, change: id, unreviewed: true }])
    expect((await readHarnessLog(home)).entries).toEqual(applied)
    expect((await harnessChanges(ctx)).changes).toEqual([])
    expect(snapshotOf(signed.directory)).toEqual(before)
    expect(await applyUnreviewedHarnessChanges(ctx)).toEqual({ applied: [] })
    await undoHarnessChange(ctx, id, terminal())
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })

  it('applies nothing with protection on, or without a copy', async () => {
    const { ctx, home } = harnessFixture()
    expect(await applyUnreviewedHarnessChanges(ctx)).toEqual({ applied: [] })
    protect(home)
    await editStart(ctx)
    expect(await applyUnreviewedHarnessChanges(ctx)).toEqual({ applied: [] })
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    expect((await harnessChanges(ctx)).changes).toHaveLength(1)
  })

  it('applies nothing from a copy that cannot be read, and says why', async () => {
    const { ctx, home } = harnessFixture()
    await editStart(ctx)
    const app = join(harnessCopyDirectory(home, RUNTIME), 'app')
    chmodSync(app, 0o000)
    const result = await applyUnreviewedHarnessChanges(ctx)
    chmodSync(app, 0o700)
    expect(result).toEqual({ applied: [], unread: expect.stringContaining('EACCES') })
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })

  it('applies nothing from a file that grows while it is read, and stops on a signed installation that cannot be read', async () => {
    const { ctx, home } = harnessFixture()
    await editStart(ctx)
    const restore = await understateSize(inCopy(ctx, START_FILE), 1)
    try {
      expect(await applyUnreviewedHarnessChanges(ctx)).toEqual({ applied: [], unread: expect.stringContaining('grew while it was read') })
    } finally {
      restore()
    }
    await expect(applyUnreviewedHarnessChanges({ ...ctx, signed: () => Promise.reject(new Error('unreadable installation')) })).rejects.toThrow('unreadable installation')
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
  })
})
