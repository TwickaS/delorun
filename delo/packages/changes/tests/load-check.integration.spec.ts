/**
 * Specs of what a start and a reload load when a folder cannot be read, when a plugin links installed packages, and
 * when a link or an active directory is not what Changes keeps: the start keeps approved content running and reports
 * the folder, copies installed dependencies by hash, refuses a profile that would load anything else, collects the
 * store, and the check before every reload moves folder links and refuses a mismatch.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CONTENT_VERSION, enforceApprovedContent, prepareReload, startNotice } from '../src/enforce.ts'
import { checkLoadedContent } from '../src/invariants.ts'
import { activeDirectory, versionsDirectory } from '../src/paths.ts'
import { readActiveRecord, readChangeLog, setProtection } from '../src/records.ts'
import { holdsVersion, readVersion, storeFolder } from '../src/store.ts'
import { CONTENT_BYTE_LIMIT } from '../src/tree.ts'
import { approvedVersion, fixture, folder, linkAs, migrated, namingActive, NOW, PROFILE, recorded, start, terminal, type Fixture } from './profile-fixture.ts'
import { lockOut, rejection, writeFiles } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * @param fx - the fixture.
 * @returns the request a reload's check makes for the fixture's profile.
 */
function reload(fx: Fixture): Parameters<typeof prepareReload>[0] {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW }
}

/**
 * Write the profile write lock's file as upstream's lock writes it.
 * @param fx - the fixture.
 * @param pid - the holder's process id.
 */
function holdLock(fx: Fixture, pid: number): void {
  writeFileSync(join(fx.profileDir, 'package.json.lock'), `${String(pid)}\n`)
}

/**
 * Make a file sparse and larger than a content version may hold, without writing its bytes.
 * @param path - the file.
 */
function oversized(path: string): void {
  writeFileSync(path, '')
  truncateSync(path, CONTENT_BYTE_LIMIT + 1)
}

/**
 * A pnpm workspace whose plugin imports an installed package that imports its own dependency installed beside it.
 * @param fx - the fixture.
 * @returns the plugin folder and the installed package's directory in pnpm's store.
 */
function workspacePlugin(fx: Fixture): { plug: string, installed: string } {
  const workspace = join(fx.root, 'workspace')
  const pnpm = join(workspace, 'node_modules', '.pnpm')
  const installed = join(pnpm, 'dep@1.0.0', 'node_modules', 'dep')
  writeFiles(installed, { 'package.json': '{"name":"dep","version":"1.0.0","type":"module","exports":"./index.js","dependencies":{"inner":"1.0.0"}}\n', 'index.js': 'import inner from "inner"\nexport default `dep+${inner}`\n' })
  writeFiles(join(pnpm, 'inner@1.0.0', 'node_modules', 'inner'), { 'package.json': '{"name":"inner","version":"1.0.0","type":"module","exports":"./index.js"}\n', 'index.js': 'export default "inner"\n' })
  symlinkSync('../../inner@1.0.0/node_modules/inner', join(pnpm, 'dep@1.0.0', 'node_modules', 'inner'))
  const plug = join(workspace, 'packages', 'plug')
  writeFiles(plug, { 'package.json': '{"name":"plug","version":"1.0.0","type":"module"}\n', 'index.js': 'import dep from "dep"\nexport const value = `plug+${dep}`\n' })
  mkdirSync(join(plug, 'node_modules'))
  symlinkSync(relative(join(plug, 'node_modules'), installed), join(plug, 'node_modules', 'dep'))
  return { plug, installed }
}

