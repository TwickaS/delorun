/**
 * The CLI home's harness carry (`delo/apps/cli/src/update/harness-carry.ts`) over a real runtime store with two signed
 * releases: both runtimes read through the store's start check, a change waiting for review refused with C19's
 * `HARNESS_CHANGES_PENDING` at prepare and before the switch, a copy that cannot be scanned refused with
 * `HARNESS_COPY_UNREADABLE`, a merge that differs from the confirmed report refused with `HARNESS_REPORT_STALE`, and the
 * target's record written before the switch runs.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyHarnessChange, attestTerminal, ChangesError, createHarnessCopy, harnessChanges, harnessCopyDirectory, harnessRuntimeDirectory, readHarnessRecord, type HarnessContext } from '@delo/changes'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import { UPDATE_REPORT_SCHEMA, type ReportVersions, type UpdateReport } from '@delo/contract-update-report'
import { ensureHomeTree } from '@delo/home'
import { HomeProcessError } from '@delo/home-process'
import { RuntimeStore } from '@delo/runtime-store'
import { outputLogger, quietOutput } from '../../src/changes/harness-start.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { harnessItems, type HarnessFact } from '@delo/update'
import { confirmedPlan, scanFailure, storeHarnessCarry } from '../../src/update/harness-carry.ts'
import { readHarnessFacts } from '../../src/update/harness-items.ts'
import { signedRuntimeOf } from '../../src/update/signed-runtime.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const FROM = v('1.0.0')
const TO = v('1.1.0')
const FILE = 'app/node_modules/@delo/cli/package.json'
const TERMINAL = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })

let base: string
let home: string
let store: RuntimeStore
let root: ReturnType<typeof throwawayRoot>

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dhc-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
  root = throwawayRoot()
  store = new RuntimeStore({ home, platform, logger: outputLogger(quietOutput()) })
  for (const version of ['1.0.0', '1.1.0']) {
    const files = fakeClosure(version, { healthy: true, persistence: 'a'.repeat(64) })
    await store.install({ version: v(version), root: root.metadata, fill: async (directory) => {
      writeClosure(directory, files)
      return Promise.resolve(signedRelease(root.keys.targets, platform, version, files))
    } })
  }
})

afterAll(() => {
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

/** @returns the running runtime's harness, read through the store's start check. */
function running(): HarnessContext {
  return { home, runtime: FROM, signed: async () => signedRuntimeOf(store.paths.version(FROM), await store.checkRuntime(FROM, root.metadata)) }
}

const carry = (): ReturnType<typeof storeHarnessCarry> => storeHarnessCarry({ home, store, root: async () => Promise.resolve(root.metadata), now: () => new Date('2026-11-11T12:00:00.000Z') })

/**
 * @param version - a Delo version.
 * @returns the report's versions of it.
 */
const versions = (version: string): ReportVersions => ({ delo: brandString<SemanticVersion>(version), dsh: brandString<SemanticVersion>('0.2.2'), channel: 'stable' })

/**
 * A report whose items are harness facts' alone, as `update.prepare` builds it.
 * @param facts - the facts.
 * @returns the report.
 */
function reportOf(facts: readonly HarnessFact[]): UpdateReport {
  const items = harnessItems(facts)
  return {
    schema: UPDATE_REPORT_SCHEMA,
    installation: 'cli-home',
    from: versions(FROM),
    to: versions(TO),
    release: { manifest: brandString<Sha256Hex>('c'.repeat(64)), signature: 'passed', freshness: 'passed', log: 'passed' },
    generated: brandString<UtcTimestamp>('2026-11-11T12:00:00.000Z'),
    installations: [],
    items,
    notChecked: [],
    counts: { disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: items.length },
  }
}

/** @returns the report `update.prepare` builds now for the update from FROM to TO. */
async function prepared(): Promise<UpdateReport> {
  return reportOf(await readHarnessFacts(home, FROM, async () => signedRuntimeOf(store.paths.version(TO), await store.checkRuntime(TO, root.metadata))))
}

