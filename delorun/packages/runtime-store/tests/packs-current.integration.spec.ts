/**
 * `packs/current`: the release-independent link a profile follows to a pack, the start check that refuses a link to
 * another release, and the repair and install steps that keep packs and their records consistent.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RELEASE_SCHEMAS, type PackEntry, type SemanticVersion } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { HomeRuntimeStore } from '../src/seam.ts'
import { carryPacks, repairPacks, type PackCarry } from '../src/packs-carry.ts'
import { packsCurrentProblem, pointPacks } from '../src/packs-current.ts'
import { writePointers } from '../src/pointer.ts'
import { installPack, packProblems } from '../src/packs.ts'
import type { PackFiles } from '../src/packs-client.ts'
import { SUPPORTED } from '../src/launch.ts'
import { closureFiles, fixtureHome, makeWritable, PLATFORM, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')
const file = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

let fixture: FixtureHome
beforeEach(() => { fixture = fixtureHome() })
afterEach(() => { fixture.remove() })

async function publish(release: string, bodies: Readonly<Record<string, string>>, served: Map<string, Uint8Array>): Promise<Map<string, PackEntry>> {
  const entries = new Map<string, PackEntry>()
  for (const [name, body] of Object.entries(bodies)) {
    const built = await buildPackArchive(`delorun-${release}-pack-${name}.any.tar.gz`, [file('package.json', `{"name":"${name}","version":"${body}","type":"module"}`), file('index.js', `export const v = ${JSON.stringify(body)}\n`)], 1_800_000_000)
    entries.set(name, { name, version: brandString<SemanticVersion>('1.0.0'), experimental: false, variants: { any: { ...built.variant, external: [], peers: [] } } })
    served.set(built.variant.archive.name, built.bytes)
  }
  const manifest = readFileSync(join(fixture.home, 'runtimes', `delorun-${release}.manifest.json`))
  const signed = { schema: RELEASE_SCHEMAS.packs, version: release, manifest: createHash('sha256').update(manifest).digest('hex'), packs: [...entries.values()] }
  served.set(`delorun-${release}.packs.json`, Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [fixture.keys.targets]), undefined, 2)}\n`))
  served.set(`delorun-${release}.packs.log.json`, Buffer.from('{}'))
  return entries
}

async function world(packs: { v1: Record<string, string>, v2: Record<string, string> } = { v1: { demo: 'one' }, v2: { demo: 'two' } }) {
  await fixture.install('0.1.0', closureFiles('0.1.0'))
  await fixture.install('0.2.0', closureFiles('0.2.0'))
  const served = new Map<string, Uint8Array>()
  const one = await publish('0.1.0', packs.v1, served)
  const two = await publish('0.2.0', packs.v2, served)
  const paths = fixture.store.paths
  writeFileSync(paths.releaseFiles(V1).packs, served.get('delorun-0.1.0.packs.json')!)
  writeFileSync(paths.releaseFiles(V1).packsBundle, served.get('delorun-0.1.0.packs.log.json')!)
  writeFileSync(paths.releaseFiles(V2).packs, served.get('delorun-0.2.0.packs.json')!)
  writeFileSync(paths.releaseFiles(V2).packsBundle, served.get('delorun-0.2.0.packs.log.json')!)
  const install = (release: typeof V1, entry: PackEntry) => installPack({ paths, release, entry, platform: PLATFORM, archive: served.get(entry.variants.any!.archive.name)!, fetchExternal: () => Promise.reject(new Error('none')) })
  for (const entry of one.values()) await install(V1, entry)
  const filesFor = (_version: unknown): Promise<PackFiles> => Promise.resolve({ fetchRelease: name => Promise.resolve(served.get(name)), fetchExternal: () => Promise.reject(new Error('none')) })
  const carry: PackCarry = { paths, root: () => Promise.resolve(fixture.root), filesFor, checkLog: () => ({ ok: true }) }
  const store = new HomeRuntimeStore({
    store: fixture.store, profile: 'default', root: () => Promise.resolve(fixture.root), fullCheckDays: 7,
    openChannel: () => Promise.reject(new Error('the target is installed; no channel opens')),
    report: { build: () => Promise.resolve({ report: {}, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false }) },
    carryPacks: (from, to) => carryPacks(carry, from, to),
  })
  return { carry, store, paths, install, one, two }
}

const linked = (paths: { packLink: (name: string) => string }, name: string): string => readFileSync(join(paths.packLink(name), 'index.js'), 'utf8')

describe('the link a profile follows to a pack', () => {
  it('names the running release through an install, an update, a rollback and a second update', async () => {
    const { store, paths } = await world()
    expect(linked(paths, 'demo')).toContain('"one"')
    await store.prepare(V2, () => {}, () => {})
    expect(linked(paths, 'demo')).toContain('"one"')
    await fixture.store.switchTo(V1, V2)
    expect(linked(paths, 'demo')).toContain('"two"')
    await fixture.store.restore({ current: V1, previous: undefined as never })
    expect(linked(paths, 'demo')).toContain('"one"')
    await fixture.store.switchTo(V1, V2)
    expect(linked(paths, 'demo')).toContain('"two"')
    expect(readlinkSync(join(paths.packs, 'current'))).toBe(V2)
  })

  it('is never removed by retention while its release is current or previous', async () => {
    const { store, paths } = await world()
    await store.prepare(V2, () => {}, () => {})
    await fixture.store.switchTo(V1, V2)
    await fixture.store.retain()
    expect(linked(paths, 'demo')).toContain('"two"')
    expect(existsSync(paths.pack(V1, 'demo'))).toBe(true)
  })
})

describe('the start check of the link', () => {
  it('refuses a link to another release and offers delorun recover packs, and a repair points it right', async () => {
    const { carry, paths } = await world()
    await pointPacks(paths, V2)
    expect(await packsCurrentProblem(paths, V1)).toMatch(/names 0\.2\.0, not the running release 0\.1\.0/u)
    await expect(fixture.store.checkRuntime(V1, fixture.root)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED', remedies: expect.arrayContaining(['recover-packs']) })
    await repairPacks(carry, V1)
    await expect(fixture.store.checkRuntime(V1, fixture.root)).resolves.toBeDefined()
  })

  it('refuses a missing link when the release has packs installed', async () => {
    const { paths } = await world()
    rmSync(join(paths.packs, 'current'))
    expect(await packsCurrentProblem(paths, V1)).toMatch(/packs\/current is missing/u)
  })
})

describe('a switch that stopped between the pointers and the link', () => {
  const launch = () => fixture.store.prepareLaunch({ launcher: SUPPORTED, root: fixture.root, mode: 'warn', fullCheckDays: 7, profile: 'default', args: ['status'] })

  it('is finished by the next start, offline, and the pack then loads from the running release', async () => {
    const { store, paths } = await world()
    await store.prepare(V2, () => {}, () => {})
    // The state a process killed after writing `current` leaves: the pointers name 0.2.0, the link still names 0.1.0.
    await writePointers(paths, { current: V2, previous: V1 })
    expect(await packsCurrentProblem(paths, V2)).toMatch(/names 0\.1\.0/u)
    await expect(launch()).resolves.toMatchObject({ version: V2 })
    expect(linked(paths, 'demo')).toContain('"two"')
  })

  it('is finished by recover packs before it fetches anything, so it works without a connection', async () => {
    const { paths } = await world()
    await writePointers(paths, { current: V2, previous: V1 })
    const offline: PackCarry = { paths, root: () => Promise.resolve(fixture.root), filesFor: () => Promise.reject(new Error('no connection')), checkLog: () => ({ ok: true }) }
    await expect(repairPacks(offline, V2)).rejects.toThrow(/no connection/u)
    expect(await packsCurrentProblem(paths, V2)).toBeUndefined()
  })
})

describe('a repair', () => {
  it('removes a directory the signed packs file does not list, which would refuse every start', async () => {
    const { carry, paths } = await world()
    mkdirSync(join(paths.packs, V1, 'stranger'), { recursive: true })
    writeFileSync(join(paths.packs, V1, 'stranger', 'x.js'), 'x')
    await expect(fixture.store.checkRuntime(V1, fixture.root)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED', remedies: expect.arrayContaining(['recover-packs']) })
    await repairPacks(carry, V1)
    expect(existsSync(join(paths.packs, V1, 'stranger'))).toBe(false)
    await expect(fixture.store.checkRuntime(V1, fixture.root)).resolves.toBeDefined()
  })
})

describe('an install', () => {
  it('writes the record before the pack, so a crash between the two leaves a record the next install overwrites', async () => {
    const { paths, install, one } = await world()
    // The state a crash after the record and before the rename leaves: the record exists, the pack does not.
    makeWritable(paths.pack(V1, 'demo'))
    rmSync(paths.pack(V1, 'demo'), { recursive: true, force: true })
    expect(existsSync(paths.packRecord(V1, 'demo'))).toBe(true)
    await install(V1, one.get('demo')!)
    expect(await packProblems(paths, V1, one.get('demo')!, PLATFORM)).toEqual([])
  })

  it('refuses a record that names a file outside a pinned external package or one the signed list holds', async () => {
    const { paths, one } = await world()
    const record = paths.packRecord(V1, 'demo')
    const parsed = JSON.parse(readFileSync(record, 'utf8')) as { externals: unknown[] }
    makeWritable(record)
    writeFileSync(record, JSON.stringify({ ...parsed, externals: [{ path: 'index.js', length: 1, sha256: 'a'.repeat(64), mode: '0644' }] }))
    expect(await packProblems(paths, V1, one.get('demo')!, PLATFORM)).toEqual([expect.stringMatching(/index\.js.*not inside a pinned external package/u)])
    writeFileSync(record, JSON.stringify({ ...parsed, externals: [{ path: 'lib/x.js', length: 1, sha256: 'a'.repeat(64), mode: '0644' }] }))
    expect((await packProblems(paths, V1, one.get('demo')!, PLATFORM))[0]).toMatch(/lib\/x\.js/u)
  })
})

describe('a carry that fails', () => {
  it('removes only the packs it created, not one the new release already had', async () => {
    const { carry, paths, two, install } = await world({ v1: { aa: 'one', bb: 'one' }, v2: { aa: 'two' } })
    await install(V2, two.get('aa')!)
    await expect(carryPacks(carry, V1, V2)).rejects.toMatchObject({ code: 'NO_SUCH_PACK' })
    expect(existsSync(paths.pack(V2, 'aa'))).toBe(true)
    expect(existsSync(paths.pack(V2, 'bb'))).toBe(false)
  })
})

describe('the link and a stray symlink', () => {
  it('is replaced by a rename and never leaves a half-made link behind', async () => {
    const { paths } = await world()
    symlinkSync('nowhere', join(paths.packs, '.current.stale'))
    await pointPacks(paths, V1)
    await pointPacks(paths, V2)
    expect(readlinkSync(join(paths.packs, 'current'))).toBe(V2)
  })
})
