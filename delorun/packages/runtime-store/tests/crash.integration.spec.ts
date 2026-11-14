import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { readPointerFile, type PointerStepKind } from '../src/pointer.ts'
import { fixtureHome, REPOSITORY, version, type FixtureHome } from './support.ts'

const CHILD = join(import.meta.dirname, 'fixtures/switch-child.ts')
const V1 = version('0.1.0')
const V2 = version('0.2.0')
const STEPS: readonly PointerStepKind[] = ['create', 'write', 'sync', 'rename', 'sync-directory']

let fixture: FixtureHome

beforeEach(async () => {
  fixture = fixtureHome()
  await fixture.install(V1)
  await fixture.install(V2)
})

afterEach(() => {
  fixture.remove()
})

/**
 * Require the store to name a whole, installed version as `current`, and to hold well-formed pointers.
 * @param versions - the versions `current` may name.
 * @returns the version `current` names.
 */
async function requireWhole(versions: readonly RuntimeVersion[]): Promise<RuntimeVersion> {
  const { current, previous } = await fixture.store.pointers()
  expect(versions).toContain(current)
  if (previous !== undefined) expect(versions).toContain(previous)
  expect(await readPointerFile(join(fixture.home, 'runtimes/previous'))).not.toBe('malformed')
  await expect(fixture.store.checkRuntime(current, fixture.root)).resolves.toMatchObject({ version: current })
  return current
}

// Each case spawns a Node child through tsx and hashes the installation, so the suite's tests get the
// process-spawning budget the home process's specs use.
describe('a switch killed mid-way', { timeout: 90_000 }, () => {
  const cases = [
    ...STEPS.map(step => ({ pointer: 'previous', step, current: V1 })),
    ...STEPS.map(step => ({ pointer: 'current', step, current: step === 'sync-directory' ? V2 : V1 })),
    { pointer: 'none', step: 'none', current: V2 },
  ]

  it.each(cases)('before $pointer $step leaves current naming the whole version $current', async ({ pointer, step, current }) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', CHILD, 'step', fixture.home, pointer, step, V1, V2], { cwd: REPOSITORY, encoding: 'utf8', timeout: 50_000 })
    if (pointer === 'none') expect(child.status, child.stderr).toBe(0)
    else expect(child.signal, child.stderr).toBe('SIGKILL')
    expect(await requireWhole([V1, V2])).toBe(current)
    await fixture.store.switchTo(current, current === V1 ? V2 : V1)
    await requireWhole([V1, V2])
    await fixture.store.retain()
    expect(readdirSync(join(fixture.home, 'runtimes')).filter(name => name.includes('.tmp-') || name.includes('store.lock'))).toEqual([])
  })

  it('at random moments of repeated switches always leaves a whole version current', async () => {
    for (let round = 0; round < 12; round += 1) {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', CHILD, 'loop', fixture.home, V1, V2], { cwd: REPOSITORY, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.on('exit', (_code, signal) => { resolve(signal) }) })
      const lines = createInterface({ input: child.stdout })
      await new Promise<void>((resolve, reject) => {
        lines.once('line', () => { resolve() })
        child.once('exit', () => { reject(new Error(`the switching child exited before it switched: ${stderr}`)) })
      })
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 40)))
      child.kill('SIGKILL')
      expect(await exited).toBe('SIGKILL')
      await requireWhole([V1, V2])
    }
  })
})
