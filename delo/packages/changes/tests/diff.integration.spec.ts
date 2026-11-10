import { createHash } from 'node:crypto'
import { chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeProtectedFile } from '@delo/home'
import { boundedDiff, compareVersions, DIFF_FILE_LIMIT, DIFF_TOTAL_LIMIT, reviewInputOf } from '../src/diff.ts'
import { objectsDirectory } from '../src/paths.ts'
import { storeFolder } from '../src/store.ts'
import type { VersionManifest } from '../src/types.ts'
import { rejection, temporaryDirectory, writeFiles } from './support.ts'

/**
 * Store a folder before and after an edit.
 * @param files - the folder's first files.
 * @param edit - changes the folder.
 * @returns the home and both manifests.
 */
async function versions(files: Readonly<Record<string, string | Uint8Array>>, edit: (folder: string) => void): Promise<{ home: string, before: VersionManifest, after: VersionManifest }> {
  const home = temporaryDirectory('delo-changes-home-')
  const folder = temporaryDirectory('delo-changes-folder-')
  writeFiles(folder, files)
  const before = (await storeFolder(home, folder)).manifest
  edit(folder)
  const after = (await storeFolder(home, folder)).manifest
  return { home, before, after }
}

const BINARY = Buffer.from([0x41, 0x00, 0x42])
const NOT_UTF8 = Buffer.from([0x41, 0xff, 0x42])

describe('compareVersions', () => {
  it('lists added, modified and removed files in path order with sizes, and leaves unchanged ones out', async () => {
    const { home, before, after } = await versions({ 'same.js': 's', 'mod.js': 'old', 'gone.js': 'g', 'mode.sh': 'm' }, (folder) => {
      writeFiles(folder, { 'mod.js': 'newer', 'add.js': 'a' })
      unlinkSync(join(folder, 'gone.js'))
      chmodSync(join(folder, 'mode.sh'), 0o755)
    })
    expect(await compareVersions(home, before, after)).toEqual([
      { path: 'add.js', status: 'added', binary: false, dependency: false, sizeAfter: 1 },
      { path: 'gone.js', status: 'removed', binary: false, dependency: false, sizeBefore: 1 },
      { path: 'mod.js', status: 'modified', binary: false, dependency: false, sizeBefore: 3, sizeAfter: 5 },
      { path: 'mode.sh', status: 'modified', binary: false, dependency: false, sizeBefore: 1, sizeAfter: 1 },
    ])
  })

  it('counts a link as a file whose content is its target', async () => {
    const { home, before, after } = await versions({ 'a.js': 'a' }, (folder) => {
      symlinkSync('a.js', join(folder, 'link'))
      unlinkSync(join(folder, 'a.js'))
      symlinkSync('elsewhere', join(folder, 'a.js'))
    })
    expect(await compareVersions(home, before, after)).toEqual([
      { path: 'a.js', status: 'modified', binary: false, dependency: false, sizeBefore: 1, sizeAfter: 9 },
      { path: 'link', status: 'added', binary: false, dependency: false, sizeAfter: 4 },
    ])
    const relinked = await versions({}, (folder) => { symlinkSync('x', join(folder, 'l')) })
    const second = await storeFolder(relinked.home, (() => {
      const folder = temporaryDirectory()
      symlinkSync('y', join(folder, 'l'))
      return folder
    })())
    expect(await compareVersions(relinked.home, relinked.after, second.manifest)).toEqual([
      { path: 'l', status: 'modified', binary: false, dependency: false, sizeBefore: 1, sizeAfter: 1 },
    ])
    expect(await compareVersions(relinked.home, relinked.after, relinked.after)).toEqual([])
  })

  it('marks a side with a NUL byte or invalid UTF-8 as binary, and a node_modules path as a dependency', async () => {
    const { home, before, after } = await versions({ 'text.bin': 'text', 'node_modules/dep/index.js': 'd' }, (folder) => {
      writeFiles(folder, { 'text.bin': BINARY, 'raw.dat': NOT_UTF8, 'copy.dat': NOT_UTF8, 'node_modules/dep/index.js': 'changed' })
    })
    expect(await compareVersions(home, before, after)).toEqual([
      { path: 'copy.dat', status: 'added', binary: true, dependency: false, sizeAfter: 3 },
      { path: 'node_modules/dep/index.js', status: 'modified', binary: false, dependency: true, sizeBefore: 1, sizeAfter: 7 },
      { path: 'raw.dat', status: 'added', binary: true, dependency: false, sizeAfter: 3 },
      { path: 'text.bin', status: 'modified', binary: true, dependency: false, sizeBefore: 4, sizeAfter: 3 },
    ])
  })

  it('lists every file as added when there is no content before', async () => {
    const { home, after } = await versions({ 'a.js': 'a' }, () => undefined)
    expect(await compareVersions(home, undefined, after)).toEqual([{ path: 'a.js', status: 'added', binary: false, dependency: false, sizeAfter: 1 }])
  })

  it('refuses an altered object', async () => {
    const { home, after } = await versions({ 'a.js': 'a' }, () => undefined)
    await writeProtectedFile(join(objectsDirectory(home), createHash('sha256').update('a').digest('hex')), 'tampered')
    await rejection(compareVersions(home, undefined, after), 'STORE_CORRUPT')
  })
})

