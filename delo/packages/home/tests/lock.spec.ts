import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delo/contract-home-layout'
import { acquireHomeLock, newStartId, HomeLayoutError, readHomeLock, removeStaleLock, type HolderProbe } from '../src/index.ts'

const REPOSITORY = join(import.meta.dirname, '../../../..')
const CONTENDER = join(import.meta.dirname, 'fixtures/lock-contender.ts')
const RUNTIME = brandString<RuntimeVersion>('1.2.3')
const answered: HolderProbe = () => Promise.resolve('answered')

let runDirectory: string

beforeEach(() => {
  runDirectory = join(mkdtempSync(join(tmpdir(), 'delorun-lock-')), 'run', 'default')
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
})

afterEach(() => {
  rmSync(join(runDirectory, '..', '..'), { recursive: true, force: true })
})

/**
 * The process id of a process that has exited.
 * @returns the pid.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

/**
 * Write a lock record as another holder would.
 * @param pid - the holder's process id.
 * @param startId - its start id.
 */
function plantLock(pid: number, startId = 'a'.repeat(32)): void {
  writeFileSync(join(runDirectory, 'home.lock'), JSON.stringify({ v: 1, pid, startId, runtime: '1.0.0', startedAt: '2026-01-01T00:00:00.000Z' }), { mode: 0o600 })
}

/** One contender's report. */
interface Outcome {
  readonly outcome: string
  readonly startId?: string
  readonly pid?: number
}

/**
 * Start contenders, release them at once when every one is ready, and collect each one's report.
 * @param count - how many.
 * @returns the children and their reports.
 */
async function race(count: number): Promise<{ children: ChildProcess[], outcomes: Outcome[] }> {
  const children = Array.from({ length: count }, () => spawn(process.execPath, ['--import', 'tsx/esm', CONTENDER, runDirectory], { cwd: REPOSITORY, stdio: ['pipe', 'pipe', 'inherit'] }))
  const lines = children.map(child => createInterface({ input: child.stdout! }))
  // Every contender has loaded its modules and waits; then all are released together.
  await Promise.all(lines.map(line => new Promise<void>((resolve) => { line.once('line', () => { resolve() }) })))
  const outcomes = Promise.all(lines.map(line => new Promise<Outcome>((resolve) => {
    line.once('line', text => { resolve(JSON.parse(text) as Outcome) })
  })))
  for (const child of children) child.stdin!.write('go\n')
  return { children, outcomes: await outcomes }
}

/**
 * Close every contender's input and wait for all to exit.
 * @param children - the contenders.
 */
async function finish(children: readonly ChildProcess[]): Promise<void> {
  await Promise.all(children.map(child => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return }
    child.once('exit', () => { resolve() })
    child.stdin!.end()
  })))
}

/**
 * Check that a race left exactly one holder, that the lock file holds that holder's record, and that every other contender refused.
 * @param outcomes - the contenders' reports.
 */
function expectOneHolder(outcomes: readonly Outcome[]): void {
  const holders = outcomes.filter(outcome => outcome.outcome === 'held')
  expect(holders).toHaveLength(1)
  expect(outcomes.filter(outcome => outcome.outcome === 'HOME_RUNNING')).toHaveLength(outcomes.length - 1)
  expect(readHomeLock(runDirectory)).toMatchObject({ startId: holders[0]!.startId, pid: holders[0]!.pid })
}

