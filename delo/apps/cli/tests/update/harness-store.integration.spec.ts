/**
 * The harness of a runtime the store installed from a signed release (contract C21, "Harness edits"): the signed file
 * list `delorun changes` and a start read through the store's start check under the root the launcher anchors, the
 * running runtime's check of its composed tree, the hand-off's own dependencies, and what `doctor` reads of it.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyHarnessChange, attestTerminal, createHarnessCopy, harnessChanges, harnessCopyDirectory, prepareComposedTree } from '@delo/changes'
import { DELO_HOME_ENTRIES, DELO_LAUNCHER_ROOTS_ENV, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStore } from '@delo/runtime-store'
import { runningHarness } from '../../src/changes/command.ts'
import { checkRunningRuntime, harnessContextOf, outputLogger, processHandOff, quietOutput, verifiedSignedRuntime } from '../../src/changes/harness-start.ts'
import { checkChanges, runningHarnessStatus } from '../../src/doctor/changes.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { runtimeOfFile } from '../../src/update/runtime.ts'
import { launcherAnchor } from '../../src/update/trusted-root.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const VERSION = brandString<RuntimeVersion>('1.0.0')
const SILENT: DeloLogger = outputLogger(quietOutput())
const FILE = 'app/node_modules/@delo/cli/package.json'

let base: string
let home: string
let launched: Record<string, string>

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dhs-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
  const root = throwawayRoot()
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
  mkdirSync(join(base, 'roots'))
  writeFileSync(join(base, 'roots', '1.root.json'), root.bytes)
  launched = { [DELO_LAUNCHER_ROOTS_ENV]: join(base, 'roots') }
  const files = fakeClosure('1.0.0', { healthy: true, persistence: 'a'.repeat(64) })
  await new RuntimeStore({ home, platform, logger: SILENT }).install({ version: VERSION, root: root.metadata, fill: async (directory) => {
    writeClosure(directory, files)
    return Promise.resolve(signedRelease(root.keys.targets, platform, '1.0.0', files))
  } })
})

afterAll(() => {
  // Installed runtimes and composed trees are read-only; the owner's write permission comes back before removal.
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

/** The store's runtime as a process running from `runtimes/1.0.0/` sees it. */
function stored(): ReturnType<typeof runtimeOfFile> {
  return runtimeOfFile(home, join(home, DELO_HOME_ENTRIES.runtimes, VERSION, 'app', 'node_modules', '@delo', 'cli', 'src', 'bin.js'))
}

describe('the harness of an installed runtime', () => {
  it('reads the signed file list through the store\'s start check, once per command, and refuses a root the launcher does not anchor', async () => {
    const signed = await verifiedSignedRuntime(home, VERSION, launched, SILENT)
    expect(signed.directory).toBe(join(home, DELO_HOME_ENTRIES.runtimes, VERSION))
    expect(signed.files.find(file => file.path === 'node/bin/node')?.executable).toBe(true)
    expect(signed.files.find(file => file.path === FILE)?.executable).toBe(false)
    let reads = 0
    const ctx = harnessContextOf(home, stored(), launched, SILENT, (...args) => {
      reads += 1
      return verifiedSignedRuntime(...args)
    })!
    await ctx.signed()
    await ctx.signed()
    expect(reads).toBe(1)
    expect(harnessContextOf(home, runtimeOfFile(home, join(base, 'checkout', 'bin.js')), launched, SILENT)).toBeUndefined()
    await expect(verifiedSignedRuntime(home, VERSION, {}, SILENT)).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED' })
    const printed: string[] = []
    expect(runningHarness(home, { env: launched, stdout: () => {}, stderr: text => void printed.push(text) }, stored())?.runtime).toBe(VERSION)
  })

  it('the running runtime\'s check passes the installation and its composed tree, and refuses a tree that differs', async () => {
    await checkRunningRuntime(home, VERSION, SILENT, launcherAnchor(home, launched).root)
    const ctx = harnessContextOf(home, stored(), launched, SILENT)!
    const terminal = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
    await createHarnessCopy(ctx, terminal)
    writeFileSync(join(harnessCopyDirectory(home, VERSION), ...FILE.split('/')), '{"name":"@delo/cli","type":"module","edited":true}\n')
    await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal)
    const tree = (await prepareComposedTree(home, VERSION, await ctx.signed()))!.directory
    await checkRunningRuntime(home, VERSION, SILENT, launcherAnchor(home, launched).root, tree)
    expect((await runningHarnessStatus(home, launched, stored()))?.tree).toEqual({ kind: 'passed', directory: tree })
    expect((await runningHarnessStatus(home, {}, stored()))?.tree).toEqual({ kind: 'not-checked', directory: tree })
    expect(await runningHarnessStatus(home, launched)).toBeUndefined()
    expect((await checkChanges({ DELO_HOME: home }, 'default', () => runningHarnessStatus(home, launched, stored()))).map(result => result.status)).toContain('pass')
    chmodSync(join(tree, 'app'), 0o755)
    writeFileSync(join(tree, 'app', 'extra.js'), 'extra\n')
    await expect(checkRunningRuntime(home, VERSION, SILENT, launcherAnchor(home, launched).root, tree)).rejects.toMatchObject({ code: 'HARNESS_CHANGED' })
    rmSync(join(tree, 'app', 'extra.js'))
  })

  it('a start\'s own hand-off dependencies read this process and the home', async () => {
    const printed: string[] = []
    const dependencies = processHandOff(stored(), { stdout: () => {}, stderr: text => void printed.push(text) })
    expect(dependencies.args).toEqual(process.argv.slice(2))
    expect(typeof dependencies.handover()).toBe('boolean')
    expect(dependencies.homeProcessRuns(home)).toBe(false)
    expect((await dependencies.signed(home, VERSION, launched)).directory).toBe(join(home, DELO_HOME_ENTRIES.runtimes, VERSION))
    const logger = outputLogger({ stderr: text => void printed.push(text) })
    logger.warn('w')
    logger.error('e')
    logger.info('i')
    logger.debug('d')
    quietOutput().stdout('nothing')
    expect(printed).toEqual(['w\n', 'e\n'])
  })
})
