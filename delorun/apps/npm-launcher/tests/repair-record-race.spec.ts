/**
 * A launcher start that read a dead repair's mark must not remove the live mark a repair linked in meanwhile, and a
 * repair's end removes only the mark it wrote. The race is made deterministic by replacing the mark right after the
 * check's first read.
 */
// spec-lanes-allow: one short-lived child that has exited gives a process id no process holds.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentHolder } from '@delorun/home'
import { beginRepairRecord, checkRepairRecord, repairRecordPath } from '../src/repair-record.ts'

/** What runs once after the next read of the mark; set by a spec. */
const hooks: { afterRead?: () => Promise<void> } = {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args)
      const hook = hooks.afterRead
      if (hook !== undefined && String(args[0]).endsWith('repair.json')) {
        hooks.afterRead = undefined
        await hook()
      }
      return result
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
    hooks.afterRead = undefined
    await rm(home, { recursive: true, force: true })
  })

  it('keeps the live mark a repair linked in after the check read a dead one', async () => {
    await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
    const live = `${JSON.stringify({ ...currentHolder(), startedAt: '2026-11-13T11:59:59.000Z' })}\n`
    hooks.afterRead = async () => { await writeFile(repairRecordPath(home), live) }
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
})
