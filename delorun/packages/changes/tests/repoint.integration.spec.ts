import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { repointActiveCopies } from '../src/enforce.ts'
import { checkLoadedContent } from '../src/invariants.ts'
import { activeDirectory } from '../src/paths.ts'
import { readActiveRecord, readApproved, readChangeLog, writeActiveRecord } from '../src/records.ts'
import { ACTIVE_RECORD_SCHEMA } from '../src/types.ts'
import { fixture, linkAs, PROFILE, start, type Fixture } from './profile-fixture.ts'
import { writeFiles } from './support.ts'

vi.setConfig({ testTimeout: 30_000 })

/**
 * Install one release with a pack whose peer links into it, and make it current.
 * @param fx - the fixture.
 * @param version - the release.
 */
function installRelease(fx: Fixture, version: string): void {
  const pack = join(fx.home, 'packs', version, 'plug', 'package')
  writeFiles(fx.home, {
    [`runtimes/${version}/app/node_modules/@s/peer/package.json`]: JSON.stringify({ name: '@s/peer', version }),
    [`packs/${version}/plug/package/package.json`]: JSON.stringify({ name: 'plug', dependencies: { '@s/peer': '1' } }),
    'runtimes/current': `${version}\n`,
  })
  mkdirSync(join(pack, 'node_modules', '@s'), { recursive: true })
  symlinkSync(join(fx.home, 'runtimes', version, 'app', 'node_modules', '@s', 'peer'), join(pack, 'node_modules', '@s', 'peer'))
  rmSync(join(fx.home, 'packs', 'current'), { force: true })
  symlinkSync(version, join(fx.home, 'packs', 'current'))
}

/**
 * @param fx - the fixture.
 * @param release - the release the checking process runs from.
 * @returns the broken invariants a start or recomposition of that release finds.
 */
const atLoad = (fx: Fixture, release: string) => checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, runningRelease: release })

/**
 * A profile with a pack that loaded without review under 0.1.0 (protection off), then an update that installed 0.2.0
 * and switched to it, before any start of the new release.
 * @returns the fixture.
 */
async function updatedWithoutReview(): Promise<Fixture> {
  const fx = fixture({ protection: 'off' })
  installRelease(fx, '0.1.0')
  linkAs(fx, 'plug', join(fx.home, 'packs', 'current', 'plug', 'package'))
  await start(fx, '0.1.0')
  installRelease(fx, '0.2.0')
  return fx
}

/**
 * @param fx - the fixture.
 * @returns the three records of Changes for the profile.
 */
async function recordsOf(fx: Fixture): Promise<readonly unknown[]> {
  return [await readApproved(fx.profileDir), await readActiveRecord(fx.home, PROFILE), await readChangeLog(fx.home, PROFILE)]
}

describe('repointActiveCopies', () => {
  const request = (fx: Fixture, runningRelease: string) => ({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, runningRelease })

  it('makes a pack copy written under the previous release pass the new release\'s load check, and changes no record', async () => {
    const fx = await updatedWithoutReview()
    expect(await atLoad(fx, '0.2.0')).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
    const before = JSON.stringify(await recordsOf(fx))
    expect(await repointActiveCopies(request(fx, '0.2.0'))).toEqual(['plug'])
    expect(await atLoad(fx, '0.2.0')).toEqual([])
    expect(realpathSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'node_modules', '@s', 'peer'))).toBe(realpathSync(join(fx.home, 'runtimes', '0.2.0', 'app', 'node_modules', '@s', 'peer')))
    expect(JSON.stringify(await recordsOf(fx))).toBe(before)
    expect(await repointActiveCopies(request(fx, '0.2.0'))).toEqual([])
  })

  it('points the copy back at the previous release after a failed switch, so that release loads it again', async () => {
    const fx = await updatedWithoutReview()
    await repointActiveCopies(request(fx, '0.2.0'))
    expect(await atLoad(fx, '0.1.0')).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
    expect(await repointActiveCopies(request(fx, '0.1.0'))).toEqual(['plug'])
    expect(await atLoad(fx, '0.1.0')).toEqual([])
  })

  it('leaves a copy that already names the running release as it is', async () => {
    const fx = await updatedWithoutReview()
    expect(await repointActiveCopies(request(fx, '0.1.0'))).toEqual([])
  })

  it('restores what was recorded and approves nothing when an active copy was changed', async () => {
    const fx = await updatedWithoutReview()
    writeFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'package.json'), '{"name":"plug","tampered":true}\n')
    expect(await repointActiveCopies(request(fx, '0.2.0'))).toEqual(['plug'])
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'package.json'), 'utf8')).not.toContain('tampered')
  })

  it('does not adopt a directory no record names: the load check still refuses it', async () => {
    const fx = await updatedWithoutReview()
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: {} })
    expect(await repointActiveCopies(request(fx, '0.2.0'))).toEqual([])
    expect(await atLoad(fx, '0.2.0')).toEqual([expect.stringContaining('holds content, and active.json records none')])
  })
})
