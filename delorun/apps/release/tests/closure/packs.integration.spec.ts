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

/**
 * What `pnpm deploy` writes for a workspace package it injects: `file:///` specifiers and lockfile keys that name the
 * deployment's folder, a `directory` relative to it, and a workspace file listing a patch by path. The path is derived
 * from the deployment's own folder, so two builds in different temporary folders write different text.
 */
function injectedByPnpm(directory: string): Record<string, string> {
  const source = `${dirname(directory)}/source/packages/util/brand`
  const injected = `@deepseek-ai/dsh-brand@file://${source}`
  return {
    'package.json': JSON.stringify({ name: '@delorun/demo', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-brand': injected, 'own-dep': '1.0.0' } }, null, 2),
    'node_modules/@deepseek-ai/dsh-brand/package.json': '{"name":"@deepseek-ai/dsh-brand","version":"0.2.2-rc.3"}',
    'pnpm-workspace.yaml': `patchedDependencies:\n  x@1.0.0: >-\n    ../../..${source}.patch\n`,
    'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@deepseek-ai/dsh-brand':\n        specifier: '${injected}'\n        version: '${injected}'\n      own-dep:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  '${injected}':\n    resolution: {directory: ../..${source}, type: directory}\n\n  own-dep@1.0.0:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  '${injected}': {}\n\n  own-dep@1.0.0: {}\n`,
  }
}

function sources(options: { readonly native: boolean, readonly served?: Buffer, readonly bundledPeer?: string, readonly armOnlyPeer?: boolean, readonly extra?: string, readonly peerDependencies?: Record<string, string>, readonly typescript?: boolean, readonly files?: Record<string, string>, readonly locked?: boolean, readonly injected?: boolean, readonly stray?: Record<string, string> }): PackSources {
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
        ...options.injected === true ? injectedByPnpm(directory) : {},
        ...options.files,
        ...options.stray,
      })
      await Promise.resolve()
    },
    locked: (name, _platform) => (name.startsWith('@vendor/native-') || (options.locked === true && name === '@vendor/native') ? { version: '9.9.9', integrity: integrity(NATIVE) } : undefined),
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

describe('a pack\'s metadata', () => {
  it('is byte for byte the same when the same sources are built in two different temporary folders', async () => {
    const first = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, injected: true }), temp())
    const second = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, injected: true }), temp())
    expect(first.entry).toEqual(second.entry)
    expect([...first.archives.values()].map(bytes => bytes.toString('hex'))).toEqual([...second.archives.values()].map(bytes => bytes.toString('hex')))
    expect(first.entry.variants.any!.files.map(file => file.path)).toEqual(expect.arrayContaining(['package.json', 'pnpm-lock.yaml']))
  })

  it('names an injected workspace package by the version the pack carries, with no path, and drops pnpm\'s workspace file', async () => {
    const scratch = temp()
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, injected: true }), scratch)
    const deployed = join(scratch, '@delorun__demo-linux-x64')
    expect(JSON.parse(readFileSync(join(deployed, 'package.json'), 'utf8')).dependencies).toEqual({ '@deepseek-ai/dsh-brand': '0.2.2-rc.3', 'own-dep': '1.0.0' })
    const lock = readFileSync(join(deployed, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).toContain("specifier: 0.2.2-rc.3")
    expect(lock).toContain("'@deepseek-ai/dsh-brand@0.2.2-rc.3':")
    expect(lock).toContain('resolution: { directory: node_modules/@deepseek-ai/dsh-brand, type: directory }')
    expect(lock).not.toMatch(/file:|\/tmp|delorun-pack-build/u)
    expect(existsSync(join(deployed, 'pnpm-workspace.yaml'))).toBe(false)
    expect(built.entry.variants.any!.files.map(file => file.path)).not.toContain('pnpm-workspace.yaml')
  })

  it.each([
    ['a dependency naming an absolute path', { 'package.json': JSON.stringify({ name: '@delorun/demo', version: '1.0.0', dependencies: { 'own-dep': 'file:/var/tmp/delorun-release-build-abc/source/own' } }) }, /@delorun\/demo for linux-x64.*package\.json dependencies\.own-dep: file:\/var\/tmp\/delorun-release-build-abc/u],
    ['a dependency naming a path outside the pack', { 'package.json': JSON.stringify({ name: '@delorun/demo', version: '1.0.0', optionalDependencies: { 'own-dep': 'link:../own' } }) }, /package\.json optionalDependencies\.own-dep: link:\.\.\/own/u],
    ['a lockfile key naming a home folder', { 'pnpm-lock.yaml': "packages:\n  'x@file:/home/someone/source/x':\n    resolution: {integrity: sha512-AAAA}\n" }, /pnpm-lock\.yaml packages > x@file:\/home\/someone\/source\/x: x@file:\/home\/someone\/source\/x/u],
    ['a lockfile directory outside the pack', { 'pnpm-lock.yaml': "packages:\n  x@1.0.0:\n    resolution: {directory: ../../../tmp/build/x, type: directory}\n" }, /pnpm-lock\.yaml packages > x@1\.0\.0 > resolution > directory: \.\.\/\.\.\/\.\.\/tmp\/build\/x/u],
    ['a Delorun package inside the pack naming a temporary folder', { 'node_modules/@delorun/inner/package.json': JSON.stringify({ name: '@delorun/inner', version: '1.0.0', dependencies: { 'own-dep': 'file:///tmp/y' } }), 'node_modules/@delorun/inner/index.js': 'export {}\n' }, /node_modules\/@delorun\/inner\/package\.json dependencies\.own-dep: file:\/\/\/tmp\/y/u],
  ])('refuses %s, naming the pack and the field', async (_label, stray, message) => {
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, stray }), temp())).rejects.toThrow(message)
  })

  it('refuses an injected package the deployment does not carry, as it has no version to write', async () => {
    const stray = { 'package.json': JSON.stringify({ name: '@delorun/demo', version: '1.0.0', dependencies: { 'missing-dep': 'missing-dep@file:///var/tmp/x/missing' } }) }
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ native: false, stray }), temp())).rejects.toThrow(/missing-dep by a file: path but does not carry it/u)
  })
})

describe('the recipe\'s pack externals', () => {
  const externals = (JSON.parse(readFileSync(join(import.meta.dirname, '../../closure.json'), 'utf8')) as { packExternals: string[] }).packExternals

  it('fetches the Claude Agent SDK package and its platform programs from the publisher, never from Delorun\'s pack', () => {
    expect(isExternal('@anthropic-ai/claude-agent-sdk', externals)).toBe(true)
    expect(isExternal('@anthropic-ai/claude-agent-sdk-linux-x64', externals)).toBe(true)
    expect(isExternal('@anthropic-ai/sdk', externals)).toBe(false)
  })

  it('pins the SDK\'s own package by URL and SHA-512 and leaves its files out of the archive', async () => {
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native'], sources({ native: false, files: { 'node_modules/@vendor/native/package.json': '{"name":"@vendor/native","version":"9.9.9"}', 'node_modules/@vendor/native/index.js': 'x\n' }, locked: true }), temp())
    const variant = built.entry.variants['linux-x64']!
    expect(variant.external.map(pin => pin.name)).toEqual(['@vendor/native'])
    expect(variant.files.some(file => file.path.includes('@vendor/native'))).toBe(false)
  })

  it('refuses a pack that carries an external package nested inside another package, at any depth', async () => {
    const nested = { 'node_modules/own-dep/node_modules/@vendor/native/package.json': '{"name":"@vendor/native","version":"1.0.0"}' }
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native'], sources({ native: false, files: nested }), temp()))
      .rejects.toThrow(/@delorun\/demo for linux-x64 carries @vendor\/native nested inside another package \(node_modules\/own-dep\/node_modules\/@vendor\/native\/package\.json\)/u)
    const deep = { 'node_modules/own-dep/node_modules/other/node_modules/@vendor/native-linux-x64/index.js': 'x\n' }
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native-*'], sources({ native: false, files: deep }), temp()))
      .rejects.toThrow(/carries @vendor\/native-linux-x64 nested inside another package/u)
  })

  it('passes an external package nested inside a top-level external that is dropped from the pack', async () => {
    const inside = { 'node_modules/@vendor/native/package.json': '{"name":"@vendor/native","version":"9.9.9"}', 'node_modules/@vendor/native/node_modules/inner-ext/package.json': '{"name":"inner-ext","version":"1.0.0"}', 'node_modules/@vendor/native/node_modules/@vendor/native-linux-x64/index.js': 'x\n' }
    const built = await buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native', '@vendor/native-*', 'inner-ext'], sources({ native: false, files: inside, locked: true }), temp())
    const variant = built.entry.variants['linux-x64']!
    expect(variant.external.map(pin => pin.name)).toEqual(['@vendor/native'])
    expect(variant.files.some(file => file.path.includes('inner-ext') || file.path.includes('@vendor/native'))).toBe(false)
    const elsewhere = { ...inside, 'node_modules/own-dep/node_modules/inner-ext/package.json': '{"name":"inner-ext","version":"1.0.0"}' }
    await expect(buildPack('@delorun/demo', '1.0.0', false, '0.1.0', PLATFORMS, 1_800_000_000, ['@vendor/native', '@vendor/native-*', 'inner-ext'], sources({ native: false, files: elsewhere, locked: true }), temp()))
      .rejects.toThrow(/carries inner-ext nested inside another package \(node_modules\/own-dep\/node_modules\/inner-ext\/package\.json\)/u)
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
