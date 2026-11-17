import { chmodSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkChangesInvariants, checkLoadedContent } from '../src/invariants.ts'
import { changesStatus } from '../src/status.ts'
import { activeDirectory, objectsDirectory, profileChangesDirectory, protectionPath, versionsDirectory } from '../src/paths.ts'
import { openWorkSession, writeActiveRecord } from '../src/records.ts'
import { materialize, storeFolder } from '../src/store.ts'
import { ACTIVE_RECORD_SCHEMA } from '../src/types.ts'
import { fixture, folder, linkAs, migrated, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { writeFiles } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/**
 * @param fx - the fixture.
 * @returns the broken invariants of its profile.
 */
function check(fx: Fixture): Promise<readonly string[]> {
  return checkChangesInvariants({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })
}

/**
 * Install one release with a pack whose peer links into it, as the runtime store does, and name it current.
 * @param fx - the fixture.
 * @param version - the release.
 */
function installRelease(fx: Fixture, version: string): void {
  const pack = join(fx.home, 'packs', version, 'plug', 'package')
  writeFiles(fx.home, {
    [`runtimes/${version}/app/node_modules/@s/peer/package.json`]: JSON.stringify({ name: '@s/peer', version }),
    [`runtimes/${version}/app/node_modules/@s/other/package.json`]: JSON.stringify({ name: '@s/other', version }),
    [`packs/${version}/plug/package/package.json`]: JSON.stringify({ name: 'plug', dependencies: { '@s/peer': '1' } }),
    'runtimes/current': `${version}\n`,
  })
  mkdirSync(join(pack, 'node_modules', '@s'), { recursive: true })
  symlinkSync(join(fx.home, 'runtimes', version, 'app', 'node_modules', '@s', 'peer'), join(pack, 'node_modules', '@s', 'peer'))
  rmSync(join(fx.home, 'packs', 'current'), { force: true })
  symlinkSync(version, join(fx.home, 'packs', 'current'))
}

describe('checkChangesInvariants', () => {
  describe('a pack copy whose peer links into the release it was written under', () => {
    /**
     * @param fx - the fixture.
     * @param runningRelease - the release the checking process runs from.
     * @returns what a start or a recomposition of that release finds broken.
     */
    const atLoad = (fx: Fixture, runningRelease: string) => checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, runningRelease })
    /**
     * @param fx - the fixture.
     * @returns what `delorun doctor` and `delorun verify` report broken.
     */
    const atDoctor = async (fx: Fixture) => (await changesStatus({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).invariants

    /**
     * A profile that started under 0.1.0 with a pack, then an update that installed 0.2.0 and switched to it.
     * @returns the fixture and the copy's peer link.
     */
    async function updated(): Promise<{ readonly fx: Fixture, readonly peer: string }> {
      const fx = fixture()
      installRelease(fx, '0.1.0')
      linkAs(fx, 'plug', join(fx.home, 'packs', 'current', 'plug', 'package'))
      await start(fx, '0.1.0')
      expect(await atLoad(fx, '0.1.0')).toEqual([])
      installRelease(fx, '0.2.0')
      return { fx, peer: join(activeDirectory(fx.home, PROFILE, 'plug'), 'node_modules', '@s', 'peer') }
    }

    it('is what a Host still running the old release loads, and what doctor accepts until the next start re-points it', async () => {
      const { fx, peer } = await updated()
      expect(await atLoad(fx, '0.1.0')).toEqual([])
      expect(await atDoctor(fx)).toEqual([])
      await start(fx, '0.2.0')
      expect(realpathSync(peer)).toBe(realpathSync(join(fx.home, 'runtimes', '0.2.0', 'app', 'node_modules', '@s', 'peer')))
      expect(await atLoad(fx, '0.2.0')).toEqual([])
      expect(await atDoctor(fx)).toEqual([])
    })

    it('is refused at load by the new release when its re-point did not happen', async () => {
      const { fx } = await updated()
      expect(await atLoad(fx, '0.2.0')).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
      expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
    })

    it('is reported by doctor once the old release is removed, or when its link names another package', async () => {
      const { fx, peer } = await updated()
      rmSync(join(fx.home, 'runtimes', '0.1.0', 'app', 'node_modules', '@s', 'peer'), { recursive: true })
      expect(await atDoctor(fx)).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
      rmSync(peer)
      symlinkSync(join(fx.home, 'runtimes', '0.1.0', 'app', 'node_modules', '@s', 'other'), peer)
      expect(await atDoctor(fx)).toEqual([expect.stringContaining('The active directory of plug does not hold version')])
    })
  })

  it('finds nothing broken after a start, links into the runtime store and to non-directories included', async () => {
    const { fx } = await migrated()
    const carried = join(fx.home, 'runtimes', '1.2.3', 'bundle')
    mkdirSync(carried, { recursive: true })
    linkAs(fx, 'carried', carried)
    writeFileSync(join(fx.root, 'a-file'), 'x\n')
    linkAs(fx, 'to-file', join(fx.root, 'a-file'))
    linkAs(fx, 'added', folder(fx, 'added'))
    await start(fx)
    expect(await check(fx)).toEqual([])
  })

  it('reads back an approved version that holds a symbolic link', async () => {
    const fx = fixture()
    const source = folder(fx, 'linked')
    symlinkSync('index.js', join(source, 'main.js'))
    linkAs(fx, 'linked', source)
    await start(fx)
    expect(await check(fx)).toEqual([])
  })

  it('accepts the harness\'s own link to the directory the installation carries', async () => {
    const { fx } = await migrated()
    const carried = folder(fx, 'checkout/bundle-local')
    linkAs(fx, '@delorun/bundle-local', carried)
    expect(await check(fx)).toEqual([`@delorun/bundle-local is linked from ${carried}, not from its active directory ${activeDirectory(fx.home, PROFILE, '@delorun/bundle-local')}.`])
    expect(await checkChangesInvariants({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, harnessLink: (_name, target) => target === carried })).toEqual([])
  })

  it('reports a protection record that cannot be read', async () => {
    const { fx } = await migrated()
    writeFileSync(protectionPath(fx.home), '{}\n', { mode: 0o600 })
    expect(await check(fx)).toEqual([expect.stringMatching(/^The protection setting cannot be read: /)])
  })

  it('reports a link: dependency that names its folder instead of its active directory', async () => {
    const { fx, source } = await migrated()
    linkAs(fx, 'plug', source)
    expect(await check(fx)).toEqual([`plug is linked from ${source}, not from its active directory ${activeDirectory(fx.home, PROFILE, 'plug')}.`])
  })

  it('reports a link to a folder that cannot be read, or to none, as any link that names no active directory', async () => {
    const { fx } = await migrated()
    const closed = join(fx.root, 'closed')
    mkdirSync(join(closed, 'other'), { recursive: true })
    linkAs(fx, 'other', join(closed, 'other'))
    linkAs(fx, 'gone', join(fx.root, 'gone'))
    chmodSync(closed, 0o000)
    expect(await check(fx)).toEqual([
      `other is linked from ${join(closed, 'other')}, not from its active directory ${activeDirectory(fx.home, PROFILE, 'other')}.`,
      `gone is linked from ${join(fx.root, 'gone')}, not from its active directory ${activeDirectory(fx.home, PROFILE, 'gone')}.`,
    ])
  })

  it('reports a manifest that cannot be read, and goes on with the rest', async () => {
    const { fx } = await migrated()
    writeFileSync(join(fx.profileDir, 'package.json'), '{')
    expect(await check(fx)).toEqual([
      expect.stringMatching(/^The profile's links cannot be read: /),
      expect.stringMatching(/^The approved plugins cannot be read: /),
    ])
  })

  it('reports an active record and a work session that cannot be read', async () => {
    const { fx } = await migrated()
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'active.json'), '{}\n', { mode: 0o600 })
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'work-session.json'), '{}\n', { mode: 0o600 })
    const broken = await check(fx)
    expect(broken[0]).toMatch(/^The record of active directories cannot be read: /)
    expect(broken[1]).toMatch(/^The work session cannot be read: /)
  })

  it('reports an active directory that does not hold what active.json records', async () => {
    const { fx, approved } = await migrated()
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    writeFileSync(join(active, 'index.js'), 'export default "tampered"\n')
    expect(await check(fx)).toEqual([`The active directory of plug does not hold version ${approved}, which active.json records: ${active}.`])
  })

  it('reports content in an active directory that active.json records nothing for', async () => {
    const { fx } = await migrated()
    linkAs(fx, 'added', folder(fx, 'added'))
    await start(fx)
    const active = activeDirectory(fx.home, PROFILE, 'added')
    writeFileSync(join(active, 'planted.js'), 'x\n')
    expect(await check(fx)).toEqual([`The active directory of added holds content, and active.json records none: ${active}.`])
  })

  it('reports an active directory that cannot be read', async () => {
    const { fx } = await migrated()
    chmodSync(activeDirectory(fx.home, PROFILE, 'plug'), 0o000)
    expect(await check(fx)).toEqual([expect.stringMatching(/^The active directory of plug cannot be read: .*EACCES/)])
  })

  it('reports content that is not the approved version with protection on outside a work session, and accepts it during one', async () => {
    const { fx, source, approved } = await migrated()
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    const edited = (await storeFolder(fx.home, source)).version
    await materialize(fx.home, edited, activeDirectory(fx.home, PROFILE, 'plug'))
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: edited, kind: 'approved' } } })
    const [line] = await check(fx)
    expect(line).toMatch(/^plug loads version [0-9a-f]{64} with protection on outside a work session, which is not its approved version\.$/)
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    expect(await check(fx)).toEqual([])
  })

  it('reports an approved version whose object or manifest is missing from the store', async () => {
    const { fx, approved } = await migrated()
    const objects = objectsDirectory(fx.home)
    rmSync(join(objects, readdirSync(objects)[0]!))
    expect(await check(fx)).toEqual([expect.stringMatching(/^The approved version of plug does not read back intact: /)])
    rmSync(join(versionsDirectory(fx.home), `${approved}.json`))
    expect(await check(fx)).toEqual([expect.stringMatching(/^The approved version of plug does not read back intact: /)])
  })
})
