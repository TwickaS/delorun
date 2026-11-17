import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { storeFolder } from '../src/store.ts'
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
    const scanned = await scan(folder)
    const paths = scanned.entries.map((entry) => entry.path)
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
