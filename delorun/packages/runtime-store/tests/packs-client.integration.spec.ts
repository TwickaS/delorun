/**
 * Turning a pack on from the installed release: the packs file must verify under the release's root and manifest and
 * have a log record, an archive only downloads from the signed name, and each refusal leaves nothing under `packs/`.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain } from '@delorun/release-formats/sign/verify'
import { removeTree } from '../src/files.ts'
import { acquirePacks, packDownloadSize, openSignedPacks, readStoredPacks, turnOnPack, type InstalledRelease, type PackFiles } from '../src/packs-client.ts'
import { StorePaths } from '../src/paths.ts'
import { PLATFORM, releaseFiles, rootFile, throwawayKeys, version } from './support.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await removeTree(root) })
const V = version('0.1.0')
const text = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

async function setup(options: { readonly logOk?: boolean, readonly tamperPacks?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'delorun-packs-client-'))
  roots.push(home)
  const keys = throwawayKeys()
  const paths = new StorePaths(home, PLATFORM)
  mkdirSync(paths.root, { recursive: true })
  const nodeModules = paths.runtimeNodeModules(V)
  mkdirSync(join(nodeModules, 'peer'), { recursive: true })
  writeFileSync(join(nodeModules, 'peer', 'package.json'), '{"name":"peer"}')
  const files = releaseFiles(keys.targets, '0.1.0', { 'a.txt': { content: 'a' } })
  const root = trustRootChain([rootFile(keys).bytes], Math.floor(Date.now() / 1000)).at(-1)!.metadata
    const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [text('package.json', '{"name":"demo"}')], 1_800_000_000)
  const signed = {
    schema: RELEASE_SCHEMAS.packs,
    version: '0.1.0',
    manifest: createHash('sha256').update(options.tamperPacks === true ? Buffer.from('other') : files.manifest).digest('hex'),
    packs: [{ name: 'demo', version: '1.0.0', experimental: true, variants: { any: { ...built.variant, external: [], peers: ['peer'] } } }],
  }
  const packsBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [keys.targets]), undefined, 2)}\n`)
  const served = new Map<string, Uint8Array>([['delorun-0.1.0.packs.json', packsBytes], ['delorun-0.1.0.packs.log.json', Buffer.from('{}')], [built.variant.archive.name, built.bytes]])
  const release: InstalledRelease = { paths, root, version: V, manifestBytes: files.manifest, checkLog: () => ({ ok: options.logOk !== false, detail: 'no record' }) }
  const fetched: string[] = []
  const channel: PackFiles = {
    fetchRelease: (name, _size) => { fetched.push(name); return Promise.resolve(served.get(name)) },
    fetchExternal: () => Promise.reject(new Error('no external')),
  }
  return { release, channel, fetched, paths }
}

describe('turning a pack on', () => {
  it('verifies the packs file and its log record, downloads the pack once, and installs it beside the release', async () => {
    const { release, channel, fetched, paths } = await setup()
    const directory = await turnOnPack(release, 'demo', channel)
    expect(directory).toBe(join(paths.pack(V, 'demo'), 'package'))
    expect(fetched).toEqual(['delorun-0.1.0.packs.json', 'delorun-0.1.0.packs.log.json', 'delorun-0.1.0-pack-demo.tar.gz'])
    expect((await readStoredPacks(release))!.packs.map(pack => pack.name)).toEqual(['demo'])
    expect(packDownloadSize((await readStoredPacks(release))!.packs[0]!, PLATFORM)).toBeGreaterThan(0)
  })

  it('refuses a packs file whose log record does not verify, or that belongs to another manifest, and stores nothing', async () => {
    const noLog = await setup({ logOk: false })
    await expect(turnOnPack(noLog.release, 'demo', noLog.channel)).rejects.toThrow(/release-log record/u)
    expect(existsSync(noLog.paths.releaseFiles(V).packs)).toBe(false)
    const other = await setup({ tamperPacks: true })
    await expect(turnOnPack(other.release, 'demo', other.channel)).rejects.toThrow(/belongs to the manifest/u)
    expect(existsSync(other.paths.packs)).toBe(false)
  })

  it('treats a release without a packs file as having no packs, and refuses an unknown pack', async () => {
    const { release } = await setup()
    const empty: PackFiles = { fetchRelease: () => Promise.resolve(undefined), fetchExternal: () => Promise.reject(new Error('unused')) }
    expect(await acquirePacks(release, empty)).toBeUndefined()
    await expect(turnOnPack(release, 'demo', empty)).rejects.toThrow(/has no pack demo/u)
  })

  it('refuses when the signed pack archive is not on the channel', async () => {
    const { release, channel } = await setup()
    const missing: PackFiles = { ...channel, fetchRelease: name => (name.endsWith('.tar.gz') ? Promise.resolve(undefined) : channel.fetchRelease(name, { max: 1 << 20 })) }
    await expect(turnOnPack(release, 'demo', missing)).rejects.toThrow(/has no delorun-0\.1\.0-pack-demo/u)
  })
})

describe('the signed files of an installed release\'s packs', () => {
  it('lists each pack\'s signed files and its peers, and reads the text of package.json only when the installed file matches its signed digest', async () => {
    const { release, channel } = await setup()
    await turnOnPack(release, 'demo', channel)
    const demo = await (await openSignedPacks(release))!.files('demo')
    expect(demo).toMatchObject({ name: 'demo', release: V, peers: ['peer'] })
    expect([...demo!.files.keys()]).toEqual(['package.json'])
    expect(demo!.files.get('package.json')).toEqual({ sha256: createHash('sha256').update('{"name":"demo"}').digest('hex'), executable: false })
    expect(await demo!.text('package.json')).toBe('{"name":"demo"}')
    expect(await demo!.text('index.js')).toBeUndefined()
  })

  it('gives no text from an installed file that differs from its signed digest, and no files without a packs file', async () => {
    const { release, channel, paths } = await setup()
    expect(await openSignedPacks(release)).toBeUndefined()
    await turnOnPack(release, 'demo', channel)
    const file = join(paths.pack(V, 'demo'), 'package', 'package.json')
    chmodSync(join(paths.pack(V, 'demo'), 'package'), 0o755)
    chmodSync(file, 0o644)
    writeFileSync(file, '{"name":"planted"}')
    const demo = await (await openSignedPacks(release))!.files('demo')
    expect(await demo!.text('package.json')).toBeUndefined()
    expect(demo!.files.get('package.json')!.sha256).toBe(createHash('sha256').update('{"name":"demo"}').digest('hex'))
  })

  it('says which packs the release lists from the verified packs file, without reading an installed file', async () => {
    const { release, channel } = await setup()
    await turnOnPack(release, 'demo', channel)
    const packs = (await openSignedPacks(release))!
    expect(packs.lists('demo')).toBe(true)
    expect(packs.lists('another')).toBe(false)
  })

  it('lists no files for a pack the release does not list', async () => {
    const { release, channel } = await setup()
    await turnOnPack(release, 'demo', channel)
    expect(await (await openSignedPacks(release))!.files('another')).toBeUndefined()
  })

  it('refuses a stored packs file that no longer verifies', async () => {
    const { release, channel } = await setup()
    await turnOnPack(release, 'demo', channel)
    await expect(openSignedPacks({ ...release, checkLog: () => ({ ok: false, detail: 'revoked' }) })).rejects.toThrow(/release-log record/u)
  })

  it('refuses a stored packs file whose signature has one character flipped, though its log record verifies', async () => {
    const { release, channel, paths } = await setup()
    await turnOnPack(release, 'demo', channel)
    expect((await (await openSignedPacks(release))!.files('demo'))?.name).toBe('demo')
    const file = paths.releaseFiles(V).packs
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { signatures: { sig: string }[] }
    const sig = envelope.signatures[0]!.sig
    // A middle character, never the `=` padding, whose change could fail as a decode error instead of a signature check.
    const middle = Math.floor(sig.length / 2)
    envelope.signatures[0]!.sig = `${sig.slice(0, middle)}${sig[middle] === 'A' ? 'B' : 'A'}${sig.slice(middle + 1)}`
    chmodSync(file, 0o644)
    writeFileSync(file, JSON.stringify(envelope))
    await expect(openSignedPacks(release)).rejects.toThrow(/0 valid signatures/u)
  })
})
