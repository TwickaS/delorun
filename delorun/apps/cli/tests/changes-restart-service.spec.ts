/**
 * The home process gives the Host it boots its restart as `changesRestart`, and a failed restart leaves out the
 * runtime's newest applied harness change only when the Host that keeps running does not run it.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { applyHarnessChange, attestTerminal, createHarnessCopy, harnessChanges, harnessCopyDirectory, readHarnessLog, type ChangesRestartHost, type HarnessContext, type SignedFile } from '@delorun/changes'
import { ensureHomeTree } from '@delorun/home'
import type { RestartControl } from '@delorun/home-process'
import { describe, expect, it, onTestFinished } from 'vitest'
import { provideChangesRestart, restartSupport } from '../src/changes/restart-service.ts'

const RUNTIME = '1.2.3'
const START_FILE = 'app/node_modules/@delorun/cli/src/start.js'
const FAILURE = 'H2-host-ready: the new Host did not answer'

/**
 * @param root - a root context.
 * @returns its `changesRestart` service, if provided.
 */
function serviceOf(root: Context): ChangesRestartHost | undefined {
  return (root as Context & { get(name: 'changesRestart'): ChangesRestartHost | undefined }).get('changesRestart')
}

/**
 * A home with runtime {@link RUNTIME} installed and the start file changed and applied.
 * @returns the home and the applied change's id and content version.
 */
async function appliedChange(): Promise<{ readonly home: string, readonly id: string, readonly to: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-restart-service-')))
  onTestFinished(() => { rmSync(base, { recursive: true, force: true }) })
  const home = join(base, '.delorun')
  mkdirSync(home, { mode: 0o700 })
  await ensureHomeTree(home, 'default')
  const directory = join(home, 'runtimes', RUNTIME)
  const files: SignedFile[] = []
  for (const [path, text] of Object.entries({ 'app/package.json': '{}\n', [START_FILE]: 'export const start = 1\n' })) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
    files.push({ path, length: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), executable: false })
  }
  const harness: HarnessContext = { home, runtime: RUNTIME, signed: () => Promise.resolve({ directory, files }) }
  const terminal = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
  await createHarnessCopy(harness, terminal)
  writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'export const start = 2\n')
  const id = (await harnessChanges(harness)).changes[0]!.id
  await applyHarnessChange(harness, id, terminal)
  const entry = (await readHarnessLog(home)).entries.find(candidate => candidate.id === id)!
  return { home, id, to: entry.to! }
}

describe('the changesRestart service', () => {
  it('gives the home process\'s restart with what the Host booted with, or none outside the runtime store', async () => {
    const calls: string[] = []
    const control: RestartControl = {
      view: () => ({ kind: 'idle' }),
      runningChats: () => 3,
      begin: (request) => {
        calls.push(`begin ${String(request.stopChats)} ${String(request.drainTimeoutS)}`)
        return Promise.resolve({ runningChats: 3, done: new Promise(() => {}) })
      },
      cancel: () => Promise.resolve(true),
      clearFailure: () => { calls.push('clear') },
    }
    const root = new Context()
    provideChangesRestart(root, control, { kind: 'unknown' })
    const service = serviceOf(root)!
    expect(service.running).toEqual({ kind: 'unknown' })
    expect(service.view()).toEqual({ kind: 'idle' })
    expect(service.runningChats()).toBe(3)
    expect(await service.begin({ stopChats: true, drainTimeoutS: 60 })).toEqual({ runningChats: 3 })
    expect(await service.cancel()).toBe(true)
    service.clearFailure()
    expect(calls).toEqual(['begin true 60', 'clear'])
    const source = new Context()
    provideChangesRestart(source, undefined, { kind: 'unknown' })
    expect(serviceOf(source)).toBeUndefined()
  })
})

describe('the leave-out after a failed restart', () => {
  it('leaves the newest applied change out when the running Host does not run it', async () => {
    for (const running of [{ kind: 'known', files: {} }, { kind: 'unknown' }] as const) {
      const { home, id } = await appliedChange()
      expect(await restartSupport(home, RUNTIME, { current: running }).leaveOut(FAILURE)).toEqual({ id, file: START_FILE })
      expect((await readHarnessLog(home)).entries.find(entry => entry.id === id)).toMatchObject({ state: 'left-out-at-start' })
    }
  })

  it('leaves nothing out when the running Host runs that change, or when none is applied', async () => {
    const { home, id, to } = await appliedChange()
    const before = await readHarnessLog(home)
    expect(await restartSupport(home, RUNTIME, { current: { kind: 'known', files: { [START_FILE]: to as never } } }).leaveOut(FAILURE)).toBeUndefined()
    expect(await readHarnessLog(home)).toEqual(before)
    expect(before.entries.find(entry => entry.id === id)).toMatchObject({ state: 'applied' })
    const other = await appliedChange()
    await restartSupport(other.home, RUNTIME, { current: { kind: 'known', files: {} } }).leaveOut(FAILURE)
    // Its one applied change is now left out, so nothing applied remains to leave out.
    expect(await restartSupport(other.home, RUNTIME, { current: { kind: 'known', files: {} } }).leaveOut(FAILURE)).toBeUndefined()
  })
})
