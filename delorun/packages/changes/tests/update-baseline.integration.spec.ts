/**
 * An update's successor makes the release's own pack files the baseline, and nothing else: the folder must be exactly
 * the verified signed pack, every approved file that differs must be a signed one, and a person's edit keeps waiting.
 */
import { createHash } from 'node:crypto'
import { readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRuntimeVersion } from '@delorun/runtime-store'
import { enforceApprovedContent, followApprovedContent, prepareReload, recordsOf, repointActiveCopies, revertDecisions, startNotice, type StartChanges } from '../src/enforce.ts'
import { checkLoadedContent } from '../src/invariants.ts'
import { readActiveRecord, readApproved, readChangeLog, writeActiveRecord, writeApproved, writeChangeLog } from '../src/records.ts'
import { activeDirectory } from '../src/paths.ts'
import { manifestOf } from '../src/tree.ts'
import { ACTIVE_RECORD_SCHEMA, type ObjectDigest, type VersionEntry, type VersionManifest } from '../src/types.ts'
import { storeFolder } from '../src/store.ts'
import { baselineMayApply, baselineOfPacks, LAST_RELEASE_WITH_BUILD_PATHS, leftReleaseWithBuildPaths, supersededByUpdate, withoutBuildFolder, type SignedPackFiles, type UpdateBaseline } from '../src/update-baseline.ts'
import { approvedVersion, fixture, history, linkAs, NOW, PROFILE, start, type Fixture } from './profile-fixture.ts'
import { writeFiles } from './support.ts'

vi.setConfig({ testTimeout: 30_000 })

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
type Files = Readonly<Record<string, string>>

/** A pack's `package.json` whose dependency names a build's temporary folder, as releases up to 0.1.0-preview.2.1 shipped it. */
const manifest = (folder: string): string => `{"name":"pkg","version":"1.0.0","dependencies":{"brand":"file:///var/tmp/delorun-release-build-${folder}/source/brand"}}\n`
const stable = '{"name":"pkg","version":"1.0.0","dependencies":{"brand":"1.0.0"}}\n'
const lock = (folder: string): string => `importers:\n  .:\n    brand: file:///var/tmp/delorun-release-build-${folder}/source/brand\n`

/** What a verified packs file lists for the pack, `peers` none. */
function signed(release: string, files: Files, texts: readonly string[] = ['package.json', 'pnpm-lock.yaml']): SignedPackFiles {
  return {
    name: 'pkg',
    release: parseRuntimeVersion(release)!,
    files: new Map(Object.entries(files).map(([path, body]) => [path, { sha256: sha(body), executable: false }])),
    peers: [],
    text: path => Promise.resolve(texts.includes(path) ? files[path] : undefined),
  }
}

/** The pack folder an installed release holds, and the link a profile follows. */
function install(fx: Fixture, release: string, files: Files): void {
  writeFiles(join(fx.home, 'packs', release, 'pkg', 'package'), files)
}

function point(fx: Fixture, release: string): void {
  const link = join(fx.home, 'packs', 'current')
  rmSync(link, { force: true })
  symlinkSync(release, link)
}

/** A profile that approved the pack of release 2.0.0 as it was, then an update that moved `packs/current` to 2.2.0. */
async function updated(approvedFiles: Files, folderFiles: Files, options: { readonly protection?: 'on' | 'off', readonly from?: Files } = {}): Promise<{ fx: Fixture, source: string, approved: Awaited<ReturnType<typeof approvedVersion>> }> {
  const fx = fixture(options.protection === undefined ? {} : { protection: options.protection })
  install(fx, '2.0.0', approvedFiles)
  point(fx, '2.0.0')
  const source = join(fx.home, 'packs', 'current', 'pkg', 'package')
  linkAs(fx, 'pkg', source)
  await start(fx)
  const approved = await approvedVersion(fx, 'pkg')
  install(fx, '2.2.0', folderFiles)
  point(fx, '2.2.0')
  return { fx, source, approved }
}

const request = (fx: Fixture, baseline?: UpdateBaseline): Parameters<typeof enforceApprovedContent>[0] => ({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW, ...baseline === undefined ? {} : { updateBaseline: baseline } })

function baselineOf(from: Files, to: Files): UpdateBaseline {
  return baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [signed('0.1.0-preview.2.1', from), signed('2.2.0', to)])
}

