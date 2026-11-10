import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeProtectedFile } from '@delo/home'
import { objectsDirectory, versionsDirectory } from '../src/paths.ts'
import { holdsVersion, materialize, readObject, readVersion, storeFolder } from '../src/store.ts'
import { versionOf } from '../src/tree.ts'
import { VERSION_MANIFEST_SCHEMA, type ContentVersion, type ObjectDigest, type VersionEntry } from '../src/types.ts'
import { lockOut, makeFifo, modeOf, rejection, temporaryDirectory, writeFiles } from './support.ts'

// The cases write real files and git histories; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/**
 * The SHA-256 of a text.
 * @param text - the text.
 * @returns its digest.
 */
function sha(text: string): ObjectDigest {
  return createHash('sha256').update(text).digest('hex') as ObjectDigest
}

/**
 * A home and a plugin folder holding files.
 * @param files - the folder's files.
 * @returns the two directories.
 */
function setUp(files: Readonly<Record<string, string>>): { home: string, folder: string } {
  const home = temporaryDirectory('delo-changes-home-')
  const folder = temporaryDirectory('delo-changes-folder-')
  writeFiles(folder, files)
  return { home, folder }
}

/**
 * The inode of a path.
 * @param path - the path.
 * @returns its inode number.
 */
function inode(path: string): number {
  return lstatSync(path).ino
}

