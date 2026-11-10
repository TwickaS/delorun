import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeProtectedFile } from '@delo/home'
import { CACHE_SETTLE_MS, compareCodeUnits, isDigest, manifestOf, openRegularFile, readChunks, SCAN_CACHE_SCHEMA, scanFolder, versionOf } from '../src/tree.ts'
import { VERSION_MANIFEST_SCHEMA, type ObjectDigest, type VersionEntry } from '../src/types.ts'
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

/** A clock far enough ahead that every file in a test counts as settled for the cache. */
const later = (): number => Date.now() + 10 * CACHE_SETTLE_MS

describe('scanFolder', () => {
  it('lists files with digest, size and execute bit, sorted by code unit, and leaves out .git at every depth', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'b.js': 'b', 'B.js': 'upper', 'a/x.js': 'x', '.git/config': 'c', 'a/.git/HEAD': 'h', 'a/.gitignore': 'g' })
    chmodSync(join(folder, 'b.js'), 0o755)
    const { entries, skipped } = await scanFolder(folder)
    expect(entries).toEqual([
      { type: 'file', path: 'B.js', digest: sha('upper'), size: 5, executable: false },
      { type: 'file', path: 'a/.gitignore', digest: sha('g'), size: 1, executable: false },
      { type: 'file', path: 'a/x.js', digest: sha('x'), size: 1, executable: false },
      { type: 'file', path: 'b.js', digest: sha('b'), size: 1, executable: true },
    ])
    expect(skipped).toEqual([])
  })

  it('keeps a relative link that stays inside the folder as written', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'sub/file.js': 'f' })
    symlinkSync('sub/file.js', join(folder, 'in'))
    symlinkSync('../missing.js', join(folder, 'sub', 'up'))
    symlinkSync('.', join(folder, 'self'))
    symlinkSync('sub', join(folder, 'dir'))
    const { entries } = await scanFolder(folder)
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'dir', target: 'sub', outside: false },
      { type: 'link', path: 'in', target: 'sub/file.js', outside: false },
      { type: 'link', path: 'self', target: '.', outside: false },
      { type: 'link', path: 'sub/up', target: '../missing.js', outside: false },
    ])
  })

  it('keeps a link into a node_modules directory as an outside link with its absolute target, and skips one that does not resolve', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    const store = join(workspace, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep')
    writeFiles(workspace, { 'node_modules/.pnpm/dep@1/node_modules/dep/index.js': 'd', 'plain.txt': 'p', 'loop/.keep': '' })
    mkdirSync(join(folder, 'node_modules'), { recursive: true })
    symlinkSync('../../node_modules/.pnpm/dep@1/node_modules/dep', join(folder, 'node_modules', 'dep'))
    symlinkSync(join(store, 'index.js'), join(folder, 'absolute.js'))
    symlinkSync('../missing', join(folder, 'missing'))
    symlinkSync('../plain.txt/below', join(folder, 'notdir'))
    symlinkSync('cycle', join(workspace, 'loop', 'cycle'))
    symlinkSync('../loop/cycle', join(folder, 'loop'))
    symlinkSync('.git/config', join(folder, 'git'))
    symlinkSync('../node_modules/absent', join(folder, 'absent'))
    const { entries, files, skipped } = await scanFolder(folder)
    expect(entries).toEqual([
      { type: 'link', path: 'absent', target: join(workspace, 'node_modules', 'absent'), outside: true },
      { type: 'link', path: 'absolute.js', target: join(store, 'index.js'), outside: true },
      { type: 'link', path: 'node_modules/dep', target: store, outside: true },
    ])
    expect(files).toEqual([])
    expect(skipped).toEqual(['git', 'loop', 'missing', 'notdir'])
  })

  it('dereferences a link to a sibling package, walking it by the same rules', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, {
      'plugin/index.js': 'p',
      'pkg/index.js': 'sibling',
      'pkg/.git/HEAD': 'h',
      'pkg/src/a.js': 'a',
      'node_modules/.pnpm/dep@1/node_modules/dep/index.js': 'd',
      'shared.txt': 'shared',
    })
    symlinkSync('src', join(workspace, 'pkg', 'lib'))
    mkdirSync(join(workspace, 'pkg', 'node_modules'))
    symlinkSync('../../node_modules/.pnpm/dep@1/node_modules/dep', join(workspace, 'pkg', 'node_modules', 'dep'))
    makeFifo(join(workspace, 'pipe'))
    mkdirSync(join(folder, 'node_modules', '@scope'), { recursive: true })
    symlinkSync('../../../pkg', join(folder, 'node_modules', '@scope', 'pkg'))
    symlinkSync(join(workspace, 'shared.txt'), join(folder, 'shared.txt'))
    symlinkSync('../pipe', join(folder, 'pipe'))
    const { entries, files, skipped } = await scanFolder(folder)
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'link', path: 'node_modules/@scope/pkg/lib', target: 'src', outside: false },
      { type: 'file', path: 'node_modules/@scope/pkg/index.js', digest: sha('sibling'), size: 7, executable: false },
      { type: 'link', path: 'node_modules/@scope/pkg/node_modules/dep', target: join(workspace, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep'), outside: true },
      { type: 'file', path: 'node_modules/@scope/pkg/src/a.js', digest: sha('a'), size: 1, executable: false },
      { type: 'file', path: 'shared.txt', digest: sha('shared'), size: 6, executable: false },
    ].sort((x, y) => compareCodeUnits(x.path, y.path)))
    expect(files.map((file) => file.source)).toEqual([
      join(folder, 'index.js'),
      join(workspace, 'pkg', 'index.js'),
      join(workspace, 'pkg', 'src', 'a.js'),
      join(workspace, 'shared.txt'),
    ])
    expect(skipped).toEqual(['pipe'])
    const before = versionOf(entries)
    writeFiles(workspace, { 'pkg/index.js': 'edited' })
    expect(versionOf((await scanFolder(folder)).entries)).not.toBe(before)
  })

  it('includes each real directory once, linking every later path to it relatively, and skips a link to a containing directory', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'pkg/index.js': 'sibling', 'pkg/src/a.js': 'a' })
    symlinkSync('../pkg', join(folder, 'pkg'))
    symlinkSync('../pkg', join(folder, 'twice'))
    symlinkSync(join(workspace, 'pkg', 'src', 'a.js'), join(folder, 'z.js'))
    symlinkSync('../plugin', join(workspace, 'pkg', 'back'))
    symlinkSync(join(workspace, 'pkg'), join(workspace, 'pkg', 'again'))
    symlinkSync(join(workspace, 'pkg', 'src'), join(workspace, 'pkg', 'source'))
    symlinkSync('..', join(folder, 'parent'))
    symlinkSync('/', join(folder, 'root'))
    const { entries, files, skipped } = await scanFolder(folder)
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'pkg/again', target: '.', outside: false },
      { type: 'link', path: 'pkg/back', target: '..', outside: false },
      { type: 'link', path: 'pkg/source', target: 'src', outside: false },
      { type: 'link', path: 'twice', target: 'pkg', outside: false },
      { type: 'link', path: 'z.js', target: 'pkg/src/a.js', outside: false },
    ])
    expect(files.map((file) => file.entry.path)).toEqual(['index.js', 'pkg/index.js', 'pkg/src/a.js'])
    expect(skipped).toEqual(['parent', 'root'])
  })

  it('includes a directory two dereferenced packages link once, and finishes on a cycle between them', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'a/index.js': 'a', 'b/index.js': 'b', 'c/index.js': 'c' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../a', join(folder, 'node_modules', 'a'))
    symlinkSync('../../b', join(folder, 'node_modules', 'b'))
    symlinkSync('../c', join(workspace, 'a', 'shared'))
    symlinkSync('../c', join(workspace, 'b', 'shared'))
    symlinkSync('../a', join(workspace, 'c', 'back'))
    symlinkSync('../plugin', join(workspace, 'c', 'home'))
    const { entries, files } = await scanFolder(folder)
    expect(files.map((file) => file.source)).toEqual([
      join(folder, 'index.js'),
      join(workspace, 'a', 'index.js'),
      join(workspace, 'c', 'index.js'),
      join(workspace, 'b', 'index.js'),
    ])
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'node_modules/a/shared/back', target: '..', outside: false },
      { type: 'link', path: 'node_modules/a/shared/home', target: '../../..', outside: false },
      { type: 'link', path: 'node_modules/b/shared', target: '../a/shared', outside: false },
    ])
  })

  it('links, and never copies, the dependencies of a dereferenced package', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    const store = join(workspace, 'node_modules', '.pnpm', 'x@1', 'node_modules', 'x')
    writeFiles(workspace, {
      'plugin/index.js': 'p',
      'pkg/index.js': 'sibling',
      'pkg/node_modules/real/index.js': 'nested',
      'dep/index.js': 'dep',
      'node_modules/.pnpm/x@1/node_modules/x/index.js': 'x',
    })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../pkg', join(folder, 'node_modules', 'pkg'))
    const modules = join(workspace, 'pkg', 'node_modules')
    mkdirSync(join(modules, '@s'))
    symlinkSync('../../../dep', join(modules, '@s', 'dep'))
    symlinkSync('../../dep/index.js', join(modules, 'file'))
    symlinkSync('../../missing', join(modules, 'gone'))
    symlinkSync('../../plugin', join(modules, 'plugin'))
    symlinkSync('../..', join(modules, 'root'))
    symlinkSync('../../node_modules/.pnpm/x@1/node_modules/x', join(modules, 'x'))
    const { entries, skipped } = await scanFolder(folder)
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'file', path: 'node_modules/pkg/index.js', digest: sha('sibling'), size: 7, executable: false },
      { type: 'link', path: 'node_modules/pkg/node_modules/@s/dep', target: join(workspace, 'dep'), outside: true },
      { type: 'link', path: 'node_modules/pkg/node_modules/file', target: join(workspace, 'dep', 'index.js'), outside: true },
      { type: 'link', path: 'node_modules/pkg/node_modules/plugin', target: '../../..', outside: false },
      { type: 'file', path: 'node_modules/pkg/node_modules/real/index.js', digest: sha('nested'), size: 6, executable: false },
      { type: 'link', path: 'node_modules/pkg/node_modules/x', target: store, outside: true },
    ])
    expect(skipped).toEqual(['node_modules/pkg/node_modules/gone', 'node_modules/pkg/node_modules/root'])
  })

  it('dereferences a link into the folder\'s own .git directory, and links back into it relatively', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { '.git/hooks/pre-commit': 'hook' })
    symlinkSync('.git/hooks', join(folder, 'hooks'))
    symlinkSync(join(folder, '.git', 'hooks'), join(folder, '.git', 'hooks', 'again'))
    const { entries } = await scanFolder(folder)
    expect(entries).toEqual([
      { type: 'link', path: 'hooks/again', target: '.', outside: false },
      { type: 'file', path: 'hooks/pre-commit', digest: sha('hook'), size: 4, executable: false },
    ])
  })

  it('finishes on this repository\'s bundle-local package and includes its workspace dependencies', async () => {
    const { entries } = await scanFolder(join(import.meta.dirname, '..', '..', 'bundle-local'))
    expect(entries.some((entry) => entry.path.startsWith('node_modules/@delo/') && entry.type === 'file')).toBe(true)
    expect(entries.length).toBeLessThan(5000)
  }, 120_000)

  it('fails with the filesystem error when a link target cannot be examined', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'locked/inner/a.js': 'a' })
    symlinkSync('../locked/inner', join(folder, 'inner'))
    lockOut(join(workspace, 'locked'))
    await expect(scanFolder(folder)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('judges links against the real path of a folder reached through a link', async () => {
    const parent = temporaryDirectory()
    const real = join(parent, 'real')
    writeFiles(real, { 'a.js': 'a' })
    symlinkSync('a.js', join(real, 'b'))
    symlinkSync(real, join(parent, 'alias'))
    const { entries } = await scanFolder(join(parent, 'alias'))
    expect(entries.at(-1)).toEqual({ type: 'link', path: 'b', target: 'a.js', outside: false })
  })

  it('skips a FIFO and lists it', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a' })
    mkdirSync(join(folder, 'pipes'))
    makeFifo(join(folder, 'pipes', 'p'))
    const { entries, skipped } = await scanFolder(folder)
    expect(entries.map((entry) => entry.path)).toEqual(['a.js'])
    expect(skipped).toEqual(['pipes/p'])
  })

  it('fails with the filesystem error for a missing folder', async () => {
    await expect(scanFolder(join(temporaryDirectory(), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the scan cache', () => {
  it('records settled files only, in a 0600 file in a 0700 directory it creates', async () => {
    const folder = temporaryDirectory()
    const home = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a' })
    const cache = join(home, 'profile', 'scan-cache.json')
    await scanFolder(folder, { cache })
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual({ schema: SCAN_CACHE_SCHEMA, files: {} })
    expect(modeOf(cache)).toBe(0o600)
    expect(modeOf(join(home, 'profile'))).toBe(0o700)
    await scanFolder(folder, { cache, now: later })
    const stats = statSync(join(folder, 'a.js'))
    expect(JSON.parse(readFileSync(cache, 'utf8')).files).toEqual({
      'a.js': { dev: stats.dev, ino: stats.ino, size: 1, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest: sha('a') },
    })
  })

  it('reuses a cached digest when device, inode, size and times match', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a', 'b.js': 'b' })
    await scanFolder(folder, { cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, { digest: string }> }
    // A digest only the cache can have supplied shows the file was not read again.
    written.files['a.js']!.digest = sha('cached')
    await writeProtectedFile(cache, JSON.stringify(written))
    const { entries } = await scanFolder(folder, { cache, now: later })
    expect(entries.map((entry) => entry.type === 'file' && entry.digest)).toEqual([sha('cached'), sha('b')])
  })

  it.each(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)('hashes the file again when the cached %s differs', async (field) => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a' })
    await scanFolder(folder, { cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, Record<string, number | string>> }
    const entry = written.files['a.js']!
    entry.digest = sha('cached')
    entry[field] = (entry[field] as number) + 1
    await writeProtectedFile(cache, JSON.stringify(written))
    const { entries } = await scanFolder(folder, { cache, now: later })
    expect(entries).toEqual([{ type: 'file', path: 'a.js', digest: sha('a'), size: 1, executable: false }])
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON null', 'null'],
    ['another schema', JSON.stringify({ schema: 'other/1', files: {} })],
    ['files that are not an object', JSON.stringify({ schema: SCAN_CACHE_SCHEMA, files: 'x' })],
    ['files that are null', JSON.stringify({ schema: SCAN_CACHE_SCHEMA, files: null })],
  ])('ignores and rewrites a cache holding %s', async (_name, text) => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a' })
    await writeProtectedFile(cache, text)
    const { entries } = await scanFolder(folder, { cache, now: later })
    expect(entries).toEqual([{ type: 'file', path: 'a.js', digest: sha('a'), size: 1, executable: false }])
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toMatchObject({ schema: SCAN_CACHE_SCHEMA, files: { 'a.js': { digest: sha('a') } } })
  })

  it('ignores a cache file other users can read', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a' })
    await scanFolder(folder, { cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, { digest: string }> }
    written.files['a.js']!.digest = sha('cached')
    writeFileSync(cache, JSON.stringify(written))
    chmodSync(cache, 0o644)
    const { entries } = await scanFolder(folder, { cache, now: later })
    expect(entries).toEqual([{ type: 'file', path: 'a.js', digest: sha('a'), size: 1, executable: false }])
    expect(modeOf(cache)).toBe(0o600)
  })

  it('drops cache entries whose fields do not have their types and keeps the rest', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c', 'd.js': 'd', 'e.js': 'e' })
    await scanFolder(folder, { cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, unknown> }
    const files = written.files as Record<string, Record<string, unknown>>
    for (const entry of Object.values(files)) entry.digest = sha('cached')
    files['a.js'] = { ...files['a.js'], ino: 'x' }
    files['b.js'] = { ...files['b.js'], digest: 'not-a-digest' }
    files['c.js'] = { ...files['c.js'], digest: 7 }
    written.files['d.js'] = null
    const { entries } = await scanFolder(folder, { cache: await rewrite(cache, written), now: later })
    expect(entries.map((entry) => entry.type === 'file' && entry.digest)).toEqual([sha('a'), sha('b'), sha('c'), sha('d'), sha('cached')])
  })
})

/**
 * Write a cache value back to its file.
 * @param cache - the file.
 * @param value - the value.
 * @returns the file.
 */
async function rewrite(cache: string, value: unknown): Promise<string> {
  await writeProtectedFile(cache, JSON.stringify(value))
  return cache
}

describe('versionOf and manifestOf', () => {
  const file: VersionEntry = { type: 'file', path: 'b', digest: sha('b'), size: 1, executable: false }
  const link: VersionEntry = { type: 'link', path: 'a', target: 'b', outside: false }

  it('gives the same version for entries in any order, and a different one for any field', () => {
    expect(versionOf([file, link])).toBe(versionOf([link, file]))
    expect(isDigest(versionOf([file, link]))).toBe(true)
    expect(versionOf([file])).not.toBe(versionOf([{ ...file, executable: true }]))
    expect(versionOf([link])).not.toBe(versionOf([{ ...link, outside: true }]))
    expect(versionOf([])).toBe(createHash('sha256').update('[]').digest('hex'))
  })

  it('sorts a manifest by path', () => {
    expect(manifestOf([file, link])).toEqual({ schema: VERSION_MANIFEST_SCHEMA, entries: [link, file] })
  })

  it('orders by code unit', () => {
    expect(['b', 'a', 'B', 'a'].sort(compareCodeUnits)).toEqual(['B', 'a', 'a', 'b'])
  })
})

describe('openRegularFile and readChunks', () => {
  it('reads a file larger than one chunk to its end', async () => {
    const folder = temporaryDirectory()
    const bytes = Buffer.alloc(200_000, 7)
    writeFiles(folder, { big: bytes })
    const { handle, stats } = await openRegularFile(join(folder, 'big'))
    const chunks: Buffer[] = []
    try {
      expect(await readChunks(handle, (chunk) => { chunks.push(Buffer.from(chunk)) })).toBe(200_000)
    } finally {
      await handle.close()
    }
    expect(stats.size).toBe(200_000)
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
  })

  it('refuses a symbolic link as a file replaced while it was read', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { a: 'a' })
    symlinkSync('a', join(folder, 'link'))
    await rejection(openRegularFile(join(folder, 'link')), 'CHANGED_WHILE_READING')
  })

  it('refuses a FIFO without blocking on it', async () => {
    const folder = temporaryDirectory()
    makeFifo(join(folder, 'p'))
    await rejection(openRegularFile(join(folder, 'p')), 'CHANGED_WHILE_READING')
  })

  it('fails with the filesystem error for a missing file', async () => {
    await expect(openRegularFile(join(temporaryDirectory(), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
