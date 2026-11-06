import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, HomeLayoutError, readHomeLock, type HolderProbe } from '../src/home/index.ts'

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

/**
 * Start contenders together and collect each one's first line.
 * @param count - how many.
 * @returns the children and their outcomes.
 */
async function race(count: number): Promise<{ children: ChildProcess[], outcomes: string[] }> {
  const children = Array.from({ length: count }, () => spawn(process.execPath, ['--import', 'tsx/esm', CONTENDER, runDirectory], { cwd: REPOSITORY, stdio: ['pipe', 'pipe', 'inherit'] }))
  const outcomes = await Promise.all(children.map(child => new Promise<string>((resolve) => {
    createInterface({ input: child.stdout! }).once('line', line => { resolve((JSON.parse(line) as { outcome: string }).outcome) })
  })))
  return { children, outcomes }
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

describe('the home lock', () => {
  it('writes C1\'s record at mode 0600 and removes it on release', async () => {
    const lock = await acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered })
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
    const held = await acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered })
    const running = await acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered }).catch((error: unknown) => error)
    expect(running).toBeInstanceOf(HomeLayoutError)
    expect(running).toMatchObject({ code: 'HOME_RUNNING' })
    expect((running as Error).message).toContain(`process ${String(process.pid)}`)
    const silent = await acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: () => Promise.resolve('silent') }).catch((error: unknown) => error)
    expect(silent).toMatchObject({ code: 'HOME_UNRESPONSIVE' })
    expect(readHomeLock(runDirectory)).toEqual(held.record)
    held.release()
  })

  it('replaces a lock whose process no longer exists', async () => {
    plantLock(deadPid())
    const lock = await acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered })
    expect(readHomeLock(runDirectory)?.pid).toBe(process.pid)
    lock.release()
    expect(readdirSync(runDirectory)).toEqual([])
  })

  it('does not take over a live holder of another start and does not remove its lock on release', async () => {
    plantLock(process.pid, 'b'.repeat(32))
    await expect(acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered })).rejects.toMatchObject({ code: 'HOME_RUNNING' })
    expect(readHomeLock(runDirectory)?.startId).toBe('b'.repeat(32))
  })

  it('refuses a file that is not a lock record and leaves it', async () => {
    writeFileSync(join(runDirectory, 'home.lock'), 'not json')
    await expect(acquireHomeLock({ runDirectory, runtime: RUNTIME, probe: answered })).rejects.toThrow('is not a home lock record')
    expect(readFileSync(join(runDirectory, 'home.lock'), 'utf8')).toBe('not json')
  })

  it('leaves exactly one holder when starts race, on a free lock and on a stale one', async () => {
    for (const stale of [false, true]) {
      if (stale) plantLock(deadPid())
      const { children, outcomes } = await race(6)
      try {
        expect(outcomes.filter(outcome => outcome === 'held')).toHaveLength(1)
        expect(outcomes.filter(outcome => outcome === 'HOME_RUNNING')).toHaveLength(5)
        const holder = children[outcomes.indexOf('held')]!
        expect(readHomeLock(runDirectory)?.pid).toBe(holder.pid)
      } finally {
        await finish(children)
      }
      expect(readdirSync(runDirectory)).toEqual([])
    }
  }, 60_000)
})