describe('storeFolder', () => {
  it('copies each file into a 0600 object named by its digest and writes the version file', async () => {
    const { home, folder } = setUp({ 'index.js': 'one', 'lib/two.js': 'two' })
    symlinkSync('index.js', join(folder, 'main'))
    makeFifo(join(folder, 'pipe'))
    const stored = await storeFolder(home, folder)
    expect(stored.skipped).toEqual(['pipe'])
    expect(stored.manifest.schema).toBe(VERSION_MANIFEST_SCHEMA)
    expect(stored.version).toBe(versionOf(stored.manifest.entries))
    expect(readdirSync(objectsDirectory(home)).sort()).toEqual([sha('one'), sha('two')].sort())
    expect(modeOf(join(objectsDirectory(home), sha('one')))).toBe(0o600)
    expect(modeOf(objectsDirectory(home))).toBe(0o700)
    expect(modeOf(versionsDirectory(home))).toBe(0o700)
    expect(modeOf(join(versionsDirectory(home), `${stored.version}.json`))).toBe(0o600)
    expect(await readVersion(home, stored.version)).toEqual(stored.manifest)
    expect((await readObject(home, sha('two'))).toString()).toBe('two')
  })

  it('does not copy an object the store holds, and gives the same version again', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const first = await storeFolder(home, folder)
    const object = join(objectsDirectory(home), sha('a'))
    const before = inode(object)
    const copied: string[] = []
    const second = await storeFolder(home, folder, { onCopied: (path) => { copied.push(path) } })
    expect(second.version).toBe(first.version)
    expect(copied).toEqual([])
    expect(inode(object)).toBe(before)
  })

  it('replaces a symbolic link standing where an object belongs', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    await storeFolder(home, folder)
    const object = join(objectsDirectory(home), sha('a'))
    unlinkSync(object)
    symlinkSync(join(folder, 'a.js'), object)
    await storeFolder(home, folder)
    expect(lstatSync(object).isFile()).toBe(true)
  })

  it('passes the scan cache on', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const cache = join(home, 'changes', 'profiles', 'p', 'scan-cache.json')
    await storeFolder(home, folder, { scanCache: cache })
    expect(existsSync(cache)).toBe(true)
  })

  it('refuses a file whose bytes while copying differ from the scan, leaving no temporary file', async () => {
    const { home, folder } = setUp({ 'a.js': 'a', 'b.js': 'b' })
    const error = await rejection(storeFolder(home, folder, {
      onCopied: (path) => { if (path === 'a.js') writeFileSync(join(folder, 'b.js'), 'changed') },
    }), 'CHANGED_WHILE_READING')
    expect(error.subject).toBe(join(folder, 'b.js'))
    expect(readdirSync(objectsDirectory(home))).toEqual([sha('a')])
    expect(readdirSync(versionsDirectory(home))).toEqual([])
  })

  it('refuses a folder whose version after copying differs from before', async () => {
    const { home, folder } = setUp({ 'a.js': 'a', 'b.js': 'b' })
    const error = await rejection(storeFolder(home, folder, {
      onCopied: (path) => { if (path === 'b.js') writeFileSync(join(folder, 'a.js'), 'changed') },
    }), 'CHANGED_WHILE_READING')
    expect(error.subject).toBe(folder)
    expect(readdirSync(versionsDirectory(home))).toEqual([])
  })

  it('fails with the filesystem error when the store cannot be examined', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    await storeFolder(home, folder)
    writeFiles(folder, { 'b.js': 'b' })
    lockOut(objectsDirectory(home))
    await expect(storeFolder(home, folder)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('readVersion', () => {
  const name = sha('any') as string as ContentVersion

  /**
   * Write a version file.
   * @param home - the Delo home.
   * @param version - its name.
   * @param text - its text.
   */
  async function writeVersion(home: string, version: string, text: string): Promise<void> {
    await storeFolder(home, temporaryDirectory())
    await writeProtectedFile(join(versionsDirectory(home), `${version}.json`), text)
  }

  it('refuses a version file whose content is not the version its name says', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version, manifest } = await storeFolder(home, folder)
    const altered = { ...manifest, entries: manifest.entries.map((entry) => ({ ...entry, size: 2 })) }
    await writeProtectedFile(join(versionsDirectory(home), `${version}.json`), JSON.stringify(altered))
    await rejection(readVersion(home, version), 'STORE_CORRUPT')
  })

  it('refuses a missing version file', async () => {
    const home = temporaryDirectory()
    await rejection(readVersion(home, name), 'STORE_CORRUPT')
  })

  it('refuses a version file other users can read', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    chmodSync(join(versionsDirectory(home), `${version}.json`), 0o644)
    await rejection(readVersion(home, version), 'STORE_CORRUPT')
  })

  it('fails with the filesystem error when the store cannot be examined', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    lockOut(versionsDirectory(home))
    await expect(readVersion(home, version)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON null', 'null'],
    ['another schema', JSON.stringify({ schema: 'other/1', entries: [] })],
    ['entries that are not an array', JSON.stringify({ schema: VERSION_MANIFEST_SCHEMA, entries: {} })],
  ])('refuses a version file holding %s', async (_name, text) => {
    const home = temporaryDirectory()
    await writeVersion(home, name, text)
    await rejection(readVersion(home, name), 'STORE_CORRUPT')
  })

  const file = { type: 'file', path: 'a', digest: sha('a'), size: 1, executable: false }
  const link = { type: 'link', path: 'b', target: 'a', outside: false }
  it.each([
    ['an entry that is not an object', [null]],
    ['a path that is not a string', [{ ...file, path: 1 }]],
    ['an absolute path', [{ ...file, path: '/a' }]],
    ['a backslash', [{ ...file, path: 'a\\b' }]],
    ['a NUL character', [{ ...file, path: 'a\0' }]],
    ['an empty segment', [{ ...file, path: 'a//b' }]],
    ['a trailing separator', [{ ...file, path: 'a/' }]],
    ['a . segment', [{ ...file, path: './a' }]],
    ['a .. segment', [{ ...file, path: 'a/../b' }]],
    ['an unknown type', [{ ...file, type: 'directory' }]],
    ['a digest that is not a string', [{ ...file, digest: 1 }]],
    ['a digest that is not SHA-256 hex', [{ ...file, digest: 'ABC' }]],
    ['a size that is not an integer', [{ ...file, size: 1.5 }]],
    ['a negative size', [{ ...file, size: -1 }]],
    ['an execute bit that is not a boolean', [{ ...file, executable: 'no' }]],
    ['a link target that is not a string', [{ ...link, target: 1 }]],
    ['an empty link target', [{ ...link, target: '' }]],
    ['a link outside flag that is not a boolean', [{ ...link, outside: 'no' }]],
    ['entries out of order', [link, file]],
    ['a repeated path', [file, file]],
    ['a path below a file', [file, { ...link, path: 'a/b' }]],
  ])('refuses a version listing %s', async (_name, entries) => {
    const home = temporaryDirectory()
    await writeVersion(home, name, JSON.stringify({ schema: VERSION_MANIFEST_SCHEMA, entries }))
    await rejection(readVersion(home, name), 'STORE_CORRUPT')
  })

  it('reads a version written by hand when its name is its digest', async () => {
    const home = temporaryDirectory()
    const entries = [file, link] as VersionEntry[]
    const version = versionOf(entries)
    await writeVersion(home, version, JSON.stringify({ schema: VERSION_MANIFEST_SCHEMA, entries: entries.map((entry) => ({ ...entry, extra: true })) }))
    expect((await readVersion(home, version)).entries).toEqual(entries)
  })
})

describe('readObject', () => {
  it('refuses an object whose bytes do not have its digest', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    await storeFolder(home, folder)
    await writeProtectedFile(join(objectsDirectory(home), sha('a')), 'tampered')
    await rejection(readObject(home, sha('a')), 'STORE_CORRUPT')
  })

  it('refuses a missing object', async () => {
    await rejection(readObject(temporaryDirectory(), sha('a')), 'STORE_CORRUPT')
  })
})

