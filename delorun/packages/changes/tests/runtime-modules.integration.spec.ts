import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { holdContent } from '../src/enforce.ts'
import { holdsVersion, holdsVersionUnder, materialize, storeFolder } from '../src/store.ts'
import { scanFolder } from '../src/tree.ts'
import { rejection, temporaryDirectory, writeFiles } from './support.ts'

/**
 * Scan a folder as the start of a linked plugin does.
 * @param folder - the plugin folder.
 * @param entries - the entry limit.
 * @returns the scan.
 */
async function scan(folder: string, entries = 50_000): Promise<Awaited<ReturnType<typeof scanFolder>>> {
  return await scanFolder(folder, { home: temporaryDirectory('delorun-changes-home-'), limits: { entries, bytes: 1024 * 1024 } })
}

/**
 * @param directory - a package directory path.
 * @param manifest - its `package.json` fields.
 * @returns the files of a one-file package.
 */
function installed(directory: string, manifest: Record<string, unknown>): Record<string, string> {
  return { [`${directory}/package.json`]: JSON.stringify(manifest), [`${directory}/index.js`]: 'export {}' }
}

/** An npm install: hoisted real directories, with development packages beside the runtime ones. */
function npmFolder(): string {
  const folder = temporaryDirectory('delorun-changes-npm-')
  writeFiles(folder, {
    'package.json': JSON.stringify({ name: 'plug', dependencies: { runtime: '1', '@s/scoped': '1' }, peerDependencies: { peer: '1' }, devDependencies: { devtool: '1', runtime: '1' } }),
    'lib/index.js': 'export {}',
    ...installed('node_modules/runtime', { name: 'runtime', dependencies: { deep: '1', nested: '1' } }),
    ...installed('node_modules/deep', { name: 'deep' }),
    ...installed('node_modules/runtime/node_modules/nested', { name: 'nested', dependencies: { deep: '1' } }),
    ...installed('node_modules/@s/scoped', { name: '@s/scoped' }),
    ...installed('node_modules/peer', { name: 'peer' }),
    ...installed('node_modules/devtool', { name: 'devtool', dependencies: { devleaf: '1' } }),
    ...installed('node_modules/devleaf', { name: 'devleaf' }),
    ...installed('node_modules/runtime/node_modules/devonly', { name: 'devonly' }),
    'node_modules/.package-lock.json': '{}',
  })
  mkdirSync(join(folder, 'node_modules/.bin'))
  symlinkSync('../devtool/index.js', join(folder, 'node_modules/.bin/devtool'))
  return folder
}

