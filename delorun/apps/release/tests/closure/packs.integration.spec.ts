import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { closureName } from '../../src/rebuild/compare.ts'
import { buildPack, isExternal, packArchiveName, lockedFrom, tarballUrl, type PackSources } from '../../src/closure/packs.ts'
import { packCandidates, readWorkspacePackages, selectClosurePackages } from '../../src/closure/plugin-set.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-pack-build-')); roots.push(root); return root }
const put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
}
const PLATFORMS: RuntimePlatform[] = ['linux-x64', 'linux-arm64']
const NATIVE = Buffer.from('registry tarball bytes')
const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

function sources(options: { readonly native: boolean, readonly served?: Buffer, readonly bundledPeer?: string, readonly armOnlyPeer?: boolean }): PackSources {
  const closure = temp()
  put(closure, { 'node_modules/shared-peer/package.json': '{"name":"shared-peer","version":"2.0.0"}', 'node_modules/arm-peer/package.json': '{"name":"arm-peer","version":"1.0.0"}' })
  return {
    closureNodeModules: () => join(closure, 'node_modules'),
    deploy: async (_name, platform, directory) => {
      put(directory, {
        'package.json': '{"name":"@delorun/demo","version":"1.0.0"}',
        'lib/index.js': 'export {}\n',
        'node_modules/shared-peer/package.json': `{"name":"shared-peer","version":"${options.bundledPeer ?? '2.0.0'}"}`,
        ...options.armOnlyPeer === true && platform === 'linux-arm64' ? { 'node_modules/arm-peer/package.json': '{"name":"arm-peer","version":"1.0.0"}' } : {},
        'node_modules/shared-peer/index.js': 'peer\n',
        'node_modules/own-dep/package.json': '{"name":"own-dep","version":"1.0.0"}',
        ...options.native ? { [`node_modules/@vendor/native-${platform}/package.json`]: '{}' } : {},
      })
      await Promise.resolve()
    },
    locked: (name, _platform) => (name.startsWith('@vendor/native-') ? { version: '9.9.9', integrity: integrity(NATIVE) } : undefined),
    download: () => Promise.resolve(options.served ?? NATIVE),
  }
}

describe('building a pack', () => {
  it('links the closure\'s packages as peers, keeps its own dependency, and shares one variant across platforms', async () => {
    const built = await buildPack('@delorun/demo', '1.0.0', true, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native-*'], sources({ native: false }), temp())
    expect(built.entry.variants.any!.peers).toEqual(['shared-peer'])
    expect(Object.keys(built.entry.variants)).toEqual(['any'])
    expect(built.entry.variants.any!.files.map(file => file.path)).toEqual(['lib/index.js', 'node_modules/own-dep/package.json', 'package.json'])
    expect(built.entry.variants.any!.archive.name).toBe('delorun-0.1.0-pack-delorun__demo.any.tar.gz')
    expect([...built.archives.keys()]).toEqual([built.entry.variants.any!.archive.name])
  })

  it('pins an external package per platform by URL and SHA-512, leaving its files out of the archive', async () => {
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native-*'], sources({ native: true }), temp())
    const x64 = built.entry.variants['linux-x64']!
    expect(x64.external).toEqual([expect.objectContaining({ name: '@vendor/native-linux-x64', url: 'https://registry.npmjs.org/@vendor/native-linux-x64/-/native-linux-x64-9.9.9.tgz', length: NATIVE.byteLength })])
    expect(x64.files.some(file => file.path.includes('native-'))).toBe(false)
    expect(Object.keys(built.entry.variants).sort()).toEqual(['linux-arm64', 'linux-x64'])
  })

  it('keeps each platform\'s peers with its own variant instead of merging them', async () => {
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, armOnlyPeer: true }), temp())
    expect(Object.keys(built.entry.variants).sort()).toEqual(['linux-arm64', 'linux-x64'])
    expect(built.entry.variants['linux-x64']!.peers).toEqual(['shared-peer'])
    expect(built.entry.variants['linux-arm64']!.peers).toEqual(['arm-peer', 'shared-peer'])
  })

  it('refuses a pack that bundles a core package at another version than the closure carries', async () => {
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, bundledPeer: '1.0.0' }), temp())).rejects.toThrow(/shared-peer@1\.0\.0.*closure carries shared-peer@2\.0\.0/u)
  })

  it('names no pack archive like a runtime archive or file list, whatever the pack is called', () => {
    for (const name of ['demo', '@delorun/linux-x64', 'files', 'foo-linux-x64']) {
      for (const platform of [undefined, ...PLATFORMS]) {
        const archive = packArchiveName('0.1.0', name, platform)
        expect(closureName(archive)).toBeUndefined()
      }
    }
  })

  it('refuses a registry that serves other bytes than the lockfile pins', async () => {
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native-*'], sources({ native: true, served: Buffer.from('other') }), temp())).rejects.toThrow(/does not match the lockfile/u)
  })

  it('matches an external by exact name or prefix, and writes scoped tarball URLs', () => {
    expect(isExternal('@openai/codex-linux-x64', ['@openai/codex-*'])).toBe(true)
    expect(isExternal('@openai/codex', ['@openai/codex-*'])).toBe(false)
    expect(tarballUrl('@openai/codex-linux-x64', '0.153.4')).toBe('https://registry.npmjs.org/@openai/codex-linux-x64/-/codex-linux-x64-0.153.4.tgz')
  })
})

describe('the lockfile and the pack candidates', () => {
  it('reads one package\'s version and integrity, and refuses a package pinned at two versions', () => {
    const lock = "packages:\n  '@openai/codex-linux-x64@0.153.4':\n    resolution: {integrity: sha512-AAAA}\n  twice@1.0.0:\n    resolution: {integrity: sha512-B}\n  twice@2.0.0:\n    resolution: {integrity: sha512-C}\n"
    expect(lockedFrom(lock, '@openai/codex-linux-x64')).toEqual({ version: '0.153.4', integrity: 'sha512-AAAA' })
    expect(lockedFrom(lock, 'absent')).toBeUndefined()
    expect(() => lockedFrom(lock, 'twice')).toThrow(/2 versions/u)
  })

  it('makes the bundles the default install lacks packs: Claude Code and Codex, not what the closure carries', () => {
    const packages = readWorkspacePackages(join(import.meta.dirname, '../../../../..'))
    const names = packCandidates(packages, selectClosurePackages(packages), new Set(['@deepseek-ai/dsh-base'])).map(each => each.name)
    expect(names).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']))
    expect(names).not.toContain('@deepseek-ai/dsh-base')
    expect(names).not.toContain('@delorun/plugin-main-chat')
  })
})