describe('the home lock', () => {
  it('writes C1\'s record at mode 0600 and removes it on release', async () => {
    const lock = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })
    const path = join(runDirectory, 'home.lock')
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(record)).toEqual(['v', 'pid', 'startId', 'runtime', 'startedAt'])
    expect(record).toMatchObject({ v: 1, pid: process.pid, runtime: '1.2.3' })
    expect(record.startId).toMatch(/^[0-9a-f]{32}$/)
    expect(new Date(record.startedAt as string).toISOString()).toBe(record.startedAt)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readHomeLock(runDirectory)).toEqual(lock.record)
    lock.release()
    lock.release()
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(runDirectory)).toEqual([])
  })

  it('refuses a second start while the holder lives, with HOME_RUNNING or HOME_UNRESPONSIVE by the probe', async () => {
    const held = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })
    const running = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered }).catch((error: unknown) => error)
    expect(running).toBeInstanceOf(HomeLayoutError)
    expect(running).toMatchObject({ code: 'HOME_RUNNING' })
    expect((running as Error).message).toContain(`process ${String(process.pid)}`)
    const silent = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: () => Promise.resolve('silent') }).catch((error: unknown) => error)
    expect(silent).toMatchObject({ code: 'HOME_UNRESPONSIVE' })
    expect(readHomeLock(runDirectory)).toEqual(held.record)
    held.release()
  })

  it('replaces a lock whose process no longer exists', async () => {
    plantLock(deadPid())
    const lock = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })
    expect(readHomeLock(runDirectory)?.pid).toBe(process.pid)
    lock.release()
    expect(readdirSync(runDirectory)).toEqual([])
  })

  it('does not take over a live holder of another start and does not remove its lock on release', async () => {
    plantLock(process.pid, 'b'.repeat(32))
    await expect(acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })).rejects.toMatchObject({ code: 'HOME_RUNNING' })
    expect(readHomeLock(runDirectory)?.startId).toBe('b'.repeat(32))
  })

  it('refuses a file that is not a lock record and leaves it', async () => {
    writeFileSync(join(runDirectory, 'home.lock'), 'not json')
    await expect(acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })).rejects.toThrow('is not a home lock record')
    expect(readFileSync(join(runDirectory, 'home.lock'), 'utf8')).toBe('not json')
  })

  it('leaves exactly one holder when starts race on a free lock', async () => {
    const { children, outcomes } = await race(8)
    try {
      expectOneHolder(outcomes)
    } finally {
      await finish(children)
    }
    expect(readdirSync(runDirectory)).toEqual([])
  }, 60_000)

  it('leaves exactly one holder, holding the lock file, when many starts race over a dead holder\'s lock, round after round', async () => {
    for (let round = 0; round < 20; round += 1) {
      plantLock(deadPid(), randomBytes(16).toString('hex'))
      const { children, outcomes } = await race(16)
      try {
        expectOneHolder(outcomes)
      } finally {
        await finish(children)
      }
      expect(readdirSync(runDirectory)).toEqual([])
    }
  }, 300_000)

  it('never removes a lock taken after a late contender found the old one stale', async () => {
    const staleId = brandString<StartId>('9'.repeat(32))
    plantLock(deadPid(), staleId)
    const winner = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })
    // A contender that read the dead record before the winner replaced it removes it only now.
    expect(await removeStaleLock(runDirectory, staleId)).toBe('done')
    expect(readHomeLock(runDirectory)).toEqual(winner.record)
    expect(readdirSync(runDirectory)).toEqual(['home.lock'])
    winner.release()
  })

  it('takes over a takeover guard left by a contender that died', async () => {
    const staleId = 'c'.repeat(32)
    plantLock(deadPid(), staleId)
    writeFileSync(join(runDirectory, `home.lock.takeover-${staleId}`), JSON.stringify({ pid: deadPid(), id: 'd'.repeat(32) }), { mode: 0o600 })
    const { children, outcomes } = await race(8)
    try {
      expectOneHolder(outcomes)
    } finally {
      await finish(children)
    }
    expect(readdirSync(runDirectory)).toEqual([])
  }, 60_000)

  it('waits for a live contender\'s takeover instead of removing the lock itself', async () => {
    const staleId = 'e'.repeat(32)
    plantLock(deadPid(), staleId)
    writeFileSync(join(runDirectory, `home.lock.takeover-${staleId}`), JSON.stringify({ pid: process.pid, id: 'f'.repeat(32) }), { mode: 0o600 })
    const pending = acquireHomeLock({ startId: newStartId(), runDirectory, runtime: RUNTIME, probe: answered })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(readHomeLock(runDirectory)?.startId).toBe(staleId)
    rmSync(join(runDirectory, `home.lock.takeover-${staleId}`))
    const lock = await pending
    expect(readHomeLock(runDirectory)?.startId).toBe(lock.record.startId)
    lock.release()
    expect(readdirSync(runDirectory)).toEqual([])
  })
})