describe('a linked folder with npm-installed packages', () => {
  it('copies only the packages the plugin can load: its dependency closure, found where Node finds them', async () => {
    const scanned = await scan(npmFolder())
    const paths = scanned.entries.map((entry) => entry.path)
    expect(paths.filter((path) => path.startsWith('node_modules/') && path.endsWith('index.js'))).toEqual([
      'node_modules/@s/scoped/index.js', 'node_modules/deep/index.js', 'node_modules/peer/index.js',
      'node_modules/runtime/index.js', 'node_modules/runtime/node_modules/nested/index.js',
    ])
    expect(paths).toContain('lib/index.js')
    expect(paths.some((path) => path.includes('devtool') || path.includes('devleaf') || path.includes('devonly') || path.includes('.bin'))).toBe(false)
  })

  it('names every top-level package the copy leaves out among the skipped paths, which the review lists', async () => {
    const folder = npmFolder()
    writeFiles(folder, installed('node_modules/@d/extraneous', { name: '@d/extraneous' }))
    const expected = ['node_modules/@d/extraneous', 'node_modules/devleaf', 'node_modules/devtool']
    expect((await scan(folder)).skipped).toEqual(expected)
    expect((await storeFolder(temporaryDirectory('delorun-changes-home-'), folder)).skipped).toEqual(expected)
  })

  it('names the first 25 left-out packages and counts the rest', async () => {
    const folder = npmFolder()
    for (let index = 0; index < 30; index++) writeFiles(folder, installed(`node_modules/extra-${String(index).padStart(2, '0')}`, { name: `extra-${String(index).padStart(2, '0')}` }))
    const { skipped } = await scan(folder)
    expect(skipped).toHaveLength(26)
    expect(skipped[0]).toBe('node_modules (and 7 more packages left out)')
  })

  it('copies the dependencies of a package an npm workspace links from inside the folder', async () => {
    const folder = temporaryDirectory('delorun-changes-npm-')
    writeFiles(folder, {
      'package.json': JSON.stringify({ name: 'plug', dependencies: { '@s/core': '1' } }),
      ...installed('packages/core', { name: '@s/core', dependencies: { lodash: '1' } }),
      ...installed('node_modules/lodash', { name: 'lodash' }),
      ...installed('node_modules/other', { name: 'other' }),
    })
    mkdirSync(join(folder, 'node_modules/@s'))
    symlinkSync('../../packages/core', join(folder, 'node_modules/@s/core'))
    writeFiles(folder, installed('packages/core/node_modules/nested', { name: 'nested' }))
    writeFiles(folder, installed('packages/core', { name: '@s/core', dependencies: { lodash: '1', nested: '1' } }))
    const scanned = await scan(folder)
    const paths = scanned.entries.map((entry) => entry.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toContain('packages/core/node_modules/nested/index.js')
    expect(paths).toContain('node_modules/@s/core')
    expect(paths).toContain('node_modules/lodash/index.js')
    expect(scanned.skipped).toEqual(['node_modules/other'])
  })

  it('keeps every package when the package.json cannot be read as JSON', async () => {
    const folder = temporaryDirectory('delorun-changes-npm-')
    writeFiles(folder, { 'package.json': '{not json', ...installed('node_modules/any', { name: 'any' }) })
    expect((await scan(folder)).entries.map((entry) => entry.path)).toContain('node_modules/any/index.js')
  })

  it('copies a folder whose development packages put the whole install over the limit', async () => {
    const folder = npmFolder()
    for (let index = 0; index < 40; index++) writeFiles(folder, installed(`node_modules/dev-extra-${String(index)}`, { name: `dev-extra-${String(index)}` }))
    writeFiles(folder, { 'package.json': JSON.stringify({ name: 'plug', dependencies: { runtime: '1' }, devDependencies: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`dev-extra-${String(index)}`, '1'])) }) })
    await rejection(scanFolder(folder, { home: temporaryDirectory('delorun-changes-home-'), limits: { entries: 40, bytes: 1024 * 1024 }, dependencies: 'link' }), 'CONTENT_TOO_LARGE')
    const scanned = await scan(folder, 40)
    expect(scanned.entries.some((entry) => entry.path.startsWith('node_modules/dev-extra'))).toBe(false)
    expect(scanned.entries.some((entry) => entry.path === 'node_modules/runtime/index.js')).toBe(true)
  })

  it('leaves out a package that only the development dependencies list, so an import of it finds nothing in the copy', async () => {
    const folder = temporaryDirectory('delorun-changes-npm-')
    writeFiles(folder, {
      'package.json': JSON.stringify({ name: 'plug', devDependencies: { devonly: '1' } }),
      'lib/index.js': "import 'devonly'",
      ...installed('node_modules/devonly', { name: 'devonly' }),
    })
    const scanned = await scan(folder)
    expect(scanned.entries.some((entry) => entry.path.startsWith('node_modules/devonly'))).toBe(false)
    expect(scanned.skipped).toEqual(['node_modules/devonly'])
  })

  it('keeps every package of a folder with no package.json', async () => {
    const folder = temporaryDirectory('delorun-changes-npm-')
    writeFiles(folder, { 'lib/index.js': 'x', ...installed('node_modules/any', { name: 'any' }) })
    expect((await scan(folder)).entries.map((entry) => entry.path)).toContain('node_modules/any/index.js')
  })
})

