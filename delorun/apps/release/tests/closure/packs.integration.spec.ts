import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { closureName } from '../../src/rebuild/compare.ts'
import { buildPack, isExternal, keepsOneCopy, packArchiveName, lockedFrom, SINGLETON_LIBRARIES, tarballUrl, type PackSources } from '../../src/closure/packs.ts'
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
/** A registry tarball of an external package: its files under `package/`, as npm packs them. */
const NATIVE = (await buildPackArchive('native.tgz', [{ path: 'package/package.json', mode: '0644', data: Buffer.from('{"name":"native","version":"9.9.9"}') }], 1_800_000_000)).bytes
const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

function sources(options: { readonly native: boolean, readonly served?: Buffer, readonly bundledPeer?: string, readonly armOnlyPeer?: boolean, readonly extra?: string, readonly peerDependencies?: Record<string, string>, readonly typescript?: boolean, readonly files?: Record<string, string> }): PackSources {
  const closure = temp()
  const extra = options.extra
  put(closure, { ...extra === undefined ? {} : { [`node_modules/${extra}/package.json`]: `{"name":"${extra}","version":"2.0.0"}` }, 'node_modules/shared-peer/package.json': '{"name":"shared-peer","version":"2.0.0"}', 'node_modules/arm-peer/package.json': '{"name":"arm-peer","version":"1.0.0"}' })
  return {
    closureNodeModules: () => join(closure, 'node_modules'),
    deploy: async (_name, platform, directory) => {
      put(directory, {
        'package.json': JSON.stringify({ name: '@delorun/demo', version: '1.0.0', peerDependencies: options.peerDependencies, ...options.typescript === true ? { exports: { './server': './src/server.ts' } } : {} }),
        ...extra === undefined ? {} : { [`node_modules/${extra}/package.json`]: `{"name":"${extra}","version":"1.0.0"}`, [`node_modules/${extra}/index.js`]: 'own\n' },
        'lib/index.js': 'export {}\n',
        ...options.typescript === true
          ? {
              'src/server.ts': 'export { default } from \'shared-peer\'\nexport const port: number = 3081\n',
              'node_modules/@delorun/helper/package.json': JSON.stringify({ name: '@delorun/helper', version: '1.0.0', exports: { '.': './src/index.ts' } }),
              'node_modules/@delorun/helper/src/index.ts': 'export const answer: number = 42\n',
            }
          : {},
        'node_modules/shared-peer/package.json': `{"name":"shared-peer","version":"${options.bundledPeer ?? '2.0.0'}"}`,
        ...options.armOnlyPeer === true && platform === 'linux-arm64' ? { 'node_modules/arm-peer/package.json': '{"name":"arm-peer","version":"1.0.0"}' } : {},
        'node_modules/shared-peer/index.js': 'peer\n',
        'node_modules/own-dep/package.json': '{"name":"own-dep","version":"1.0.0"}',
        ...options.native ? { [`node_modules/@vendor/native-${platform}/package.json`]: '{}' } : {},
        ...options.files,
      })
      await Promise.resolve()
    },
    locked: (name, _platform) => (name.startsWith('@vendor/native-') ? { version: '9.9.9', integrity: integrity(NATIVE) } : undefined),
    download: () => Promise.resolve(options.served ?? NATIVE),
    declaredPeers: () => Promise.resolve({}),
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

  it('carries a Delorun package\'s TypeScript sources, its own and a bundled Delorun dependency\'s, as JavaScript its entry points name', async () => {
    const scratch = temp()
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, typescript: true }), scratch)
    const paths = built.entry.variants.any!.files.map(file => file.path)
    expect(paths).toEqual(expect.arrayContaining(['src/server.js', 'node_modules/@delorun/helper/src/index.js']))
    expect(paths.filter(path => path.endsWith('.ts'))).toEqual([])
    const deployed = join(scratch, '@delorun__demo-linux-x64')
    expect(JSON.parse(readFileSync(join(deployed, 'package.json'), 'utf8'))).toMatchObject({ exports: { './server': './src/server.js' } })
    expect(readFileSync(join(deployed, 'src/server.js'), 'utf8')).toBe('export { default } from \'shared-peer\';\nexport const port = 3081;\n')
    expect(JSON.parse(readFileSync(join(deployed, 'node_modules/@delorun/helper/package.json'), 'utf8'))).toMatchObject({ exports: { '.': './src/index.js' } })
  })

  it('keeps another package\'s TypeScript sources but refuses a pack that carries a Delorun package\'s untranspiled', async () => {
    const theirs = { 'node_modules/own-dep/src/index.ts': 'export const own: number = 1\n', 'node_modules/own-dep/index.d.ts': 'export declare const own: number\n' }
    const kept = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, files: theirs }), temp())
    expect(kept.entry.variants.any!.files.map(file => file.path)).toEqual(expect.arrayContaining(Object.keys(theirs)))
    // The transpile step reaches the pack's own `node_modules/@delorun`, not a Delorun package nested deeper.
    const nested = { ...theirs, 'node_modules/own-dep/node_modules/@delorun/deep/src/index.ts': 'export const deep: number = 2\n' }
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, files: nested }), temp()))
      .rejects.toThrow(/@delorun\/demo for linux-x64 carries TypeScript sources of a Delorun package.*node_modules\/own-dep\/node_modules\/@delorun\/deep\/src\/index\.ts/u)
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, files: { 'lib/extra.mts': 'export {}\n' } }), temp())).rejects.toThrow(/lib\/extra\.mts/u)
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

  it('lets a third-party package keep its own version inside the pack, without linking the closure\'s', async () => {
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, extra: 'old-http' }), temp())
    expect(built.entry.variants.any!.peers).toEqual(['shared-peer'])
    expect(built.entry.variants.any!.files.map(file => file.path)).toEqual(expect.arrayContaining(['node_modules/old-http/index.js', 'node_modules/old-http/package.json']))
  })

  it.each(['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@delorun/contract-release-manifest', ...SINGLETON_LIBRARIES])('refuses a differing copy of %s, which must exist once', async (extra) => {
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, extra }), temp())).rejects.toThrow(/second copy/u)
  })

  it('refuses a differing copy of a package the pack lists as a peer dependency', async () => {
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, extra: 'old-http', peerDependencies: { 'old-http': '*' } }), temp())).rejects.toThrow(/old-http@1\.0\.0.*second copy/u)
  })

  it('counts every vendored package as core, by its real name', () => {
    const root = join(import.meta.dirname, '../../../../..')
    const names = readdirSync(join(root, 'vendor')).filter(entry => existsSync(join(root, 'vendor', entry, 'package.json'))).map(entry => (JSON.parse(readFileSync(join(root, 'vendor', entry, 'package.json'), 'utf8')) as { name: string }).name)
    expect(names.length).toBeGreaterThan(0)
    for (const vendored of names) expect(keepsOneCopy(vendored, new Set(), [])).toBe(true)
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

  it('finds a package the lockfile pins under another registry name, with the name to download from', () => {
    const lock = "packages:\n  '@openai/codex@0.153.4-linux-x64':\n    resolution: {integrity: sha512-AAAA}\nsnapshots:\n  '@openai/codex@0.153.4':\n    optionalDependencies:\n      '@openai/codex-linux-x64': '@openai/codex@0.153.4-linux-x64'\n"
    expect(lockedFrom(lock, '@openai/codex-linux-x64')).toEqual({ version: '0.153.4-linux-x64', integrity: 'sha512-AAAA', source: '@openai/codex' })
  })

  it('makes the bundles the default install lacks packs: Claude Code and Codex, not what the closure carries', () => {
    const packages = readWorkspacePackages(join(import.meta.dirname, '../../../../..'))
    const names = packCandidates(packages, selectClosurePackages(packages), new Set(['@deepseek-ai/dsh-base'])).map(each => each.name)
    expect(names).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']))
    expect(names).not.toContain('@deepseek-ai/dsh-base')
    expect(names).not.toContain('@delorun/plugin-main-chat')
  })
})
