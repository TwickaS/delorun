/**
 * Which update gets a baseline of signed pack files: an update to a newer release, with the running release's packs
 * file verified; anything else gives none, or refuses.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { StorePaths, parseRuntimeVersion } from '@delorun/runtime-store'
import { isUpgrade, updateBaselineOf } from '../src/changes/update-baseline.ts'

let base: string

beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-update-gate-'))) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const v = (text: string): RuntimeVersion => parseRuntimeVersion(text)!

describe('which update gets a baseline', () => {
  it('is an update to a newer semantic version', () => {
    expect(isUpgrade(v('0.1.0-preview.2.1'), v('0.1.0-preview.2.2'))).toBe(true)
    expect(isUpgrade(v('0.1.0'), v('0.1.0'))).toBe(false)
    expect(isUpgrade(v('0.1.1'), v('0.1.0'))).toBe(false)
  })

  it('gives none for a downgrade or the same release, and never asks for a release', async () => {
    const asked: (string | undefined)[] = []
    const environment = { release: (other?: RuntimeVersion) => { asked.push(other); return Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: v('0.1.0') } as never) } }
    expect(await updateBaselineOf(environment, v('0.1.0'))).toBeUndefined()
    expect(await updateBaselineOf(environment, v('0.2.0'))).toBeUndefined()
    expect(asked).toEqual([undefined, undefined])
  })

  it('throws, so nothing is replaced, when the running release\'s packs file does not verify', async () => {
    const paths = new StorePaths(base, 'linux-x64')
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.releaseFiles(v('0.2.0')).packs, '{}')
    writeFileSync(paths.releaseFiles(v('0.2.0')).packsBundle, '{}')
    const release = { paths, version: v('0.2.0'), root: {} as never, manifestBytes: new Uint8Array(), checkLog: () => ({ ok: true }) }
    await expect(updateBaselineOf({ release: () => Promise.resolve(release) }, v('0.1.0'))).rejects.toThrow()
  })
})