describe('a start whose folder cannot be read', () => {
  it('a scan failure under Block keeps the approved content running', async () => {
    const { fx, source, approved } = await migrated()
    writeFiles(source, { 'locked/a.js': 'a' })
    lockOut(join(source, 'locked'))
    const changes = await start(fx)
    expect(changes.failed).toEqual([{ plugin: 'plug', detail: expect.stringContaining('EACCES') }])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect(startNotice(changes)).toContain('plug runs the content you approved, or nothing if you approved none, because Delo could not read its folder: ')
  })

  it('refuses a plugin over the content limits under Block with the reason, and keeps its approved content', async () => {
    const { fx, source, approved } = await migrated()
    oversized(join(source, 'big.bin'))
    const changes = await start(fx)
    expect(changes.failed).toEqual([{ plugin: 'plug', detail: expect.stringContaining('so Delo does not copy it') }])
    expect(changes.pending).toEqual([])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('under Warn, keeps the approved content of a folder that cannot be read, even without its installed packages', async () => {
    const { fx, source, approved } = await migrated()
    await setProtection(fx.home, 'warn', terminal())
    oversized(join(source, 'big.bin'))
    const changes = await start(fx)
    expect(changes.failed).toEqual([{ plugin: 'plug', detail: expect.stringContaining('MiB') }])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('under Warn, keeps the approved content of a folder that changed while it was read', async () => {
    const { fx, source, approved } = await migrated()
    await setProtection(fx.home, 'warn', terminal())
    lockOut(source)
    const changes = await start(fx)
    chmodSync(source, 0o700)
    expect(changes.failed).toEqual([{ plugin: 'plug', detail: expect.stringContaining('EACCES') }])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('moves a new link whose folder cannot be read to its empty active directory, waiting for review with no content', async () => {
    const { fx } = await migrated()
    const added = folder(fx, 'added')
    oversized(join(added, 'big.bin'))
    linkAs(fx, 'added', added)
    const changes = await start(fx)
    expect(changes.failed).toEqual([{ plugin: 'added', detail: expect.stringContaining('so Delo does not copy it') }])
    expect(recorded(fx, 'added')).toEqual(namingActive(fx, 'added'))
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'added'))).toEqual([])
    expect((await readChangeLog(fx.home, PROFILE)).entries.at(-1)).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'added', source: added }, to: EMPTY_CONTENT_VERSION })
    expect((await readVersion(fx.home, EMPTY_CONTENT_VERSION)).entries).toEqual([])
  })

  it('approves nothing at the upgrade for a folder that cannot be read', async () => {
    const fx = fixture()
    const plug = folder(fx, 'plug')
    oversized(join(plug, 'big.bin'))
    linkAs(fx, 'plug', plug)
    const changes = await start(fx)
    expect(changes.approvedAtUpgrade).toEqual([])
    expect(changes.failed).toHaveLength(1)
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'plug'))).toEqual([])
  })

  it('loads nothing for a plugin whose approved content the store no longer holds, and says so', async () => {
    const { fx, source, approved } = await migrated()
    // With the folder gone, nothing stores the approved content again.
    rmSync(source, { recursive: true })
    rmSync(join(versionsDirectory(fx.home), `${approved}.json`))
    rmSync(activeDirectory(fx.home, PROFILE, 'plug'), { recursive: true })
    const changes = await start(fx)
    expect(changes.failed).toEqual([{ plugin: 'plug', detail: expect.stringContaining('the store has no usable version') }])
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'plug'))).toEqual([])
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({})
  })

  it('fails the start when the active directory cannot be written', async () => {
    const { fx } = await migrated()
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    writeFileSync(join(active, 'index.js'), 'tampered')
    chmodSync(active, 0o500)
    await expect(start(fx)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('installed packages a plugin links', () => {
  it('an approved plugin\'s outside dependency loads from the approved copy', async () => {
    const fx = fixture()
    const { plug, installed } = workspacePlugin(fx)
    linkAs(fx, 'plug', plug)
    await start(fx)
    // A confined command can write a workspace's installed packages; the approved copy holds its own.
    writeFileSync(join(installed, 'index.js'), 'export default "changed outside"\n')
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    const loaded = await import(pathToFileURL(join(active, 'index.js')).href) as { value: string }
    expect(loaded.value).toBe('plug+dep+inner')
  })

  it('under Warn, loads a plugin too large to copy with its installed packages from where they are installed, and says where', async () => {
    const fx = fixture()
    const { plug, installed } = workspacePlugin(fx)
    oversized(join(installed, 'big.bin'))
    await setProtection(fx.home, 'warn', terminal())
    linkAs(fx, 'plug', plug)
    const outsideHome = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW })
    expect(outsideHome.linkedDependencies).toEqual([{ plugin: 'plug', underHome: false }])
    expect(startNotice(outsideHome)).toContain('Warning: plug is too large to copy with its installed packages, so it loads them from where they are installed.\n')
    vi.stubEnv('HOME', fx.root)
    writeFileSync(join(plug, 'index.js'), 'export const value = "edited"\n')
    const underHome = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW })
    expect(underHome.linkedDependencies).toEqual([{ plugin: 'plug', underHome: true }])
    expect(startNotice(underHome)).toContain('so it loads them from where they are installed, inside your home folder, where commands the agent runs can change them.\n')
  })
})

