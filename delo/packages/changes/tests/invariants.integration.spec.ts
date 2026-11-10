import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkChangesInvariants } from '../src/invariants.ts'
import { activeDirectory, objectsDirectory, profileChangesDirectory, protectionPath, versionsDirectory } from '../src/paths.ts'
import { openWorkSession, setProtection } from '../src/records.ts'
import { fixture, folder, linkAs, migrated, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/**
 * @param fx - the fixture.
 * @returns the broken invariants of its profile.
 */
function check(fx: Fixture): Promise<readonly string[]> {
  return checkChangesInvariants({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })
}

describe('checkChangesInvariants', () => {
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
    linkAs(fx, '@delo/bundle-local', carried)
    expect(await check(fx)).toEqual([`@delo/bundle-local is linked from ${carried}, not from its active directory ${activeDirectory(fx.home, PROFILE, '@delo/bundle-local')}.`])
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

  it('reports a link whose folder cannot be read', async () => {
    const { fx } = await migrated()
    const closed = join(fx.root, 'closed')
    mkdirSync(join(closed, 'other'), { recursive: true })
    linkAs(fx, 'other', join(closed, 'other'))
    chmodSync(closed, 0o000)
    expect(await check(fx)).toEqual([expect.stringMatching(/^The folder of other cannot be read: .*EACCES/)])
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

  it('reports unapproved content under block outside a work session, and accepts it during one', async () => {
    const { fx, source, approved } = await migrated()
    await setProtection(fx.home, 'warn', terminal())
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    await start(fx)
    await setProtection(fx.home, 'block', terminal())
    const [line] = await check(fx)
    expect(line).toMatch(/^plug loads version [0-9a-f]{64} under block outside a work session, which is not its approved version\.$/)
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved }, terminal())
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
