/**
 * What the bill's start stage says of a launcher's handoff and of a record the runtime made from its own check.
 */
import { describe, expect, it } from 'vitest'
import { START_CHECK_SCHEMA, type StartCheckHandoff } from '@delorun/runtime-store'
import { startResults, type ReleaseIdentity } from '../../src/verify/bill-release.ts'

const IDENTITY: ReleaseIdentity = { anchor: undefined, commit: null, manifestSha256: null, fileListSha256: null, part: { result: 'pass', detail: 'verified' } }
const LAUNCHER: StartCheckHandoff = { schema: START_CHECK_SCHEMA, release: '0.1.0', at: 1_800_000_000_000, full: false, hashed: 0, files: 10, fullCheckAt: null, launcher: { version: '0.1.0', path: '/l' } }

describe('startResults', () => {
  it('passes the launcher\'s handoff without a detail', () => {
    expect(startResults(IDENTITY, LAUNCHER)).toMatchObject({ signature: 'pass', files: 'pass' })
    expect(startResults(IDENTITY, LAUNCHER).detail).toBeUndefined()
  })

  it('passes the runtime\'s own record and says whose check it was', () => {
    const results = startResults(IDENTITY, { ...LAUNCHER, checkedBy: 'runtime' })
    expect(results).toMatchObject({ signature: 'pass', files: 'pass' })
    expect(results.detail).toBe('the updated release checked its own files at start; Check now runs the launcher\'s check')
  })

  it('stays unknown without a record', () => {
    expect(startResults(IDENTITY, undefined)).toMatchObject({ signature: 'unknown', files: 'unknown' })
  })
})
