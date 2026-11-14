/**
 * The `release-log` line when the state reader throws something other than its documented refusal: the line still
 * warns that the record does not read and names the error, instead of failing the whole check.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { checkReleaseLog } from '../../src/doctor/records.ts'

vi.mock('@delorun/release-verify', async (original) => ({
  ...await original<typeof import('@delorun/release-verify')>(),
  readCheckState: () => { throw new RangeError('the reader broke') },
}))

let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

it('warns with the error\'s text when the state reader throws an error it does not document', async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-records-faults-')))
  mkdirSync(join(home, 'trust'), { mode: 0o700 })
  writeFileSync(join(home, 'trust', 'release-log.json'), '{}\n', { mode: 0o600 })
  const result = await checkReleaseLog(home, '0.4.0', 0)
  expect(result).toMatchObject({ name: 'release-log', status: 'warn' })
  expect(result.message).toContain('does not read (RangeError: the reader broke)')
})
