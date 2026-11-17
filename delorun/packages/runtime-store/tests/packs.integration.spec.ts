/**
 * Installing a pack: the pack's package directory exists only after every check passed, loads under plain Node ESM
 * with its own dependency and the runtime's peers, and a refusal leaves nothing under `packs/` or `staging/`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PackEntry, PackExternal, RuntimePlatform, SemanticVersion, Sha512Base64 } from '@delorun/contract-release-manifest'
import { gzip } from '@delorun/release-formats/archive/bytes'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { buildPackArchive, PackRefusal } from '@delorun/release-formats/packs/archive'
import { removeTree } from '../src/files.ts'
import { installPack } from '../src/packs.ts'
import { StorePaths } from '../src/paths.ts'
import { parseRuntimeVersion } from '../src/paths.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await removeTree(root) })
const PLATFORM: RuntimePlatform = 'linux-x64'
const RELEASE = parseRuntimeVersion('0.1.0')!
const EPOCH = 1_800_000_000
const text = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

async function tarball(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of gzip(tarStream(Object.entries(files).sort().map(([path, body]) => text(`package/${path}`, body)), EPOCH))) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'delorun-pack-home-'))
  roots.push(home)
  const nodeModules = join(home, 'runtimes', '0.1.0', 'app', 'node_modules')
  mkdirSync(join(nodeModules, 'runtime-peer'), { recursive: true })
  writeFileSync(join(nodeModules, 'runtime-peer', 'package.json'), '{"name":"runtime-peer","type":"module","main":"index.js"}')
  writeFileSync(join(nodeModules, 'runtime-peer', 'index.js'), 'export const peer = "from the runtime"\n')
  return { home, paths: new StorePaths(home, PLATFORM) }
}

async function entryFor(external: PackExternal[] = [], peers: string[] = ['runtime-peer']): Promise<{ entry: PackEntry, archive: Buffer }> {
  const built = await buildPackArchive('delorun-0.1.0-pack-demo.tar.gz', [
    text('package.json', '{"name":"demo","type":"module","main":"index.js"}'),
    text('index.js', 'import { peer } from "runtime-peer"\nimport { own } from "own-dep"\nexport const both = `${peer}+${own}`\n'),
    text('node_modules/own-dep/package.json', '{"name":"own-dep","type":"module","main":"index.js"}'),
    text('node_modules/own-dep/index.js', 'export const own = "bundled"\n'),
  ], EPOCH)
  return {
    archive: built.bytes,
    entry: { name: 'demo', version: brandString<SemanticVersion>('1.0.0'), experimental: true, variants: { any: { ...built.variant, external, peers } } },
  }
}

describe('installing a pack', () => {
  it('publishes a package that loads under plain Node ESM with its own dependency and the runtime peer', async () => {
    const { paths } = setup()
    const { entry, archive } = await entryFor()
    const directory = await installPack({ paths, release: RELEASE, entry, platform: PLATFORM, archive, fetchExternal: () => Promise.reject(new Error('no external expected')) })
    expect(directory).toBe(join(paths.pack(RELEASE, 'demo'), 'package'))
    const loaded = await import(pathToFileURL(join(directory, 'index.js')).href) as { both: string }
    expect(loaded.both).toBe('from the runtime+bundled')
    expect(readdirSync(paths.staging)).toEqual([])
  })

  it('fetches a signed external package, checks it, and refuses other bytes with nothing published', async () => {
    const { paths } = setup()
    const real = await tarball({ 'package.json': '{"name":"native-linux-x64"}', 'bin/agent': 'binary' })
    const pin: PackExternal = {
      name: '@vendor/native-linux-x64',
      version: brandString<SemanticVersion>('1.0.0'),
      url: 'https://registry.npmjs.org/@vendor/native-linux-x64/-/native-linux-x64-1.0.0.tgz',
      sha512: brandString<Sha512Base64>(createHash('sha512').update(real).digest('base64')),
      length: real.byteLength,
    }
    const { entry, archive } = await entryFor([pin])
    const forged = await tarball({ 'package.json': '{"name":"evil"}' })
    await expect(installPack({ paths, release: RELEASE, entry, platform: PLATFORM, archive, fetchExternal: () => Promise.resolve(forged) })).rejects.toBeInstanceOf(PackRefusal)
    expect(existsSync(paths.packs)).toBe(false)
    expect(readdirSync(paths.staging)).toEqual([])
    const directory = await installPack({ paths, release: RELEASE, entry, platform: PLATFORM, archive, fetchExternal: () => Promise.resolve(real) })
    expect(readdirSync(join(directory, 'node_modules/@vendor/native-linux-x64/bin'))).toEqual(['agent'])
  })

  it('refuses a pack whose peer the runtime does not provide, and a platform the release does not publish', async () => {
    const { paths } = setup()
    const missingPeer = await entryFor([], ['not-in-runtime'])
    await expect(installPack({ paths, release: RELEASE, entry: missingPeer.entry, platform: PLATFORM, archive: missingPeer.archive, fetchExternal: () => Promise.reject(new Error('unused')) })).rejects.toThrow(/does not provide/u)
    const { entry, archive } = await entryFor()
    const only: PackEntry = { ...entry, variants: { 'linux-arm64': entry.variants.any! } }
    await expect(installPack({ paths, release: RELEASE, entry: only, platform: PLATFORM, archive, fetchExternal: () => Promise.reject(new Error('unused')) })).rejects.toThrow(/not published for linux-x64/u)
    expect(existsSync(paths.packs)).toBe(false)
  })
})
