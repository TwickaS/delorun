/**
 * Which update gets a baseline of signed pack files: an update to a newer release, with the running release's packs
 * file verified; anything else gives none, or refuses.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { readSignedPackFiles, StorePaths, parseRuntimeVersion, type SignedPackFiles } from '@delorun/runtime-store'
import { isUpgrade, updateBaselineOf, updateSource } from '../src/changes/update-baseline.ts'

vi.mock('@delorun/runtime-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/runtime-store')>()
  return { ...actual, readSignedPackFiles: vi.fn(actual.readSignedPackFiles) }
})

let base: string

beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-update-gate-'))) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const v = (text: string): RuntimeVersion => parseRuntimeVersion(text)!
const pack = (release: RuntimeVersion): SignedPackFiles => ({ name: 'demo', release, files: new Map(), peers: [], texts: new Map() })

beforeEach(async () => {
  const { readSignedPackFiles: actual } = await vi.importActual<typeof import('@delorun/runtime-store')>('@delorun/runtime-store')
  vi.mocked(readSignedPackFiles).mockReset().mockImplementation(actual)
})

describe('which update gets a baseline', () => {
  it('is an update to a newer semantic version', () => {
    expect(isUpgrade(v('0.1.0-preview.2.1'), v('0.1.0-preview.2.2'))).toBe(true)
    expect(isUpgrade(v('0.1.0'), v('0.1.0'))).toBe(false)
    expect(isUpgrade(v('0.1.1'), v('0.1.0'))).toBe(false)
  })

  it('gives none for a downgrade or the same release, though both releases\' packs files would verify', async () => {
    // Every release verifies and lists a pack, so only the downgrade guard can return `undefined` here.
    const asked: (string | undefined)[] = []
    const environment = {
      release: (other?: RuntimeVersion) => {
        asked.push(other)
        return Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: other ?? v('0.1.0') } as never)
      },
    }
    vi.mocked(readSignedPackFiles).mockImplementation(release => Promise.resolve([pack(release.version)]))
    expect(await updateBaselineOf(environment, v('0.1.0'))).toBeUndefined()
    expect(await updateBaselineOf(environment, v('0.2.0'))).toBeUndefined()
    expect(asked).toEqual([undefined, undefined])
    expect(readSignedPackFiles).not.toHaveBeenCalled()
  })

  it('gives both releases\' signed packs for an update to a newer release, so the denial above is the guard\'s', async () => {
    const environment = { release: (other?: RuntimeVersion) => Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: other ?? v('0.2.0') } as never) }
    vi.mocked(readSignedPackFiles).mockImplementation(release => Promise.resolve([pack(release.version)]))
    expect(await updateBaselineOf(environment, v('0.1.0'))).toEqual({ from: '0.1.0', to: '0.2.0', packs: [pack(v('0.1.0')), pack(v('0.2.0'))] })
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

describe('which handover is an update', () => {
  const line = (type: 'handover' | 'restart', purpose?: 'update' | 'rollback') => ({ type, from: v('0.2.0'), ...purpose === undefined ? {} : { purpose } })

  it('is an update\'s handover, and one from a predecessor that names no purpose', () => {
    expect(updateSource(line('handover', 'update'))).toBe('0.2.0')
    expect(updateSource(line('handover'))).toBe('0.2.0')
  })

  it('is never a rollback\'s handover, a restart or a start without a handover', () => {
    expect(updateSource(line('handover', 'rollback'))).toBeUndefined()
    expect(updateSource(line('restart'))).toBeUndefined()
    expect(updateSource(undefined)).toBeUndefined()
  })
})