const code = 'export default "pkg"\n'
const released21 = { 'package.json': manifest('Yyyyyy'), 'pnpm-lock.yaml': lock('Yyyyyy'), 'index.js': code }
const released22 = { 'package.json': stable, 'pnpm-lock.yaml': 'importers: {}\n', 'index.js': 'export default "pkg 2"\n' }

describe('an update replaces the approved pack content with the release\'s own files', () => {
  it('closes the owner\'s case: approved and previous release differ only by the build folder, the new release is signed', async () => {
    const { fx, source, approved } = await updated({ ...released21, 'package.json': manifest('Xxxxxx'), 'pnpm-lock.yaml': lock('Xxxxxx') }, released22)
    expect((await start(fx)).pending).toHaveLength(1)

    const changes = await enforceApprovedContent(request(fx, baselineOf(released21, released22)))

    expect(changes.pending).toEqual([])
    expect(changes.unreviewed).toEqual([])
    const version = (await storeFolder(fx.home, source)).version
    expect((await readApproved(fx.profileDir)).plugins.pkg).toMatchObject({ source, version })
    const entry = (await readChangeLog(fx.home, PROFILE)).entries.find(each => each.decidedFrom === 'update')!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', from: approved, to: version, summary: 'Replaced by the update to 2.2.0: pkg', historyVersion: changes.historyVersion })
    expect(changes.replacedByUpdate).toEqual([{ id: entry.id, plugin: 'pkg', to: '2.2.0' }])
    expect(await history(fx)).toContain('Changes: replaced by the update to 2.2.0 pkg')
    expect(startNotice(changes)).toContain('pkg now holds the files of the update to 2.2.0')
    expect((await start(fx)).pending).toEqual([])
  })

  it('closes a change whose only difference is the previous release\'s own files, whichever protection', async () => {
    for (const protection of ['on', 'off'] as const) {
      const { fx, approved } = await updated(released21, released22, { protection })
      const changes = await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
      expect(changes.pending).toEqual([])
      expect(changes.unreviewed).toEqual([])
      expect(await approvedVersion(fx, 'pkg')).not.toBe(approved)
      expect((await readChangeLog(fx.home, PROFILE)).entries.filter(each => each.decidedFrom === 'update')).toHaveLength(1)
    }
  })

  it('asks for the signed files of a pack only when a change waits on it, and still checks that pack fully', async () => {
    const { fx, source, approved } = await updated(released21, released22)
    // A second pack of the profile, unchanged by the update: its folder is what its approved content is.
    const unchanged = { 'package.json': '{"name":"other","version":"1.0.0"}\n', 'index.js': 'export default "other"\n' }
    writeFiles(join(fx.home, 'packs', '2.0.0', 'other', 'package'), unchanged)
    writeFiles(join(fx.home, 'packs', '2.2.0', 'other', 'package'), unchanged)
    linkAs(fx, 'other', join(fx.home, 'packs', 'current', 'other', 'package'))
    point(fx, '2.0.0')
    await start(fx)
    point(fx, '2.2.0')
    const asked: string[] = []
    const inner = baselineOf(released21, released22)
    const baseline: UpdateBaseline = { ...inner, packsFor: (name) => { asked.push(name); return inner.packsFor(name) } }

    const changes = await enforceApprovedContent(request(fx, baseline))

    expect(asked).toEqual(['pkg'])
    expect(changes.replacedByUpdate).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).not.toBe(approved)
    expect((await storeFolder(fx.home, source)).version).toBe(await approvedVersion(fx, 'pkg'))
  })

  it('never replaces content for a start without a baseline', async () => {
    const { fx, approved } = await updated(released21, released22)
    expect((await enforceApprovedContent(request(fx))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('never replaces content for a reload, even one that moves a link to the pack\'s folder', async () => {
    const { fx, source, approved } = await updated(released21, released22)
    // A restore or an undo writes the link back to the folder; the reload then decides the plugin it moved.
    linkAs(fx, 'pkg', source)
    const changes = await prepareReload(request(fx, baselineOf(released21, released22)))
    expect(changes.replacedByUpdate).toBeUndefined()
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    expect((await readChangeLog(fx.home, PROFILE)).entries.some(each => each.decidedFrom === 'update')).toBe(false)
  })
})

describe('what an update never replaces', () => {
  it('leaves an approved edit waiting: a file the release does not list', async () => {
    const { fx, approved } = await updated({ ...released21, 'index.js': 'export default "edited"\n' }, released22)
    const changes = await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
    expect(changes.pending).toHaveLength(1)
    expect(changes.replacedByUpdate).toBeUndefined()
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    expect((await readChangeLog(fx.home, PROFILE)).entries.some(each => each.decidedFrom === 'update')).toBe(false)
  })

  it('leaves an edit waiting in any other line of package.json or pnpm-lock.yaml', async () => {
    for (const edited of [{ 'package.json': manifest('Xxxxxx').replace('"1.0.0"', '"1.0.1"') }, { 'pnpm-lock.yaml': `${lock('Xxxxxx')}  planted: file:///elsewhere\n` }]) {
      const { fx, approved } = await updated({ ...released21, 'package.json': manifest('Xxxxxx'), 'pnpm-lock.yaml': lock('Xxxxxx'), ...edited }, released22)
      expect((await enforceApprovedContent(request(fx, baselineOf(released21, released22)))).pending).toHaveLength(1)
      expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    }
  })

  it('applies the build folder allowance to no other file', async () => {
    const other = { ...released21, 'index.js': 'import "/var/tmp/delorun-release-build-Xxxxxx/x"\n' }
    const { fx, approved } = await updated(other, released22)
    const from = { ...released21, 'index.js': 'import "/var/tmp/delorun-release-build-Yyyyyy/x"\n' }
    const listsText: UpdateBaseline = baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [signed('0.1.0-preview.2.1', from, ['package.json', 'pnpm-lock.yaml', 'index.js']), signed('2.2.0', released22)])
    expect((await enforceApprovedContent(request(fx, listsText))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('does not close a change that mixes release files with an edit, and the whole change keeps waiting', async () => {
    const { fx, approved } = await updated({ ...released21, 'package.json': manifest('Xxxxxx'), 'extra.js': 'planted\n' }, released22)
    const changes = await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
    expect(changes.pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('treats a folder that is not exactly the signed pack as a person\'s change', async () => {
    const planted = { ...released22, 'planted.js': 'x\n' }
    for (const folder of [planted, { ...released22, 'index.js': 'tampered\n' }, { 'package.json': stable }]) {
      const { fx, approved } = await updated(released21, folder)
      expect((await enforceApprovedContent(request(fx, baselineOf(released21, released22)))).pending).toHaveLength(1)
      expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    }
  })

  it('treats a pack whose digest the verified list does not give as a person\'s change', async () => {
    const { fx, approved } = await updated(released21, released22)
    const wrong: UpdateBaseline = baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [signed('0.1.0-preview.2.1', released21), signed('2.2.0', { ...released22, 'index.js': 'another\n' })])
    expect((await enforceApprovedContent(request(fx, wrong))).pending).toHaveLength(1)
    const missing: UpdateBaseline = baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [signed('0.1.0-preview.2.1', released21)])
    expect((await enforceApprovedContent(request(fx, missing))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('counts only the packs files of the two releases of the update', async () => {
    const older = { ...released21, 'index.js': 'export default "pkg 1.9"\n' }
    const { fx, approved } = await updated(older, released22)
    const baseline: UpdateBaseline = baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [signed('1.9.0', older), signed('0.1.0-preview.2.1', released21), signed('2.2.0', released22)])
    expect((await enforceApprovedContent(request(fx, baseline))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('leaves a plugin that is not a pack of the home alone', async () => {
    const fx = fixture()
    const source = join(fx.root, 'outside')
    writeFiles(source, released21)
    linkAs(fx, 'pkg', source)
    await start(fx)
    const approved = await approvedVersion(fx, 'pkg')
    writeFiles(source, released22)
    expect((await enforceApprovedContent(request(fx, baselineOf(released21, released22)))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('leaves content the person declined waiting', async () => {
    const { fx, source, approved } = await updated(released21, released22)
    const version = (await storeFolder(fx.home, source)).version
    const log = await readChangeLog(fx.home, PROFILE)
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: [...log.entries, { id: 'c0000000000' as never, kind: 'plugin-edit', state: 'discarded', subject: { plugin: 'pkg', source }, from: approved, to: version, summary: 'declined', createdAt: NOW.toISOString(), decidedAt: NOW.toISOString(), decidedFrom: 'terminal' }] })
    expect((await enforceApprovedContent(request(fx, baselineOf(released21, released22)))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })
})

describe('the build folder allowance', () => {
  const approvedTemp = { ...released21, 'package.json': manifest('Xxxxxx'), 'pnpm-lock.yaml': lock('Xxxxxx') }

  it('ends with the last release that shipped build folder names', () => {
    expect(LAST_RELEASE_WITH_BUILD_PATHS).toBe('0.1.0-preview.2.1')
    for (const left of ['0.1.0-preview.2.1', '0.1.0-preview.2', '0.1.0-preview.1.2', '0.1.0-preview.1']) expect(leftReleaseWithBuildPaths(left)).toBe(true)
    for (const left of ['0.1.0-preview.2.2', '0.1.0-preview.3', '0.1.0-preview.10', '0.1.0', '0.2.0', '1.0.0', '0.1.0-rc.1', '0.1.0-preview.2.1.1', 'x0.1.0-preview.1']) expect(leftReleaseWithBuildPaths(left)).toBe(false)
  })

  it('closes the build folder difference only for an update that leaves such a release', async () => {
    const leaving = (from: string): UpdateBaseline => baselineOfPacks(from, '0.1.0-preview.4', [signed(from, released21), signed('0.1.0-preview.4', released22)])
    for (const [from, closed] of [['0.1.0-preview.2.1', true], ['0.1.0-preview.2.2', false], ['0.1.0-preview.3', false]] as const) {
      const { fx, approved } = await updated(approvedTemp, released22)
      const changes = await enforceApprovedContent(request(fx, leaving(from)))
      expect(changes.pending).toHaveLength(closed ? 0 : 1)
      expect(await approvedVersion(fx, 'pkg') === approved).toBe(!closed)
    }
  })
})

describe('supersededByUpdate', () => {
  it('replaces only the exact build folder segment', () => {
    expect(withoutBuildFolder('file:///var/tmp/delorun-release-build-Ab12Cd/source/x')).toBe('file:///var/tmp/delorun-release-build-TOKEN/source/x')
    expect(withoutBuildFolder('delorun-release-build-Ab12Cd')).toBe('delorun-release-build-Ab12Cd')
    expect(withoutBuildFolder('/var/tmp/delorun-release-build-Ab12Cd')).toBe('/var/tmp/delorun-release-build-Ab12Cd')
    expect(withoutBuildFolder('/tmp/delorun-release-build/source')).toBe('/tmp/delorun-release-build/source')
  })

  it('refuses a plugin the release this process runs does not list as a pack', async () => {
    const { fx, source } = await updated(released21, released22)
    const stored = await storeFolder(fx.home, source)
    const baseline: UpdateBaseline = baselineOfPacks('0.1.0-preview.2.1', '2.2.0', [{ ...signed('2.2.0', released22), name: 'another' }])
    expect(await supersededByUpdate(fx.home, baseline, { plugin: 'pkg', before: stored.manifest, after: stored.manifest })).toBe(false)
  })
})

/** The entries of a content version, from files by path and body, and optional extra entries. */
function content(files: Files, extra: readonly VersionEntry[] = []): VersionManifest {
  return manifestOf([...Object.entries(files).map(([path, body]): VersionEntry => ({ type: 'file', path, digest: sha(body) as ObjectDigest, size: body.length, executable: false })), ...extra])
}

const binary: VersionEntry = { type: 'file', path: 'node_modules/ext/bin', digest: sha('an external package\'s binary') as ObjectDigest, size: 1, executable: true }
const runtimeLink: VersionEntry = { type: 'link', path: 'node_modules/peer', target: 'peer', outside: true, runtime: true }

describe('the entries that differ decide, as the agent packs of 2.1 to 2.2 show', () => {
  // What the real pair held: package.json and pnpm-lock.yaml replaced by the new release's signed ones, pnpm-workspace.yaml dropped
  // by it, and entries no signed list holds (an external package's binary, the runtime links) unchanged on both sides.
  const from = { ...released21, 'pnpm-workspace.yaml': 'packages: []\n' }
  const to = released22
  const baseline = baselineOf(from, to)
  const unchanged = [binary, runtimeLink]

  it('closes when every differing entry is a signed file or a file the release dropped, whatever else is unchanged', async () => {
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content(to, unchanged) })).toBe(true)
  })

  it('waits when a link differs, or a file the release signs is not what the folder holds', async () => {
    const moved: VersionEntry = { ...runtimeLink, target: 'another' }
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, [binary, runtimeLink]), after: content(to, [binary, moved]) })).toBe(false)
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, [binary]), after: content(to, [binary, runtimeLink]) })).toBe(false)
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content({ ...to, 'index.js': 'tampered\n' }, unchanged) })).toBe(false)
  })

  it('waits for an entry that differs only in its execute bit, an unsigned new file, or an external binary that changed', async () => {
    const executable: VersionEntry = { type: 'file', path: 'index.js', digest: sha(to['index.js']) as ObjectDigest, size: 1, executable: true }
    const withoutIndex = { ...to }
    delete (withoutIndex as Record<string, string>)['index.js']
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content(withoutIndex, [...unchanged, executable]) })).toBe(false)
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content({ ...to, 'new.js': 'unsigned\n' }, unchanged) })).toBe(false)
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content(to, [{ ...binary, digest: sha('another binary') as ObjectDigest }, runtimeLink]) })).toBe(false)
  })

  it('closes a removal only when the release the update left lists the file with the approved digest and this release does not list it', async () => {
    const dropped = { ...from }
    const kept = { ...to, 'pnpm-workspace.yaml': from['pnpm-workspace.yaml'] }
    // The folder lacks pnpm-workspace.yaml, which the release this process runs does not list: closes.
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(dropped, unchanged), after: content(to, unchanged) })).toBe(true)
    // The approved file is not the digest the previous release signed, or the previous release does not list it: waits.
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content({ ...dropped, 'pnpm-workspace.yaml': 'packages: [edited]\n' }, unchanged), after: content(to, unchanged) })).toBe(false)
    expect(await supersededByUpdate('/h', baselineOf(released21, to), { plugin: 'pkg', before: content(dropped, unchanged), after: content(to, unchanged) })).toBe(false)
    // The release this process runs still lists it, and the folder lacks it (a person deleted it): waits.
    const stillListed = baselineOf(from, kept)
    expect(await supersededByUpdate('/h', stillListed, { plugin: 'pkg', before: content(dropped, unchanged), after: content(to, unchanged) })).toBe(false)
  })

  it('closes an added entry only when it was absent before and the folder holds exactly what this release signs for it', async () => {
    const added = { ...to, 'added.js': 'export const added = 1\n' }
    const withAdded = baselineOf(from, added)
    expect(await supersededByUpdate('/h', withAdded, { plugin: 'pkg', before: content(from, unchanged), after: content(added, unchanged) })).toBe(true)
    expect(await supersededByUpdate('/h', withAdded, { plugin: 'pkg', before: content(from, unchanged), after: content({ ...to, 'added.js': 'another\n' }, unchanged) })).toBe(false)
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content(from, unchanged), after: content(added, unchanged) })).toBe(false)
  })

  it('waits when an approved entry that differs is not what the release the update left signed', async () => {
    expect(await supersededByUpdate('/h', baseline, { plugin: 'pkg', before: content({ ...from, 'index.js': 'edited\n' }, unchanged), after: content(to, unchanged) })).toBe(false)
  })
})

