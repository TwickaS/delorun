/**
 * The outcome record `update-result.json` (contract C19, "The outcome record"): written mode 0600, read back
 * through the protected-file check, and read as none when it is absent, not JSON, not a record this module wrote, or
 * laxer than C1 allows.
 */
import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { readUpdateResult, removeUpdateResult, updateResultPath, writeUpdateResult, type UpdateResultRecord } from '../src/index.ts'
import { PROFILE, tempHome, V1, V2, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

const record = (): UpdateResultRecord => ({ v: 1, kind: 'update', outcome: 'rolled-back', from: V1, to: V2, reason: 'HEALTH_CHECK_FAILED', criterion: 'H2-host-ready', at: '2026-11-17T12:00:00.000Z' })

describe('update-result', () => {
  it('round-trips a record written with mode 0600 and removes it', async () => {
    temp = await tempHome()
    const path = updateResultPath(temp.home, PROFILE)
    await writeUpdateResult(path, record())
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readUpdateResult(path)).toEqual(record())
    await removeUpdateResult(path)
    expect(await readUpdateResult(path)).toBeUndefined()
    await removeUpdateResult(path)
  })

  it('round-trips the sentences the successor added, and reads as none a list that is too long or holds a long sentence', async () => {
    temp = await tempHome()
    const path = updateResultPath(temp.home, PROFILE)
    const committed: UpdateResultRecord = { ...record(), outcome: 'committed', rowChanges: ['Delorun 2.0.0 changes the settings of the External agents row (delorun-agent-seats): turns on live agents.'] }
    await writeUpdateResult(path, committed)
    expect(await readUpdateResult(path)).toEqual(committed)
    await writeUpdateResult(path, { ...committed, rowChanges: Array.from({ length: 33 }, () => 'x') })
    expect(await readUpdateResult(path)).toBeUndefined()
    await writeUpdateResult(path, { ...committed, rowChanges: ['x'.repeat(601)] })
    expect(await readUpdateResult(path)).toBeUndefined()
  })

  it('reads as none a file that is not JSON, holds an unknown field or a bad version, or is laxer than 0600', async () => {
    temp = await tempHome()
    const path = updateResultPath(temp.home, PROFILE)
    await writeUpdateResult(path, record())
    writeFileSync(path, 'not json\n')
    expect(await readUpdateResult(path)).toBeUndefined()
    writeFileSync(path, `${JSON.stringify({ ...record(), extra: true })}\n`)
    expect(await readUpdateResult(path)).toBeUndefined()
    writeFileSync(path, `${JSON.stringify({ ...record(), to: 'latest; rm -rf /' })}\n`)
    expect(await readUpdateResult(path)).toBeUndefined()
    await writeUpdateResult(path, record())
    chmodSync(path, 0o644)
    expect(await readUpdateResult(path)).toBeUndefined()
  })
})
