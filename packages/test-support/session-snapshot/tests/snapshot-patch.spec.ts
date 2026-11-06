import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SNAPSHOT_PATCH_ENV, snapshotPatchOverlay, withSnapshotPatch } from '../src/snapshot-patch.ts'

const dir = mkdtempSync(join(tmpdir(), 'snapshot-patch-'))
const overlay = join(dir, 'overlay.yml')
writeFileSync(overlay, '[]\n')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('snapshot patch overlay', () => {
  it('selects nothing without the variable', () => {
    expect(snapshotPatchOverlay(undefined, {})).toEqual([])
    expect(snapshotPatchOverlay('replay', { [SNAPSHOT_PATCH_ENV]: '' })).toEqual([])
  })

  it('selects the named file in replay', () => {
    expect(snapshotPatchOverlay(undefined, { [SNAPSHOT_PATCH_ENV]: overlay })).toEqual([overlay])
    expect(snapshotPatchOverlay('replay', { [SNAPSHOT_PATCH_ENV]: overlay })).toEqual([overlay])
  })

  it('refuses record and refresh, and a path that names no file', () => {
    expect(() => snapshotPatchOverlay('record', { [SNAPSHOT_PATCH_ENV]: overlay })).toThrow('refused in DSH_SNAPSHOT=record mode')
    expect(() => snapshotPatchOverlay('refresh', { [SNAPSHOT_PATCH_ENV]: overlay })).toThrow('refused in DSH_SNAPSHOT=refresh mode')
    expect(() => snapshotPatchOverlay('replay', { [SNAPSHOT_PATCH_ENV]: join(dir, 'missing.yml') })).toThrow('names no file')
  })

  it('places the overlay after the root configuration and before every later layer', () => {
    expect(withSnapshotPatch(['root', 'composition', 'runtime'], ['overlay'])).toEqual(['root', 'overlay', 'composition', 'runtime'])
    expect(withSnapshotPatch(['root', 'composition'], [])).toEqual(['root', 'composition'])
  })
})
