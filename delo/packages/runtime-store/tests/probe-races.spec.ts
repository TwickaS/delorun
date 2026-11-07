/**
 * Review probes (not part of the package): concurrency — two switches racing for one `from`, a switch against a
 * held lock, and a launch prepared while `store.lock` is held by a live process. The holder announces the lock with
 * a marker file, because a child's stdout pipe can deliver its line after it has released.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SUPPORTED } from '../src/index.ts'
import { fixtureHome, REPOSITORY, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')
const CHILD = ['--import', 'tsx/esm', 'delo/packages/runtime-store/tests/fixtures/race-child.ts']

let fixture: FixtureHome

beforeEach(async () => {
  fixture = fixtureHome()
  await fixture.install(V1)
  await fixture.install(V2)
})

afterEach(() => {
  fixture.remove()
})

function child(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [...CHILD, ...args], { cwd: REPOSITORY, encoding: 'utf8', timeout: 45_000 })
}

/** Wait until the holder's marker file names the lock as held. */
async function held(): Promise<void> {
  const marker = join(fixture.home, 'lock-held.marker')
  for (let waited = 0; waited < 20_000 && !existsSync(marker); waited += 20) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(existsSync(marker)).toBe(true)
}

describe('probe: concurrency', () => {
  it('two switches racing from the same version: one switches, the other refuses with POINTER_CHANGED', async () => {
    const first = child(['switch', fixture.home, '0.1.0', '0.2.0'])
    const second = child(['switch', fixture.home, '0.1.0', '0.2.0'])
    const outcomes = [first, second].map(result => String(result.stdout).trim())
    expect(outcomes).toContain('refused POINTER_CHANGED')
    expect(outcomes.filter(text => text.startsWith('switched'))).toHaveLength(1)
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
  })

  it('a switch waits for a held store.lock and then commits', async () => {
    const holder = spawn(process.execPath, [...CHILD, 'lockhold', fixture.home, '2500'], { cwd: REPOSITORY, stdio: ['ignore', 'pipe', 'pipe'] })
    await held()
    const started = Date.now()
    expect(String(child(['switch', fixture.home, '0.1.0', '0.2.0']).stdout).trim()).toContain('switched')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
    holder.kill('SIGKILL')
  })

  it('prepareLaunch runs without the lock, while a live process holds store.lock mid-switch', async () => {
    const holder = spawn(process.execPath, [...CHILD, 'lockhold', fixture.home, '2500'], { cwd: REPOSITORY, stdio: ['ignore', 'pipe', 'pipe'] })
    await held()
    const started = Date.now()
    // current is still whole, so the lock-free launch check succeeds even though a writer holds the lock
    await expect(fixture.store.prepareLaunch({ launcher: SUPPORTED, root: fixture.root, mode: 'warn', profile: 'default', args: [] })).resolves.toMatchObject({ version: V1 })
    expect(Date.now() - started).toBeLessThan(2_000)
    holder.kill('SIGKILL')
  })
})
