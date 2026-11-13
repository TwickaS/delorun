import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeProtectedFile } from '@delo/home'
import { CACHE_SETTLE_MS, compareCodeUnits, CONTENT_BYTE_LIMIT, CONTENT_ENTRY_LIMIT, isDigest, manifestOf, openRegularFile, readChunks, SCAN_CACHE_SCHEMA, scanFolder, versionOf } from '../src/tree.ts'
import { VERSION_MANIFEST_SCHEMA, type ObjectDigest, type VersionEntry } from '../src/types.ts'
import { lockOut, makeFifo, modeOf, rejection, temporaryDirectory, understateSize, writeFiles } from './support.ts'

/** A Delo home no test creates: the scans of folders outside it only need to know where it is. */
const HOME = join(import.meta.dirname, 'no-delo-home')

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

/** The scan of an active directory, which keeps links to installed packages as outside links. */
const LINKED = { home: HOME, dependencies: 'link' } as const

/** A clock far enough ahead that every file in a test counts as settled for the cache. */
const later = (): number => Date.now() + 10 * CACHE_SETTLE_MS

describe('scanFolder', () => {
  it('lists files with digest, size and execute bit, sorted by code unit, and leaves out .git at every depth', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'b.js': 'b', 'B.js': 'upper', 'a/x.js': 'x', '.git/config': 'c', 'a/.git/HEAD': 'h', 'a/.gitignore': 'g' })
    chmodSync(join(folder, 'b.js'), 0o755)
    const { entries, skipped } = await scanFolder(folder, { home: HOME })
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
    const { entries } = await scanFolder(folder, { home: HOME })
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'dir', target: 'sub', outside: false },
      { type: 'link', path: 'in', target: 'sub/file.js', outside: false },
      { type: 'link', path: 'self', target: '.', outside: false },
      { type: 'link', path: 'sub/up', target: '../missing.js', outside: false },
    ])
  })

  it('with dependencies kept as links, keeps a link into a node_modules directory as an outside link with its absolute target, and skips one that does not resolve', async () => {
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
    const { entries, files, skipped } = await scanFolder(folder, LINKED)
    expect(entries).toEqual([
      { type: 'link', path: 'absent', target: join(workspace, 'node_modules', 'absent'), outside: true },
      { type: 'link', path: 'absolute.js', target: join(store, 'index.js'), outside: true },
      { type: 'link', path: 'node_modules/dep', target: store, outside: true },
    ])
    expect(files).toEqual([])
    expect(skipped).toEqual(['git', 'loop', 'missing', 'notdir'])
  })

  it('with dependencies kept as links, dereferences a link to a sibling workspace package, walking it by the same rules, and leaves out other links out of the folder', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, {
      'plugin/index.js': 'p',
      'pkg/index.js': 'sibling',
      'pkg/package.json': '{"name":"@scope/pkg"}',
      'pkg/.git/HEAD': 'h',
      'pkg/src/a.js': 'a',
      'node_modules/.pnpm/dep@1/node_modules/dep/index.js': 'd',
      'shared.txt': 'shared',
      'unpackaged/index.js': 'u',
      'tools/package.json': '{"name":"tools"}',
    })
    symlinkSync('src', join(workspace, 'pkg', 'lib'))
    mkdirSync(join(workspace, 'pkg', 'node_modules'))
    symlinkSync('../../node_modules/.pnpm/dep@1/node_modules/dep', join(workspace, 'pkg', 'node_modules', 'dep'))
    makeFifo(join(workspace, 'pipe'))
    mkdirSync(join(folder, 'node_modules', '@scope'), { recursive: true })
    symlinkSync('../../../pkg', join(folder, 'node_modules', '@scope', 'pkg'))
    // A directory without a package.json, a name that is no package name, and a package at a path no workspace links
    // a package at are not sibling workspace packages; nor is a file.
    symlinkSync('../../unpackaged', join(folder, 'node_modules', 'unpackaged'))
    symlinkSync('../../tools', join(folder, 'node_modules', '.bin'))
    symlinkSync('../tools', join(folder, 'tools'))
    symlinkSync(join(workspace, 'shared.txt'), join(folder, 'shared.txt'))
    symlinkSync('../pipe', join(folder, 'pipe'))
    const { entries, files, skipped } = await scanFolder(folder, LINKED)
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'link', path: 'node_modules/@scope/pkg/lib', target: 'src', outside: false },
      { type: 'file', path: 'node_modules/@scope/pkg/index.js', digest: sha('sibling'), size: 7, executable: false },
      { type: 'link', path: 'node_modules/@scope/pkg/node_modules/dep', target: join(workspace, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep'), outside: true },
      { type: 'file', path: 'node_modules/@scope/pkg/package.json', digest: sha('{"name":"@scope/pkg"}'), size: 21, executable: false },
      { type: 'file', path: 'node_modules/@scope/pkg/src/a.js', digest: sha('a'), size: 1, executable: false },
    ].sort((x, y) => compareCodeUnits(x.path, y.path)))
    expect(files.map((file) => file.source)).toEqual([
      join(folder, 'index.js'),
      join(workspace, 'pkg', 'index.js'),
      join(workspace, 'pkg', 'package.json'),
      join(workspace, 'pkg', 'src', 'a.js'),
    ])
    expect(skipped).toEqual(['node_modules/.bin', 'node_modules/unpackaged', 'pipe', 'shared.txt', 'tools'])
    const before = versionOf(entries)
    writeFiles(workspace, { 'pkg/index.js': 'edited' })
    expect(versionOf((await scanFolder(folder, LINKED)).entries)).not.toBe(before)
  })

  it('includes each real directory once, linking every later path to it relatively, and skips a link to a containing directory', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'pkg/index.js': 'sibling', 'pkg/package.json': '{}', 'pkg/src/a.js': 'a' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../pkg', join(folder, 'node_modules', 'pkg'))
    symlinkSync('../pkg', join(folder, 'twice'))
    symlinkSync(join(workspace, 'pkg', 'src', 'a.js'), join(folder, 'z.js'))
    symlinkSync('../plugin', join(workspace, 'pkg', 'back'))
    symlinkSync(join(workspace, 'pkg'), join(workspace, 'pkg', 'again'))
    symlinkSync(join(workspace, 'pkg', 'src'), join(workspace, 'pkg', 'source'))
    symlinkSync('..', join(folder, 'parent'))
    symlinkSync('/', join(folder, 'root'))
    const { entries, files, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'node_modules/pkg/again', target: '.', outside: false },
      { type: 'link', path: 'node_modules/pkg/back', target: '../..', outside: false },
      { type: 'link', path: 'node_modules/pkg/source', target: 'src', outside: false },
      { type: 'link', path: 'twice', target: 'node_modules/pkg', outside: false },
      { type: 'link', path: 'z.js', target: 'node_modules/pkg/src/a.js', outside: false },
    ])
    expect(files.map((file) => file.entry.path)).toEqual(['index.js', 'node_modules/pkg/index.js', 'node_modules/pkg/package.json', 'node_modules/pkg/src/a.js'])
    expect(skipped).toEqual(['parent', 'root'])
  })

  it('includes a directory two dereferenced packages link once, and finishes on a cycle between them', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'a/index.js': 'a', 'b/index.js': 'b', 'c/index.js': 'c', 'a/package.json': '{}', 'b/package.json': '{}', 'c/package.json': '{}' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../a', join(folder, 'node_modules', 'a'))
    symlinkSync('../../b', join(folder, 'node_modules', 'b'))
    mkdirSync(join(workspace, 'a', 'node_modules'))
    mkdirSync(join(workspace, 'b', 'node_modules'))
    symlinkSync('../../c', join(workspace, 'a', 'node_modules', 'c'))
    symlinkSync('../../c', join(workspace, 'b', 'node_modules', 'c'))
    symlinkSync('../a', join(workspace, 'c', 'back'))
    symlinkSync('../plugin', join(workspace, 'c', 'home'))
    const { entries, files } = await scanFolder(folder, { home: HOME })
    expect(files.map((file) => file.source)).toEqual([
      join(folder, 'index.js'),
      join(workspace, 'a', 'index.js'),
      join(workspace, 'c', 'index.js'),
      join(workspace, 'c', 'package.json'),
      join(workspace, 'a', 'package.json'),
      join(workspace, 'b', 'index.js'),
      join(workspace, 'b', 'package.json'),
    ])
    expect(entries.filter((entry) => entry.type === 'link')).toEqual([
      { type: 'link', path: 'node_modules/a/node_modules/c/back', target: '../..', outside: false },
      { type: 'link', path: 'node_modules/a/node_modules/c/home', target: '../../../..', outside: false },
      { type: 'link', path: 'node_modules/b/node_modules/c', target: '../../a/node_modules/c', outside: false },
    ])
  })

  it('with dependencies kept as links, links, and never copies, the dependencies of a dereferenced package', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    const store = join(workspace, 'node_modules', '.pnpm', 'x@1', 'node_modules', 'x')
    writeFiles(workspace, {
      'plugin/index.js': 'p',
      'pkg/index.js': 'sibling',
      'pkg/package.json': '{}',
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
    const { entries, skipped } = await scanFolder(folder, LINKED)
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'file', path: 'node_modules/pkg/index.js', digest: sha('sibling'), size: 7, executable: false },
      { type: 'link', path: 'node_modules/pkg/node_modules/@s/dep', target: join(workspace, 'dep'), outside: true },
      { type: 'link', path: 'node_modules/pkg/node_modules/file', target: join(workspace, 'dep', 'index.js'), outside: true },
      { type: 'link', path: 'node_modules/pkg/node_modules/plugin', target: '../../..', outside: false },
      { type: 'file', path: 'node_modules/pkg/node_modules/real/index.js', digest: sha('nested'), size: 6, executable: false },
      { type: 'link', path: 'node_modules/pkg/node_modules/x', target: store, outside: true },
      { type: 'file', path: 'node_modules/pkg/package.json', digest: sha('{}'), size: 2, executable: false },
    ])
    expect(skipped).toEqual(['node_modules/pkg/node_modules/gone', 'node_modules/pkg/node_modules/root'])
  })

  it('dereferences a link into the folder\'s own .git directory, and links back into it relatively', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { '.git/hooks/pre-commit': 'hook' })
    symlinkSync('.git/hooks', join(folder, 'hooks'))
    symlinkSync('.git/hooks/pre-commit', join(folder, 'hook.sh'))
    symlinkSync(join(folder, '.git', 'hooks'), join(folder, '.git', 'hooks', 'again'))
    const { entries } = await scanFolder(folder, { home: HOME })
    expect(entries).toEqual([
      { type: 'file', path: 'hook.sh', digest: sha('hook'), size: 4, executable: false },
      { type: 'link', path: 'hooks/again', target: '.', outside: false },
      { type: 'file', path: 'hooks/pre-commit', digest: sha('hook'), size: 4, executable: false },
    ])
  })

  it('finishes on this repository\'s bundle-local package: too large to copy with its installed packages, and with them kept as links it includes its workspace dependencies', async () => {
    const bundle = join(import.meta.dirname, '..', '..', 'bundle-local')
    await rejection(scanFolder(bundle, { home: HOME }), 'CONTENT_TOO_LARGE')
    const { entries } = await scanFolder(bundle, LINKED)
    expect(entries.some((entry) => entry.path.startsWith('node_modules/@delo/') && entry.type === 'file')).toBe(true)
    // The package's own files and the linked workspace packages grow with the source; a copy of the installed packages passes CONTENT_ENTRY_LIMIT (50 000).
    expect(entries.length).toBeLessThan(10_000)
  }, 120_000)

  it('fails with the filesystem error when a link target cannot be examined', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'locked/inner/a.js': 'a' })
    symlinkSync('../locked/inner', join(folder, 'inner'))
    lockOut(join(workspace, 'locked'))
    await expect(scanFolder(folder, { home: HOME })).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('judges links against the real path of a folder reached through a link', async () => {
    const parent = temporaryDirectory()
    const real = join(parent, 'real')
    writeFiles(real, { 'a.js': 'a' })
    symlinkSync('a.js', join(real, 'b'))
    symlinkSync(real, join(parent, 'alias'))
    const { entries } = await scanFolder(join(parent, 'alias'), { home: HOME })
    expect(entries.at(-1)).toEqual({ type: 'link', path: 'b', target: 'a.js', outside: false })
  })

  it('skips a FIFO and lists it', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a' })
    mkdirSync(join(folder, 'pipes'))
    makeFifo(join(folder, 'pipes', 'p'))
    const { entries, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries.map((entry) => entry.path)).toEqual(['a.js'])
    expect(skipped).toEqual(['pipes/p'])
  })

  it('includes an installed package\'s files and the dependencies pnpm installs beside it, and skips a dangling link into node_modules', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    const pnpm = join(workspace, 'node_modules', '.pnpm')
    writeFiles(pnpm, {
      'dep@1/node_modules/dep/package.json': JSON.stringify({ name: 'dep', dependencies: { inner: '1', '@s/scoped': '1', dep: '1', missing: '1', '../escape': '1' }, optionalDependencies: { own: '1' }, peerDependencies: 'not an object' }),
      'dep@1/node_modules/dep/node_modules/own/index.js': 'own',
      'inner@1/node_modules/inner/package.json': '{"name":"inner","dependencies":{"dep":"1"}}',
      '@s+scoped@1/node_modules/@s/scoped/package.json': '[1]',
      'dep@1/node_modules/own/index.js': 'not used',
    })
    symlinkSync('../../inner@1/node_modules/inner', join(pnpm, 'dep@1', 'node_modules', 'inner'))
    symlinkSync('../../dep@1/node_modules/dep', join(pnpm, 'inner@1', 'node_modules', 'dep'))
    mkdirSync(join(pnpm, 'dep@1', 'node_modules', '@s'))
    symlinkSync('../../../@s+scoped@1/node_modules/@s/scoped', join(pnpm, 'dep@1', 'node_modules', '@s', 'scoped'))
    writeFiles(folder, { 'index.js': 'p' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../node_modules/.pnpm/dep@1/node_modules/dep', join(folder, 'node_modules', 'dep'))
    symlinkSync('../../node_modules/absent', join(folder, 'node_modules', 'absent'))
    const { entries, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries.map((entry) => entry.type === 'link' ? `${entry.path} -> ${entry.target}` : entry.path)).toEqual([
      'index.js',
      'node_modules/dep/node_modules/@s/scoped/package.json',
      'node_modules/dep/node_modules/inner/node_modules/dep -> ../../..',
      'node_modules/dep/node_modules/inner/package.json',
      'node_modules/dep/node_modules/own/index.js',
      'node_modules/dep/package.json',
    ])
    expect(entries.every((entry) => entry.type === 'file' || !entry.outside)).toBe(true)
    expect(skipped).toEqual(['node_modules/absent'])
  })

  it('reads no dependency names from a package.json that is too large, not JSON, null or without dependency objects', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    const pnpm = join(workspace, 'node_modules', '.pnpm')
    writeFiles(pnpm, {
      'big@1/node_modules/big/index.js': 'b',
      'bad@1/node_modules/bad/package.json': '{',
      'big@1/node_modules/other/index.js': 'o',
      'nul@1/node_modules/nul/package.json': 'null',
      'nul@1/node_modules/other/index.js': 'o',
      'none@1/node_modules/none/package.json': '{"dependencies":null}',
      'none@1/node_modules/other/index.js': 'o',
    })
    writeFileSync(join(pnpm, 'big@1', 'node_modules', 'big', 'package.json'), JSON.stringify({ dependencies: { other: '1' }, padding: 'x'.repeat(1024 * 1024) }))
    writeFiles(folder, { 'index.js': 'p' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../node_modules/.pnpm/big@1/node_modules/big', join(folder, 'node_modules', 'big'))
    symlinkSync('../../node_modules/.pnpm/bad@1/node_modules/bad', join(folder, 'node_modules', 'bad'))
    symlinkSync('../../node_modules/.pnpm/nul@1/node_modules/nul', join(folder, 'node_modules', 'nul'))
    symlinkSync('../../node_modules/.pnpm/none@1/node_modules/none', join(folder, 'node_modules', 'none'))
    const { entries } = await scanFolder(folder, { home: HOME })
    expect(entries.map((entry) => entry.path)).toEqual([
      'index.js',
      'node_modules/bad/package.json',
      'node_modules/big/index.js',
      'node_modules/big/package.json',
      'node_modules/none/package.json',
      'node_modules/nul/package.json',
    ])
  })

  it('judges a relative link by where it resolves on disk, not by its spelling', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'outside/inner/a.js': 'a', 'outside/inner/package.json': '{}', 'outside/secret.js': 's' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../outside/inner', join(folder, 'node_modules', 'evil'))
    symlinkSync('node_modules/evil/..', join(folder, 'up'))
    symlinkSync('node_modules/evil/../gone/x', join(folder, 'dangling'))
    symlinkSync('missing/x', join(folder, 'inside'))
    const { entries, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'link', path: 'inside', target: 'missing/x', outside: false },
      { type: 'file', path: 'node_modules/evil/a.js', digest: sha('a'), size: 1, executable: false },
      { type: 'file', path: 'node_modules/evil/package.json', digest: sha('{}'), size: 2, executable: false },
    ])
    expect(skipped).toEqual(['dangling', 'up'])
  })

  it('a link whose spelling leaves the folder is outside even when its real path is inside', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(folder, { 'index.js': 'p' })
    symlinkSync('plugin', join(workspace, 'alias'))
    // Kept as written, `../alias/index.js` in an active directory would name a file beside it, not this folder's.
    symlinkSync('../alias/index.js', join(folder, 'x'))
    const { entries } = await scanFolder(folder, { home: HOME })
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'link', path: 'x', target: 'index.js', outside: false },
    ])
  })

  it.runIf(existsSync('/proc/self/status'))('a link into /proc is never read', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'index.js': 'p' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('/proc/self/status', join(folder, 'status'))
    symlinkSync('/proc/self/cmdline', join(folder, 'node_modules', 'cmdline'))
    const { entries, files, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries.map((entry) => entry.path)).toEqual(['index.js'])
    expect(files.map((file) => file.source)).toEqual([join(folder, 'index.js')])
    expect(skipped).toEqual(['node_modules/cmdline', 'status'])
  })

  it('never walks into the Delo home, and reads nothing of a folder that is the home or in a system directory', async () => {
    const workspace = temporaryDirectory()
    const home = join(workspace, '.delo')
    writeFiles(workspace, { 'index.js': 'p', '.delo/secret.txt': 's' })
    const { entries, skipped } = await scanFolder(workspace, { home })
    expect(entries.map((entry) => entry.path)).toEqual(['index.js'])
    expect(skipped).toEqual(['.delo'])
    expect(await scanFolder(home, { home })).toEqual({ entries: [], files: [], skipped: ['.'] })
    expect(await scanFolder('/dev', { home })).toEqual({ entries: [], files: [], skipped: ['.'] })
  })

  it('fails with the filesystem error when a sibling package\'s package.json cannot be examined', async () => {
    const workspace = temporaryDirectory()
    const folder = join(workspace, 'plugin')
    writeFiles(workspace, { 'plugin/index.js': 'p', 'closed/package.json': '{}' })
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync('../../closed', join(folder, 'node_modules', 'closed'))
    lockOut(join(workspace, 'closed'))
    await expect(scanFolder(folder, { home: HOME })).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('an active directory\'s scan follows no link, recording one that leaves it as an outside link', async () => {
    const workspace = temporaryDirectory()
    const active = join(workspace, 'active')
    writeFiles(workspace, { 'active/index.js': 'p', 'pkg/package.json': '{}', 'secret.txt': 's' })
    mkdirSync(join(active, 'node_modules'))
    symlinkSync('../../pkg', join(active, 'node_modules', 'pkg'))
    symlinkSync('../secret.txt', join(active, 'secret.txt'))
    symlinkSync('../missing', join(active, 'missing'))
    symlinkSync('index.js', join(active, 'inside'))
    const { entries, files } = await scanFolder(active, { active: true })
    expect(entries).toEqual([
      { type: 'file', path: 'index.js', digest: sha('p'), size: 1, executable: false },
      { type: 'link', path: 'inside', target: 'index.js', outside: false },
      { type: 'link', path: 'missing', target: join(workspace, 'missing'), outside: true },
      { type: 'link', path: 'node_modules/pkg', target: join(workspace, 'pkg'), outside: true },
      { type: 'link', path: 'secret.txt', target: join(workspace, 'secret.txt'), outside: true },
    ])
    expect(files.map((file) => file.source)).toEqual([join(active, 'index.js')])
  })

  it('a file that grows while it is read is refused', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a', 'grown.js': 'grown!' })
    const restore = await understateSize(join(folder, 'grown.js'), 3)
    try {
      const error = await rejection(scanFolder(folder, { home: HOME }), 'CHANGED_WHILE_READING')
      expect(error.detail).toBe(`${join(folder, 'grown.js')} grew while it was read`)
    } finally {
      restore()
    }
  })

  it('skips a name holding a backslash, which no version path can hold', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a', 'sub\\b.js': 'b' })
    const { entries, skipped } = await scanFolder(folder, { home: HOME })
    expect(entries.map((entry) => entry.path)).toEqual(['a.js'])
    expect(skipped).toEqual(['sub\\b.js'])
  })

  it('refuses a folder with more files, links and directories than a version holds', async () => {
    const folder = temporaryDirectory()
    for (let index = 0; index < CONTENT_ENTRY_LIMIT; index++) mkdirSync(join(folder, `d${String(index)}`))
    const error = await rejection(scanFolder(folder, { home: HOME }), 'CONTENT_TOO_LARGE')
    expect(error.detail).toContain(`more than ${String(CONTENT_ENTRY_LIMIT)} files, links and directories`)
  }, 120_000)

  it('refuses a folder with more bytes than a version holds, before reading them', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a' })
    writeFileSync(join(folder, 'big.bin'), '')
    truncateSync(join(folder, 'big.bin'), CONTENT_BYTE_LIMIT)
    const error = await rejection(scanFolder(folder, { home: HOME }), 'CONTENT_TOO_LARGE')
    expect(error.detail).toContain('more than 512 MiB')
  })

  it('fails with the filesystem error for a missing folder', async () => {
    await expect(scanFolder(join(temporaryDirectory(), 'missing'), { home: HOME })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the scan cache', () => {
  it('records settled files only, in a 0600 file in a 0700 directory it creates', async () => {
    const folder = temporaryDirectory()
    const home = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a' })
    const cache = join(home, 'profile', 'scan-cache.json')
    await scanFolder(folder, { home: HOME, cache })
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual({ schema: SCAN_CACHE_SCHEMA, files: {} })
    expect(modeOf(cache)).toBe(0o600)
    expect(modeOf(join(home, 'profile'))).toBe(0o700)
    await scanFolder(folder, { home: HOME, cache, now: later })
    const stats = statSync(join(folder, 'a.js'))
    expect(JSON.parse(readFileSync(cache, 'utf8')).files).toEqual({
      'a.js': { dev: stats.dev, ino: stats.ino, size: 1, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest: sha('a') },
    })
  })

  it('reuses a cached digest when device, inode, size and times match', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a', 'b.js': 'b' })
    await scanFolder(folder, { home: HOME, cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, { digest: string }> }
    // A digest only the cache can have supplied shows the file was not read again.
    written.files['a.js']!.digest = sha('cached')
    await writeProtectedFile(cache, JSON.stringify(written))
    const { entries } = await scanFolder(folder, { home: HOME, cache, now: later })
    expect(entries.map((entry) => entry.type === 'file' && entry.digest)).toEqual([sha('cached'), sha('b')])
  })

  it.each(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)('hashes the file again when the cached %s differs', async (field) => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a' })
    await scanFolder(folder, { home: HOME, cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, Record<string, number | string>> }
    const entry = written.files['a.js']!
    entry.digest = sha('cached')
    entry[field] = (entry[field] as number) + 1
    await writeProtectedFile(cache, JSON.stringify(written))
    const { entries } = await scanFolder(folder, { home: HOME, cache, now: later })
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
    const { entries } = await scanFolder(folder, { home: HOME, cache, now: later })
    expect(entries).toEqual([{ type: 'file', path: 'a.js', digest: sha('a'), size: 1, executable: false }])
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toMatchObject({ schema: SCAN_CACHE_SCHEMA, files: { 'a.js': { digest: sha('a') } } })
  })

  it('ignores a cache file other users can read', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a' })
    await scanFolder(folder, { home: HOME, cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, { digest: string }> }
    written.files['a.js']!.digest = sha('cached')
    writeFileSync(cache, JSON.stringify(written))
    chmodSync(cache, 0o644)
    const { entries } = await scanFolder(folder, { home: HOME, cache, now: later })
    expect(entries).toEqual([{ type: 'file', path: 'a.js', digest: sha('a'), size: 1, executable: false }])
    expect(modeOf(cache)).toBe(0o600)
  })

  it('drops cache entries whose fields do not have their types and keeps the rest', async () => {
    const folder = temporaryDirectory()
    const cache = join(temporaryDirectory(), 'scan-cache.json')
    writeFiles(folder, { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c', 'd.js': 'd', 'e.js': 'e' })
    await scanFolder(folder, { home: HOME, cache, now: later })
    const written = JSON.parse(readFileSync(cache, 'utf8')) as { files: Record<string, unknown> }
    const files = written.files as Record<string, Record<string, unknown>>
    for (const entry of Object.values(files)) entry.digest = sha('cached')
    files['a.js'] = { ...files['a.js'], ino: 'x' }
    files['b.js'] = { ...files['b.js'], digest: 'not-a-digest' }
    files['c.js'] = { ...files['c.js'], digest: 7 }
    written.files['d.js'] = null
    const { entries } = await scanFolder(folder, { home: HOME, cache: await rewrite(cache, written), now: later })
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
      expect(await readChunks(handle, { size: stats.size, path: join(folder, 'big') }, (chunk) => { chunks.push(Buffer.from(chunk)) })).toBe(200_000)
    } finally {
      await handle.close()
    }
    expect(stats.size).toBe(200_000)
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
  })

  it('stops at the end of a file that holds less than its counted size, and refuses one that holds more', async () => {
    const folder = temporaryDirectory()
    writeFiles(folder, { short: 'abc' })
    const path = join(folder, 'short')
    const { handle } = await openRegularFile(path)
    try {
      expect(await readChunks(handle, { size: 10, path }, () => undefined)).toBe(3)
    } finally {
      await handle.close()
    }
    const again = await openRegularFile(path)
    try {
      expect((await rejection(readChunks(again.handle, { size: 2, path }, () => undefined), 'CHANGED_WHILE_READING')).detail).toBe(`${path} grew while it was read`)
    } finally {
      await again.handle.close()
    }
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
