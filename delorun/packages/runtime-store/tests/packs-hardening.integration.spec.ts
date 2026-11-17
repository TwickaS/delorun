/**
 * Installed packs are held to the same rules as a runtime installation: installs and retention take `store.lock`, the
 * tree is sealed and recorded, and a changed, added or relinked file is refused by the start check and by `delorun
 * verify`'s full check.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RELEASE_SCHEMAS, type PackEntry, type SemanticVersion } from '@delorun/contract-release-manifest'
import { buildPackArchive, PackRefusal } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { checkInstalledPack, installPack } from '../src/packs.ts'
import { acquireStoreLock } from '../src/lock.ts'
import { SUPPORTED } from '../src/index.ts'
import { fixtureHome, makeWritable, PLATFORM, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const text = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

let fixture: FixtureHome
beforeEach(() => { fixture = fixtureHome() })
afterEach(() => { fixture.remove() })

/** Install a runtime with a peer and build a pack against it. */
async function withPack(): Promise<{ entry: PackEntry, archive: Buffer, request: Parameters<typeof installPack>[0] }> {
  await fixture.install('0.1.0')
  const modules = join(fixture.home, 'runtimes', '0.1.0', 'app', 'node_modules')
  const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [
    text('package.json', '{"name":"demo","type":"module","main":"index.js"}'),
    text('index.js', 'export const x = 1\n'),
  ], 1_800_000_000)
  const entry: PackEntry = { name: 'demo', version: brandString<SemanticVersion>('1.0.0'), experimental: true, variants: { any: { ...built.variant, external: [], peers: [] } } }
  const manifestBytes = readFileSync(fixture.store['paths'].releaseFiles(V1).manifest)
  const signed = { schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: createHash('sha256').update(manifestBytes).digest('hex'), packs: [entry] }
  writeFileSync(fixture.store['paths'].releaseFiles(V1).packs, Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [fixture.keys.targets]), undefined, 2)}\n`))
  void modules
  return { entry, archive: built.bytes, request: { paths: fixture.store['paths'], release: V1, entry, platform: PLATFORM, archive: built.bytes, fetchExternal: () => Promise.reject(new Error('no external')) } }
}

describe('installing a pack under store.lock', () => {
  it('waits for a held store lock and creates no staging directory meanwhile', async () => {
    const { request } = await withPack()
    const lock = await acquireStoreLock(request.paths.lock, 1000)
    let done = false
    const install = installPack(request).then((directory) => { done = true; return directory })
    await sleep(250)
    expect(done).toBe(false)
    expect(readdirSync(request.paths.staging)).toEqual([])
    lock.release()
    expect(await install).toBe(join(request.paths.pack(V1, 'demo'), 'package'))
  })

  it('serialises two installs of one pack: both succeed and one pack is installed', async () => {
    const { request } = await withPack()
    const [first, second] = await Promise.all([installPack(request), installPack(request)])
    expect(second).toBe(first)
    expect(readdirSync(join(request.paths.packs, '0.1.0'))).toEqual(['demo'])
    expect(readdirSync(request.paths.staging)).toEqual([])
  })

  it('seals the tree like a runtime installation and records the install outside the pack', async () => {
    const { request } = await withPack()
    const directory = await installPack(request)
    expect(statSync(request.paths.pack(V1, 'demo')).mode & 0o777).toBe(0o555)
    expect(statSync(directory).mode & 0o777).toBe(0o555)
    expect(statSync(join(directory, 'index.js')).mode & 0o777).toBe(0o444)
    expect(existsSync(request.paths.packRecord(V1, 'demo'))).toBe(true)
  })
})

describe('checking an installed pack', () => {
  async function installed() {
    const made = await withPack()
    const directory = await installPack(made.request)
    return { ...made, directory }
  }

  it('passes an intact pack, so the start check does not refuse a good install', async () => {
    const { request, entry } = await installed()
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).resolves.toBeUndefined()
    await expect(fixture.store.checkRuntime(V1, fixture.root)).resolves.toBeDefined()
  })

  it('refuses a changed file, at the pack check, the full check and the start', async () => {
    const { request, entry, directory } = await installed()
    makeWritable(directory)
    writeFileSync(join(directory, 'index.js'), 'export const x = 2\n')
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).rejects.toMatchObject({ code: 'INSTALLED_PACK_CHANGED' })
    await expect(fixture.store.checkRuntime(V1, fixture.root)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
    await expect(fixture.store.prepareLaunch({ launcher: SUPPORTED, root: fixture.root, mode: 'warn', fullCheckDays: 7, profile: 'default', args: [] })).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })

  it('refuses an added file, a removed file, an unlisted link and a mode change', async () => {
    const { request, entry, directory } = await installed()
    makeWritable(directory)
    writeFileSync(join(directory, 'extra.js'), 'x')
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).rejects.toThrow(/extra\.js is not in the signed file list/u)
    rmSync(join(directory, 'extra.js'))
    symlinkSync('/etc', join(directory, 'link'))
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).rejects.toThrow(/link is a link the install did not make/u)
    rmSync(join(directory, 'link'))
    chmodSync(join(directory, 'index.js'), 0o666)
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).rejects.toThrow(/not its sealed mode/u)
    chmodSync(join(directory, 'index.js'), 0o444)
    rmSync(join(directory, 'index.js'))
    await expect(checkInstalledPack(request.paths, V1, entry, PLATFORM)).rejects.toThrow(/index\.js is missing/u)
  })

  it('refuses a pack directory the signed packs file does not list', async () => {
    await installed()
    mkdirSync(join(fixture.store['paths'].packs, '0.1.0', 'stranger'), { recursive: true })
    await expect(fixture.store.checkRuntime(V1, fixture.root)).rejects.toThrow(/stranger is not a pack/u)
  })

  it('keeps a pack as long as its release is current or previous, and removes it with the release', async () => {
    const { request } = await installed()
    await fixture.install('0.2.0')
    await fixture.install('0.3.0')
    await fixture.store.switchTo(V1, version('0.2.0'))
    await fixture.store.switchTo(version('0.2.0'), version('0.3.0'))
    await fixture.store.retain()
    expect(existsSync(request.paths.pack(V1, 'demo'))).toBe(false)
    expect(existsSync(request.paths.packRecord(V1, 'demo'))).toBe(false)
    expect(lstatSync(request.paths.root).isDirectory()).toBe(true)
  })
})

describe('the pack refusal', () => {
  it('carries a code', () => {
    expect(new PackRefusal('x', 'FILE_ERROR').code).toBe('FILE_ERROR')
  })
})
