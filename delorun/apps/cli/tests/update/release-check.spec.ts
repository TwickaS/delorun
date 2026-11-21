/**
 * The release-log start check before a home process starts from an installed version without the launcher
 * (`delorun/apps/cli/src/update/release-check.ts`): a release the log verifies, or one whose check could not complete,
 * starts; one whose stored bundle is for another manifest stops with `VERIFY_FAILED`, before any of its code runs.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree } from '@delorun/home'
import { writeChannelRecord } from '@delorun/install'
import { StorePaths } from '@delorun/runtime-store'
import { processReleaseCheck, releaseLogStartCheck } from '../../src/update/release-check.ts'
import { fixtureRelease, logService, NOW, unreachableLog, VERSION, type Fixture } from '../../../install/tests/support.ts'

let base: string
let home: string

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'drc-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/**
 * Store a release's manifest and, when given, a bundle beside the installation, as an install leaves them.
 * @param fixture - the release.
 * @param bundle - the bundle's bytes, or `undefined` for none.
 */
function storeRelease(fixture: Fixture, bundle: Uint8Array | undefined): void {
  const files = new StorePaths(home, fixture.platform).releaseFiles(VERSION as RuntimeVersion)
  mkdirSync(dirname(files.manifest), { recursive: true })
  writeFileSync(files.manifest, fixture.manifestBytes)
  if (bundle !== undefined) writeFileSync(files.bundle, bundle)
}

describe('the release-log start check before a home process starts', () => {
  it('lets a release the log verifies start, and one whose check could not complete', async () => {
    const fixture = await fixtureRelease()
    storeRelease(fixture, fixture.bundleBytes)
    await releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => logService(fixture.checkpoint), now: () => NOW * 1000 })
    await releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => unreachableLog(), now: () => NOW * 1000 })
  })

  it('stops a release with no stored bundle, which every install through the store keeps, with VERIFY_FAILED', async () => {
    const fixture = await fixtureRelease()
    storeRelease(fixture, undefined)
    await expect(releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => unreachableLog(), now: () => NOW * 1000 }))
      .rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('no release-log bundle is stored beside this release') })
  })

  it('stops a release whose stored bundle is for another manifest, with VERIFY_FAILED naming delorun verify', async () => {
    const fixture = await fixtureRelease()
    const other = await fixtureRelease({ bundleOver: { manifest: Buffer.from('another manifest') } })
    storeRelease(fixture, other.bundleBytes)
    await expect(releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => logService(fixture.checkpoint), now: () => NOW * 1000 }))
      .rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining(`Run delorun verify --release ${VERSION}`) })
  })

  it('stops when the stored manifest or bundle cannot be read', async () => {
    const fixture = await fixtureRelease()
    await expect(releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => unreachableLog(), now: () => NOW * 1000 })).rejects.toMatchObject({ code: 'ENOENT' })
    storeRelease(fixture, undefined)
    mkdirSync(new StorePaths(home, fixture.platform).releaseFiles(VERSION as RuntimeVersion).bundle)
    await expect(releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { transport: () => unreachableLog(), now: () => NOW * 1000 })).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('asks the log the installation recorded instead of the root\'s', async () => {
    const fixture = await fixtureRelease()
    storeRelease(fixture, fixture.bundleBytes)
    await writeChannelRecord(home, { logOrigin: 'http://127.0.0.1:9' })
    const asked: string[] = []
    const environment = processReleaseCheck((input) => {
      asked.push(String(input instanceof Request ? input.url : input))
      return Promise.reject(new Error('no network in this spec'))
    })
    await releaseLogStartCheck(home, fixture.platform, VERSION as RuntimeVersion, fixture.rootMetadata, { ...environment, now: () => NOW * 1000 })
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(url => url.startsWith('http://127.0.0.1:9/'))).toBe(true)
  })

  it('reads the log the root names through this process\'s fetch', () => {
    const environment = processReleaseCheck(() => Promise.reject(new Error('no network in this spec')))
    expect(typeof environment.transport({ log: { origin: 'log.example.test', vkey: 'x' } } as Parameters<typeof environment.transport>[0], {}).latestCheckpoint).toBe('function')
    expect(environment.now()).toBeGreaterThan(0)
  })
})
