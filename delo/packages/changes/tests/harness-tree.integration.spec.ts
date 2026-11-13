import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHarnessChange, createHarnessCopy, discardAllHarnessChanges, harnessChanges, type HarnessContext } from '../src/harness.ts'
import { checkComposedTree, composition, harnessStatus, prepareComposedTree, retainHarness, TREE_RETENTION_GRACE_MS } from '../src/harness-tree.ts'
import { harnessCopyDirectory, harnessRunDirectory, harnessRuntimeDirectory } from '../src/paths.ts'
import { readHarnessRecord, writeHarnessRecord } from '../src/records.ts'
import { storeFileVersion } from '../src/store.ts'
import type { ChangeId } from '../src/types.ts'
import { harnessFixture, RUNTIME, SIGNED_FILES, snapshotOf, START_FILE, terminal } from './harness-fixture.ts'
import { modeOf, rejection } from './support.ts'

/**
 * Apply one edit of the start file.
 * @param ctx - the runtime.
 * @param text - the approved text.
 */
async function approveStart(ctx: HarnessContext, text = 'export const start = 2\n'): Promise<void> {
  await createHarnessCopy(ctx, terminal())
  writeFileSync(join(harnessCopyDirectory(ctx.home, ctx.runtime), ...START_FILE.split('/')), text)
  await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
}

/**
 * Set a composed tree's time back past retention's grace period, as for a tree no start chose recently.
 * @param root - the tree.
 */
function chosenLongAgo(root: string): void {
  const then = new Date(Date.now() - TREE_RETENTION_GRACE_MS - 60_000)
  utimesSync(root, then, then)
}

/**
 * Give a composed tree's directories their write permission back, as a person tampering with it would.
 * @param root - the tree.
 * @param paths - directories relative to it.
 */
function writable(root: string, ...paths: string[]): void {
  for (const path of paths) chmodSync(join(root, ...path.split('/')), 0o755)
}

describe('the composed tree', () => {
  it('a runtime without approved files runs its signed release', async () => {
    const { ctx, home, signed } = harnessFixture()
    expect(await prepareComposedTree(home, RUNTIME, signed)).toBeUndefined()
    expect(await composition(home, RUNTIME)).toBeUndefined()
    await rejection(checkComposedTree(home, RUNTIME, signed, join(harnessRunDirectory(home, RUNTIME), 'x')), 'HARNESS_CHANGED')
    expect(ctx.runtime).toBe(RUNTIME)
  })

  it('an applied change runs: the composed tree holds the approved file and hard links to every other signed file', async () => {
    const { ctx, home, signed } = harnessFixture()
    const before = snapshotOf(signed.directory)
    await approveStart(ctx)
    const tree = await prepareComposedTree(home, RUNTIME, signed)
    expect(tree?.directory).toBe(join(harnessRunDirectory(home, RUNTIME), tree!.digest))
    const root = tree!.directory
    expect(readFileSync(join(root, START_FILE), 'utf8')).toBe('export const start = 2\n')
    expect(modeOf(join(root, START_FILE))).toBe(0o444)
    for (const path of Object.keys(SIGNED_FILES).filter(path => path !== START_FILE)) {
      expect(lstatSync(join(root, ...path.split('/'))).ino).toBe(lstatSync(join(signed.directory, ...path.split('/'))).ino)
    }
    expect(modeOf(root)).toBe(0o555)
    expect(modeOf(join(root, 'app', 'node_modules'))).toBe(0o555)
    await checkComposedTree(home, RUNTIME, signed, root)
    expect(await prepareComposedTree(home, RUNTIME, signed)).toEqual(tree)
    expect(snapshotOf(signed.directory)).toEqual(before)
  })

  it('an approved executable file is written read-only and executable, and a removed file is absent', async () => {
    const { ctx, home, signed } = harnessFixture()
    await createHarnessCopy(ctx, terminal())
    const copy = harnessCopyDirectory(home, RUNTIME)
    writeFileSync(join(copy, 'app/node_modules/@delo/cli/run.sh'), '#!/bin/sh\necho changed\n')
    rmSync(join(copy, 'app/package.json'))
    for (const change of (await harnessChanges(ctx)).changes) await applyHarnessChange(ctx, change.id, terminal())
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    expect(modeOf(join(root, 'app/node_modules/@delo/cli/run.sh'))).toBe(0o555)
    expect(existsSync(join(root, 'app/package.json'))).toBe(false)
    await checkComposedTree(home, RUNTIME, signed, root)
  })

  it('a composed tree with a changed, extra or missing file is rebuilt once', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    const tamper: readonly [string, () => void][] = [
      ['app/node_modules/@delo/cli/src/start.js', () => {
        writable(root, 'app/node_modules/@delo/cli/src')
        rmSync(join(root, START_FILE))
        writeFileSync(join(root, START_FILE), 'export const start = 3\n', { mode: 0o444 })
      }],
      ['app/extra.js', () => {
        writable(root, 'app')
        writeFileSync(join(root, 'app/extra.js'), 'extra\n')
      }],
      ['app/package.json', () => {
        writable(root, 'app')
        rmSync(join(root, 'app/package.json'))
      }],
      ['app/package.json', () => {
        writable(root, 'app')
        rmSync(join(root, 'app/package.json'))
        symlinkSync('../node/bin/node', join(root, 'app/package.json'))
      }],
      ['app/node_modules/@delo/cli/src/bin.js', () => {
        writable(root, 'app/node_modules/@delo/cli/src')
        rmSync(join(root, 'app/node_modules/@delo/cli/src/bin.js'))
        writeFileSync(join(root, 'app/node_modules/@delo/cli/src/bin.js'), 'other\n')
      }],
    ]
    for (const [path, change] of tamper) {
      change()
      const refused = await rejection(checkComposedTree(home, RUNTIME, signed, root), 'HARNESS_CHANGED')
      expect(refused.subject).toBe(join(root, ...path.split('/')))
      expect((await prepareComposedTree(home, RUNTIME, signed))?.directory).toBe(root)
      await checkComposedTree(home, RUNTIME, signed, root)
    }
  })

  it('a copy of a signed file where a hard link was refused passes the check by its bytes', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    writable(root, 'app')
    rmSync(join(root, 'app/package.json'))
    writeFileSync(join(root, 'app/package.json'), SIGNED_FILES['app/package.json']!, { mode: 0o444 })
    await checkComposedTree(home, RUNTIME, signed, root)
    rmSync(join(signed.directory, 'app/package.json'))
    await checkComposedTree(home, RUNTIME, signed, root)
  })

  it('a tree the records no longer compose is refused, and discarding every harness change returns to the signed release', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    await approveStart(ctx, 'export const start = 3\n')
    await rejection(checkComposedTree(home, RUNTIME, signed, root), 'HARNESS_CHANGED')
    await discardAllHarnessChanges(ctx, terminal())
    expect(await prepareComposedTree(home, RUNTIME, signed)).toBeUndefined()
  })
})