/** What a start prints names the replacement once, in the person's words. */
describe('the start notice', () => {
  it('is silent without a replacement', () => {
    const none: StartChanges = { protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] }
    expect(startNotice(none)).toBe('')
  })
})

describe('a failed health check after the baseline advanced, with protection on', () => {
  const request2 = (fx: Fixture): Parameters<typeof checkLoadedContent>[0] => ({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })

  it('lets the predecessor boot again: its active copies follow the approved record the rollback restored', async () => {
    const { fx, source, approved } = await updated(released21, released22)
    const approvedBefore = await readApproved(fx.profileDir)
    await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
    expect(await approvedVersion(fx, 'pkg')).not.toBe(approved)
    // The rollback of the failed update restores the profile's files, the approved record included, not active.json.
    await writeApproved(fx.profileDir, approvedBefore)
    expect(await checkLoadedContent(request2(fx))).toEqual([expect.stringContaining('loads version')])

    expect(await followApprovedContent(request(fx))).toEqual(['pkg'])
    await repointActiveCopies(request(fx))

    expect(await checkLoadedContent(request2(fx))).toEqual([])
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.pkg).toEqual({ version: approved, kind: 'approved' })
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    expect((await storeFolder(fx.home, source)).version).not.toBe(approved)
    expect((await enforceApprovedContent(request(fx))).pending).toHaveLength(1)
  })

  it('changes nothing when the records agree, and leaves a work session\'s or left-out copy alone', async () => {
    const { fx, approved } = await updated(released21, released22)
    expect(await followApprovedContent(request(fx))).toEqual([])
    const record = await readActiveRecord(fx.home, PROFILE)
    const other = { version: (await storeFolder(fx.home, join(fx.home, 'packs', '2.2.0', 'pkg', 'package'))).version, kind: 'work-session' as const }
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { pkg: other } })
    expect(await followApprovedContent(request(fx))).toEqual([])
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.pkg).toEqual(other)
    expect(record.plugins.pkg).toEqual({ version: approved, kind: 'approved' })
  })
})

