/**
 * An update's carry of the person's approved harness files (`carryHarness`): the target runtime's record and log
 * entries, the person's content kept beside a conflicted file, the refusal while changes wait for review, the target
 * directory replaced and removed on failure, and the running runtime's records left as they were for a rollback.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { carryHarness, type HarnessCarried, type HarnessCarryPlan } from '../src/harness-merge.ts'
import { applyHarnessChange, createHarnessCopy, harnessChanges, type HarnessContext, type SignedRuntime } from '../src/harness.ts'
import { composition } from '../src/harness-tree.ts'
import { leaveOutNewestChange } from '../src/left-out.ts'
import { harnessCopyDirectory, harnessRuntimeDirectory } from '../src/paths.ts'
import { readHarnessLog, readHarnessRecord, withHarnessLock, writeHarnessRecord } from '../src/records.ts'
import { readObject, readVersion, storeFileVersion } from '../src/store.ts'
import { HARNESS_RECORD_SCHEMA, type ChangeId } from '../src/types.ts'
import { harnessFixture, listOf, RUNTIME, SIGNED_FILES, snapshotOf, START_FILE, terminal } from './harness-fixture.ts'
import { rejection, writeFiles } from './support.ts'

const TARGET = '1.3.0'
const MANIFEST = 'app/package.json'
const BIN = 'app/node_modules/@delo/cli/src/bin.js'
const AT = new Date('2026-11-11T12:00:00.000Z')

/**
 * Install the target runtime beside the fixture's: its signed files, with some replaced or removed.
 * @param home - the Delo home.
 * @param change - the target's content by path; undefined removes the path.
 * @returns the target's signed installation.
 */
function installTarget(home: string, change: Readonly<Record<string, string | undefined>> = {}): SignedRuntime {
  const directory = join(home, 'runtimes', TARGET)
  const files = { ...SIGNED_FILES, ...change }
  writeFiles(directory, Object.fromEntries(Object.entries(files).flatMap(([path, text]) => text === undefined ? [] : [[path, text]])))
  return { directory, files: listOf(directory) }
}

/**
 * @param ctx - a runtime.
 * @param path - a path relative to the runtime.
 * @returns the path in the runtime's copy.
 */
function inCopy(ctx: Pick<HarnessContext, 'home' | 'runtime'>, path: string): string {
  return join(harnessCopyDirectory(ctx.home, ctx.runtime), ...path.split('/'))
}

/**
 * Approve a file's content for the running runtime through its copy, as the person does.
 * @param ctx - the running runtime.
 * @param path - the file.
 * @param text - the new text; undefined removes the file.
 */
async function approve(ctx: HarnessContext, path: string, text: string | undefined): Promise<void> {
  await createHarnessCopy(ctx, terminal())
  if (text === undefined) rmSync(inCopy(ctx, path))
  else writeFileSync(inCopy(ctx, path), text)
  const change = (await harnessChanges(ctx)).changes.find(candidate => candidate.file === path)
  await applyHarnessChange(ctx, change!.id, terminal())
}

/**
 * Carry the running runtime's files to the target, recording whether the switch ran.
 * @param ctx - the running runtime.
 * @param signed - the target's installation.
 * @param switchRuntime - the switch; it only counts by default.
 * @param confirm - the comparison with what the person confirmed; it accepts every plan by default.
 * @returns what was carried and how many times the switch ran.
 */
async function carry(ctx: HarnessContext, signed: SignedRuntime, switchRuntime?: () => Promise<void>, confirm: (plan: HarnessCarryPlan) => void = () => {}): Promise<{ carried: HarnessCarried, switches: number }> {
  let switches = 0
  const carried = await carryHarness({ from: ctx, to: TARGET, signed: async () => Promise.resolve(signed), confirm }, async () => {
    switches += 1
    await switchRuntime?.()
  }, () => AT)
  return { carried, switches }
}

/**
 * The bytes of a one-file version's file.
 * @param home - the Delo home.
 * @param version - the version.
 * @returns its text.
 */
