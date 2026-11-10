/**
 * Reading a plugin folder as a content version: its regular files by digest, its symbolic links by target, and the
 * canonical version id over them. A scan never opens a socket, FIFO or device, and leaves every directory named `.git`
 * out. A symbolic link is classified by where it points:
 *
 * - a relative target that stays inside the directory being walked: a `link` entry with the target as written;
 * - any other target whose real path lies below a `node_modules` directory, such as pnpm's `.pnpm` store: a `link`
 *   entry marked `outside` whose target is that absolute real path, so a copy of the folder (an active directory) still
 *   names the same place; a target that does not resolve is judged by its absolute path;
 * - any other target that does not resolve: skipped, since a copy holding the link would load whatever appears there;
 * - any other target, such as a sibling workspace package a source checkout links: dereferenced, so its files are part
 *   of the content under the link's path and nothing loads from outside the approved copy. A dereferenced directory is
 *   walked by the same rules with itself as the directory links are judged against. Each real directory is included
 *   once, at the first path the walk reaches it by (directories are walked in code-unit order, so the choice is
 *   stable): a later link to it, or to anything below it or below the folder, becomes a relative `link` entry to that
 *   path, so a copy resolves it inside itself; a link to a directory that contains an included one is skipped.
 *
 * Below every `node_modules` directory other than the folder's own top-level one, such as a dereferenced sibling
 * package's, links are classified the same way except that a link the scan would dereference stays a `link` entry
 * marked `outside` with its absolute real target: a sibling package included through a link loads its own
 * dependencies from where they are installed.
 *
 * A scan reads one moment of a folder only when nothing writes to it; the store ({@link ./store.ts}) checks that by
 * scanning again after it copied.
 *
 * @module @delo/changes/tree
 */
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { mkdir, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { ChangesError } from './errors.ts'
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

/** What a scan reads. */
export interface ScanOptions {
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
  /** Sockets, FIFOs, devices, link cycles and links that do not resolve, by relative path in code-unit order. */
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
 * Read an open file to its end, passing each chunk on.
 * @param handle - the file, read from its current position.
 * @param onChunk - receives each chunk; the buffer is reused after the call returns.
 * @returns the number of bytes read.
 */
export async function readChunks(handle: FileHandle, onChunk: (chunk: Buffer) => Promise<void> | void): Promise<number> {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  let total = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null)
    if (bytesRead === 0) return total
    total += bytesRead
    await onChunk(buffer.subarray(0, bytesRead))
  }
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
 * Whether a link's target is relative and stays inside a directory, outside every `.git` directory.
 * @param root - the directory's real path.
 * @param linkDirectory - the link's directory below `root`.
 * @param target - the target as written.
 * @returns whether it is inside.
 */
function linkInside(root: string, linkDirectory: string, target: string): boolean {
  const resolved = resolve(linkDirectory, target)
  return !isAbsolute(target) && contains(root, resolved) && !relative(root, resolved).split(sep).includes(EXCLUDED_DIRECTORY)
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
    const executable = (stats.mode & 0o100) !== 0
    const cached = walk.cached.get(path)
    if (cached !== undefined && cacheMatches(cached, stats)) {
      walk.recorded.set(path, cached)
      entry = { type: 'file', path, digest: cached.digest, size: cached.size, executable }
    } else {
      const hash = createHash('sha256')
      const size = await readChunks(handle, (chunk) => { hash.update(chunk) })
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
  if (linkInside(root, directory, target)) {
    walk.entries.push({ type: 'link', path, target, outside: false })
    return
  }
  const resolved = resolve(directory, target)
  const real = await realTarget(resolved)
  const known = real ?? resolved
  if (known.split(sep).includes(DEPENDENCY_DIRECTORY)) {
    walk.entries.push({ type: 'link', path, target: known, outside: true })
    return
  }
  if (real === undefined) {
    walk.skipped.push(path)
    return
  }
  const stats = await stat(real)
  if (!stats.isDirectory() && !stats.isFile()) {
    walk.skipped.push(path)
    return
  }
  const included = includedPath(walk, real)
  if (included !== undefined) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    walk.entries.push({ type: 'link', path, target: versionRelative(parent, included), outside: false })
    return
  }
  if ([...walk.included.keys()].some((directory) => contains(real, directory))) {
    walk.skipped.push(path)
  } else if (!dereference) {
    walk.entries.push({ type: 'link', path, target: real, outside: true })
  } else if (stats.isDirectory()) {
    walk.included.set(real, path)
    await walkDirectory(walk, real, real, path, false)
  } else {
    await addFile(walk, real, path)
  }
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
  const dirents = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const dirent of dirents) {
    const path = directory === '' ? dirent.name : `${directory}/${dirent.name}`
    if (dirent.isDirectory()) {
      const nested = dependencies || (dirent.name === DEPENDENCY_DIRECTORY && directory !== '')
      if (dirent.name !== EXCLUDED_DIRECTORY) await walkDirectory(walk, root, join(absolute, dirent.name), path, nested)
    } else if (dirent.isFile()) {
      await addFile(walk, join(absolute, dirent.name), path)
    } else if (dirent.isSymbolicLink()) {
      await addLink(walk, root, absolute, path, !dependencies)
    } else {
      walk.skipped.push(path)
    }
  }
}

/**
 * Scan a folder as a content version.
 * @param folder - the folder; its real path is what links are judged against.
 * @param options - the scan cache and the clock.
 * @returns the entries, the files with where they were read, and the skipped paths, each sorted by path.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when a file is replaced by a link or another kind while it is read.
 * @throws the filesystem error, such as `ENOENT`, when the folder cannot be read.
 */
export async function scanFolder(folder: string, options: ScanOptions = {}): Promise<ScannedFolder> {
  const now = options.now ?? Date.now
  const root = await realpath(folder)
  const walk: Walk = {
    cached: options.cache === undefined ? new Map() : await readCache(options.cache),
    recorded: new Map(),
    settledBefore: now() - CACHE_SETTLE_MS,
    entries: [],
    files: [],
    skipped: [],
    included: new Map([[root, '']]),
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
