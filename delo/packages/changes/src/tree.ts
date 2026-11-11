/**
 * Reading a plugin folder as a content version: its regular files by digest, its symbolic links by target, and the
 * canonical version id over them. A scan never opens a socket, FIFO or device, leaves every directory named `.git`
 * out, and skips a name holding a backslash, which a version path cannot hold. A symbolic link is classified by where
 * it points:
 *
 * - a relative target that stays inside the directory being walked, judged both by the path as written and by the
 *   real path it resolves to (the nearest existing directory's real path for a target that does not exist yet): a
 *   `link` entry with the target as written;
 * - any other target that does not resolve: skipped, since a copy holding the link would load whatever appears there;
 * - a target the walk already included, or below one: a relative `link` entry to its path in the version (see below);
 * - a target the scan may follow: dereferenced, so its files are part of the content under the link's path and nothing
 *   loads from outside the approved copy. The scan follows a link only to an installed package (a real path below a
 *   `node_modules` directory, such as one in pnpm's `.pnpm` store), to a sibling workspace package (a directory holding
 *   a regular `package.json` that the link reaches at a version path `…node_modules/<name>`, `<name>` a package name,
 *   as a pnpm workspace links one), or into a `.git` directory of the folder or of a package it includes; and never to
 *   a target in the Delo home or in `/proc`, `/sys` or `/dev` ({@link SYSTEM_DIRECTORIES}), whose files hold the
 *   person's secrets or never end;
 * - any other target: skipped, so the copy holds neither the link nor what it names, and the review lists it among the
 *   paths the scan could not include. A copy that kept the link would load whatever is there when it runs, and
 *   refusing the whole folder for one such link would stop a plugin over an editor's stray link.
 *
 * A dereferenced directory is walked by the same rules with itself as the directory links are judged against. When it
 * is a package installed in a `node_modules` directory, each dependency its `package.json` names (`dependencies`,
 * `optionalDependencies`, `peerDependencies`) that sits beside it in that directory, as pnpm installs them, is followed
 * by the same rules at `<its path>/node_modules/<name>` unless the package holds that path itself, so the copy resolves
 * it as Node resolves the original. Each real directory is included once, at the first path the walk reaches it by
 * (directories are walked in code-unit order, so the choice is stable): a later link to it, or to anything below it or
 * below the folder, becomes a relative `link` entry to that path, so a copy resolves it inside itself; a link to a
 * directory that contains an included one is skipped. A walk never enters the Delo home or a system directory.
 *
 * With `dependencies: 'link'`, the scan of a plugin too large to copy with its dependencies under Warn and Off, a link
 * whose real path lies below a `node_modules` directory is instead a `link` entry marked `outside` with that absolute
 * real path (its absolute path when it does not resolve), and below every `node_modules` directory other than the
 * folder's own top-level one a link the scan would dereference is such an entry too. An active directory's scan
 * ({@link ActiveScanOptions}) follows no link: Delo wrote every link in it, so one that does not stay inside is a `link`
 * entry marked `outside` with its real path, or its absolute path when it does not resolve.
 *
 * One version holds at most {@link CONTENT_ENTRY_LIMIT} files, links and directories and
 * {@link CONTENT_BYTE_LIMIT} bytes; a scan that reaches either stops with `CONTENT_TOO_LARGE`. A file is read up to
 * the size its status gave when it was opened, which is what counts against the limit, and a file that holds more
 * stops the scan with `CHANGED_WHILE_READING`, so a file that never ends, such as one in `/proc`, cannot stall it.
 *
 * A scan reads one moment of a folder only when nothing writes to it; the store ({@link ./store.ts}) checks that by
 * scanning again after it copied.
 *
 * @module @delo/changes/tree
 */
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { ChangesError } from './errors.ts'
import { PACKAGE_NAME_PATTERN } from './paths.ts'
import { VERSION_MANIFEST_SCHEMA, type ContentVersion, type ObjectDigest, type VersionEntry, type VersionManifest } from './types.ts'

/** A file entry of a content version. */
export type FileEntry = Extract<VersionEntry, { type: 'file' }>

/** The name of the directories a scan leaves out at every depth. */
export const EXCLUDED_DIRECTORY = '.git'

/** The name of the directories whose linked contents stay outside links: installed packages. */
export const DEPENDENCY_DIRECTORY = 'node_modules'

/** Schema tag of the scan cache file. */
export const SCAN_CACHE_SCHEMA = 'delo.changes-scan-cache/1'

