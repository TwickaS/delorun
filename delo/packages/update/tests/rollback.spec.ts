/**
 * C3's rollback table through the one rollback function, over a temporary home: each row's data, profile and runtime
 * steps, and the refusal that changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decideRollback, isDataSafetyError, rollbackUpdate, saveDataCopy, type UpdateRecordFacts } from '../src/index.ts'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const LATER = new Date('2026-11-10T13:00:00.000Z')
const RECORD: UpdateRecordFacts = { from: '1.0.0', to: '1.1.0', dataDiffers: true, targetStarted: true }

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
 * @returns the result.
 */
async function roll(record: UpdateRecordFacts, profileOnly = false): Promise<Awaited<ReturnType<typeof rollbackUpdate>>> {
  return rollbackUpdate({
    home, record, profileOnly, now: LATER,
    restoreProfile: async () => { steps.push('profile') },
    switchRuntime: async () => { steps.push('runtime') },
  })
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
    await saveDataCopy({ home, from: '1.0.0', to: '1.1.0', formats: { from: undefined, to: undefined }, now: NOW })
    newerChats()
    const result = await roll(RECORD)
    expect(result.decision).toBe('restore-copy')
    expect(result.restored).toEqual({ setAside: join('data-set-aside', '1.1.0-20261110T130000Z'), changedChats: 1 })
    expect(existsSync(join(home, 'sessions/after'))).toBe(false)
    expect(readFileSync(join(home, 'data-set-aside/1.1.0-20261110T130000Z/sessions/after/log.jsonl'), 'utf8')).toBe('after\n')
    expect(steps).toEqual(['profile', 'runtime'])
    expect(result.lines.join('\n')).toMatch(/1 chat\(s\) created or changed since the update are set aside in data-set-aside/u)
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

  it('c03-rollback-before-first-start-needs-no-copy: before the target started, the profile and runtime go back and the data stays', async () => {
    newerChats()
    const result = await roll({ ...RECORD, targetStarted: false })
    expect(result.decision).toBe('plain')
    expect(result.lines.at(-1)).toBe('Chats written since the update stay as they are.')
    expect(steps).toEqual(['profile', 'runtime'])
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
    expect(existsSync(join(home, 'data-set-aside'))).toBe(false)
  })

  it('leaves the data alone when it does not differ, even with a copy', async () => {
    await saveDataCopy({ home, from: '1.0.0', to: '1.1.0', formats: { from: undefined, to: undefined }, now: NOW })
    newerChats()
    expect((await roll({ ...RECORD, dataDiffers: false })).decision).toBe('plain')
    expect(existsSync(join(home, 'sessions/after'))).toBe(true)
  })
})
