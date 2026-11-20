/**
 * Which update gets a baseline of signed pack files: an update to a newer release, with the running release's packs
 * file verified; anything else gives none, or refuses.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { openSignedPacks, StorePaths, parseRuntimeVersion, type SignedPackFiles } from '@delorun/runtime-store'
import { isUpgrade, updateBaselineOf, updateSource } from '../src/changes/update-baseline.ts'

vi.mock('@delorun/runtime-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/runtime-store')>()
  return { ...actual, openSignedPacks: vi.fn(actual.openSignedPacks) }
})

let base: string

beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-update-gate-'))) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const v = (text: string): RuntimeVersion => parseRuntimeVersion(text)!
const pack = (release: RuntimeVersion, name = 'demo'): SignedPackFiles => ({ name, release, files: new Map(), peers: [], texts: new Map() })

/**
 * Both releases' packs files, each listing every pack by name.
 * @returns the log of each pack read, as "release name".
 */
function opened(): string[] {
  const read: string[] = []
  vi.mocked(openSignedPacks).mockImplementation(release => Promise.resolve({
    lists: () => true,
    files: (name) => {
      read.push(`${release.version} ${name}`)
      return Promise.resolve({ ...pack(release.version), name })
    },
  }))
  return read
}

beforeEach(async () => {
  const { openSignedPacks: actual } = await vi.importActual<typeof import('@delorun/runtime-store')>('@delorun/runtime-store')
  vi.mocked(openSignedPacks).mockReset().mockImplementation(actual)
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
    opened()
    expect(await updateBaselineOf(environment, v('0.1.0'))).toBeUndefined()
    expect(await updateBaselineOf(environment, v('0.2.0'))).toBeUndefined()
    expect(asked).toEqual([undefined, undefined])
    expect(openSignedPacks).not.toHaveBeenCalled()
  })

  it('gives both releases\' signed packs of the pack asked for, so the denial above is the guard\'s', async () => {
    const environment = { release: (other?: RuntimeVersion) => Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: other ?? v('0.2.0') } as never) }
    opened()
    const baseline = await updateBaselineOf(environment, v('0.1.0'))
    expect(baseline).toMatchObject({ from: '0.1.0', to: '0.2.0' })
    expect(await baseline!.packsFor('demo')).toEqual([pack(v('0.1.0')), pack(v('0.2.0'))])
  })

  it('reads no pack until a waiting change asks for it, and each pack once', async () => {
    const environment = { release: (other?: RuntimeVersion) => Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: other ?? v('0.2.0') } as never) }
    const read = opened()
    const baseline = await updateBaselineOf(environment, v('0.1.0'))
    expect(read).toEqual([])
    await Promise.all([baseline!.packsFor('demo'), baseline!.packsFor('demo')])
    await baseline!.packsFor('demo')
    expect(read).toEqual(['0.1.0 demo', '0.2.0 demo'])
    await baseline!.packsFor('another')
    expect(read).toEqual(['0.1.0 demo', '0.2.0 demo', '0.1.0 another', '0.2.0 another'])
  })

  it('gives a pack that cannot be read no files and says so once, so its change waits', async () => {
    const environment = { release: (other?: RuntimeVersion) => Promise.resolve({ paths: new StorePaths(base, 'linux-x64'), version: other ?? v('0.2.0') } as never) }
    vi.mocked(openSignedPacks).mockImplementation(() => Promise.resolve({ lists: () => true, files: () => Promise.reject(new Error('EIO')) }))
    const told: string[] = []
    const baseline = await updateBaselineOf(environment, v('0.1.0'), (name, error) => void told.push(`${name}: ${(error as Error).message}`))
    expect(await baseline!.packsFor('demo')).toEqual([])
    expect(await baseline!.packsFor('demo')).toEqual([])
    expect(told).toEqual(['demo: EIO'])
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
