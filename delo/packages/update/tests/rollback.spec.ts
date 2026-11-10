/**
 * C3's rollback table through the one rollback function, over a temporary home: each row's data, profile and runtime
 * steps in their order, the refusals that change nothing, a copy the update did not take, and the completion of a
 * rollback a kill interrupted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decideRollback, isDataSafetyError, restoreDataCopy, readCopyRecord, rollbackUpdate, ROLLING_BACK_PHASE, saveDataCopy, type RollbackRequest, type UpdateRecordFacts } from '../src/index.ts'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const LATER = new Date('2026-11-10T13:00:00.000Z')
const RECORD: UpdateRecordFacts = { from: '1.0.0', to: '1.1.0', dataDiffers: true, targetStarted: true, copy: true, startedAt: '2026-11-10T11:59:00.000Z', phase: 'health-check' }

let home: string
let steps: string[]
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'delo-rollback-'))
  steps = []
  mkdirSync(join(home, 'sessions/before'), { recursive: true })
  writeFileSync(join(home, 'sessions/before/log.jsonl'), 'before\n')
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

/**
 * Roll back with recording steps.
 * @param record - the update record.
 * @param profileOnly - the person's choice.
 * @param replaced - steps that replace the recording ones.
 * @returns the result.
 */
async function roll(record: UpdateRecordFacts, profileOnly = false, replaced: Partial<RollbackRequest> = {}): Promise<Awaited<ReturnType<typeof rollbackUpdate>>> {
  return rollbackUpdate({
    home, record, profileOnly, now: LATER,
    preflight: async () => { steps.push('preflight') },
    markRollingBack: async () => { steps.push('mark') },
    restoreProfile: async () => { steps.push('profile') },
    switchRuntime: async () => { steps.push('runtime') },
    ...replaced,
  })
}

/**
 * Take the update's copy.
 * @param now - the copy's time.
 */
async function takeCopy(now = NOW): Promise<void> {
  await saveDataCopy({ home, from: '1.0.0', to: '1.1.0', formats: { from: undefined, to: undefined }, now })
}

/** Write chats the target created after the update. */
function newerChats(): void {
  mkdirSync(join(home, 'sessions/after'), { recursive: true })
  writeFileSync(join(home, 'sessions/after/log.jsonl'), 'after\n')
}

describe('decideRollback', () => {
  it('applies each row of the table', () => {
    expect(decideRollback({ ...RECORD, dataDiffers: false }, false, false)).toBe('plain')
    expect(decideRollback({ ...RECORD, dataDiffers: false, targetStarted: false }, true, false)).toBe('plain')
    expect(decideRollback({ ...RECORD, targetStarted: false }, false, false)).toBe('plain')
    expect(decideRollback(RECORD, true, false)).toBe('restore-copy')
    expect(decideRollback(RECORD, false, false)).toBe('refuse')
    expect(decideRollback(RECORD, false, true)).toBe('profile-only')
  })
})

