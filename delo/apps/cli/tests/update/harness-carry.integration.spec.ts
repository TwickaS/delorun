/**
 * The CLI home's harness carry (`delo/apps/cli/src/update/harness-carry.ts`) over a real runtime store with two signed
 * releases: both runtimes read through the store's start check, a change waiting for review refused with C19's
 * `HARNESS_CHANGES_PENDING` at prepare and before the switch, and the target's record written before the switch runs.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyHarnessChange, attestTerminal, createHarnessCopy, harnessChanges, harnessCopyDirectory, readHarnessRecord, type HarnessContext } from '@delo/changes'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { HomeProcessError } from '@delo/home-process'
import { RuntimeStore } from '@delo/runtime-store'
import { outputLogger, quietOutput } from '../../src/changes/harness-start.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { storeHarnessCarry } from '../../src/update/harness-carry.ts'
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

describe('the CLI home\'s harness carry', () => {
  it('refuses at prepare and before the switch while a change waits for review, with C19\'s code and the file', async () => {
    await createHarnessCopy(running(), TERMINAL)
    writeFileSync(join(harnessCopyDirectory(home, FROM), ...FILE.split('/')), '{"name":"@delo/cli","type":"module","edited":true}\n')
    let switched = false

    const checked = await carry().check(FROM).catch((error: unknown) => error)
    const carried = await carry().carry(FROM, TO, async () => { switched = true }).catch((error: unknown) => error)

    for (const failure of [checked, carried]) {
      expect(failure).toBeInstanceOf(HomeProcessError)
      expect(failure).toMatchObject({ code: 'HARNESS_CHANGES_PENDING' })
      expect((failure as HomeProcessError).detail).toContain(FILE)
    }
    expect(switched).toBe(false)
  })

  it('writes the target\'s record from both runtimes\' verified files, then runs the switch, and passes the switch\'s own failure on', async () => {
    await applyHarnessChange(running(), (await harnessChanges(running())).changes[0]!.id, TERMINAL)
    await carry().check(FROM)
    let switched = false

    await carry().carry(FROM, TO, async () => { switched = true })

    expect(switched).toBe(true)
    expect(Object.keys((await readHarnessRecord(home, TO)).files)).toEqual([FILE])
    await expect(carry().carry(FROM, TO, async () => Promise.reject(new Error('the switch failed')))).rejects.toThrow('the switch failed')
  })
})
