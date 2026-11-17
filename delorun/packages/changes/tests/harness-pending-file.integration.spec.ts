import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHarnessChange, createHarnessCopy, discardHarnessChange, harnessChanges, HARNESS_PENDING_SCHEMA, showHarnessChange, type HarnessContext } from '../src/harness.ts'
import { changeId } from '../src/ids.ts'
import { harnessCopyDirectory, harnessPendingPath, harnessScanCachePath } from '../src/paths.ts'
import { readHarnessLog, readHarnessRecord } from '../src/records.ts'
import { SCAN_CACHE_SCHEMA, versionOf } from '../src/tree.ts'
import type { ChangeId, ContentVersion, ObjectDigest } from '../src/types.ts'
import { harnessFixture, SIGNED_FILES, START_FILE, terminal } from './harness-fixture.ts'
import { lockOut, rejection, temporaryDirectory } from './support.ts'

/**
 * @param ctx - the runtime.
 * @param path - a path relative to the runtime.
 * @returns the path in the runtime's copy.
 */
function inCopy(ctx: HarnessContext, path: string): string {
  return join(harnessCopyDirectory(ctx.home, ctx.runtime), ...path.split('/'))
}

/**
 * @param text - a text.
 * @returns its SHA-256.
 */
function sha(text: string): ObjectDigest {
  return createHash('sha256').update(text).digest('hex') as ObjectDigest
}

/**
 * @param path - a harness file.
 * @param text - its content.
 * @returns the one-file version of that content.
 */
function fileVersion(path: string, text: string): ContentVersion {
  return versionOf([{ type: 'file', path, digest: sha(text), size: Buffer.byteLength(text), executable: false }])
}

/**
 * Make the copy, edit the start file in it, and read the changes as the studio does, which names each change's file.
 * @param ctx - the runtime.
 * @param text - the new text.
 * @returns the start file's change.
 */
async function editStart(ctx: HarnessContext, text = 'export const start = 2\n'): Promise<{ readonly id: ChangeId, readonly to: ContentVersion }> {
  await createHarnessCopy(ctx, terminal())
  writeFileSync(inCopy(ctx, START_FILE), text)
  const change = (await harnessChanges(ctx)).changes.find(candidate => candidate.file === START_FILE)!
  expect(existsSync(harnessPendingPath(ctx.home, ctx.runtime))).toBe(true)
  return { id: change.id, to: change.to }
}

/**
 * Write the pending file as a person or another program might, 0600 unless a mode is given.
 * @param ctx - the runtime.
 * @param text - its text.
 * @param mode - its mode.
 */
function writePending(ctx: HarnessContext, text: string, mode = 0o600): void {
  const path = harnessPendingPath(ctx.home, ctx.runtime)
  writeFileSync(path, text)
  chmodSync(path, mode)
}

/**
 * Expect the runtime to run nothing but the signed release and the log to hold no decision.
 * @param ctx - the runtime.
 */
async function expectNothingApplied(ctx: HarnessContext): Promise<void> {
  expect((await readHarnessRecord(ctx.home, ctx.runtime)).files).toEqual({})
  expect((await readHarnessLog(ctx.home)).entries).toEqual([])
}

describe('the pending file', () => {
  it('names the file of each change the last read found, and a read that writes nothing leaves it out', async () => {
    const { ctx } = harnessFixture()
    const { id } = await editStart(ctx)
    expect(JSON.parse(readFileSync(harnessPendingPath(ctx.home, ctx.runtime), 'utf8'))).toEqual({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: START_FILE } })
    expect(lstatSync(harnessPendingPath(ctx.home, ctx.runtime)).mode & 0o777).toBe(0o600)
    const other = harnessFixture()
    await createHarnessCopy(other.ctx, terminal())
    writeFileSync(inCopy(other.ctx, START_FILE), 'export const start = 2\n')
    expect((await harnessChanges(other.ctx, { cache: false })).changes).toHaveLength(1)
    expect(existsSync(harnessPendingPath(other.ctx.home, other.ctx.runtime))).toBe(false)
  })

  it('an action on one change reads that file alone: another file of the copy that cannot be read does not stop it', async () => {
    const { ctx } = harnessFixture()
    const { id, to } = await editStart(ctx)
    lockOut(inCopy(ctx, 'app/package.json'))
    await rejection(harnessChanges(ctx), 'HARNESS_COPY_UNREADABLE')
    expect((await showHarnessChange(ctx, id))?.to).toBe(to)
    expect((await applyHarnessChange(ctx, id, terminal(), { reviewedTo: to })).state).toBe('applied')
    expect((await readHarnessRecord(ctx.home, ctx.runtime)).files[START_FILE]?.version).toBe(to)
  })
})

