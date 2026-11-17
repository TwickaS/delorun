/**
 * Packs across an update, a rollback and a repair: the update installs the new release's packs before `current` moves
 * and fails loudly when it cannot; a rollback keeps the previous release's packs; a repair fetches a changed pack again.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RELEASE_SCHEMAS, type PackEntry, type SemanticVersion } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { HomeRuntimeStore } from '../src/seam.ts'
import { carryPacks, repairPacks, type PackCarry } from '../src/packs-carry.ts'
import { installPack } from '../src/packs.ts'
import type { PackFiles } from '../src/packs-client.ts'
import { closureFiles, fixtureHome, makeWritable, PLATFORM, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')
const file = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

let fixture: FixtureHome
beforeEach(() => { fixture = fixtureHome() })
afterEach(() => { fixture.remove() })

/** Sign a release's packs file over its stored manifest, and keep the archives it names. */
async function publish(release: string, bodies: Readonly<Record<string, string>>, served: Map<string, Uint8Array>): Promise<Map<string, PackEntry>> {
  const entries = new Map<string, PackEntry>()
  for (const [name, body] of Object.entries(bodies)) {
    const built = await buildPackArchive(`delorun-${release}-pack-${name}.any.tar.gz`, [file('package.json', `{"name":"${name}","version":"${body}","type":"module"}`), file('index.js', `export const v = ${JSON.stringify(body)}\n`)], 1_800_000_000)
    entries.set(name, { name, version: brandString<SemanticVersion>('1.0.0'), experimental: false, variants: { any: { ...built.variant, external: [], peers: [] } } })
    served.set(built.variant.archive.name, built.bytes)
  }
  const manifest = readFileSync(join(fixture.home, 'runtimes', `delorun-${release}.manifest.json`))
  const signed = { schema: RELEASE_SCHEMAS.packs, version: release, manifest: createHash('sha256').update(manifest).digest('hex'), packs: [...entries.values()] }
  const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [fixture.keys.targets]), undefined, 2)}\n`)
  served.set(`delorun-${release}.packs.json`, bytes)
  served.set(`delorun-${release}.packs.log.json`, Buffer.from('{}'))
  return entries
}

async function world(options: { v2Packs: Record<string, string> } = { v2Packs: { demo: 'two' } }) {
  await fixture.install('0.1.0', closureFiles('0.1.0'))
  await fixture.install('0.2.0', closureFiles('0.2.0'))
  const served = new Map<string, Uint8Array>()
  const one = await publish('0.1.0', { demo: 'one' }, served)
  await publish('0.2.0', options.v2Packs, served)
  const paths = fixture.store.paths
  writeFileSync(paths.releaseFiles(V1).packs, served.get('delorun-0.1.0.packs.json')!)
  writeFileSync(paths.releaseFiles(V1).packsBundle, served.get('delorun-0.1.0.packs.log.json')!)
  await installPack({ paths, release: V1, entry: one.get('demo')!, platform: PLATFORM, archive: served.get('delorun-0.1.0-pack-demo.any.tar.gz')!, fetchExternal: () => Promise.reject(new Error('none')) })
  const fetches: string[] = []
  const filesFor = (_version: unknown): Promise<PackFiles> => Promise.resolve({
    fetchRelease: (name) => { fetches.push(name); return Promise.resolve(served.get(name)) },
    fetchExternal: () => Promise.reject(new Error('none')),
  })
  const carry: PackCarry = { paths, root: () => Promise.resolve(fixture.root), filesFor, checkLog: () => ({ ok: true }) }
  const store = new HomeRuntimeStore({
    store: fixture.store, profile: 'default', root: () => Promise.resolve(fixture.root), fullCheckDays: 7,
    openChannel: () => Promise.reject(new Error('the target is installed; no channel opens')),
    report: { build: () => Promise.resolve({ report: {}, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false }) },
    carryPacks: (from, to) => carryPacks(carry, from, to),
  })
  return { carry, store, paths, served, fetches }
}

describe('an update', () => {
  it('installs the new release\'s pack before it switches, and current stays', async () => {
    const { store, paths } = await world()
    await store.prepare(V2, () => {}, () => {})
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    expect(readFileSync(join(paths.pack(V2, 'demo'), 'package', 'index.js'), 'utf8')).toContain('"two"')
    expect(readFileSync(join(paths.pack(V1, 'demo'), 'package', 'index.js'), 'utf8')).toContain('"one"')
    await expect(fixture.store.checkRuntime(V2, fixture.root)).resolves.toBeDefined()
  })

  it('fails before the switch, with nothing carried, when the new release no longer publishes an added pack', async () => {
    const { store, paths } = await world({ v2Packs: { other: 'x' } })
    await expect(store.prepare(V2, () => {}, () => {})).rejects.toMatchObject({ code: 'INSTALL_VERIFY_FAILED', detail: expect.stringMatching(/no longer publishes the plugin pack demo/u) })
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    expect(existsSync(paths.pack(V2, 'demo'))).toBe(false)
  })

  it('fails before the switch when the new pack\'s archive is not what the signed file lists', async () => {
    const { store, paths, served } = await world()
    served.set('delorun-0.2.0-pack-demo.any.tar.gz', Buffer.from('forged'))
    await expect(store.prepare(V2, () => {}, () => {})).rejects.toMatchObject({ code: 'INSTALL_VERIFY_FAILED' })
    expect(existsSync(paths.pack(V2, 'demo'))).toBe(false)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
  })
})

describe('a rollback', () => {
  it('keeps the previous release\'s pack whole, so versions match', async () => {
    const { store, paths } = await world()
    await store.prepare(V2, () => {}, () => {})
    await fixture.store.switchTo(V1, V2)
    await fixture.store.retain()
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
    await expect(fixture.store.checkRuntime(V1, fixture.root)).resolves.toBeDefined()
    expect(existsSync(join(paths.pack(V1, 'demo'), 'package', 'index.js'))).toBe(true)
  })
})

describe('a repair', () => {
  it('leaves an intact pack alone and fetches a changed one again', async () => {
    const { carry, paths, fetches } = await world()
    expect(await repairPacks(carry, V1)).toEqual({ intact: ['demo'], repaired: [] })
    makeWritable(paths.pack(V1, 'demo'))
    writeFileSync(join(paths.pack(V1, 'demo'), 'package', 'index.js'), 'export const v = "evil"\n')
    fetches.length = 0
    expect(await repairPacks(carry, V1)).toEqual({ intact: [], repaired: ['demo'] })
    expect(fetches).toContain('delorun-0.1.0-pack-demo.any.tar.gz')
    await expect(fixture.store.checkRuntime(V1, fixture.root)).resolves.toBeDefined()
  })

  it('leaves a pack it cannot fetch removed instead of trusted', async () => {
    const { carry, paths, served } = await world()
    makeWritable(paths.pack(V1, 'demo'))
    writeFileSync(join(paths.pack(V1, 'demo'), 'package', 'index.js'), 'export const v = "evil"\n')
    served.delete('delorun-0.1.0-pack-demo.any.tar.gz')
    await expect(repairPacks(carry, V1)).rejects.toMatchObject({ code: 'NOT_ON_CHANNEL' })
    expect(existsSync(paths.pack(V1, 'demo'))).toBe(false)
  })
})