describe('undoing a start\'s decisions', () => {
  it('puts back the approved and active entries the baseline changed, so a predecessor without followApprovedContent resumes', async () => {
    const { fx, approved } = await updated(released21, released22)
    const before = await recordsOf(request(fx))
    await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
    const after = await recordsOf(request(fx))
    expect(after.active.pkg).not.toEqual(before.active.pkg)

    expect(await revertDecisions(request(fx), before, after)).toEqual(['pkg'])

    expect(await recordsOf(request(fx))).toEqual(before)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
    // The predecessor re-points its copies to what the record names, as every release does at its start.
    await repointActiveCopies(request(fx))
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
  })

  it('fills the active directory of an entry the start added with nothing, so a predecessor that records none resumes', async () => {
    const { fx } = await updated(released21, released22)
    // The previous start held nothing for the pack: no record, an empty directory.
    const record = await readActiveRecord(fx.home, PROFILE)
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: Object.fromEntries(Object.entries(record.plugins).filter(([name]) => name !== 'pkg')) })
    const directory = activeDirectory(fx.home, PROFILE, 'pkg')
    rmSync(directory, { recursive: true, force: true })
    const before = await recordsOf(request(fx))
    expect(before.active.pkg).toBeUndefined()
    await enforceApprovedContent(request(fx, baselineOf(released21, released22)))
    const after = await recordsOf(request(fx))
    expect(after.active.pkg).toBeDefined()
    expect(readdirSync(directory).length).toBeGreaterThan(0)

    expect(await revertDecisions(request(fx), before, after)).toContain('pkg')

    expect((await recordsOf(request(fx))).active.pkg).toBeUndefined()
    expect(readdirSync(directory)).toEqual([])
    await repointActiveCopies(request(fx))
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
  })

  it('does nothing, and takes no lock, when the start changed nothing', async () => {
    const { fx } = await updated(released21, released22)
    const records = await recordsOf(request(fx))
    expect(await revertDecisions({ ...request(fx), lockWaitMs: 0 }, records, records)).toEqual([])
  })

  it('keeps an entry that changed after the start, and removes an entry the start added', async () => {
    const { fx } = await updated(released21, released22)
    const before = await recordsOf(request(fx))
    const added = { version: before.active.pkg!.version!, kind: 'approved' as const }
    const started = { ...before, active: { ...before.active, pkg: { version: added.version, kind: 'work-session' as const }, extra: added } }
    const later = { version: (await storeFolder(fx.home, join(fx.home, 'packs', '2.2.0', 'pkg', 'package'))).version, kind: 'work-session' as const }
    // A later writer changed `pkg`, so only `extra`, which still equals what the start wrote, goes.
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { pkg: later, extra: added } })

    expect(await revertDecisions(request(fx), before, started)).toEqual(['extra'])

    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({ pkg: later })
  })
})

describe('baselineMayApply', () => {
  const baseline = baselineOfPacks('1.0.0', '2.0.0', [signed('1.0.0', { 'package.json': '{}' })])
  const approved = (source: string, name = 'pkg'): Parameters<typeof baselineMayApply>[1] => ({ schema: 'delorun.changes-approved/1', plugins: { [name]: { source, version: sha('v') as never, approvedAt: NOW.toISOString() } } })

  it('applies for an approved plugin linked from the pack store that a release lists', () => {
    expect(baselineMayApply('/h', approved('/h/packs/current/pkg/package'), baseline)).toBe(true)
  })

  it('does not apply for a plugin outside the pack store, a pack no release lists, or no plugin', () => {
    expect(baselineMayApply('/h', approved('/elsewhere/pkg'), baseline)).toBe(false)
    expect(baselineMayApply('/h', approved('/h/packs/current/other/package', 'other'), baseline)).toBe(false)
    expect(baselineMayApply('/h', { schema: 'delorun.changes-approved/1', plugins: {} }, baseline)).toBe(false)
  })
})