describe('retention of the harness directories', () => {
  it('removes the runtime\'s other trees and the directories of runtimes no longer installed', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const old = (await prepareComposedTree(home, RUNTIME, signed))!
    await approveStart(ctx, 'export const start = 3\n')
    const current = (await prepareComposedTree(home, RUNTIME, signed))!
    mkdirSync(join(harnessRuntimeDirectory(home, '0.9.0'), 'copy'), { recursive: true })
    writeFileSync(join(home, 'changes', 'harness', 'not-a-version'), '')
    expect(await retainHarness(home, { runtime: RUNTIME, keep: current.digest, removeTrees: false, installed: new Set([RUNTIME]) })).toEqual({ removed: [harnessRuntimeDirectory(home, '0.9.0')], failed: [] })
    expect(existsSync(old.directory)).toBe(true)
    chosenLongAgo(old.directory)
    expect(await retainHarness(home, { runtime: RUNTIME, keep: current.digest, removeTrees: true, installed: new Set([RUNTIME]) })).toEqual({ removed: [old.directory], failed: [] })
    expect(existsSync(current.directory)).toBe(true)
    expect(existsSync(join(signed.directory, START_FILE))).toBe(true)
    expect(readFileSync(join(signed.directory, START_FILE), 'utf8')).toBe(SIGNED_FILES[START_FILE])
  })

  it('never removes a tree a start chose within the grace period, built or reused', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const first = (await prepareComposedTree(home, RUNTIME, signed))!
    await approveStart(ctx, 'export const start = 3\n')
    const second = (await prepareComposedTree(home, RUNTIME, signed))!
    const retain = (): ReturnType<typeof retainHarness> => retainHarness(home, { runtime: RUNTIME, keep: second.digest, removeTrees: true, installed: new Set([RUNTIME]) })
    expect(await retain()).toEqual({ removed: [], failed: [] })
    expect(existsSync(first.directory)).toBe(true)
    await approveStart(ctx)
    chosenLongAgo(first.directory)
    expect(await prepareComposedTree(home, RUNTIME, signed)).toEqual(first)
    expect(await retain()).toEqual({ removed: [], failed: [] })
    expect(existsSync(first.directory)).toBe(true)
    chosenLongAgo(first.directory)
    expect(await retain()).toEqual({ removed: [first.directory], failed: [] })
  })

  it('a home without harness directories retains nothing, and a failed removal is reported', async () => {
    const { home } = harnessFixture()
    expect(await retainHarness(home, { runtime: RUNTIME, removeTrees: true, installed: new Set() })).toEqual({ removed: [], failed: [] })
    const blocked = join(harnessRuntimeDirectory(home, '0.9.0'), 'copy')
    mkdirSync(blocked, { recursive: true })
    chmodSync(join(home, 'changes', 'harness'), 0o500)
    try {
      const retained = await retainHarness(home, { runtime: RUNTIME, removeTrees: true, installed: new Set() })
      expect(retained.failed.map(failure => failure.path)).toEqual([harnessRuntimeDirectory(home, '0.9.0')])
    } finally {
      chmodSync(join(home, 'changes', 'harness'), 0o700)
    }
  })
})