/**
 * How recent a file's modification or status change may be for the scan cache to record it, in milliseconds: the
 * coarsest timestamp granularity of a filesystem Delo runs on (FAT's two seconds). A file changed again within that
 * window can keep the same recorded times, so its digest is computed again on the next scan.
 */
export const CACHE_SETTLE_MS = 2000

/** The size of one read while hashing or copying. */
const CHUNK_SIZE = 64 * 1024

/**
 * The most files, links and directories one content version may hold, the installed packages it includes counted. A
 * folder with more is not copied, so a folder that grows without end cannot fill the store or stall a start.
 */
export const CONTENT_ENTRY_LIMIT = 50_000

/** The most bytes the files of one content version may hold, the installed packages it includes counted. */
export const CONTENT_BYTE_LIMIT = 512 * 1024 * 1024

/** The `package.json` fields whose names a package installed beside it resolves, in the order they are read. */
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** The most bytes of an included package's `package.json` read for its dependency names. */
const MANIFEST_BYTE_LIMIT = 1024 * 1024

/**
 * The system directories a scan never reads or follows a link into: their files describe processes, the kernel and
 * devices, and some never end.
 */
export const SYSTEM_DIRECTORIES: readonly string[] = ['/proc', '/sys', '/dev']

/**
 * How a scan records a link to an installed package outside the directory it walks: `include` copies its files, and
 * those of the dependencies installed beside it, into the version; `link` keeps a `link` entry to its absolute real
 * path.
 */
export type DependencyMode = 'include' | 'link'

/** How a scan reads: a plugin folder's, or an active directory's. */
export type ScanOptions = FolderScanOptions | ActiveScanOptions

/** The scan of a plugin folder, which follows links out of it as the module describes. */
export interface FolderScanOptions extends ScanCacheOptions {
  /**
   * The Delo home: the scan never follows a link to a target in it and never walks into it. The caller names the home
   * of the request it serves.
   */
  readonly home: string
  /** How links to installed packages are recorded; `include` by default. */
  readonly dependencies?: DependencyMode
}

/** The scan of an active directory, whose links Delo wrote: it follows none ({@link ScanOptions}). */
export interface ActiveScanOptions extends ScanCacheOptions {
  readonly active: true
}

/** The scan cache and clock both scans take. */
export interface ScanCacheOptions {
  /**
   * The scan cache file, such as `changes/profiles/<profile>/scan-cache.json`. A file whose device, inode, size and
   * modification and status-change times equal the cached ones is not hashed again. A cache that cannot be read is
   * ignored, and the file is rewritten after the scan.
   */
  readonly cache?: string
  /** The wall clock in milliseconds, which decides which files the cache records; defaults to `Date.now`. A test hook. */
  readonly now?: () => number
}

/** One file a scan read, and where it read it. */
export interface ScannedFile {
  readonly entry: FileEntry
  /** The absolute path read: below the folder, or below a dereferenced link's real target. */
  readonly source: string
}

/** One scan's result. */
export interface ScannedFolder {
  /** The files and links, sorted by path in code-unit order. */
  readonly entries: readonly VersionEntry[]
  /** The file entries with the paths they were read from, in the same order. */
  readonly files: readonly ScannedFile[]
  /**
   * Sockets, FIFOs, devices, names holding a backslash, link cycles and links that do not resolve, by relative path in
   * code-unit order.
   */
  readonly skipped: readonly string[]
}

/** One cached digest and the file status it was computed for. */
interface CacheEntry {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly digest: ObjectDigest
}

/** The scan cache file. */
interface ScanCache {
  readonly schema: typeof SCAN_CACHE_SCHEMA
  readonly files: Readonly<Record<string, CacheEntry>>
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/**
 * Compare two strings by UTF-16 code units, the order of every list Changes writes.
 * @param a - one string.
 * @param b - the other.
 * @returns negative, zero or positive as `a` sorts before, with or after `b`.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Whether a string is a SHA-256 digest in lowercase hexadecimal.
 * @param value - the string.
 * @returns whether it is one.
 */
export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value)
}

/**
 * Open a path that must be a regular file, without following a symbolic link and without blocking on a FIFO.
 * @param path - the file.
 * @returns the open handle and its status; the caller closes the handle.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the path is a symbolic link or not a regular file, which for a
 * path a listing reported as a regular file means it was replaced in between.
 */