describe('rollbackUpdate', () => {
  it('c03-rollback-restores-copy-and-sets-aside: after the target started, the copy goes back and the newer data is set aside', async () => {
    await takeCopy()
    newerChats()
    const result = await roll(RECORD)
    expect(result.decision).toBe('restore-copy')
    expect(result.restored).toEqual({ setAside: join('data-set-aside', '1.1.0-20261110T130000Z'), changedChats: 1 })
    expect(existsSync(join(home, 'sessions/after'))).toBe(false)
    expect(readFileSync(join(home, 'data-set-aside/1.1.0-20261110T130000Z/sessions/after/log.jsonl'), 'utf8')).toBe('after\n')
    expect(result.lines.join('\n')).toMatch(/1 chat\(s\) created or changed since the update are set aside in data-set-aside/u)
  })

  it('c03-rollback-order: the preflight runs before anything changes, the record is marked, then data, profile and runtime', async () => {
    await takeCopy()
    newerChats()
    const order: string[] = []
    await roll(RECORD, false, {
      preflight: async () => { order.push(`preflight, after: ${String(existsSync(join(home, 'sessions/after')))}`) },
      markRollingBack: async () => { order.push(`mark, copy: ${String(await readCopyRecord(home, '1.1.0') !== undefined)}`) },
      restoreProfile: async () => { order.push(`profile, after: ${String(existsSync(join(home, 'sessions/after')))}`) },
      switchRuntime: async () => { order.push('runtime') },
    })
    expect(order).toEqual(['preflight, after: true', 'mark, copy: true', 'profile, after: false', 'runtime'])
  })

  it('c03-rollback-preflight-failure-changes-nothing: a failing preflight reaches the caller and no other step runs', async () => {
    await takeCopy()
    newerChats()
    const failure = new Error('Delo 1.0.0 failed its start check')
    await expect(roll(RECORD, false, { preflight: async () => { throw failure } })).rejects.toBe(failure)
    expect(steps).toEqual([])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    expect(await readCopyRecord(home, '1.1.0')).toBeDefined()
    expect(existsSync(join(home, 'data-set-aside'))).toBe(false)
  })

  it('c03-rollback-without-copy-refuses: with no copy it refuses before any step, and --profile-only restores the snapshot alone', async () => {
    newerChats()
    await expect(roll(RECORD)).rejects.toSatisfy(error => isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY') && /--profile-only/u.test(error.message))
    expect(steps).toEqual([])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    const result = await roll(RECORD, true)
    expect(result).toEqual({ decision: 'profile-only', lines: ['Restored the profile from before the update to Delo 1.1.0; Delo 1.1.0 keeps running.'] })
    expect(steps).toEqual(['profile'])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
  })

  it('c03-rollback-ignores-stale-copy: a copy taken before the update started is never restored', async () => {
    await takeCopy()
    newerChats()
    await expect(roll({ ...RECORD, startedAt: '2026-11-10T12:30:00.000Z' })).rejects.toSatisfy(error => isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY'))
    expect(steps).toEqual([])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    await expect(roll({ ...RECORD, startedAt: 'not a time' })).rejects.toSatisfy(error => isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY'))
  })

  it('c03-rollback-ignores-copy-the-record-did-not-take: a copy present while the record says none was taken is never restored', async () => {
    await takeCopy()
    newerChats()
    await expect(roll({ ...RECORD, copy: false })).rejects.toSatisfy(error => isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY'))
    expect(steps).toEqual([])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
  })

  it('c03-rollback-before-first-start-needs-no-copy: before the target started, the profile and runtime go back and the data stays', async () => {
    newerChats()
    const result = await roll({ ...RECORD, targetStarted: false })
    expect(result.decision).toBe('plain')
    expect(result.lines.at(-1)).toBe('Chats written since the update stay as they are.')
    expect(steps).toEqual(['preflight', 'mark', 'profile', 'runtime'])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    expect(existsSync(join(home, 'data-set-aside'))).toBe(false)
  })

  it('leaves the data alone when it does not differ, even with a copy', async () => {
    await takeCopy()
    newerChats()
    expect((await roll({ ...RECORD, dataDiffers: false })).decision).toBe('plain')
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
  })
})

describe('rollbackUpdate resuming a rollback', () => {
  const RESUMED: UpdateRecordFacts = { ...RECORD, phase: ROLLING_BACK_PHASE }

  it('c03-rollback-resume-after-data-step: with the copy already consumed it does not refuse, and the profile and runtime go back', async () => {
    await takeCopy()
    newerChats()
    const copy = await readCopyRecord(home, '1.1.0')
    if (copy === undefined) throw new Error('the copy was not taken')
    const restored = await restoreDataCopy(home, copy, LATER)
    const result = await roll(RESUMED)
    expect(steps).toEqual(['preflight', 'profile', 'runtime'])
    expect(result.decision).toBe('restore-copy')
    expect(result.restored).toBeUndefined()
    expect(result.lines.at(-1)).toMatch(/put back when this rollback began/u)
    expect(readdirSync(join(home, 'data-set-aside'))).toEqual([basename(restored.setAside)])
    expect(existsSync(join(home, 'sessions/after'))).toBe(false)
  })

  it('c03-rollback-resume-before-data-step: with the copy still present the data is restored, without marking again', async () => {
    await takeCopy()
    newerChats()
    const result = await roll(RESUMED)
    expect(steps).toEqual(['preflight', 'profile', 'runtime'])
    expect(result.restored).toEqual({ setAside: join('data-set-aside', '1.1.0-20261110T130000Z'), changedChats: 1 })
    expect(existsSync(join(home, 'sessions/after'))).toBe(false)
  })

  it('completes a data restore a kill interrupted before deciding, and runs nothing when its preflight fails', async () => {
    await takeCopy()
    newerChats()
    const failure = new Error('Delo 1.0.0 is not installed')
    await expect(roll(RESUMED, false, { preflight: async () => { throw failure } })).rejects.toBe(failure)
    expect(steps).toEqual([])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    mkdirSync(join(home, 'data-set-aside/1.1.0-20261110T130000Z'), { recursive: true })
    writeFileSync(join(home, 'data-copies/restore.json'), JSON.stringify({ schema: 'delo.data-restore/1', to: '1.1.0', setAside: '1.1.0-20261110T130000Z', steps: [{ kind: 'set-aside', directory: 'sessions' }, { kind: 'restore', directory: 'sessions' }, { kind: 'record' }], done: 0 }))
    const result = await roll(RESUMED)
    expect(result.restored).toBeUndefined()
    expect(readFileSync(join(home, 'data-set-aside/1.1.0-20261110T130000Z/sessions/after/log.jsonl'), 'utf8')).toBe('after\n')
    expect(readdirSync(join(home, 'data-set-aside'))).toEqual(['1.1.0-20261110T130000Z'])
    expect(steps).toEqual(['preflight', 'profile', 'runtime'])
  })
})