async function textOf(home: string, version: Parameters<typeof readVersion>[1]): Promise<string> {
  const [entry] = (await readVersion(home, version)).entries
  return entry?.type === 'file' ? (await readObject(home, entry.digest)).toString('utf8') : ''
}

describe('c03-harness-change-carried: an update carries the approved files', () => {
  it('writes the target\'s record and an applied log entry decided at update for a change the release did not touch, then switches', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    const signed = installTarget(home, { [MANIFEST]: '{"name":"closure","version":2}\n' })

    const { carried, switches } = await carry(ctx, signed)

    expect(switches).toBe(1)
    expect(carried).toEqual({ carried: [START_FILE], keptBeside: [], removedReturned: [], copy: true })
    const record = await readHarnessRecord(home, TARGET)
    const approved = record.files[START_FILE]!
    expect(await textOf(home, approved.version)).toBe('export const start = 2\n')
    expect(await textOf(home, approved.signed!)).toBe(SIGNED_FILES[START_FILE])
    expect(approved.approvedAt).toBe(AT.toISOString())
    const entry = (await readHarnessLog(home)).entries.find(candidate => candidate.subject.runtime === TARGET)
    expect(entry).toMatchObject({ id: approved.change, kind: 'harness-edit', state: 'applied', subject: { file: START_FILE, runtime: TARGET }, from: approved.signed, to: approved.version, decidedFrom: 'update', summary: `Delo ${TARGET} itself: ${START_FILE}` })
    expect((await composition(home, TARGET))?.files).toEqual({ [START_FILE]: approved.version })
    // The running runtime had a copy, so the target has one holding what it runs, and nothing waits for review there.
    expect(readFileSync(inCopy({ home, runtime: TARGET }, START_FILE), 'utf8')).toBe('export const start = 2\n')
    expect(readFileSync(inCopy({ home, runtime: TARGET }, MANIFEST), 'utf8')).toBe('{"name":"closure","version":2}\n')
    expect((await harnessChanges({ home, runtime: TARGET, signed: async () => Promise.resolve(signed) })).changes).toEqual([])
  })

  it('writes nothing for a file the release already holds as approved, and nothing at all without approved files or a copy', async () => {
    const { ctx, home } = harnessFixture()
    expect(await carry(ctx, installTarget(home))).toEqual({ carried: { carried: [], keptBeside: [], removedReturned: [], copy: false }, switches: 1 })
    expect(existsSync(harnessRuntimeDirectory(home, TARGET))).toBe(false)

    await approve(ctx, START_FILE, 'export const start = 2\n')
    const { carried } = await carry(ctx, installTarget(home, { [START_FILE]: 'export const start = 2\n' }))
    expect(carried.carried).toEqual([])
    expect(await readHarnessRecord(home, TARGET)).toMatchObject({ files: {} })
    expect((await readHarnessLog(home)).entries.filter(entry => entry.subject.runtime === TARGET)).toEqual([])
  })

  it('carries a file the person added and a file the person removed, each against what the release has', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, 'app/added.js', 'added\n')
    await approve(ctx, BIN, undefined)

    const { carried } = await carry(ctx, installTarget(home))

    expect(carried.carried).toEqual(['app/added.js', BIN])
    const record = await readHarnessRecord(home, TARGET)
    expect(record.files['app/added.js']?.signed).toBeUndefined()
    expect(await textOf(home, record.files['app/added.js']!.version)).toBe('added\n')
    expect((await readVersion(home, record.files[BIN]!.version)).entries).toEqual([])
    expect(await textOf(home, record.files[BIN]!.signed!)).toBe(SIGNED_FILES[BIN])
    expect(existsSync(inCopy({ home, runtime: TARGET }, BIN))).toBe(false)
  })

  it('records nothing for a file whose approved content is the signed file, when the release changed it', async () => {
    const { ctx, home } = harnessFixture()
    const signedVersion = await storeFileVersion(home, START_FILE, Buffer.from(SIGNED_FILES[START_FILE]!), false)
    await withHarnessLock(home, async () => writeHarnessRecord(home, { schema: HARNESS_RECORD_SCHEMA, runtime: RUNTIME, files: { [START_FILE]: { version: signedVersion, signed: signedVersion, change: 'c0123456789' as ChangeId, approvedAt: AT.toISOString() } } }))

    const { carried } = await carry(ctx, installTarget(home, { [START_FILE]: 'export const start = 3\n' }))

    expect(carried.carried).toEqual([])
    expect(existsSync(harnessRuntimeDirectory(home, TARGET))).toBe(false)
  })

  it('carries what the running runtime runs: a change a failed start left out stays out', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    const profileDir = join(home, 'profiles', 'p')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"p","dependencies":{}}\n')
    await leaveOutNewestChange({ home, profile: 'p', profileDir }, 'SyntaxError', RUNTIME)

    const { carried } = await carry(ctx, installTarget(home))

    expect(carried.carried).toEqual([])
    expect(await composition(home, TARGET)).toBeUndefined()
  })
})

