/**
 * Turning a pack on from the installed release: the packs file must verify under the release's root and manifest and
 * have a log record, an archive only downloads from the signed name, and each refusal leaves nothing under `packs/`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain, verifySignedManifest } from '@delorun/release-formats/sign/verify'
import { acquirePacks, packDownloadSize, readStoredPacks, turnOnPack, type InstalledRelease, type PackFiles } from '../src/packs-client.ts'
import { StorePaths } from '../src/paths.ts'
import { PLATFORM, releaseFiles, rootFile, throwawayKeys, version } from './support.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const V = version('0.1.0')
const text = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

async function setup(options: { readonly logOk?: boolean, readonly tamperPacks?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'delorun-packs-client-'))
  roots.push(home)
  const keys = throwawayKeys()
  const paths = new StorePaths(home, PLATFORM)
  mkdirSync(paths.root, { recursive: true })
  const nodeModules = join(home, 'node_modules')
  mkdirSync(join(nodeModules, 'peer'), { recursive: true })
  writeFileSync(join(nodeModules, 'peer', 'package.json'), '{"name":"peer"}')
  const files = releaseFiles(keys.targets, '0.1.0', { 'a.txt': { content: 'a' } })
  const root = trustRootChain([rootFile(keys).bytes], Math.floor(Date.now() / 1000)).at(-1)!.metadata
  const manifest = verifySignedManifest(root, files.manifest)
  const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [text('package.json', '{"name":"demo"}')], 1_800_000_000)
  const signed = {
    schema: RELEASE_SCHEMAS.packs,
    version: '0.1.0',
    manifest: createHash('sha256').update(options.tamperPacks === true ? Buffer.from('other') : files.manifest).digest('hex'),
    packs: [{ name: 'demo', version: '1.0.0', experimental: true, peers: ['peer'], variants: { any: { ...built.variant, external: [] } } }],
  }
  const packsBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [keys.targets]), undefined, 2)}\n`)
  const served = new Map<string, Uint8Array>([['delorun-0.1.0.packs.json', packsBytes], ['delorun-0.1.0.packs.log.json', Buffer.from('{}')], [built.variant.archive.name, built.bytes]])
  const release: InstalledRelease = { paths, root, version: V, manifest, manifestBytes: files.manifest, checkLog: () => ({ ok: options.logOk !== false, detail: 'no record' }) }
  const fetched: string[] = []
  const channel: PackFiles = {
    fetchRelease: (name) => { fetched.push(name); return Promise.resolve(served.get(name)) },
    fetchExternal: () => Promise.reject(new Error('no external')),
  }
  return { release, channel, nodeModules, fetched, paths }
}

describe('turning a pack on', () => {
  it('verifies the packs file and its log record, downloads the pack once, and installs it beside the release', async () => {
    const { release, channel, nodeModules, fetched, paths } = await setup()
    const directory = await turnOnPack(release, 'demo', channel, nodeModules)
    expect(directory).toBe(join(paths.pack(V, 'demo'), 'package'))
    expect(fetched).toEqual(['delorun-0.1.0.packs.json', 'delorun-0.1.0.packs.log.json', 'delorun-0.1.0-pack-demo.tar.gz'])
    expect((await readStoredPacks(release))!.packs.map(pack => pack.name)).toEqual(['demo'])
    expect(packDownloadSize((await readStoredPacks(release))!.packs[0]!, PLATFORM)).toBeGreaterThan(0)
  })

  it('refuses a packs file whose log record does not verify, or that belongs to another manifest, and stores nothing', async () => {
    const noLog = await setup({ logOk: false })
    await expect(turnOnPack(noLog.release, 'demo', noLog.channel, noLog.nodeModules)).rejects.toThrow(/release-log record/u)
    expect(existsSync(noLog.paths.releaseFiles(V).packs)).toBe(false)
    const other = await setup({ tamperPacks: true })
    await expect(turnOnPack(other.release, 'demo', other.channel, other.nodeModules)).rejects.toThrow(/belongs to the manifest/u)
    expect(existsSync(other.paths.packs)).toBe(false)
  })

  it('treats a release without a packs file as having no packs, and refuses an unknown pack', async () => {
    const { release, nodeModules } = await setup()
    const empty: PackFiles = { fetchRelease: () => Promise.resolve(undefined), fetchExternal: () => Promise.reject(new Error('unused')) }
    expect(await acquirePacks(release, empty)).toBeUndefined()
    await expect(turnOnPack(release, 'demo', empty, nodeModules)).rejects.toThrow(/has no pack demo/u)
  })

  it('refuses when the signed pack archive is not on the channel', async () => {
    const { release, nodeModules, channel } = await setup()
    const missing: PackFiles = { ...channel, fetchRelease: name => (name.endsWith('.tar.gz') ? Promise.resolve(undefined) : channel.fetchRelease(name)) }
    await expect(turnOnPack(release, 'demo', missing, nodeModules)).rejects.toThrow(/has no delorun-0\.1\.0-pack-demo/u)
  })
})
