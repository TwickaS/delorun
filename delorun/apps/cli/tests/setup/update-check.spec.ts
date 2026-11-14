/** The release-check row setup writes is read from `@delorun/bundle-local`'s own patch, and a patch without it stops the write. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateCheckRow } from '../../src/setup/update-check.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-update-check-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the release-check row', () => {
  it('is the row the installed bundle inserts, with Delorun\'s composition turning it on', () => {
    expect(updateCheckRow()).toEqual({ id: 'delorun-update-check', name: '@delorun/bundle-local/update-check', config: { enabled: true, intervalHours: 24, timeoutSeconds: 15 } })
  })

  it('stops the write when the bundle\'s patch inserts no such row with a config', () => {
    for (const [file, text] of [['none.yml', '- insert:\n    - id: other\n      name: x\n'], ['bare.yml', '- insert:\n    - id: delorun-update-check\n      name: x\n']] as const) {
      const path = join(directory, file)
      writeFileSync(path, text)
      expect(() => updateCheckRow(path)).toThrow(`delorun setup: ${path} inserts no delorun-update-check row with a config, so the release-check answer cannot be written`)
    }
  })
})