export async function openRegularFile(path: string): Promise<{ readonly handle: FileHandle, readonly stats: Stats }> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new ChangesError('CHANGED_WHILE_READING', path, `${path} became a symbolic link while it was read`, { cause: error })
    throw error
  }
  const stats = await handle.stat()
  if (!stats.isFile()) {
    await handle.close()
    throw new ChangesError('CHANGED_WHILE_READING', path, `${path} is no longer a regular file`)
  }
  return { handle, stats }
}

/**
 * Read an open file to its end, but never past the size it had when it was counted, passing each chunk on.
 * @param handle - the file, read from its current position.
 * @param file - the size counted for it, the most bytes read, and its path, named in a refusal.
 * @param onChunk - receives each chunk; the buffer is reused after the call returns.
 * @returns the number of bytes read: the size, or fewer when the file ended first.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the file holds more than the size, as a file that grew since its
 *   status was read, or one in `/proc` whose status gives no size, does.
 */
export async function readChunks(handle: FileHandle, file: { readonly size: number, readonly path: string }, onChunk: (chunk: Buffer) => Promise<void> | void): Promise<number> {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  let total = 0
  while (total < file.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_SIZE, file.size - total), null)
    if (bytesRead === 0) return total
    total += bytesRead
    await onChunk(buffer.subarray(0, bytesRead))
  }
  if ((await handle.read(buffer, 0, 1, null)).bytesRead !== 0) throw new ChangesError('CHANGED_WHILE_READING', file.path, `${file.path} grew while it was read`)
  return total
}

/**
 * The canonical JSON of entries, which the version id is the digest of: sorted by path, each entry's fields in a fixed
 * order.
 * @param entries - the entries, in any order.
 * @returns the JSON text.
 */
function canonicalJson(entries: readonly VersionEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.path, b.path))
  return JSON.stringify(sorted.map((entry) => entry.type === 'file'
    ? { type: entry.type, path: entry.path, digest: entry.digest, size: entry.size, executable: entry.executable }
    : { type: entry.type, path: entry.path, target: entry.target, outside: entry.outside }))
}

/**
 * The version id of a content version.
 * @param entries - its entries; their order does not matter.
 * @returns the SHA-256 of their canonical JSON.
 */
export function versionOf(entries: readonly VersionEntry[]): ContentVersion {
  return brandString<ContentVersion>(createHash('sha256').update(canonicalJson(entries)).digest('hex'))
}

/**
 * The manifest of a content version.
 * @param entries - its entries; their order does not matter.
 * @returns the manifest with the entries sorted by path.
 */
export function manifestOf(entries: readonly VersionEntry[]): VersionManifest {
  return { schema: VERSION_MANIFEST_SCHEMA, entries: [...entries].sort((a, b) => compareCodeUnits(a.path, b.path)) }
}

/**
 * Whether a link's target is relative and stays inside a directory, outside every `.git` directory, both as written
 * and where it resolves on disk: a link through another link that leaves the directory is not inside.
 * @param root - the directory's real path.
 * @param linkDirectory - the link's directory below `root`.
 * @param target - the target as written.
 * @returns whether it is inside.
 */
async function linkInside(root: string, linkDirectory: string, target: string): Promise<boolean> {
  if (isAbsolute(target)) return false
  const within = (path: string): boolean => contains(root, path) && !relative(root, path).split(sep).includes(EXCLUDED_DIRECTORY)
  return within(resolve(linkDirectory, target)) && within(await physicalPath(spelledTarget(linkDirectory, target)))
}

/**
 * A link's target joined to its directory without resolving `..` by the spelling, so the filesystem resolves each
 * segment where it leads.
 * @param linkDirectory - the link's directory, absolute.
 * @param target - the target as written.
 * @returns the joined path; the target itself when it is absolute.
 */
function spelledTarget(linkDirectory: string, target: string): string {
  return isAbsolute(target) ? target : `${linkDirectory}${sep}${target}`
}

/**
 * Where a path is on disk: its real path, or for a path that does not exist, the real path of its nearest existing
 * directory with the rest appended.
 * @param path - an absolute path.
 * @returns the physical path.
 * @throws the filesystem error other than `ENOENT`, `ENOTDIR` or `ELOOP`.
 */
async function physicalPath(path: string): Promise<string> {
  const real = await realTarget(path)
  if (real !== undefined) return real
  const parent = dirname(path)
  // The filesystem root always resolves, so the walk up ends there.
  return join(await physicalPath(parent), basename(path))
}