describe('the harness report', () => {
  it('reports the approved files, the copy, the changes waiting and each state of the composed tree, writing nothing', async () => {
    const { ctx, home, signed } = harnessFixture()
    expect(await harnessStatus(home, RUNTIME, signed)).toEqual({ runtime: RUNTIME, approved: [], pending: [], leftOut: [], tree: { kind: 'signed' } })
    await approveStart(ctx)
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), 'app', 'added.js'), 'export {}\n')
    const before = snapshotOf(join(home, 'changes'))
    const status = await harnessStatus(home, RUNTIME, signed)
    expect(status.approved).toEqual([{ file: START_FILE, change: expect.stringMatching(/^c[0-9a-f]{10}$/u), unreviewed: false }])
    expect(status.copy).toBe(join(harnessCopyDirectory(home, RUNTIME), 'app'))
    expect(status.pending.map(change => change.file)).toEqual(['app/added.js'])
    expect(status.tree.kind).toBe('not-built')
    expect(snapshotOf(join(home, 'changes'))).toEqual(before)
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    expect((await harnessStatus(home, RUNTIME, signed)).tree).toEqual({ kind: 'passed', directory: root })
    expect((await harnessStatus(home, RUNTIME, undefined)).tree).toEqual({ kind: 'not-checked', directory: root })
    expect((await harnessStatus(home, RUNTIME, undefined)).pending).toEqual([])
    writable(root, 'app')
    writeFileSync(join(root, 'app', 'extra.js'), 'extra\n')
    expect((await harnessStatus(home, RUNTIME, signed)).tree).toMatchObject({ kind: 'failed', problem: expect.stringContaining('app/extra.js') })
    chmodSync(join(root, 'app', 'node_modules'), 0o000)
    expect((await harnessStatus(home, RUNTIME, signed)).tree).toMatchObject({ kind: 'failed', problem: expect.stringContaining('cannot be checked') })
  })
})

describe('composed trees from records Delo did not write', () => {
  it('a record whose version holds another path is refused, and two approved files are reported in path order', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const record = await readHarnessRecord(home, RUNTIME)
    const other = await storeFileVersion(home, 'app/other.js', Buffer.from('x\n'), false)
    await writeHarnessRecord(home, { ...record, files: { ...record.files, 'app/package.json': { version: other, change: 'c0000000009' as ChangeId, approvedAt: '2026-11-11T10:00:00.000Z' } } })
    await rejection(prepareComposedTree(home, RUNTIME, signed), 'STORE_CORRUPT')
    expect((await harnessStatus(home, RUNTIME, undefined)).approved.map(({ file }) => file)).toEqual(['app/node_modules/@delo/cli/src/start.js', 'app/package.json'])
  })

  it('a file where the trees\' directory belongs refuses the start with HARNESS_CHANGED naming it', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    writeFileSync(harnessRunDirectory(home, RUNTIME), '')
    const refused = await rejection(prepareComposedTree(home, RUNTIME, signed), 'HARNESS_CHANGED')
    expect(refused.subject).toBe(harnessRunDirectory(home, RUNTIME))
    expect(refused.detail).toContain(`${harnessRunDirectory(home, RUNTIME)} is a file where Delo needs a directory`)
    expect(refused.cause).toMatchObject({ code: 'ENOTDIR' })
  })

  it('a signed list that names a path below one of its files refuses the start with HARNESS_CHANGED', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const below = { path: 'app/package.json/a/b/c', length: 0, sha256: createHash('sha256').digest('hex'), executable: false }
    const refused = await rejection(prepareComposedTree(home, RUNTIME, { ...signed, files: [...signed.files, below] }), 'HARNESS_CHANGED')
    expect(refused.subject).toMatch(new RegExp(`^${harnessRunDirectory(home, RUNTIME)}/\\.[0-9a-f]{64}\\.delo-tmp-[0-9a-f]{16}/app/package\\.json/a/b$`, 'u'))
    expect(refused.cause).toMatchObject({ code: 'ENOTDIR' })
  })

  it('a file where the tree belongs is replaced by the tree', async () => {
    const { ctx, home, signed } = harnessFixture()
    await approveStart(ctx)
    const { digest } = (await composition(home, RUNTIME))!
    mkdirSync(harnessRunDirectory(home, RUNTIME), { recursive: true })
    writeFileSync(join(harnessRunDirectory(home, RUNTIME), digest), '')
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    expect(lstatSync(root).isDirectory()).toBe(true)
    await checkComposedTree(home, RUNTIME, signed, root)
  })

  it('a retention whose runtime directory holds a file where its trees belong fails', async () => {
    const { home } = harnessFixture()
    mkdirSync(join(home, 'changes', 'harness', RUNTIME), { recursive: true, mode: 0o700 })
    writeFileSync(harnessRunDirectory(home, RUNTIME), '')
    await expect(retainHarness(home, { runtime: RUNTIME, removeTrees: true, installed: new Set([RUNTIME]) })).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
