/**
 * A launcher start that read a dead repair's mark must not remove the live mark a repair linked in meanwhile, and a
 * repair's end removes only the mark it wrote. The race is made deterministic by replacing the mark right after the
 * check's first read.
 */
// spec-lanes-allow: one short-lived child that has exited gives a process id no process holds.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentHolder } from '@delorun/home'
import { beginRepairRecord, checkRepairRecord, repairRecordPath } from '../src/repair-record.ts'

/** What a spec injects into the filesystem steps; each hook runs once and is then cleared. */
const hooks: {
  /** One entry per next read of the mark, in order: what runs after that read returned; `undefined` lets it pass. */
  afterReads: ((() => Promise<void>) | undefined)[]
  /** Runs once before the next move of the mark itself (not of a temporary file onto it). */
  beforeClaim?: (() => Promise<void>) | undefined
  /** Runs once before the next `link` that puts a moved mark back. */
  beforeRestore?: (() => Promise<void>) | undefined
  /** Makes the next read of a moved mark fail. */
  failClaimRead?: boolean
} = { afterReads: [] }

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.failClaimRead === true && String(args[0]).includes('repair.json.claim-')) {
        hooks.failClaimRead = false
        throw Object.assign(new Error('EIO: the injected read failure'), { code: 'EIO' })
      }
      const result = await actual.readFile(...args)
      if (String(args[0]).endsWith('repair.json') && hooks.afterReads.length > 0) await hooks.afterReads.shift()?.()
      return result
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const hook = hooks.beforeClaim
      if (hook !== undefined && String(args[0]).endsWith('repair.json')) {
        hooks.beforeClaim = undefined
        await hook()
      }
      return await actual.rename(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const hook = hooks.beforeRestore
      if (hook !== undefined && String(args[0]).includes('repair.json.claim-')) {
        hooks.beforeRestore = undefined
        await hook()
      }
      return await actual.link(...args)
    },
  }
})

const NOW = new Date('2026-11-13T12:00:00Z')
const GRACE = 5

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 })
  if (child.pid === undefined) throw new Error('the spec could not start a child process')
  return child.pid
}

describe('the repair mark under a race', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'delorun-repair-race-'))
    await mkdir(join(home, 'run'), { recursive: true })
  })
  afterEach(async () => {
    hooks.afterReads = []
    hooks.beforeClaim = undefined
    hooks.beforeRestore = undefined
    hooks.failClaimRead = false
    await rm(home, { recursive: true, force: true })
  })

  it('keeps the live mark a repair linked in after the check read a dead one', async () => {
    await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
    const live = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T11:59:59.000Z' })}\n`
    hooks.afterReads = [async () => { await writeFile(repairRecordPath(home), live) }]
    const state = await checkRepairRecord(home, GRACE, NOW.getTime())
    expect(state.kind).toBe('running')
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(live)
  })

  it('removes the dead mark when nothing replaced it, and reports it stale', async () => {
    await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
    expect((await checkRepairRecord(home, GRACE, NOW.getTime())).kind).toBe('stale')
    await expect(readFile(repairRecordPath(home), 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('leaves a mark another repair wrote when this repair ends', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    const other = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T12:00:01.000Z' })}\n`
    await writeFile(repairRecordPath(home), other)
    await end()
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(other)
  })

  it('removes its own mark when this repair ends, including after it noted the set-aside folder', async () => {
    const { end, noteSetAside } = await beginRepairRecord(home, NOW, GRACE)
    await noteSetAside(join(home, 'runtimes.set-aside-20261113T120000Z'))
    await end()
    await expect(readFile(repairRecordPath(home), 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('keeps a mark a repair writes after the removal compared the dead one and before it removes it', async () => {
    const dead = `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`
    await writeFile(repairRecordPath(home), dead)
    const live = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T11:59:59.000Z' })}\n`
    // The check's first read is skipped; right after the removal's own read matched the dead mark, a repair writes its mark.
    hooks.afterReads = [undefined, async () => { await writeFile(repairRecordPath(home), live) }]
    const state = await checkRepairRecord(home, GRACE, NOW.getTime())
    // The next look at the restored mark finds the live repair.
    expect(state.kind).toBe('running')
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(live)
    expect(await readdir(join(home, 'run'))).toEqual(['repair.json'])
  })

  it('leaves a mark another repair writes after this repair\u2019s end compared its own and before it removes it', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    const other = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T12:00:01.000Z' })}\n`
    hooks.afterReads = [async () => { await writeFile(repairRecordPath(home), other) }]
    await end()
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(other)
    expect(await readdir(join(home, 'run'))).toEqual(['repair.json'])
  })

  it('leaves the newest mark when a third one is linked while a newer one is being put back, and drops the moved one', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    const second = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T12:00:01.000Z' })}\n`
    const third = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T12:00:02.000Z' })}\n`
    hooks.afterReads = [async () => { await writeFile(repairRecordPath(home), second) }]
    // While the second mark is moved away a third repair links its own mark into the empty path.
    hooks.beforeRestore = async () => { await writeFile(repairRecordPath(home), third, { flag: 'wx' }) }
    await end()
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(third)
    expect(await readdir(join(home, 'run'))).toEqual(['repair.json'])
  })

  it('reports the dead mark stale when another check already moved it away, and leaves nothing behind', async () => {
    await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
    // A second check claims and removes the mark between this check's compare and its own move.
    hooks.beforeClaim = async () => { await rm(repairRecordPath(home)) }
    expect((await checkRepairRecord(home, GRACE, NOW.getTime())).kind).toBe('stale')
    expect(await readdir(join(home, 'run'))).toEqual([])
  })

  it('puts a newer mark back and raises the error when the first put back fails, so the mark is not lost', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    const other = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T12:00:01.000Z' })}\n`
    hooks.afterReads = [async () => { await writeFile(repairRecordPath(home), other) }]
    hooks.beforeRestore = () => Promise.reject(Object.assign(new Error('EIO: the injected link failure'), { code: 'EIO' }))
    await expect(end()).rejects.toThrow(/EIO/u)
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(other)
    expect(await readdir(join(home, 'run'))).toEqual(['repair.json'])
  })

  it('puts the moved mark back and raises the error when the moved mark cannot be read', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    const own = await readFile(repairRecordPath(home), 'utf8')
    hooks.failClaimRead = true
    await expect(end()).rejects.toThrow(/EIO/u)
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe(own)
    expect(await readdir(join(home, 'run'))).toEqual(['repair.json'])
  })
})
