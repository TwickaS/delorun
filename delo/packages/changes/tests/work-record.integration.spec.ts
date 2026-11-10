import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkFailure, removeWorkFailure, WORK_FAILURE_SCHEMA, workFailurePath, writeWorkFailure } from '../src/work-record.ts'
import { modeOf, rejection, temporaryDirectory } from './support.ts'

const PROFILE = 'default'
const AT = '2026-11-10T10:00:00.000Z'

describe('the record of the last failed reload in a work session', () => {
  it('writes a protected record, reads it back, and removes it', async () => {
    const home = temporaryDirectory()
    expect(await readWorkFailure(home, PROFILE)).toBeUndefined()
    const record = await writeWorkFailure(home, PROFILE, { plugin: '@scope/plug', at: AT, error: 'plug threw' })
    expect(record).toEqual({ schema: WORK_FAILURE_SCHEMA, plugin: '@scope/plug', at: AT, error: 'plug threw' })
    expect(modeOf(workFailurePath(home, PROFILE))).toBe(0o600)
    expect(modeOf(dirname(workFailurePath(home, PROFILE)))).toBe(0o700)
    expect(await readWorkFailure(home, PROFILE)).toEqual(record)
    await removeWorkFailure(home, PROFILE)
    expect(existsSync(workFailurePath(home, PROFILE))).toBe(false)
    await removeWorkFailure(home, PROFILE)
  })

  it('refuses a record that is not one Delo wrote, and one others can read', async () => {
    const home = temporaryDirectory()
    const path = workFailurePath(home, PROFILE)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const valid = { schema: WORK_FAILURE_SCHEMA, plugin: 'plug', at: AT, error: 'plug threw' }
    for (const text of ['not json', 'null', '[]', JSON.stringify({ ...valid, extra: 1 }), JSON.stringify({ ...valid, schema: 'delo.changes-work/2' }), JSON.stringify({ ...valid, plugin: 7 }), JSON.stringify({ ...valid, plugin: 'Not A Name' }), JSON.stringify({ ...valid, at: 'yesterday' }), JSON.stringify({ ...valid, at: 7 }), JSON.stringify({ ...valid, error: 7 })]) {
      writeFileSync(path, text, { mode: 0o600 })
      await rejection(readWorkFailure(home, PROFILE), 'RECORD_UNREADABLE')
    }
    writeFileSync(path, JSON.stringify(valid), { mode: 0o600 })
    chmodSync(path, 0o644)
    await rejection(readWorkFailure(home, PROFILE), 'RECORD_UNREADABLE')
  })
})