describe('a file changed outside Delorun after its change was read', () => {
  it('is caught before Apply: the id no longer names what the copy holds', async () => {
    const { ctx } = harnessFixture()
    const { id, to } = await editStart(ctx)
    await showHarnessChange(ctx, id)
    writeFileSync(inCopy(ctx, START_FILE), 'export const start = 3\n')
    await rejection(applyHarnessChange(ctx, id, terminal(), { reviewedTo: to }), 'CHANGED_SINCE_REVIEW')
    await rejection(discardHarnessChange(ctx, id, terminal()), 'CHANGED_SINCE_REVIEW')
    expect(await showHarnessChange(ctx, id)).toBeUndefined()
    await expectNothingApplied(ctx)
    expect(readFileSync(inCopy(ctx, START_FILE), 'utf8')).toBe('export const start = 3\n')
  })

  it('is caught before it is stored or loaded when the scan cache gives the digest of other content', async () => {
    const { ctx } = harnessFixture()
    await editStart(ctx)
    // A cache entry matching the file's status with the digest of content the file does not hold: the read lists the
    // change the cache names, and an action on it reads the file's bytes.
    const stats = lstatSync(inCopy(ctx, START_FILE))
    const claimed = 'export const start = 9\n'
    const cache = harnessScanCachePath(ctx.home, ctx.runtime)
    writeFileSync(cache, JSON.stringify({ schema: SCAN_CACHE_SCHEMA, files: { [START_FILE]: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest: sha(claimed) } } }))
    chmodSync(cache, 0o600)
    const listed = (await harnessChanges(ctx)).changes.find(candidate => candidate.file === START_FILE)!
    expect(listed.to).toBe(fileVersion(START_FILE, claimed))
    await rejection(showHarnessChange(ctx, listed.id), 'CHANGED_WHILE_READING')
    await rejection(applyHarnessChange(ctx, listed.id, terminal(), { reviewedTo: listed.to }), 'CHANGED_WHILE_READING')
    await expectNothingApplied(ctx)
  })

  it('reads nothing through a directory replaced by a link, whatever the pending file names', async () => {
    const { ctx } = harnessFixture()
    await editStart(ctx)
    // The directory holding the start file becomes a link to a folder outside the copy holding other content.
    const outside = temporaryDirectory()
    const claimed = 'export const start = 9\n'
    writeFileSync(join(outside, 'start.js'), claimed)
    const directory = inCopy(ctx, 'app/node_modules/@delorun/cli/src')
    renameSync(directory, `${directory}.moved`)
    symlinkSync(outside, directory)
    const throughLink = changeId('harness-edit', { file: START_FILE, runtime: ctx.runtime }, fileVersion(START_FILE, SIGNED_FILES[START_FILE]!), fileVersion(START_FILE, claimed))
    writePending(ctx, JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [throughLink]: START_FILE } }))
    expect(await showHarnessChange(ctx, throughLink)).toBeUndefined()
    await rejection(applyHarnessChange(ctx, throughLink, terminal()), 'UNKNOWN_CHANGE')
    await expectNothingApplied(ctx)
    // The whole copy's read lists the link's files as removed, as before.
    expect((await harnessChanges(ctx)).changes.map(change => [change.file, change.status])).toContainEqual([START_FILE, 'removed'])
  })
})

describe('a pending file Delorun cannot use', () => {
  it.each<[string, (id: ChangeId) => string, number?]>([
    ['text that is not JSON', () => 'not json'],
    ['another schema', id => JSON.stringify({ schema: 'other/1', files: { [id]: START_FILE } })],
    ['files that are null', () => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: null })],
    ['no file for the id', () => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: {} })],
    ['a file name that is not text', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: 42 } })],
    ['a path outside app/', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: 'node/bin/node' } })],
    ['a path that climbs out', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: 'app/../node/bin/node' } })],
    ['another file of the copy', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: 'app/package.json' } })],
    ['a kept-beside file', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: `${START_FILE}.mine` } })],
    ['a mode other users can read', id => JSON.stringify({ schema: HARNESS_PENDING_SCHEMA, files: { [id]: START_FILE } }), 0o644],
  ])('holding %s falls back to reading the whole copy, never to no change', async (_name, text, mode) => {
    const { ctx } = harnessFixture()
    const { id, to } = await editStart(ctx)
    writeFileSync(inCopy(ctx, `${START_FILE}.mine`), 'kept\n')
    writePending(ctx, text(id), mode)
    expect((await showHarnessChange(ctx, id))?.to).toBe(to)
    expect((await applyHarnessChange(ctx, id, terminal(), { reviewedTo: to })).state).toBe('applied')
    expect((await readHarnessRecord(ctx.home, ctx.runtime)).files[START_FILE]?.version).toBe(to)
  })

  it('a pending file that cannot be written leaves the read and the actions working', async () => {
    const { ctx } = harnessFixture()
    const { id, to } = await editStart(ctx)
    const path = harnessPendingPath(ctx.home, ctx.runtime)
    renameSync(path, `${path}.moved`)
    mkdirSync(path)
    expect((await harnessChanges(ctx)).changes.map(change => change.id)).toEqual([id])
    expect((await applyHarnessChange(ctx, id, terminal(), { reviewedTo: to })).state).toBe('applied')
  })
})