describe('c03-harness-conflict-keeps-mine: a conflicted file never silently keeps either side', () => {
  it('runs the release\'s file and keeps the person\'s content beside it as <file>.mine in the target\'s copy', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, MANIFEST, '{"name":"mine"}\n')
    const signed = installTarget(home, { [MANIFEST]: '{"name":"closure","version":2}\n' })

    const { carried } = await carry(ctx, signed)

    expect(carried).toEqual({ carried: [], keptBeside: [`${MANIFEST}.mine`], removedReturned: [], copy: true })
    expect(await readHarnessRecord(home, TARGET)).toMatchObject({ files: {} })
    expect(readFileSync(inCopy({ home, runtime: TARGET }, `${MANIFEST}.mine`), 'utf8')).toBe('{"name":"mine"}\n')
    expect(readFileSync(inCopy({ home, runtime: TARGET }, MANIFEST), 'utf8')).toBe('{"name":"closure","version":2}\n')
    const target = await harnessChanges({ home, runtime: TARGET, signed: async () => Promise.resolve(signed) })
    expect(target.changes).toEqual([])
    expect(target.keptBeside).toEqual([`${MANIFEST}.mine`])
  })

  it('names a file the person removed and the release changed, which runs again with nothing to keep', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, BIN, undefined)

    const { carried } = await carry(ctx, installTarget(home, { [BIN]: 'import "./start.js"\nimport "./more.js"\n' }))

    expect(carried).toEqual({ carried: [], keptBeside: [], removedReturned: [BIN], copy: true })
    expect(existsSync(inCopy({ home, runtime: TARGET }, `${BIN}.mine`))).toBe(false)
  })

  it('creates the target\'s copy for a conflict even when the running runtime has none', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, MANIFEST, '{"name":"mine"}\n')
    rmSync(harnessCopyDirectory(home, RUNTIME), { recursive: true })

    const { carried } = await carry(ctx, installTarget(home, { [MANIFEST]: '{"name":"closure","version":2}\n' }))

    expect(carried.copy).toBe(true)
    expect(readFileSync(inCopy({ home, runtime: TARGET }, `${MANIFEST}.mine`), 'utf8')).toBe('{"name":"mine"}\n')
  })
})

