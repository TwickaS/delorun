/**
 * An update's successor makes the release's own pack files the baseline, and nothing else: the folder must be exactly
 * the verified signed pack, every approved file that differs must be a signed one, and a person's edit keeps waiting.
 */
import { createHash } from 'node:crypto'
import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRuntimeVersion } from '@delorun/runtime-store'
import { enforceApprovedContent, prepareReload, startNotice, type StartChanges } from '../src/enforce.ts'
import { readApproved, readChangeLog, writeChangeLog } from '../src/records.ts'
import { storeFolder } from '../src/store.ts'
import { supersededByUpdate, withoutBuildFolder, type SignedPackFiles, type UpdateBaseline } from '../src/update-baseline.ts'
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
    texts: new Map(Object.entries(files).filter(([path]) => texts.includes(path))),
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
  return { from: '2.1.0', to: '2.2.0', packs: [signed('2.1.0', from), signed('2.2.0', to)] }
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

  it('never replaces content for a start without a baseline, nor for a reload', async () => {
    const { fx, approved } = await updated(released21, released22)
    expect((await enforceApprovedContent(request(fx))).pending).toHaveLength(1)
    await prepareReload({ ...request(fx, baselineOf(released21, released22)) })
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
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
    const listsText: UpdateBaseline = { from: '2.1.0', to: '2.2.0', packs: [signed('2.1.0', from, ['package.json', 'pnpm-lock.yaml', 'index.js']), signed('2.2.0', released22)] }
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
    const wrong: UpdateBaseline = { from: '2.1.0', to: '2.2.0', packs: [signed('2.1.0', released21), signed('2.2.0', { ...released22, 'index.js': 'another\n' })] }
    expect((await enforceApprovedContent(request(fx, wrong))).pending).toHaveLength(1)
    const missing: UpdateBaseline = { from: '2.1.0', to: '2.2.0', packs: [signed('2.1.0', released21)] }
    expect((await enforceApprovedContent(request(fx, missing))).pending).toHaveLength(1)
    expect(await approvedVersion(fx, 'pkg')).toBe(approved)
  })

  it('counts only the packs files of the two releases of the update', async () => {
    const older = { ...released21, 'index.js': 'export default "pkg 1.9"\n' }
    const { fx, approved } = await updated(older, released22)
    const baseline: UpdateBaseline = { from: '2.1.0', to: '2.2.0', packs: [signed('1.9.0', older), signed('2.1.0', released21), signed('2.2.0', released22)] }
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
    const baseline: UpdateBaseline = { from: '2.1.0', to: '2.2.0', packs: [{ ...signed('2.2.0', released22), name: 'another' }] }
    expect(await supersededByUpdate(fx.home, baseline, { plugin: 'pkg', before: stored.manifest, after: stored.manifest })).toBe(false)
  })
})

/** What a start prints names the replacement once, in the person's words. */
describe('the start notice', () => {
  it('is silent without a replacement', () => {
    const none: StartChanges = { protection: 'on', approvedAtUpgrade: [], pending: [], unreviewed: [] }
    expect(startNotice(none)).toBe('')
  })
})