describe('boundedDiff', () => {
  it('gives a unified diff of text files, names binary files without lines, and never shows dependency files', async () => {
    const { home, before, after } = await versions({ 'a.js': 'one\ntwo\n', 'gone.js': 'bye\n', 'image.png': 'x', 'node_modules/d/index.js': 'secret-old\n', 'mode.sh': 'm' }, (folder) => {
      writeFiles(folder, { 'a.js': 'one\nthree\n', 'image.png': BINARY, 'node_modules/d/index.js': 'secret-new\n', 'new.js': 'hello\n' })
      unlinkSync(join(folder, 'gone.js'))
      chmodSync(join(folder, 'mode.sh'), 0o755)
    })
    const changes = await compareVersions(home, before, after)
    const diff = await boundedDiff(home, before, after, changes)
    expect(diff.truncated).toBe(false)
    expect(diff.omitted).toEqual([])
    expect(diff.text).toContain('--- a/a.js\n+++ b/a.js\n')
    expect(diff.text).toContain('-two\n+three\n')
    expect(diff.text).toContain('--- a/gone.js\n+++ b/gone.js\n')
    expect(diff.text).toContain('-bye\n')
    expect(diff.text).toContain('+hello\n')
    expect(diff.text).toContain('Binary file image.png modified\n')
    expect(diff.text).not.toContain('secret')
    expect(diff.text).not.toContain('node_modules')
    expect(diff.text).not.toContain('mode.sh')
    expect(diff.text.indexOf('a/a.js')).toBeLessThan(diff.text.indexOf('a/gone.js'))
  })

  it('leaves out a text file above the file limit', async () => {
    const { home, before, after } = await versions({ 'big.js': 'x'.repeat(100), 'small.js': 'a' }, (folder) => {
      writeFiles(folder, { 'big.js': 'y'.repeat(100), 'small.js': 'b' })
    })
    const changes = await compareVersions(home, before, after)
    const diff = await boundedDiff(home, before, after, changes, { file: 50 })
    expect(diff).toMatchObject({ truncated: true, omitted: ['big.js'] })
    expect(diff.text).toContain('b/small.js')
    expect(diff.text).not.toContain('big.js')
  })

  it('stops at the total bound and lists every later text file as omitted', async () => {
    const { home, before, after } = await versions({}, (folder) => {
      writeFiles(folder, { 'a.js': 'a\n', 'b.js': 'b'.repeat(400), 'c.bin': BINARY, 'd.js': 'd\n' })
    })
    const changes = await compareVersions(home, before, after)
    const diff = await boundedDiff(home, before, after, changes, { total: 200 })
    expect(diff.truncated).toBe(true)
    expect(diff.omitted).toEqual(['b.js', 'd.js'])
    expect(diff.text).toContain('b/a.js')
    expect(diff.text).not.toContain('c.bin')
    expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(200)
  })

  it('does not list a binary file that does not fit as omitted', async () => {
    const { home, before, after } = await versions({}, (folder) => {
      writeFiles(folder, { 'a.bin': BINARY, 'b.js': 'b\n' })
    })
    const changes = await compareVersions(home, before, after)
    expect(await boundedDiff(home, before, after, changes, { total: 5 })).toEqual({ text: '', truncated: true, omitted: ['b.js'] })
  })

  it('has limits of 1 MiB per file and 256 KiB in all', () => {
    expect(DIFF_FILE_LIMIT).toBe(1024 * 1024)
    expect(DIFF_TOTAL_LIMIT).toBe(256 * 1024)
  })
})

describe('reviewInputOf', () => {
  it('gives each side\'s text for text files within the limit, none for dependency, binary or large files, and both manifests', async () => {
    const { home, before, after } = await versions({
      'package.json': '{"name":"p","version":"1.0.0"}',
      'mod.js': 'old',
      'gone.js': 'g',
      'node_modules/d/index.js': 'd',
      'big.js': 'x'.repeat(100),
      'image.png': 'x',
    }, (folder) => {
      writeFiles(folder, {
        'package.json': '{"name":"p","version":"2.0.0"}',
        'mod.js': 'new',
        'add.js': 'a',
        'node_modules/d/index.js': 'changed',
        'big.js': 'y'.repeat(100),
        'image.png': BINARY,
      })
      unlinkSync(join(folder, 'gone.js'))
      symlinkSync('mod.js', join(folder, 'link'))
    })
    const changes = await compareVersions(home, before, after)
    const input = await reviewInputOf(home, before, after, changes, { file: 50 })
    expect(input).toEqual({
      files: [
        { path: 'add.js', status: 'added', dependency: false, after: 'a' },
        { path: 'big.js', status: 'modified', dependency: false },
        { path: 'gone.js', status: 'removed', dependency: false, before: 'g' },
        { path: 'image.png', status: 'modified', dependency: false },
        { path: 'link', status: 'added', dependency: false, after: 'mod.js' },
        { path: 'mod.js', status: 'modified', dependency: false, before: 'old', after: 'new' },
        { path: 'node_modules/d/index.js', status: 'modified', dependency: true },
        { path: 'package.json', status: 'modified', dependency: false, before: '{"name":"p","version":"1.0.0"}', after: '{"name":"p","version":"2.0.0"}' },
      ],
      manifestBefore: { name: 'p', version: '1.0.0' },
      manifestAfter: { name: 'p', version: '2.0.0' },
    })
  })

  it('leaves out a manifest that is missing, not JSON or a link', async () => {
    const { home, before, after } = await versions({ 'package.json': 'not json' }, (folder) => {
      unlinkSync(join(folder, 'package.json'))
      symlinkSync('other.json', join(folder, 'package.json'))
    })
    const changes = await compareVersions(home, before, after)
    expect(await reviewInputOf(home, before, after, changes)).toEqual({
      files: [{ path: 'package.json', status: 'modified', dependency: false, before: 'not json', after: 'other.json' }],
    })
    expect(await reviewInputOf(home, undefined, before, await compareVersions(home, undefined, before))).toEqual({
      files: [{ path: 'package.json', status: 'added', dependency: false, after: 'not json' }],
    })
  })
})
