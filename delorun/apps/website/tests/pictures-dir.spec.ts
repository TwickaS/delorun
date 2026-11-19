import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { picturesDir, PICTURES_VARIABLE } from '../scripts/pictures-dir.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the folder of source pictures', () => {
  it('is the folder SITE_PICTURES_DIR names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pictures-'))
    dirs.push(dir)
    expect(picturesDir({ [PICTURES_VARIABLE]: dir })).toBe(dir)
  })

  it('fails loud, naming the variable, when it is unset or empty', () => {
    expect(() => picturesDir({})).toThrow(/SITE_PICTURES_DIR is not set/)
    expect(() => picturesDir({ SITE_PICTURES_DIR: '' })).toThrow(/SITE_PICTURES_DIR is not set/)
  })

  it('fails loud when the folder is missing, unless the caller creates it', () => {
    const missing = join(tmpdir(), 'no-such-pictures-folder')
    expect(() => picturesDir({ SITE_PICTURES_DIR: missing })).toThrow(/does not exist/)
    expect(picturesDir({ SITE_PICTURES_DIR: missing }, false)).toBe(missing)
  })
})