describe('a linked folder with pnpm-installed packages', () => {
  it('keeps its links into the store and every package it reaches, as before', async () => {
    const folder = temporaryDirectory('delorun-changes-pnpm-')
    writeFiles(folder, {
      'package.json': JSON.stringify({ name: 'plug', dependencies: { dep: '1' }, devDependencies: { devtool: '1' } }),
      ...installed('node_modules/.pnpm/dep@1.0.0/node_modules/dep', { name: 'dep' }),
      ...installed('node_modules/.pnpm/devtool@1.0.0/node_modules/devtool', { name: 'devtool' }),
    })
    symlinkSync('.pnpm/dep@1.0.0/node_modules/dep', join(folder, 'node_modules/dep'))
    symlinkSync('.pnpm/devtool@1.0.0/node_modules/devtool', join(folder, 'node_modules/devtool'))
    const paths = (await scan(folder)).entries.map((entry) => entry.path)
    expect(paths).toContain('node_modules/dep')
    expect(paths).toContain('node_modules/devtool')
    expect(paths).toContain('node_modules/.pnpm/devtool@1.0.0/node_modules/devtool/index.js')
  })
})

describe('a plugin pack whose peers link into the runtime store', () => {
  /**
   * Install one release with its pack: the runtime's `@s/peer` answers `answer`, and the pack's own package imports it
   * through the link the runtime store makes.
   * @param home - the Delorun home.
   * @param version - the release.
   * @param answer - what its peer exports.
   * @returns the pack folder.
   */
  function release(home: string, version: string, answer: number): string {
    const pack = join(home, 'packs', version, 'plug', 'package')
    writeFiles(home, {
      [`runtimes/${version}/app/node_modules/@s/peer/package.json`]: JSON.stringify({ name: '@s/peer', type: 'module', exports: './index.js' }),
      [`runtimes/${version}/app/node_modules/@s/peer/index.js`]: `export const answer = ${String(answer)}\n`,
      [`packs/${version}/plug/package/package.json`]: JSON.stringify({ name: 'plug', dependencies: { inner: '1', '@s/peer': '1' } }),
      [`packs/${version}/plug/package/node_modules/inner/package.json`]: JSON.stringify({ name: 'inner', type: 'module', exports: './index.js', dependencies: { '@s/peer': '1' } }),
      [`packs/${version}/plug/package/node_modules/inner/index.js`]: 'export { answer } from \'@s/peer\'\n',
    })
    mkdirSync(join(pack, 'node_modules', '@s'), { recursive: true })
    symlinkSync(join(home, 'runtimes', version, 'app', 'node_modules', '@s', 'peer'), join(pack, 'node_modules', '@s', 'peer'))
    return pack
  }

  /**
   * A home running release 0.1.0 with its pack, an older release 0.0.9, and other entries of the home a link may name.
   * @returns the home and the pack folder.
   */
  function packHome(): { readonly home: string, readonly pack: string } {
    const home = realpathSync(temporaryDirectory('delorun-changes-home-'))
    release(home, '0.0.9', 9)
    const pack = release(home, '0.1.0', 42)
    writeFiles(home, {
      'runtimes/current': '0.1.0\n',
      'runtimes/store.json': '{"layout":1}\n',
      'runtimes/keys/key': 'secret',
      'runtimes/0.1.0/bin/delorun': 'binary',
      'runtimes-x/node_modules/@s/peer/index.js': 'export const answer = 0\n',
      'staging/0123456789abcdef/index.js': 'export const answer = 0\n',
      'secrets/home-auth/key': 'secret',
    })
    symlinkSync(join(home, 'secrets', 'home-auth'), join(pack, 'node_modules', 'secret'))
    return { home, pack }
  }

  /**
   * @param copy - an active copy.
   * @returns what its own package imports from the peer, in a separate Node process.
   */
  function answerOf(copy: string): string {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `const { answer } = await import(${JSON.stringify(pathToFileURL(join(copy, 'node_modules', 'inner', 'index.js')).href)}); process.stdout.write(String(answer))`], { encoding: 'utf8' })
  }

  it('records a peer link into the active runtime\'s installed packages by its path there, and still leaves out a link to anywhere else in the home', async () => {
    const { home, pack } = packHome()
    const scanned = await scanFolder(pack, { home })
    expect(scanned.entries).toContainEqual({ type: 'link', path: 'node_modules/@s/peer', target: '@s/peer', outside: true, runtime: true })
    expect(scanned.entries.some(entry => entry.path.startsWith('node_modules/secret'))).toBe(false)
    expect(scanned.skipped).toContain('node_modules/secret')
  })

  it.each([
    ['another runtime version\'s package', 'runtimes/0.0.9/app/node_modules/@s/peer'],
    ['a path that climbs out of the active runtime\'s app folder', 'runtimes/0.1.0/app/../../keys'],
    ['the active runtime outside its app/node_modules', 'runtimes/0.1.0/bin'],
    ['the runtime store itself', 'runtimes'],
    ['the runtime store\'s layout record', 'runtimes/store.json'],
    ['a folder beside the runtime store whose name starts with its name', 'runtimes-x/node_modules/@s/peer'],
    ['a staging folder', 'staging/0123456789abcdef'],
    ['another pack', 'packs/0.0.9/plug/package'],
  ])('leaves out a link to %s', async (_what, target) => {
    const { home, pack } = packHome()
    // Written as given, so a `..` reaches the link's target unresolved.
    symlinkSync(`${home}/${target}`, join(pack, 'node_modules', 'elsewhere'))
    const scanned = await scanFolder(pack, { home })
    expect(scanned.entries.some(entry => entry.path.startsWith('node_modules/elsewhere'))).toBe(false)
    expect(scanned.skipped).toContain('node_modules/elsewhere')
  })

  it('leaves out a link to the active runtime\'s installed packages folder itself, which names no one package', async () => {
    const { home, pack } = packHome()
    symlinkSync(join(home, 'runtimes', '0.1.0', 'app', 'node_modules'), join(pack, 'node_modules', 'all'))
    const { manifest, skipped } = await storeFolder(home, pack)
    expect(skipped).toContain('node_modules/all')
    expect(manifest.entries.some(entry => entry.path.startsWith('node_modules/all'))).toBe(false)
  })

  it('keeps no runtime link at all while runtimes/current names no version', async () => {
    const { home, pack } = packHome()
    writeFiles(home, { 'runtimes/current': '../0.1.0\n' })
    const scanned = await scanFolder(pack, { home })
    expect(scanned.entries.some(entry => entry.path.startsWith('node_modules/@s/peer'))).toBe(false)
    expect(scanned.skipped).toContain('node_modules/@s/peer')
  })

  it('stores a copy whose own package loads the peer from the runtime store, as the pack does', async () => {
    const { home, pack } = packHome()
    const { version } = await storeFolder(home, pack)
    const copy = join(temporaryDirectory('delorun-changes-active-'), 'plug')
    await materialize(home, version, copy)
    expect(answerOf(copy)).toBe('42')
  })

  it('after an update keeps the approved version and re-points the copy to the new release\'s peers, which outlive the old release', async () => {
    const { home, pack } = packHome()
    const { version } = await storeFolder(home, pack)
    const copy = join(temporaryDirectory('delorun-changes-active-'), 'plug')
    await materialize(home, version, copy)
    // The update installs 0.2.0 with the same pack, switches runtimes/current, and retention removes the old release.
    const updated = release(home, '0.2.0', 43)
    writeFiles(home, { 'runtimes/current': '0.2.0\n' })
    expect((await storeFolder(home, updated)).version).toBe(version)
    expect(await holdsVersion(home, copy, version)).toBe(false)
    // A Host still running 0.1.0 holds the copy that names its packages; doctor holds it while they are there.
    expect(await holdsVersionUnder(home, copy, version, { kind: 'release', release: '0.1.0' })).toBe(true)
    expect(await holdsVersionUnder(home, copy, version, { kind: 'release', release: '0.2.0' })).toBe(false)
    expect(await holdsVersionUnder(home, copy, version, { kind: 'installed' })).toBe(true)
    await holdContent(home, copy, version)
    expect(await holdsVersion(home, copy, version)).toBe(true)
    rmSync(join(home, 'runtimes', '0.1.0'), { recursive: true })
    rmSync(join(home, 'packs', '0.1.0'), { recursive: true })
    expect(realpathSync(join(copy, 'node_modules', '@s', 'peer'))).toBe(join(home, 'runtimes', '0.2.0', 'app', 'node_modules', '@s', 'peer'))
    expect(answerOf(copy)).toBe('43')
  })

  it('refuses to write a runtime link while the home runs no installed release', async () => {
    const { home, pack } = packHome()
    const { version } = await storeFolder(home, pack)
    rmSync(join(home, 'runtimes', 'current'))
    await expect(materialize(home, version, join(temporaryDirectory('delorun-changes-active-'), 'plug'))).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })
})