describe('the CLI home\'s harness carry', () => {
  it('refuses at prepare and before the switch while a change waits for review, with C19\'s code and the file', async () => {
    await createHarnessCopy(running(), TERMINAL)
    writeFileSync(join(harnessCopyDirectory(home, FROM), ...FILE.split('/')), '{"name":"@delo/cli","type":"module","edited":true}\n')
    let switched = false

    const checked = await carry().check(FROM).catch((error: unknown) => error)
    const carried = await carry().carry(FROM, TO, reportOf([]), async () => { switched = true }).catch((error: unknown) => error)

    for (const failure of [checked, carried]) {
      expect(failure).toBeInstanceOf(HomeProcessError)
      expect(failure).toMatchObject({ code: 'HARNESS_CHANGES_PENDING' })
      expect((failure as HomeProcessError).detail).toContain(FILE)
    }
    expect(switched).toBe(false)
  })

  it('c03-harness-report-stale: refuses before it writes or switches when the merge differs from the report the person confirmed', async () => {
    const before = await prepared()
    await applyHarnessChange(running(), (await harnessChanges(running())).changes[0]!.id, TERMINAL)
    const now = await prepared()
    const [item] = now.items
    const otherResult = { ...now, items: now.items.map(confirmed => ({ ...confirmed, detail: { ...confirmed.detail, result: { sha256: brandString<Sha256Hex>('0'.repeat(64)), executable: false } } })) }
    const otherMerge = reportOf([{ file: FILE, merge: 'in-release' }])
    let switched = false

    for (const stale of [before, otherResult, otherMerge, reportOf([{ file: FILE, merge: 'release-unchanged' }, { file: 'app/other.js', merge: 'release-unchanged' }])]) {
      const failure = await carry().carry(FROM, TO, stale, async () => { switched = true }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(HomeProcessError)
      expect(failure).toMatchObject({ code: 'HARNESS_REPORT_STALE' })
      expect((failure as HomeProcessError).detail).toContain(FILE)
      expect((failure as HomeProcessError).detail).toContain('delorun update')
    }
    expect(item).toMatchObject({ reason: 'harness-change-carried', detail: { merge: 'release-unchanged', result: { executable: false } } })
    expect(switched).toBe(false)
    expect(existsSync(harnessRuntimeDirectory(home, TO))).toBe(false)
  })

  it('writes the target\'s record from both runtimes\' verified files, then runs the switch, and passes the switch\'s own failure on', async () => {
    await carry().check(FROM)
    let switched = false

    await carry().carry(FROM, TO, await prepared(), async () => { switched = true })

    expect(switched).toBe(true)
    expect(Object.keys((await readHarnessRecord(home, TO)).files)).toEqual([FILE])
    await expect(carry().carry(FROM, TO, await prepared(), async () => Promise.reject(new Error('the switch failed')))).rejects.toThrow('the switch failed')
  })

  it('refuses at prepare and before the switch when the copy cannot be scanned, naming what failed and the commands that clear it', async () => {
    const directory = join(harnessCopyDirectory(home, FROM), 'app', 'node_modules', '@delo', 'cli')
    chmodSync(directory, 0o000)
    let switched = false
    try {
      const checked = await carry().check(FROM).catch((error: unknown) => error)
      const carried = await carry().carry(FROM, TO, await prepared(), async () => { switched = true }).catch((error: unknown) => error)

      for (const failure of [checked, carried]) {
        expect(failure).toBeInstanceOf(HomeProcessError)
        expect(failure).toMatchObject({ code: 'HARNESS_COPY_UNREADABLE' })
        // The copy's scan names the failure and the entry; its words are kept.
        expect((failure as HomeProcessError).detail).toContain('EACCES')
        expect((failure as HomeProcessError).detail).toContain(directory)
        expect((failure as HomeProcessError).detail).toContain('delorun changes edit-harness --discard')
      }
    } finally {
      chmodSync(directory, 0o755)
    }
    expect(switched).toBe(false)
  })
})

describe('scanFailure', () => {
  const copy = '/home/x/changes/harness/1.0.0/copy'
  const errno = (path: string): Error => Object.assign(new Error('denied'), { code: 'EACCES', path })

  it('reads a scan over its limits, a file that changed while read and a filesystem error in the copy as a failed scan', () => {
    expect(scanFailure(new ChangesError('CONTENT_TOO_LARGE', copy, 'the copy holds too much'), copy)).toBe('the copy holds too much')
    expect(scanFailure(new ChangesError('CHANGED_WHILE_READING', `${copy}/app/a.js`, 'app/a.js grew while it was read'), copy)).toBe('app/a.js grew while it was read')
    expect(scanFailure(errno(copy), copy)).toBe(`EACCES at ${copy}`)
    expect(scanFailure(errno(`${copy}/app`), copy)).toBe(`EACCES at ${copy}/app`)
  })

  it('leaves every other error to its own report', () => {
    expect(scanFailure(new ChangesError('STORE_CORRUPT', copy, 'missing'), copy)).toBeUndefined()
    expect(scanFailure(errno(`${copy}-other`), copy)).toBeUndefined()
    expect(scanFailure(errno('/home/x/runtimes/1.1.0'), copy)).toBeUndefined()
    expect(scanFailure(Object.assign(new Error('no path'), { code: 'EACCES' }), copy)).toBeUndefined()
    expect(scanFailure(Object.assign(new Error('no code'), { path: copy }), copy)).toBeUndefined()
    expect(scanFailure(Object.assign(new Error('odd fields'), { path: 5, code: 'EACCES' }), copy)).toBeUndefined()
    expect(scanFailure(Object.assign(new Error('odd fields'), { path: copy, code: 5 }), copy)).toBeUndefined()
    expect(scanFailure('a string', copy)).toBeUndefined()
  })
})

describe('confirmedPlan', () => {
  it('reads only the report\'s harness items that name a merge, so one without a merge is never taken as confirmed', () => {
    const report = reportOf([{ file: FILE, merge: 'release-unchanged' }])
    const withoutMerge = { ...report, items: [{ ...report.items[0]!, detail: {} }, { kind: 'data' as const, subject: { directories: ['sessions' as const] }, reason: 'data-format-changed' as const, effect: 'changed' as const, verification: 'verified' as const, detail: {}, actions: [] }] }

    expect(() => { confirmedPlan(withoutMerge)({ from: FROM, entries: [] }) }).not.toThrow()
  })
})