describe('materialize', () => {
  it('creates a directory holding the version, with its modes and links', async () => {
    const { home, folder } = setUp({ 'index.js': 'one', 'bin/run': 'run' })
    chmodSync(join(folder, 'bin', 'run'), 0o755)
    symlinkSync('index.js', join(folder, 'main'))
    const { version, manifest } = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    expect(await materialize(home, version, target)).toEqual(manifest)
    expect(modeOf(target)).toBe(0o700)
    expect(modeOf(join(target, 'bin'))).toBe(0o700)
    expect(modeOf(join(target, 'index.js'))).toBe(0o600)
    expect(modeOf(join(target, 'bin', 'run'))).toBe(0o700)
    expect(readFileSync(join(target, 'bin', 'run'), 'utf8')).toBe('run')
    expect(readlinkSync(join(target, 'main'))).toBe('index.js')
    expect(await holdsVersion(target, version)).toBe(true)
  })

  it('keeps an unchanged file\'s inode, replaces a changed one, and removes what the version lacks with its emptied directories', async () => {
    const { home, folder } = setUp({ 'same.js': 'same', 'changed.js': 'old', 'gone/only.js': 'x', 'mode.sh': 'm', 'kept/a.js': 'a', 'kept/b.js': 'b', 'swap': 's' })
    symlinkSync('same.js', join(folder, 'link'))
    symlinkSync('same.js', join(folder, 'tofile'))
    const first = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    await materialize(home, first.version, target)
    const inodes = { same: inode(join(target, 'same.js')), changed: inode(join(target, 'changed.js')), mode: inode(join(target, 'mode.sh')), link: inode(join(target, 'link')) }
    writeFileSync(join(folder, 'changed.js'), 'new')
    unlinkSync(join(folder, 'gone', 'only.js'))
    unlinkSync(join(folder, 'kept', 'b.js'))
    chmodSync(join(folder, 'mode.sh'), 0o755)
    unlinkSync(join(folder, 'swap'))
    symlinkSync('same.js', join(folder, 'swap'))
    unlinkSync(join(folder, 'tofile'))
    writeFiles(folder, { 'tofile': 'now a file', 'added/new.js': 'added' })
    const second = await storeFolder(home, folder)
    await materialize(home, second.version, target, first.manifest)
    expect(inode(join(target, 'same.js'))).toBe(inodes.same)
    expect(inode(join(target, 'link'))).toBe(inodes.link)
    expect(inode(join(target, 'changed.js'))).not.toBe(inodes.changed)
    expect(inode(join(target, 'mode.sh'))).not.toBe(inodes.mode)
    expect(modeOf(join(target, 'mode.sh'))).toBe(0o700)
    expect(readFileSync(join(target, 'changed.js'), 'utf8')).toBe('new')
    expect(readlinkSync(join(target, 'swap'))).toBe('same.js')
    expect(readFileSync(join(target, 'tofile'), 'utf8')).toBe('now a file')
    expect(existsSync(join(target, 'gone'))).toBe(false)
    expect(readdirSync(join(target, 'kept'))).toEqual(['a.js'])
    expect(await holdsVersion(target, second.version)).toBe(true)
  })

  it('materializes a dereferenced package whose own dependencies stay links, and the copy holds the version', async () => {
    const home = temporaryDirectory('delo-changes-home-')
    const workspace = temporaryDirectory('delo-changes-workspace-')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'pkg/index.js': 'sibling', 'dep/index.js': 'dep' })
    const folder = join(workspace, 'plugin')
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../pkg', join(folder, 'node_modules', 'pkg'))
    mkdirSync(join(workspace, 'pkg', 'node_modules'))
    symlinkSync('../../dep', join(workspace, 'pkg', 'node_modules', 'dep'))
    symlinkSync('../../plugin', join(workspace, 'pkg', 'node_modules', 'plugin'))
    const { version } = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    await materialize(home, version, target)
    expect(readlinkSync(join(target, 'node_modules', 'pkg', 'node_modules', 'dep'))).toBe(join(workspace, 'dep'))
    expect(realpathSync(join(target, 'node_modules', 'pkg', 'node_modules', 'plugin'))).toBe(target)
    expect(await holdsVersion(target, version)).toBe(true)
  })

  it('keeps a dependency link that leaves the folder resolving to the same directory from the copy', async () => {
    const home = temporaryDirectory('delo-changes-home-')
    const workspace = temporaryDirectory('delo-changes-workspace-')
    writeFiles(workspace, { 'node_modules/.pnpm/dep@1/node_modules/dep/index.js': 'dependency', 'packages/plugin/index.js': 'plugin' })
    const folder = join(workspace, 'packages', 'plugin')
    writeFiles(folder, { 'node_modules/.keep': '' })
    symlinkSync('../../../node_modules/.pnpm/dep@1/node_modules/dep', join(folder, 'node_modules', 'dep'))
    const { version, manifest } = await storeFolder(home, folder)
    const dependency = join(workspace, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep')
    expect(manifest.entries.find((entry) => entry.path === 'node_modules/dep')).toEqual({ type: 'link', path: 'node_modules/dep', target: dependency, outside: true })
    const target = join(home, 'active', 'plugin')
    await materialize(home, version, target)
    expect(realpathSync(join(target, 'node_modules', 'dep'))).toBe(dependency)
    expect(readFileSync(join(target, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dependency')
  })

  it('copies a dereferenced sibling package\'s files into the active directory', async () => {
    const home = temporaryDirectory('delo-changes-home-')
    const workspace = temporaryDirectory('delo-changes-workspace-')
    writeFiles(workspace, { 'pkg/index.js': 'sibling', 'plugin/index.js': 'plugin' })
    const folder = join(workspace, 'plugin')
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../pkg', join(folder, 'node_modules', 'pkg'))
    const { version } = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    await materialize(home, version, target)
    const copied = join(target, 'node_modules', 'pkg', 'index.js')
    expect(lstatSync(join(target, 'node_modules', 'pkg')).isDirectory()).toBe(true)
    expect(readFileSync(copied, 'utf8')).toBe('sibling')
    writeFiles(workspace, { 'pkg/index.js': 'edited' })
    expect(readFileSync(copied, 'utf8')).toBe('sibling')
    expect((await storeFolder(home, folder)).version).not.toBe(version)
  })

  it('replaces a file with a directory of the same name', async () => {
    const { home, folder } = setUp({ 'a': 'file' })
    const first = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    await materialize(home, first.version, target)
    unlinkSync(join(folder, 'a'))
    writeFiles(folder, { 'a/b': 'below' })
    const second = await storeFolder(home, folder)
    await materialize(home, second.version, target, first.manifest)
    expect(readFileSync(join(target, 'a', 'b'), 'utf8')).toBe('below')
  })

  it('without the previous manifest, scans the directory and removes extra files and FIFOs', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    writeFiles(target, { 'a.js': 'a', 'extra/x.js': 'x' })
    makeFifo(join(target, 'pipe'))
    const before = inode(join(target, 'a.js'))
    await materialize(home, version, target)
    expect(readdirSync(target)).toEqual(['a.js'])
    expect(inode(join(target, 'a.js'))).toBe(before)
  })

  it('refuses a directory that does not hold the version afterwards, as when the previous manifest is wrong', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const first = await storeFolder(home, folder)
    writeFiles(folder, { 'a.js': 'changed' })
    const second = await storeFolder(home, folder)
    const target = join(home, 'active', 'plugin')
    await materialize(home, first.version, target)
    await rejection(materialize(home, second.version, target, second.manifest), 'STORE_CORRUPT')
  })

  it('refuses an object whose bytes do not have its digest, writing nothing for it', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    await writeProtectedFile(join(objectsDirectory(home), sha('a')), 'tampered')
    const target = join(home, 'active', 'plugin')
    await rejection(materialize(home, version, target), 'STORE_CORRUPT')
    expect(readdirSync(target)).toEqual([])
  })

  it('refuses a missing object and an object that is a link', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    const object = join(objectsDirectory(home), sha('a'))
    unlinkSync(object)
    await rejection(materialize(home, version, join(home, 'one')), 'STORE_CORRUPT')
    writeFiles(home, { elsewhere: 'a' })
    symlinkSync(join(home, 'elsewhere'), object)
    await rejection(materialize(home, version, join(home, 'two')), 'STORE_CORRUPT')
  })

  it('fails with the filesystem error for an object it cannot open', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    lockOut(join(objectsDirectory(home), sha('a')))
    await expect(materialize(home, version, join(home, 'target'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a version the store does not hold', async () => {
    await rejection(materialize(temporaryDirectory(), sha('none') as string as ContentVersion, join(temporaryDirectory(), 't')), 'STORE_CORRUPT')
  })
})

describe('holdsVersion', () => {
  it('answers false for another version and a missing directory', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    expect(await holdsVersion(folder, version)).toBe(true)
    expect(await holdsVersion(home, version)).toBe(false)
    expect(await holdsVersion(join(home, 'missing'), version)).toBe(false)
  })

  it('fails with the filesystem error for a path that is not a directory', async () => {
    const { home, folder } = setUp({ 'a.js': 'a' })
    const { version } = await storeFolder(home, folder)
    await expect(holdsVersion(join(folder, 'a.js'), version)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