/**
 * Whether one path is another or a directory above it.
 * @param outer - the possible ancestor.
 * @param inner - the path.
 * @returns whether `inner` is `outer` or below it.
 */
function contains(outer: string, inner: string): boolean {
  const path = relative(outer, inner)
  return path === '' || path.split(sep)[0] !== '..'
}

/**
 * The real path of a link's target.
 * @param path - the target, absolute.
 * @returns its real path, or undefined when it does not resolve.
 * @throws the filesystem error other than `ENOENT`, `ENOTDIR` or `ELOOP`.
 */
async function realTarget(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return undefined
    throw error
  }
}

/**
 * One cache entry from a parsed value, when every field has its type.
 * @param value - the parsed value.
 * @returns the entry, or undefined.
 */
function cacheEntry(value: unknown): CacheEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const numbers = [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs]
  if (!numbers.every((field) => typeof field === 'number') || typeof entry.digest !== 'string' || !isDigest(entry.digest)) return undefined
  return value as CacheEntry
}

/**
 * Read the scan cache. Any failure, including a missing file, a laxer mode or text Delo did not write, gives an
 * empty cache: the cache only saves hashing, and every entry is checked against the file's status before use.
 * @param path - the cache file.
 * @returns the cached entries by relative path.
 */
async function readCache(path: string): Promise<Map<string, CacheEntry>> {
  const entries = new Map<string, CacheEntry>()
  let parsed: unknown
  try {
    parsed = JSON.parse((await readProtectedFile(path)).toString('utf8'))
  } catch {
    // Any read or JSON error (a missing file, a refused mode, text Delo did not write): the cache is ignored and rewritten after the scan.
    return entries
  }
  const cache = parsed as Partial<ScanCache> | null
  if (cache?.schema !== SCAN_CACHE_SCHEMA || typeof cache.files !== 'object' || cache.files === null) return entries
  for (const [path, value] of Object.entries(cache.files)) {
    const entry = cacheEntry(value)
    if (entry !== undefined) entries.set(path, entry)
  }
  return entries
}

/**
 * Whether a cache entry describes a file's current status.
 * @param entry - the cached entry.
 * @param stats - the file's status.
 * @returns whether its digest can be reused.
 */
function cacheMatches(entry: CacheEntry, stats: Stats): boolean {
  return entry.dev === stats.dev && entry.ino === stats.ino && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs && entry.ctimeMs === stats.ctimeMs
}

/** The state one scan carries through its walk. */
interface Walk {
  readonly cached: ReadonlyMap<string, CacheEntry>
  readonly recorded: Map<string, CacheEntry>
  readonly settledBefore: number
  readonly entries: VersionEntry[]
  readonly files: ScannedFile[]
  readonly skipped: string[]
  /** The real path of the folder and of each dereferenced directory, to the relative path its files are under. */
  readonly included: Map<string, string>
  /** How links to installed packages are recorded; `active` for an active directory's scan, which follows no link. */
  readonly dependencies: DependencyMode | 'active'
  /** The Delo home's real path, or its absolute path when it does not resolve; undefined for an active directory. */
  readonly home: string | undefined
  /** The folder scanned, named in a refusal. */
  readonly folder: string
  /** The files, links and directories counted so far. */
  count: number
  /** The bytes of the files counted so far. */
  bytes: number
}

/**
 * Count one entry of the version, and its bytes, against the limits.
 * @param walk - the scan.
 * @param bytes - the bytes it adds; zero for a link or a directory.
 * @throws {ChangesError} `CONTENT_TOO_LARGE` when the version would pass {@link CONTENT_ENTRY_LIMIT} or
 *   {@link CONTENT_BYTE_LIMIT}.
 */
function admit(walk: Walk, bytes: number): void {
  walk.count += 1
  walk.bytes += bytes
  if (walk.count > CONTENT_ENTRY_LIMIT) {
    throw new ChangesError('CONTENT_TOO_LARGE', walk.folder, `${walk.folder}, with the installed packages it links, holds more than ${CONTENT_ENTRY_LIMIT} files, links and directories, so Delo does not copy it.`)
  }
  if (walk.bytes > CONTENT_BYTE_LIMIT) {
    throw new ChangesError('CONTENT_TOO_LARGE', walk.folder, `${walk.folder}, with the installed packages it links, holds more than ${CONTENT_BYTE_LIMIT / (1024 * 1024)} MiB, so Delo does not copy it.`)
  }
}

