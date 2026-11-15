/**
 * The start-check record a successor runtime makes for itself when an older predecessor started it without one.
 */
import { describe, expect, it } from 'vitest'
import { DELORUN_START_CHECK_ENV, type RuntimeVersion } from '@delorun/contract-home-layout'
import { parseStartCheckHandoff, RuntimeStoreError } from '@delorun/runtime-store'
import { successorRecord } from '../../src/update/store-support.ts'

const VERSION = '0.1.0-rc.5' as RuntimeVersion
const NOW = 1_700_000_000_000
const PASSED = { check: { full: false, hashed: 0, files: 42, fullCheckAt: null } }
const ENV = { DELORUN_LAUNCHER_ROOTS: '/launcher/package/roots' }

describe('successorRecord', () => {
  it('hands over what the successor\'s own start check did when the predecessor handed none', async () => {
    const text = await successorRecord({ version: VERSION, env: ENV, now: NOW, check: async () => PASSED })
    expect(parseStartCheckHandoff(text)).toEqual({ schema: 'delorun.start-check/1', release: String(VERSION), at: NOW, full: false, hashed: 0, files: 42, fullCheckAt: null, launcher: { version: null, path: '/launcher/package' } })
  })

  it('keeps a record that already names this release, and checks nothing', async () => {
    const own = await successorRecord({ version: VERSION, env: ENV, now: NOW, check: async () => PASSED })
    let ran = false
    const again = await successorRecord({ version: VERSION, env: { ...ENV, [DELORUN_START_CHECK_ENV]: own }, now: NOW, check: async () => { ran = true; return PASSED } })
    expect(again).toBeUndefined()
    expect(ran).toBe(false)
  })

  it('replaces a record of another release, which describes another start', async () => {
    const other = await successorRecord({ version: '0.1.0-rc.4' as RuntimeVersion, env: ENV, now: NOW, check: async () => PASSED })
    const text = await successorRecord({ version: VERSION, env: { ...ENV, [DELORUN_START_CHECK_ENV]: other }, now: NOW, check: async () => PASSED })
    expect(parseStartCheckHandoff(text)?.release).toBe(String(VERSION))
  })

  it('denial: a start check that fails gives no record, so the successor does not start with a pass', async () => {
    const failure = new RuntimeStoreError('RUNTIME_CHANGED', '/x', 'bin/delorun (sha256) differs', [])
    await expect(successorRecord({ version: VERSION, env: ENV, now: NOW, check: async () => { throw failure } })).rejects.toBe(failure)
  })
})
