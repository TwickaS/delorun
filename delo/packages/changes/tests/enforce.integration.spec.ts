import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CONTENT_VERSION, enforceApprovedContent, isInRuntimeStore, prepareReload, startNotice } from '../src/enforce.ts'
import { checkLoadedContent } from '../src/invariants.ts'
import { activeDirectory } from '../src/paths.ts'
import { pluginChange } from '../src/pending.ts'
import { openWorkSession, readActiveRecord, readApproved, readChangeLog, writeApproved, writeChangeLog } from '../src/records.ts'
import { holdsVersion, storeFolder } from '../src/store.ts'
import { approvedVersion, fixture, folder, history, linkAs, migrated, namingActive, NOW, PROFILE, recorded, start, terminal } from './profile-fixture.ts'
import { temporaryDirectory, writeFiles } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the first start under Changes', () => {
  it('approves the linked plugins as they are, records one history version, and names them once', async () => {
    const fx = fixture()
    const plug = folder(fx, 'plug')
    const scoped = folder(fx, 'scoped')
    linkAs(fx, 'plug', plug)
    linkAs(fx, '@x/scoped', scoped)

    const first = await start(fx)

    const stored = (await storeFolder(fx.home, plug)).version
    expect(first).toEqual({
      protection: 'on',
      approvedAtUpgrade: [{ plugin: 'plug', source: plug }, { plugin: '@x/scoped', source: scoped }],
      pending: [],
      unreviewed: [],
      historyVersion: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
    expect(recorded(fx, '@x/scoped')).toEqual(namingActive(fx, '@x/scoped'))
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), stored)).toBe(true)
    expect((await readApproved(fx.profileDir)).plugins.plug).toEqual({ source: plug, version: stored, approvedAt: NOW.toISOString(), approvedAtUpgrade: true })
    expect(await history(fx)).toEqual(['Changes: approved at upgrade plug, @x/scoped'])
    const log = await readChangeLog(fx.home, PROFILE)
    expect(log.migratedAt).toBe(NOW.toISOString())
    expect(log.entries[0]).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'upgrade', subject: { plugin: 'plug', source: plug }, to: stored, summary: `Approved at upgrade: plug from ${plug}`, historyVersion: first.historyVersion, shownAt: NOW.toISOString() })
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({ plug: { version: stored, kind: 'approved' }, '@x/scoped': { version: await approvedVersion(fx, '@x/scoped'), kind: 'approved' } })
    expect(startNotice(first)).toBe([
      `Delo now runs the approved copy of plug, linked from ${plug}. Edits in that folder wait for your review: delorun changes list.`,
      `Delo now runs the approved copy of @x/scoped, linked from ${scoped}. Edits in that folder wait for your review: delorun changes list.`,
      '',
    ].join('\n'))

    const second = await start(fx)
    expect(second).toEqual({ protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] })
    expect(startNotice(second)).toBe('')
    expect(await history(fx)).toHaveLength(1)
  })

  it('sets migratedAt in a profile with no linked plugin and records no history version', async () => {
    const fx = fixture()
    expect(await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, lockWaitMs: 1000 })).toEqual({ protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] })
    expect(Date.parse((await readChangeLog(fx.home, PROFILE)).migratedAt!)).not.toBeNaN()
    expect(await history(fx)).toEqual([])
  })

  it('leaves the harness\'s own links alone: into the runtime store, or to the directory the installation carries for the name', async () => {
    const fx = fixture()
    const checkout = folder(fx, 'checkout/delo/packages/bundle-local')
    const stored = join(fx.home, 'runtimes', '1.2.3', 'node_modules', '@delo', 'bundle-other')
    writeFiles(stored, { 'package.json': '{"name":"@delo/bundle-other"}\n' })
    linkAs(fx, '@delo/bundle-local', checkout)
    linkAs(fx, '@delo/bundle-other', stored)
    const harnessLink = (name: string, target: string): boolean => name === '@delo/bundle-local' && target === checkout
    const changes = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, harnessLink })
    expect(changes.approvedAtUpgrade).toEqual([])
    expect(recorded(fx, '@delo/bundle-local')).toEqual({ spec: `link:${checkout}`, specifier: `link:${checkout}`, version: checkout, link: checkout })
    expect(recorded(fx, '@delo/bundle-other')).toEqual({ spec: `link:${stored}`, specifier: `link:${stored}`, version: stored, link: stored })
    expect(existsSync(activeDirectory(fx.home, PROFILE, '@delo/bundle-local'))).toBe(false)
    expect(existsSync(activeDirectory(fx.home, PROFILE, '@delo/bundle-other'))).toBe(false)
    expect(await history(fx)).toEqual([])
  })

  it('brings a link to another folder with the name of a package the installation carries under Changes', async () => {
    const fx = fixture()
    const carried = folder(fx, 'checkout/delo/packages/bundle-local')
    const fork = folder(fx, 'fork/bundle-local')
    linkAs(fx, '@delo/bundle-local', fork)
    const harnessLink = (name: string, target: string): boolean => name === '@delo/bundle-local' && target === carried
    const changes = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, harnessLink })
    expect(changes.approvedAtUpgrade).toEqual([{ plugin: '@delo/bundle-local', source: fork }])
    expect(recorded(fx, '@delo/bundle-local')).toEqual(namingActive(fx, '@delo/bundle-local'))
  })

  it('approves a plugin folder from a pnpm workspace whose copy imports its sibling package and that one\'s dependency', async () => {
    const fx = fixture()
    const workspace = join(fx.root, 'workspace')
    const dependency = join(workspace, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep')
    writeFiles(dependency, { 'package.json': '{"name":"dep","version":"1.0.0","type":"module","exports":"./index.js"}\n', 'index.js': 'export default "dep"\n' })
    const sibling = join(workspace, 'packages', 'sib')
    writeFiles(sibling, { 'package.json': '{"name":"@x/sib","version":"1.0.0","type":"module","exports":"./index.js"}\n', 'index.js': 'import dep from "dep"\nexport const sib = `sib+${dep}`\n' })
    mkdirSync(join(sibling, 'node_modules'))
    symlinkSync(relative(join(sibling, 'node_modules'), dependency), join(sibling, 'node_modules', 'dep'))
    const plug = join(workspace, 'packages', 'plug')
    writeFiles(plug, { 'package.json': '{"name":"plug","version":"1.0.0","type":"module"}\n', 'index.js': 'import { sib } from "@x/sib"\nexport const value = `plug+${sib}`\n' })
    mkdirSync(join(plug, 'node_modules', '@x'), { recursive: true })
    symlinkSync('../../../sib', join(plug, 'node_modules', '@x', 'sib'))
    linkAs(fx, 'plug', plug)

    expect((await start(fx)).approvedAtUpgrade).toEqual([{ plugin: 'plug', source: plug }])
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    expect(await holdsVersion(active, await approvedVersion(fx, 'plug'))).toBe(true)
    const loaded = await import(pathToFileURL(join(active, 'index.js')).href) as { value: string }
    expect(loaded.value).toBe('plug+sib+dep')
  })

  it('leaves file: specs and registry plugins alone', async () => {
    const fx = fixture()
    const manifestPath = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['from-file'] = `file:${folder(fx, 'packed')}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    const before = readFileSync(manifestPath, 'utf8')
    expect(await start(fx)).toEqual({ protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] })
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(await history(fx)).toEqual([])
  })

  it('a link to a missing folder is brought under Changes and loads nothing', async () => {
    const { fx } = await migrated()
    const gone = join(fx.root, 'gone')
    const file = join(fx.root, 'a-file')
    writeFileSync(file, 'x\n')
    // As a restore or undo writes it back while the folder is deleted, and a link to a file where a folder was.
    linkAs(fx, 'gone', gone)
    linkAs(fx, 'to-file', file)
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([
      `gone is linked from ${gone}, not from its active directory ${activeDirectory(fx.home, PROFILE, 'gone')}.`,
      `to-file is linked from ${file}, not from its active directory ${activeDirectory(fx.home, PROFILE, 'to-file')}.`,
    ])
    const changes = await start(fx)
    expect(changes.pending).toEqual([])
    for (const [plugin, source] of [['gone', gone], ['to-file', file]] as const) {
      expect(recorded(fx, plugin)).toEqual(namingActive(fx, plugin))
      expect(readdirSync(activeDirectory(fx.home, PROFILE, plugin))).toEqual([])
      expect((await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.subject.plugin === plugin)).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin, source }, to: EMPTY_CONTENT_VERSION })
    }
    expect((await history(fx))[0]).toBe('Changes: gone, to-file wait for your review')

    // A model that recreates the folder before the next start changes nothing that loads: it waits for review.
    const recreated = folder(fx, 'gone')
    const next = await start(fx)
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'gone'))).toEqual([])
    const pending = await pluginChange(fx.home, { plugin: 'gone', source: recreated })
    expect(next.pending).toEqual([{ id: pending!.id, plugin: 'gone', kind: 'plugin-install' }])

    // The check before a reload gives the same answer for a link a restore writes back while the folder is gone.
    rmSync(recreated, { recursive: true })
    linkAs(fx, 'gone', gone)
    await prepareReload({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW })
    expect(recorded(fx, 'gone')).toEqual(namingActive(fx, 'gone'))
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'gone'))).toEqual([])
  })

  it('fails the start when the profile history cannot record the change', async () => {
    const fx = fixture()
    linkAs(fx, 'plug', folder(fx, 'plug'))
    const empty = temporaryDirectory()
    vi.stubEnv('PATH', empty)
    await expect(start(fx)).rejects.toMatchObject({ name: 'HistoryUnavailableError' })
    expect((await readChangeLog(fx.home, PROFILE)).migratedAt).toBeUndefined()
    vi.unstubAllEnvs()
    // The next start finishes the migration and records the history version the failed one could not.
    const changes = await start(fx)
    expect(changes.historyVersion).toMatch(/^[0-9a-f]{40}$/)
    expect(await history(fx)).toEqual(['Changes: approved at upgrade plug'])
    expect((await readChangeLog(fx.home, PROFILE)).entries[0]?.historyVersion).toBe(changes.historyVersion)
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
  })

  it('rethrows a failure to read a link\'s target other than a missing one', async () => {
    const fx = fixture()
    const closed = join(fx.root, 'closed')
    mkdirSync(join(closed, 'plug'), { recursive: true })
    linkAs(fx, 'plug', join(closed, 'plug'))
    chmodSync(closed, 0o000)
    await expect(start(fx)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('a start with protection on', () => {
  it('a plugin outside a work session never loads from its folder', async () => {
    const { fx, source, approved } = await migrated()
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    writeFileSync(join(source, 'added.js'), 'export const added = 1\n')
    await start(fx)
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    expect(await holdsVersion(active, approved)).toBe(true)
    expect(readFileSync(join(active, 'index.js'), 'utf8')).toBe('export default "one"\n')
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
    expect(Object.values(recorded(fx, 'plug')).some(value => value.includes(source))).toBe(false)
  })

  it('a changed plugin does not load with protection on', async () => {
    const { fx, source, approved } = await migrated()
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    const changes = await start(fx)
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    expect(readFileSync(join(active, 'index.js'), 'utf8')).not.toContain('edited')
    const pending = await pluginChange(fx.home, { plugin: 'plug', source, approved })
    expect(changes.pending).toEqual([{ id: pending!.id, plugin: 'plug', kind: 'plugin-edit' }])
    expect(startNotice(changes)).toBe(`plug has changes waiting for your review and loads without them: delorun changes show ${pending!.id}\n`)
  })

  it('a new linked plugin without approved content loads nothing with protection on', async () => {
    const { fx } = await migrated()
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    const changes = await start(fx)
    const active = activeDirectory(fx.home, PROFILE, 'added')
    expect(readdirSync(active)).toEqual([])
    expect(recorded(fx, 'added')).toEqual(namingActive(fx, 'added'))
    const pending = await pluginChange(fx.home, { plugin: 'added', source: added })
    expect(changes.pending).toEqual([{ id: pending!.id, plugin: 'added', kind: 'plugin-install' }])
    expect(changes.historyVersion).toMatch(/^[0-9a-f]{40}$/)
    expect(startNotice(changes)).toBe(`added is not loaded until you review it: delorun changes show ${pending!.id}\n`)
    expect((await readChangeLog(fx.home, PROFILE)).entries.at(-1)).toEqual({ id: pending!.id, kind: 'plugin-install', state: 'pending', subject: { plugin: 'added', source: added }, to: pending!.to, summary: `added from ${added} waits for your review`, createdAt: NOW.toISOString() })
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.added).toBeUndefined()
    expect((await history(fx))[0]).toBe('Changes: added waits for your review')

    // The same folder linked again records no second entry; two new plugins wait together.
    linkAs(fx, 'added', added)
    linkAs(fx, 'other', folder(fx, 'other'))
    await start(fx)
    expect((await readChangeLog(fx.home, PROFILE)).entries.filter(entry => entry.subject.plugin === 'added')).toHaveLength(1)
    expect((await history(fx))[0]).toBe('Changes: added, other wait for your review')
  })

  it('puts a tampered active directory back to the approved version', async () => {
    const { fx, approved } = await migrated()
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    writeFileSync(join(active, 'index.js'), 'export default "tampered"\n')
    writeFileSync(join(active, 'planted.js'), 'export const planted = 1\n')
    await start(fx)
    expect(await holdsVersion(active, approved)).toBe(true)
    expect(existsSync(join(active, 'planted.js'))).toBe(false)
    // Content planted in the empty active directory of a plugin with none approved is removed too.
    linkAs(fx, 'added', folder(fx, 'added'))
    await start(fx)
    writeFileSync(join(activeDirectory(fx.home, PROFILE, 'added'), 'planted.js'), 'x\n')
    await start(fx)
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'added'))).toEqual([])
  })

  it('moves a link back to the approved plugin\'s own folder without a pending change', async () => {
    const { fx, source } = await migrated()
    linkAs(fx, 'plug', source)
    const changes = await start(fx)
    expect(changes.pending).toEqual([])
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
    // The profile's files are again those of the version the upgrade recorded, so no new version is written.
    expect(changes.historyVersion).toBeUndefined()
    expect(await history(fx)).toEqual(['Changes: approved at upgrade plug'])
  })

  it('keeps the approved content, with nothing to review, when the folder is gone', async () => {
    const { fx, source, approved } = await migrated()
    rmSync(source, { recursive: true })
    expect((await start(fx)).pending).toEqual([])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('loads nothing for a link to its active directory that no record names a folder for', async () => {
    const fx = fixture()
    linkAs(fx, 'orphan', activeDirectory(fx.home, PROFILE, 'orphan'))
    await writeChangeLog(fx.home, PROFILE, { schema: 'delo.changes-log/1', migratedAt: NOW.toISOString(), entries: [] })
    expect(await start(fx)).toEqual({ protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] })
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'orphan'), EMPTY_CONTENT_VERSION)).toBe(true)
  })
})

describe('a work session', () => {
  it('loads the folder\'s content live with protection on and says so', async () => {
    const { fx, source, approved } = await migrated()
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    writeFileSync(join(source, 'index.js'), 'export default "editing"\n')
    const changes = await start(fx)
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    expect(readFileSync(join(active, 'index.js'), 'utf8')).toBe('export default "editing"\n')
    expect(changes).toEqual({ protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [], workSession: { plugin: 'plug' } })
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: (await storeFolder(fx.home, source)).version, kind: 'work-session' })
    expect(startNotice(changes)).toBe('Working on plug: edits in its folder load live until delorun changes done plug.\n')
  })

  it('is not reported for a plugin the profile does not link', async () => {
    const { fx, approved } = await migrated()
    await openWorkSession(fx.home, PROFILE, { plugin: 'elsewhere', source: folder(fx, 'elsewhere'), from: approved, minutes: 60 }, terminal())
    expect((await start(fx)).workSession).toBeUndefined()
  })
})

describe('a start with protection off', () => {
  it('loads a changed folder and a new link without review, approves them and logs each as unreviewed', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    expect(await start(fx)).toEqual({ protection: 'off', approvedAtUpgrade: [], pending: [], unreviewed: [] })
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    const changes = await start(fx)
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default "edited"\n')
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'added'), 'index.js'), 'utf8')).toBe('export default "one"\n')
    expect(recorded(fx, 'added')).toEqual(namingActive(fx, 'added'))
    const edited = await approvedVersion(fx, 'plug')
    const log = await readChangeLog(fx.home, PROFILE)
    const edit = log.entries.find(entry => entry.subject.plugin === 'plug' && entry.kind === 'plugin-edit')!
    const install = log.entries.find(entry => entry.subject.plugin === 'added')!
    expect(edit).toMatchObject({ state: 'applied', decidedFrom: 'unreviewed', from: approved, to: edited, summary: `Loaded without review: plug: changes in ${source}`, historyVersion: changes.historyVersion })
    expect(install).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed', to: await approvedVersion(fx, 'added'), summary: `Loaded without review: added from ${added}`, historyVersion: changes.historyVersion })
    expect(changes).toMatchObject({ protection: 'off', pending: [], unreviewed: [{ id: install.id, plugin: 'added', kind: 'plugin-install' }, { id: edit.id, plugin: 'plug', kind: 'plugin-edit' }] })
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: edited, kind: 'approved' })
    expect(await history(fx)).toContain('Changes: loaded without review added, plug')
    expect(startNotice(changes)).toBe([
      `added loaded without review, because protection is off: delorun changes show ${install.id}`,
      `plug loaded changes without review, because protection is off: delorun changes show ${edit.id}`,
      '',
    ].join('\n'))
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
    expect(await start(fx)).toEqual({ protection: 'off', approvedAtUpgrade: [], pending: [], unreviewed: [] })
  })

  it('a link back to an approved plugin\'s folder, which holds new content, loads it without review as an edit', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "edited"\n')
    linkAs(fx, 'plug', source)
    const changes = await start(fx)
    expect(changes.unreviewed).toEqual([expect.objectContaining({ plugin: 'plug', kind: 'plugin-edit' })])
    expect(recorded(fx, 'plug')).toEqual(namingActive(fx, 'plug'))
    expect((await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.decidedFrom === 'unreviewed')).toMatchObject({ from: approved, to: await approvedVersion(fx, 'plug') })
  })

  it('keeps the approved content when the folder is gone', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    rmSync(source, { recursive: true })
    expect((await start(fx)).unreviewed).toEqual([])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
  })

  it('does not load content the person declined, and loads the folder again once it holds something else', async () => {
    const { fx, source, approved } = await migrated({ protection: 'off' })
    writeFileSync(join(source, 'index.js'), 'export default "declined"\n')
    await start(fx)
    const declined = await approvedVersion(fx, 'plug')
    const log = await readChangeLog(fx.home, PROFILE)
    const loaded = log.entries.find(entry => entry.decidedFrom === 'unreviewed')!
    // The person undid it: the approved content is the one before, as `delorun changes undo` leaves it.
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: log.entries.map(entry => entry.id === loaded.id ? { ...entry, state: 'undone', decidedFrom: 'terminal', decidedAt: '2026-11-10T11:00:00.000Z' } : entry) })
    const record = await readApproved(fx.profileDir)
    await writeApproved(fx.profileDir, { ...record, plugins: { ...record.plugins, plug: { ...record.plugins.plug!, version: approved } } })

    const kept = await start(fx)
    expect(kept.unreviewed).toEqual([])
    expect(kept.pending).toEqual([{ id: loaded.id, plugin: 'plug', kind: 'plugin-edit' }])
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect(await approvedVersion(fx, 'plug')).toBe(approved)
    expect(declined).not.toBe(approved)

    writeFileSync(join(source, 'index.js'), 'export default "again"\n')
    expect((await start(fx)).unreviewed).toEqual([expect.objectContaining({ plugin: 'plug', kind: 'plugin-edit' })])
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default "again"\n')
  })

  it('a link moved before a reload loads without review and is logged, approving nothing at upgrade', async () => {
    const { fx } = await migrated({ protection: 'off' })
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    const changes = await prepareReload({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW })
    expect(changes.unreviewed).toEqual([expect.objectContaining({ plugin: 'added', kind: 'plugin-install' })])
    expect(recorded(fx, 'added')).toEqual(namingActive(fx, 'added'))
    expect(readFileSync(join(activeDirectory(fx.home, PROFILE, 'added'), 'index.js'), 'utf8')).toBe('export default "one"\n')
    expect((await readApproved(fx.profileDir)).plugins.added).toMatchObject({ source: added, approvedAt: NOW.toISOString() })
  })
})

describe('isInRuntimeStore', () => {
  it('holds for a path below runtimes/ only', () => {
    expect(isInRuntimeStore('/h', '/h/runtimes/1.0.0/x')).toBe(true)
    expect(isInRuntimeStore('/h', '/h/runtimes/..x')).toBe(true)
    expect(isInRuntimeStore('/h', '/h/runtimes')).toBe(false)
    expect(isInRuntimeStore('/h', '/h')).toBe(false)
    expect(isInRuntimeStore('/h', '/h/runtimes-old/x')).toBe(false)
  })
})