/**
 * Hash one regular file, or take its digest from the cache.
 * @param walk - the scan.
 * @param source - its absolute path.
 * @param path - its relative path in the version.
 */
async function addFile(walk: Walk, source: string, path: string): Promise<void> {
  const { handle, stats } = await openRegularFile(source)
  let entry: FileEntry
  try {
    // The size its status gives is counted before reading, so a file past the limit is never read; the read stops
    // there, and the count becomes the bytes actually read.
    admit(walk, stats.size)
    const executable = (stats.mode & 0o100) !== 0
    const cached = walk.cached.get(path)
    if (cached !== undefined && cacheMatches(cached, stats)) {
      walk.recorded.set(path, cached)
      entry = { type: 'file', path, digest: cached.digest, size: cached.size, executable }
    } else {
      const hash = createHash('sha256')
      const size = await readChunks(handle, { size: stats.size, path: source }, (chunk) => { hash.update(chunk) })
      walk.bytes -= stats.size - size
      const digest = brandString<ObjectDigest>(hash.digest('hex'))
      if (Math.max(stats.mtimeMs, stats.ctimeMs) < walk.settledBefore) {
        walk.recorded.set(path, { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest })
      }
      entry = { type: 'file', path, digest, size, executable }
    }
  } finally {
    await handle.close()
  }
  walk.entries.push(entry)
  walk.files.push({ entry, source })
}

/**
 * The relative link target that names one version path from a link's directory.
 * @param from - the link's directory in the version, empty for the folder itself.
 * @param to - the path it names in the version.
 * @returns the `/`-separated relative target; `.` when the two are one directory.
 */
function versionRelative(from: string, to: string): string {
  const source = from === '' ? [] : from.split('/')
  const destination = to === '' ? [] : to.split('/')
  let common = 0
  while (common < source.length && common < destination.length && source[common] === destination[common]) common++
  const steps = [...source.slice(common).map(() => '..'), ...destination.slice(common)]
  return steps.length === 0 ? '.' : steps.join('/')
}

/**
 * Where a real path is in the version when an included directory holds it. Included directories never hold one
 * another except through a `.git` directory, so at most one holds a path outside every `.git` directory.
 * @param walk - the scan.
 * @param real - the real path.
 * @returns its version path, or undefined when no included directory holds it outside a `.git` directory.
 */
function includedPath(walk: Walk, real: string): string | undefined {
  for (const [directory, path] of walk.included) {
    if (!contains(directory, real)) continue
    const below = relative(directory, real)
    const segments = below === '' ? [] : below.split(sep)
    if (!segments.includes(EXCLUDED_DIRECTORY)) return [path, ...segments].filter((segment) => segment !== '').join('/')
  }
  return undefined
}

/**
 * Classify one symbolic link and add what it contributes.
 * @param walk - the scan.
 * @param root - the real path of the directory links are judged against.
 * @param directory - the link's directory, absolute below `root`.
 * @param path - the link's relative path in the version.
 * @param dereference - whether a link this walk would include is dereferenced; when false it stays an outside link.
 */
async function addLink(walk: Walk, root: string, directory: string, path: string, dereference: boolean): Promise<void> {
  const target = await readlink(join(directory, basename(path)))
  if (await linkInside(root, directory, target)) {
    admit(walk, 0)
    walk.entries.push({ type: 'link', path, target, outside: false })
    return
  }
  const real = await realTarget(spelledTarget(directory, target))
  const known = real ?? resolve(directory, target)
  if (walk.dependencies === 'active' || (walk.dependencies === 'link' && known.split(sep).includes(DEPENDENCY_DIRECTORY))) {
    admit(walk, 0)
    walk.entries.push({ type: 'link', path, target: known, outside: true })
    return
  }
  if (real === undefined) {
    walk.skipped.push(path)
    return
  }
  await addTarget(walk, real, path, dereference)
}

/**
 * Add what a link, or a dependency installed beside an included package, names once its real path is known.
 * @param walk - the scan of a folder.
 * @param real - the real path it names.
 * @param path - its relative path in the version.
 * @param dereference - whether a target this walk would include is dereferenced; when false it stays an outside link.
 */