describe('what an update leaves', () => {
  it('refuses while a change waits for review, before it writes or switches', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    writeFileSync(inCopy(ctx, MANIFEST), '{"name":"waiting"}\n')
    let switched = false

    const error = await rejection(carryHarness({ from: ctx, to: TARGET, signed: async () => Promise.resolve(installTarget(home)), confirm: () => {} }, async () => { switched = true }), 'HARNESS_CHANGES_PENDING')

    expect(error.detail).toContain(MANIFEST)
    expect(switched).toBe(false)
    expect(existsSync(harnessRuntimeDirectory(home, TARGET))).toBe(false)
  })

  it('has the caller compare the plan made under the lock, and writes nothing and does not switch when it refuses', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    const log = await readHarnessLog(home)
    const plans: HarnessCarryPlan[] = []
    let switched = false

    await expect(carry(ctx, installTarget(home, { [MANIFEST]: '{"name":"closure","version":2}\n' }), async () => { switched = true }, (plan) => {
      plans.push(plan)
      throw new Error('the plan differs')
    })).rejects.toThrow('the plan differs')

    expect(plans.map(plan => plan.entries.map(entry => [entry.file, entry.merge.outcome]))).toEqual([[[START_FILE, 'carried']]])
    expect(switched).toBe(false)
    expect(existsSync(harnessRuntimeDirectory(home, TARGET))).toBe(false)
    expect(await readHarnessLog(home)).toEqual(log)
  })

  it('has the caller compare an empty plan when the running runtime runs no approved file', async () => {
    const { ctx, home } = harnessFixture()
    const plans: HarnessCarryPlan[] = []

    await carry(ctx, installTarget(home), undefined, (plan) => { plans.push(plan) })

    expect(plans).toEqual([{ from: RUNTIME, entries: [] }])
  })

  it('replaces what an earlier install left for the target, never merging into it', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    writeFiles(harnessRuntimeDirectory(home, TARGET), { 'copy/app/stale.js': 'stale\n', 'approved.json': 'not a record\n' })

    await carry(ctx, installTarget(home))

    expect(existsSync(inCopy({ home, runtime: TARGET }, 'app/stale.js'))).toBe(false)
    expect(Object.keys((await readHarnessRecord(home, TARGET)).files)).toEqual([START_FILE])
  })

  it('removes what it wrote for the target and logs nothing when it fails before the switch', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    const signed = installTarget(home)
    const log = await readHarnessLog(home)
    // A target file that no longer matches its signed list fails the target's copy, after its record was written.
    const altered = join(signed.directory, ...MANIFEST.split('/'))
    chmodSync(altered, 0o644)
    writeFileSync(altered, 'altered\n')
    let switched = false

    await rejection(carryHarness({ from: ctx, to: TARGET, signed: async () => Promise.resolve(signed), confirm: () => {} }, async () => { switched = true }), 'RUNTIME_CHANGED')

    expect(switched).toBe(false)
    expect(existsSync(harnessRuntimeDirectory(home, TARGET))).toBe(false)
    expect(await readHarnessLog(home)).toEqual(log)
  })

  it('leaves the target\'s files in place when the switch itself fails', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')

    await expect(carry(ctx, installTarget(home), async () => Promise.reject(new Error('the switch failed')))).rejects.toThrow('the switch failed')

    expect(Object.keys((await readHarnessRecord(home, TARGET)).files)).toEqual([START_FILE])
  })

  it('leaves the running runtime\'s record, copy and log entries as they were, so a rollback runs them again', async () => {
    const { ctx, home } = harnessFixture()
    await approve(ctx, START_FILE, 'export const start = 2\n')
    await approve(ctx, MANIFEST, '{"name":"mine"}\n')
    const record = await readHarnessRecord(home, RUNTIME)
    const entries = (await readHarnessLog(home)).entries
    const copy = snapshotOf(harnessCopyDirectory(home, RUNTIME))
    const composed = await composition(home, RUNTIME)

    await carry(ctx, installTarget(home, { [MANIFEST]: '{"name":"closure","version":2}\n' }))

    expect(await readHarnessRecord(home, RUNTIME)).toEqual(record)
    expect((await readHarnessLog(home)).entries.filter(entry => entry.subject.runtime === RUNTIME)).toEqual(entries)
    expect(snapshotOf(harnessCopyDirectory(home, RUNTIME))).toEqual(copy)
    expect(await composition(home, RUNTIME)).toEqual(composed)
  })

  it('refuses to carry a runtime\'s changes to itself', async () => {
    const { ctx } = harnessFixture()
    await rejection(carryHarness({ from: ctx, to: RUNTIME, signed: ctx.signed, confirm: () => {} }, async () => Promise.resolve()), 'INVALID_REQUEST')
  })
})
