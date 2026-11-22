/** The web server row of the studio's port. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { setPatchRow } from '../src/patch-file.ts'
import { STUDIO_ROW_ID, studioRow } from '../src/studio-row.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('the studio row', () => {
  it('restates the web server row\'s other keys with the port, because a patch row replaces the whole config', () => {
    expect(studioRow(4100)).toEqual({ id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port: 4100, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
  })

  it('writes into a profile patch as the profile section does', () => {
    const root = mkdtempSync(join(tmpdir(), 'delorun-studio-row-'))
    roots.push(root)
    const path = join(root, 'cordis.patch.yml')
    setPatchRow(path, studioRow(4200))
    expect(parse(readFileSync(path, 'utf8'))).toEqual([studioRow(4200)])
  })
})