async function addTarget(walk: Walk, real: string, path: string, dereference: boolean): Promise<void> {
  const stats = await stat(real)
  if (!stats.isDirectory() && !stats.isFile()) {
    walk.skipped.push(path)
    return
  }
  const included = includedPath(walk, real)
  if (included !== undefined) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    admit(walk, 0)
    walk.entries.push({ type: 'link', path, target: versionRelative(parent, included), outside: false })
    return
  }
  if ([...walk.included.keys()].some((directory) => contains(real, directory))) {
    walk.skipped.push(path)
  } else if (!dereference) {
    admit(walk, 0)
    walk.entries.push({ type: 'link', path, target: real, outside: true })
  } else if (!await mayFollow(walk, real, path, stats.isDirectory())) {
    walk.skipped.push(path)
  } else if (stats.isDirectory()) {
    walk.included.set(real, path)
    await walkDirectory(walk, real, real, path, false)
    if (walk.dependencies === 'include') await addInstalledDependencies(walk, real, path)
  } else {
    await addFile(walk, real, path)
  }
}

/** A version path a pnpm workspace links a package at: `node_modules/<name>`, below any directory. */
const DEPENDENCY_PATH = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/

/**
 * Whether a scan may follow a link out of the directory it walks to a target no included directory holds outside a
 * `.git` directory, as the module describes: never into the Delo home or a system directory; to an installed package,
 * a sibling workspace package, or a `.git` directory of an included directory.
 * @param walk - the scan of a folder.
 * @param real - the target's real path.
 * @param path - the link's version path.
 * @param directory - whether the target is a directory.
 * @returns whether it may be dereferenced.
 * @throws the filesystem error other than a missing `package.json` when a sibling package's cannot be examined.
 */
async function mayFollow(walk: Walk, real: string, path: string, directory: boolean): Promise<boolean> {
  if (contains(walk.home!, real) || SYSTEM_DIRECTORIES.some((system) => contains(system, real))) return false
  if (real.split(sep).includes(DEPENDENCY_DIRECTORY)) return true
  if ([...walk.included.keys()].some((included) => contains(included, real))) return true
  const name = DEPENDENCY_PATH.exec(path)?.[1]
  return directory && name !== undefined && PACKAGE_NAME_PATTERN.test(name) && await holdsManifest(real)
}

/**
 * @param directory - a directory.
 * @returns whether it holds a regular file `package.json`, not followed through a link.
 * @throws the filesystem error other than `ENOENT`.
 */