describe('what a start checks after it prepared the profile', () => {
  it('a start refuses a profile whose installed link names the folder', async () => {
    const { fx, source } = await migrated()
    const link = join(fx.profileDir, 'node_modules', 'plug')
    rmSync(link)
    symlinkSync(source, link)
    const error = await rejection(start(fx), 'LOAD_REFUSED')
    expect(error.detail).toContain(`The profile's node_modules/plug resolves to ${source}, not to its active directory`)
  })

  it('accepts a plugin under Changes with no installed link', async () => {
    const { fx } = await migrated()
    rmSync(join(fx.profileDir, 'node_modules', 'plug'))
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
  })

  it('reports an installed link that cannot be read', async () => {
    const { fx } = await migrated()
    lockOut(join(fx.profileDir, 'node_modules'))
    const broken = await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })
    chmodSync(join(fx.profileDir, 'node_modules'), 0o700)
    expect(broken).toEqual([expect.stringContaining('The installed link of plug cannot be read')])
  })

  it('collects store versions nothing references, and a collection that fails does not stop the start', async () => {
    const { fx } = await migrated()
    const stray = folder(fx, 'stray', 'export default "stray"\n')
    const { version } = await storeFolder(fx.home, stray)
    const versionFile = join(versionsDirectory(fx.home), `${version}.json`)
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(versionFile, old, old)
    chmodSync(versionsDirectory(fx.home), 0o500)
    await start(fx)
    chmodSync(versionsDirectory(fx.home), 0o700)
    expect(existsSync(versionFile)).toBe(true)
    await start(fx)
    expect(existsSync(versionFile)).toBe(false)
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), await approvedVersion(fx, 'plug'))).toBe(true)
  })
})

describe('the check before a reload', () => {
  it('prepareReload refuses an active directory that differs from its approved version, and does not rewrite it', async () => {
    const { fx } = await migrated()
    const file = join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js')
    writeFileSync(file, 'export default "written between starts"\n')
    const error = await rejection(prepareReload(reload(fx)), 'LOAD_REFUSED')
    expect(error.detail).toContain('The active directory of plug does not hold version')
    expect(readFileSync(file, 'utf8')).toBe('export default "written between starts"\n')
  })

  it('moves a restored link back to the approved folder to the active directory while this process holds the lock, and approves nothing', async () => {
    const { fx, source, approved } = await migrated()
    linkAs(fx, 'plug', source)
    const added = folder(fx, 'added', 'export default "not reviewed"\n')
    linkAs(fx, 'added', added)
    holdLock(fx, process.pid)
    const changes = await prepareReload(reload(fx))
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
    expect(recorded(fx, 'added')).toEqual(namingActive(fx, 'added'))
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'added'))).toEqual([])
    expect(changes).toMatchObject({ approvedAtUpgrade: [], pending: [{ plugin: 'added', kind: 'plugin-install' }] })
    expect(startNotice(changes)).toContain('added is not loaded until you review it')
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({ plug: { version: approved, kind: 'approved' } })
    // The lock stays the holder's.
    expect(existsSync(join(fx.profileDir, 'package.json.lock'))).toBe(true)
  })

  it('takes the free profile write lock to move a folder link, and keeps every other active directory as recorded', async () => {
    const { fx, approved } = await migrated()
    await setProtection(fx.home, 'warn', terminal())
    const added = folder(fx, 'added', 'export default "not reviewed"\n')
    linkAs(fx, 'added', added)
    const changes = await prepareReload(reload(fx))
    expect(changes.unapproved).toEqual([{ plugin: 'added' }])
    expect(existsSync(join(fx.profileDir, 'package.json.lock'))).toBe(false)
    const active = (await readActiveRecord(fx.home, PROFILE)).plugins
    expect(active.plug).toEqual({ version: approved, kind: 'approved' })
    expect(active.added?.kind).toBe('unapproved')
  })

  it('writes nothing and refuses a folder link while another process holds the profile write lock', async () => {
    const { fx } = await migrated()
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    const manifest = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    holdLock(fx, 1)
    const error = await rejection(prepareReload(reload(fx)), 'LOAD_REFUSED')
    expect(error.detail).toContain(`added is linked from ${added}, not from its active directory`)
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(manifest)
  })

  it('only verifies, and passes, a profile another process already brought under Changes', async () => {
    const { fx } = await migrated()
    holdLock(fx, 1)
    expect(await prepareReload(reload(fx))).toEqual({ protection: 'block', approvedAtUpgrade: [], pending: [], unapproved: [] })
  })

  it('fails when the lock file cannot be read', async () => {
    const { fx } = await migrated()
    mkdirSync(join(fx.profileDir, 'package.json.lock'))
    await expect(prepareReload(reload(fx))).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