async function holdsManifest(directory: string): Promise<boolean> {
  try {
    return (await lstat(join(directory, 'package.json'))).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * @param walk - the scan.
 * @param directory - a real directory path the walk reaches.
 * @returns whether the walk stays out of it: the Delo home, or a system directory or anything below one.
 */
function staysOut(walk: Walk, directory: string): boolean {
  return directory === walk.home || SYSTEM_DIRECTORIES.some((system) => contains(system, directory))
}

/**
 * Include the dependencies an included package resolves from the `node_modules` directory it is installed in, as pnpm
 * installs each package's dependencies beside it: each name its `package.json` lists that sits in that directory goes
 * to `<path>/node_modules/<name>`, unless the package holds that path itself.
 * @param walk - the scan.
 * @param real - the package's real path.
 * @param path - its relative path in the version.
 */
async function addInstalledDependencies(walk: Walk, real: string, path: string): Promise<void> {
  const parent = dirname(real)
  const installedIn = basename(parent).startsWith('@') ? dirname(parent) : parent
  if (basename(installedIn) !== DEPENDENCY_DIRECTORY) return
  for (const name of await dependencyNames(real)) {
    const at = `${path}/${DEPENDENCY_DIRECTORY}/${name}`
    if (walk.entries.some((entry) => entry.path === at || entry.path.startsWith(`${at}/`))) continue
    const dependency = await realTarget(join(installedIn, ...name.split('/')))
    // A dependency that is not installed beside the package resolves from nowhere in the copy, so it fails to load there.
    if (dependency !== undefined) await addTarget(walk, dependency, at, true)
  }
}

/**
 * The dependency names a package's `package.json` lists.
 * @param directory - the package's directory.
 * @returns the valid package names of {@link DEPENDENCY_FIELDS}, without the package's own, sorted in code-unit order;
 *   empty when it has no readable manifest.
 */
async function dependencyNames(directory: string): Promise<readonly string[]> {
  let manifest: unknown
  try {
    const path = join(directory, 'package.json')
    const { handle, stats } = await openRegularFile(path)
    try {
      if (stats.size > MANIFEST_BYTE_LIMIT) return []
      const chunks: Buffer[] = []
      await readChunks(handle, { size: stats.size, path }, (chunk) => { chunks.push(Buffer.from(chunk)) })
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    // ENOENT, a link or another kind of file, a file that grew while it was read, or text that is not JSON: the package
    // names no dependency Delo can include.
    return []
  }
  if (typeof manifest !== 'object' || manifest === null) return []
  const fields = manifest as Record<string, unknown>
  const names = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const listed = fields[field]
    if (typeof listed !== 'object' || listed === null) continue
    for (const name of Object.keys(listed)) {
      if (name !== fields.name && PACKAGE_NAME_PATTERN.test(name)) names.add(name)
    }
  }
  return [...names].sort(compareCodeUnits)
}

/**
 * Walk one directory.
 * @param walk - the scan.
 * @param root - the real path of the directory links are judged against: the folder, or a dereferenced directory.
 * @param absolute - the directory, absolute below `root`.
 * @param directory - its relative path in the version, empty for the folder itself.
 * @param dependencies - whether the directory is below a `node_modules` directory other than the folder's own
 * top-level one, where links are not dereferenced.
 */
async function walkDirectory(walk: Walk, root: string, absolute: string, directory: string, dependencies: boolean): Promise<void> {
  if (staysOut(walk, absolute)) {
    walk.skipped.push(directory === '' ? '.' : directory)
    return
  }
  admit(walk, 0)
  const dirents = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const dirent of dirents) {
    const path = directory === '' ? dirent.name : `${directory}/${dirent.name}`
    if (dirent.name.includes('\\')) {
      // A version path is `/`-separated and cannot hold a backslash, so a file named with one is not content.
      walk.skipped.push(path)
    } else if (dirent.isDirectory()) {
      const nested = dependencies || (dirent.name === DEPENDENCY_DIRECTORY && directory !== '')
      if (dirent.name !== EXCLUDED_DIRECTORY) await walkDirectory(walk, root, join(absolute, dirent.name), path, nested)
    } else if (dirent.isFile()) {
      await addFile(walk, join(absolute, dirent.name), path)
    } else if (dirent.isSymbolicLink()) {
      await addLink(walk, root, absolute, path, walk.dependencies === 'include' || !dependencies)
    } else {
      walk.skipped.push(path)
    }
  }
}

/**
 * Scan a folder as a content version.
 * @param folder - the folder; its real path is what links are judged against.
 * @param options - a plugin folder's scan with the Delo home, or an active directory's; the scan cache and the clock.
 * @returns the entries, the files with where they were read, and the skipped paths, each sorted by path; `.` when the
 *   folder is the Delo home or in a system directory, which the scan does not read.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when a file is replaced by a link or another kind, or grows, while it
 *   is read; `CONTENT_TOO_LARGE` when the version would pass {@link CONTENT_ENTRY_LIMIT} or {@link CONTENT_BYTE_LIMIT}.
 * @throws the filesystem error, such as `ENOENT`, when the folder cannot be read.
 */
export async function scanFolder(folder: string, options: ScanOptions): Promise<ScannedFolder> {
  const now = options.now ?? Date.now
  const root = await realpath(folder)
  const home = 'home' in options ? await realTarget(resolve(options.home)) ?? resolve(options.home) : undefined
  const walk: Walk = {
    cached: options.cache === undefined ? new Map() : await readCache(options.cache),
    recorded: new Map(),
    settledBefore: now() - CACHE_SETTLE_MS,
    entries: [],
    files: [],
    skipped: [],
    included: new Map([[root, '']]),
    dependencies: 'home' in options ? options.dependencies ?? 'include' : 'active',
    home,
    folder,
    count: 0,
    bytes: 0,
  }
  await walkDirectory(walk, root, root, '', false)
  if (options.cache !== undefined) {
    const files = Object.fromEntries([...walk.recorded].sort(([a], [b]) => compareCodeUnits(a, b)))
    const cache: ScanCache = { schema: SCAN_CACHE_SCHEMA, files }
    await mkdir(dirname(options.cache), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(options.cache, `${JSON.stringify(cache)}\n`)
  }
  return {
    entries: walk.entries.sort((a, b) => compareCodeUnits(a.path, b.path)),
    files: walk.files.sort((a, b) => compareCodeUnits(a.entry.path, b.entry.path)),
    skipped: walk.skipped.sort(compareCodeUnits),
  }
}
