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
 * - a target whose real path lies in the active runtime's installed packages, `runtimes/<version runtimes/current
 *   names>/app/node_modules/` in the Delorun home, as a plugin pack links the packages the running release carries: a
 *   `runtime` link entry with its path below that folder, which names the same package in whichever release runs, so
 *   the copy loads the signed release's package as the pack does; every other target in the home, another runtime
 *   version's included, stays out. An active directory's scan given the home records its links into the active runtime
 *   the same way, and a link into any other release as an outside link, so a copy written under an earlier release no
 *   longer holds its version;
 * - a target the scan may follow: dereferenced, so its files are part of the content under the link's path and nothing
 *   loads from outside the approved copy. The scan follows a link only to an installed package (a real path below a
 *   `node_modules` directory, such as one in pnpm's `.pnpm` store), to a sibling workspace package (a directory holding
 *   a regular `package.json` that the link reaches at a version path `…node_modules/<name>`, `<name>` a package name,
 *   as a pnpm workspace links one), or into a `.git` directory of the folder or of a package it includes; and never to
 *   a target in the Delorun home or in `/proc`, `/sys` or `/dev` ({@link SYSTEM_DIRECTORIES}), whose files hold the
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
 * directory that contains an included one is skipped. A walk never enters the Delorun home or a system directory.
 *
 * With `dependencies: 'link'`, the scan of a plugin too large to copy with its dependencies under protection off, a link
 * whose real path lies below a `node_modules` directory is instead a `link` entry marked `outside` with that absolute
 * real path (its absolute path when it does not resolve), and below every `node_modules` directory other than the
 * folder's own top-level one a link the scan would dereference is such an entry too. An active directory's scan
 * ({@link ActiveScanOptions}) follows no link: Delorun wrote every link in it, so one that does not stay inside is a `link`
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
 * @module @delorun/changes/tree
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync, readdirSync, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE, STORE_ENTRIES } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delorun/home'
import { parseRuntimeVersion, readPointerFile } from '@delorun/runtime-store'
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
export const SCAN_CACHE_SCHEMA = 'delorun.changes-scan-cache/2'

/**
 * How many folders one scan cache file keeps entries for. A profile scans a pack's source, its older copies and its
 * active directory, for each plugin; the oldest folder's entries are dropped past this count.
 */
export const SCAN_CACHE_FOLDERS = 16

/**
 * How recent a file's modification or status change may be for the scan cache to record it, in milliseconds: the
 * coarsest timestamp granularity of a filesystem Delorun runs on (FAT's two seconds). A file changed again within that
 * window can keep the same recorded times, so its digest is computed again on the next scan.
 */
export const CACHE_SETTLE_MS = 2000

/**
 * How long a scan runs before it lets other work on the event loop run, in milliseconds. A scan lists directories and
 * reads the status of files whose digest the cache holds synchronously, because a copy of Delorun holds tens of
 * thousands of files and each asynchronous call costs several times more; the pauses keep a Host's other requests
 * answered meanwhile.
 */
const SCAN_SLICE_MS = 20

/** The size of one read while hashing or copying. */
const CHUNK_SIZE = 64 * 1024

/**
 * The most files, links and directories one content version may hold, the installed packages it includes counted. A
 * folder with more is not copied, so a folder that grows without end cannot fill the store or stall a start.
 */
export const CONTENT_ENTRY_LIMIT = 50_000

/** The most bytes the files of one content version may hold, the installed packages it includes counted. */
export const CONTENT_BYTE_LIMIT = 512 * 1024 * 1024

/** The most entries and bytes one scan admits. */
export interface ScanLimits {
  /** The most files, links and directories, the scanned folder itself counted. */
  readonly entries: number
  /** The most bytes of files. */
  readonly bytes: number
}

/** The limits of every content version: {@link CONTENT_ENTRY_LIMIT} and {@link CONTENT_BYTE_LIMIT}. */
export const CONTENT_LIMITS: ScanLimits = { entries: CONTENT_ENTRY_LIMIT, bytes: CONTENT_BYTE_LIMIT }

/**
 * A byte limit in the person's words.
 * @param bytes - the limit.
 * @returns it in MiB when it is a whole number of them, else in bytes.
 */
export function byteLimitWords(bytes: number): string {
  const mebibyte = 1024 * 1024
  return bytes % mebibyte === 0 ? `${String(bytes / mebibyte)} MiB` : `${String(bytes)} bytes`
}

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
   * The Delorun home: the scan never follows a link to a target in it and never walks into it. The caller names the home
   * of the request it serves.
   */
  readonly home: string
  /** How links to installed packages are recorded; `include` by default. */
  readonly dependencies?: DependencyMode
}

/** The scan of an active directory, whose links Delorun wrote: it follows none ({@link ScanOptions}). */
export interface ActiveScanOptions extends ScanCacheOptions {
  readonly active: true
  /** The Delorun home, whose runtime store a `runtime` link entry names a package in; none when omitted. */
  readonly runtimeHome?: string
  /** The release whose installed packages a `runtime` link entry names; `runtimes/current` when omitted. */
  readonly runtimeRelease?: string
}

/**
 * The digests one process's earlier scans read, for checks that only decide whether to rewrite a directory. It lives in
 * memory for one boot and is never written. An entry names a file by absolute path, device, inode, size and the
 * modification and status-change times in nanoseconds, and a file changed since is hashed again. A check that decides
 * what loads, or verifies a write, takes no memo.
 */
export interface ScanMemo {
  /**
   * @param path - the file's absolute path.
   * @param stats - the file's status now, read from the open file.
   * @returns the digest an earlier scan read from a file with this status; undefined when none.
   */
  lookup(path: string, stats: BigIntStats): ObjectDigest | undefined
  /**
   * Remember a digest read from a file whose status was the same before and after the read and whose times are older than {@link CACHE_SETTLE_MS}.
   * @param path - the file's absolute path.
   * @param stats - the file's status.
   * @param digest - the digest of the bytes read.
   */
  record(path: string, stats: BigIntStats, digest: ObjectDigest): void
  /**
   * Drop every entry below a directory the boot writes.
   * @param directory - the directory.
   */
  forget(directory: string): void
}

/**
 * A scan memo for one boot.
 * @param now - the wall clock in milliseconds, which decides which files are recorded; defaults to `Date.now`. A test hook.
 * @returns the empty memo.
 */
export function createScanMemo(now: () => number = Date.now): ScanMemo {
  const seen = new Map<string, { readonly dev: bigint, readonly ino: bigint, readonly size: bigint, readonly mtimeNs: bigint, readonly ctimeNs: bigint, readonly digest: ObjectDigest }>()
  return {
    lookup: (path, stats) => {
      const known = seen.get(path)
      return known !== undefined && known.dev === stats.dev && known.ino === stats.ino && known.size === stats.size && known.mtimeNs === stats.mtimeNs && known.ctimeNs === stats.ctimeNs ? known.digest : undefined
    },
    record: (path, stats, digest) => {
      const changed = stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs
      if (changed / 1_000_000n >= BigInt(Math.trunc(now() - CACHE_SETTLE_MS))) return
      seen.set(path, { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, digest })
    },
    forget: (directory) => {
      const below = `${directory}${sep}`
      for (const path of seen.keys()) if (path === directory || path.startsWith(below)) seen.delete(path)
    },
  }
}

/** The scan cache and clock both scans take. */
export interface ScanCacheOptions {
  /** The digests of this boot's earlier scans, for a check that only decides whether to rewrite ({@link ScanMemo}); none by default. */
  readonly memo?: ScanMemo
  /**
   * The scan cache file, such as `changes/profiles/<profile>/scan-cache.json`. A file whose device, inode, size and
   * modification and status-change times equal the cached ones is not hashed again. A cache that cannot be read is
   * ignored. The file is written after the scan unless it holds what the scan records already.
   */
  readonly cache?: string
  /** The wall clock in milliseconds, which decides which files the cache records; defaults to `Date.now`. A test hook. */
  readonly now?: () => number
  /** The limits the scan stops at; {@link CONTENT_LIMITS} by default. A test hook. */
  readonly limits?: ScanLimits
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

/** The scan cache file: per folder, its real path and the entries of its files by relative path. */
interface ScanCache {
  readonly schema: typeof SCAN_CACHE_SCHEMA
  readonly folders: Readonly<Record<string, Readonly<Record<string, CacheEntry>>>>
}

/** What a scan cache file holds: the entries of each folder, oldest folder first, by relative path. */
type CacheFolders = Map<string, Map<string, CacheEntry>>

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
    : { type: entry.type, path: entry.path, target: entry.target, outside: entry.outside, ...(entry.runtime === true ? { runtime: true } : {}) }))
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
 * Read the scan cache. Any failure, including a missing file, a laxer mode or text Delorun did not write, gives no
 * cache, and an entry without its fields is left out: the cache only saves hashing, and every entry is checked against
 * the file's status before use.
 * @param path - the cache file.
 * @returns the cached entries of each folder by relative path, or undefined when the file is not a scan cache Delorun can read.
 */
async function readCache(path: string): Promise<CacheFolders | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await readProtectedFile(path)).toString('utf8'))
  } catch {
    // Any read or JSON error (a missing file, a refused mode, text Delorun did not write): the cache is ignored and rewritten after the scan.
    return undefined
  }
  const cache = parsed as Partial<ScanCache> | null
  if (cache?.schema !== SCAN_CACHE_SCHEMA || typeof cache.folders !== 'object' || cache.folders === null) return undefined
  const folders: CacheFolders = new Map()
  for (const [folder, files] of Object.entries(cache.folders)) {
    if (typeof files !== 'object' || files === null) continue
    const entries = new Map<string, CacheEntry>()
    for (const [path, value] of Object.entries(files)) {
      const entry = cacheEntry(value)
      if (entry !== undefined) entries.set(path, entry)
    }
    folders.set(folder, entries)
  }
  return folders
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

/**
 * @param cached - the cache the scan read.
 * @param recorded - the entries it records.
 * @returns whether they are the same entries, so the cache file need not be written again.
 */
function sameCache(cached: ReadonlyMap<string, CacheEntry>, recorded: ReadonlyMap<string, CacheEntry>): boolean {
  if (cached.size !== recorded.size) return false
  for (const [path, entry] of recorded) {
    const other = cached.get(path)
    if (other === undefined || other.dev !== entry.dev || other.ino !== entry.ino || other.size !== entry.size || other.mtimeMs !== entry.mtimeMs || other.ctimeMs !== entry.ctimeMs || other.digest !== entry.digest) return false
  }
  return true
}

/** The state one scan carries through its walk. */
interface Walk {
  readonly cached: ReadonlyMap<string, CacheEntry>
  readonly recorded: Map<string, CacheEntry>
  readonly settledBefore: number
  readonly memo: ScanMemo | undefined
  readonly entries: VersionEntry[]
  readonly files: ScannedFile[]
  readonly skipped: string[]
  /** The real path of the folder and of each dereferenced directory, to the relative path its files are under. */
  readonly included: Map<string, string>
  /** How links to installed packages are recorded; `active` for an active directory's scan, which follows no link. */
  readonly dependencies: DependencyMode | 'active'
  /** The Delorun home's real path, or its absolute path when it does not resolve; undefined for an active directory. */
  readonly home: string | undefined
  /** The real path of the active runtime's `app/node_modules`; undefined without a readable `runtimes/current`. */
  readonly runtimeModules: string | undefined
  /** The folder scanned, named in a refusal. */
  readonly folder: string
  /** The limits it stops at. */
  readonly limits: ScanLimits
  /** The `node_modules` directories of runtime packages whose own installed packages the walk leaves to the dependency closure. */
  readonly pruned: Set<string>
  /** When the scan next lets other work run ({@link SCAN_SLICE_MS}), in `performance.now()` milliseconds. */
  pauseAt: number
  /** The files, links and directories counted so far. */
  count: number
  /** The bytes of the files counted so far. */
  bytes: number
}

/**
 * What a person can do about a plugin folder over the limits.
 * @param walk - the scan.
 * @returns the sentence to append to the refusal; empty for an active directory, which a person does not edit.
 */
function tooLargeAdvice(walk: Walk): string {
  if (walk.dependencies === 'active') return ''
  return ` Remove its development packages with \`npm prune --omit=dev\` in ${walk.folder}, or link a folder that holds only the built plugin, then start again.`
}

/**
 * Count one entry of the version, and its bytes, against the limits.
 * @param walk - the scan.
 * @param bytes - the bytes it adds; zero for a link or a directory.
 * @throws {ChangesError} `CONTENT_TOO_LARGE` when the version would pass the scan's limits.
 */
function admit(walk: Walk, bytes: number): void {
  walk.count += 1
  walk.bytes += bytes
  if (walk.count > walk.limits.entries) {
    throw new ChangesError('CONTENT_TOO_LARGE', walk.folder, `${walk.folder}, with the installed packages it links, holds more than ${String(walk.limits.entries)} files, links and directories, so Delorun does not copy it.${tooLargeAdvice(walk)}`)
  }
  if (walk.bytes > walk.limits.bytes) {
    throw new ChangesError('CONTENT_TOO_LARGE', walk.folder, `${walk.folder}, with the installed packages it links, holds more than ${byteLimitWords(walk.limits.bytes)}, so Delorun does not copy it.${tooLargeAdvice(walk)}`)
  }
}

/**
 * Let other work on the event loop run; the scan calls it once it has run for {@link SCAN_SLICE_MS} since it last did.
 * @param walk - the scan.
 */
async function pause(walk: Walk): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  walk.pauseAt = performance.now() + SCAN_SLICE_MS
}

/**
 * Take a regular file's digest from the cache when its status, read without opening it, is the cached one.
 * @param walk - the scan.
 * @param source - its absolute path.
 * @param path - its relative path in the version.
 * @returns whether the cache gave the digest; false when it holds none for the path or the file's status differs, as
 *   it does for a file that is no longer regular.
 */
function addCachedFile(walk: Walk, source: string, path: string): boolean {
  const cached = walk.cached.get(path)
  if (cached === undefined) return false
  const stats = lstatSync(source)
  if (!stats.isFile() || !cacheMatches(cached, stats)) return false
  admit(walk, stats.size)
  walk.recorded.set(path, cached)
  const entry: FileEntry = { type: 'file', path, digest: cached.digest, size: cached.size, executable: (stats.mode & 0o100) !== 0 }
  walk.entries.push(entry)
  walk.files.push({ entry, source })
  return true
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
      const before = walk.memo === undefined ? undefined : await handle.stat({ bigint: true })
      const remembered = before === undefined ? undefined : walk.memo!.lookup(source, before)
      if (remembered !== undefined) {
        entry = { type: 'file', path, digest: remembered, size: stats.size, executable }
      } else {
        const hash = createHash('sha256')
        const size = await readChunks(handle, { size: stats.size, path: source }, (chunk) => { hash.update(chunk) })
        walk.bytes -= stats.size - size
        const digest = brandString<ObjectDigest>(hash.digest('hex'))
        if (Math.max(stats.mtimeMs, stats.ctimeMs) < walk.settledBefore) {
          walk.recorded.set(path, { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest })
        }
        if (before !== undefined) {
          const after = await handle.stat({ bigint: true })
          if (size === stats.size && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs) walk.memo!.record(source, after, digest)
        }
        entry = { type: 'file', path, digest, size, executable }
      }
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
  if (real !== undefined && inRuntimeStore(walk, real)) {
    addRuntimeLink(walk, path, real)
    return
  }
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
  } else if (inRuntimeStore(walk, real)) {
    addRuntimeLink(walk, path, real)
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

/**
 * @param home - the Delorun home, or undefined.
 * @param release - the release, or undefined for `runtimes/current`.
 * @returns the real path of that release's installed packages, or undefined without a home.
 */
async function runtimeModulesOf(home: string | undefined, release: string | undefined): Promise<string | undefined> {
  return home === undefined ? undefined : await activeRuntimeModules(await realTarget(resolve(home)) ?? resolve(home), release)
}

/**
 * Add a link to a package the running release carries, by its path below the active runtime's installed packages; a
 * link to that folder itself is left out.
 * @param walk - the scan, whose `runtimeModules` holds `real`.
 * @param path - the link's relative path in the version.
 * @param real - its real target.
 */
function addRuntimeLink(walk: Walk, path: string, real: string): void {
  const target = relative(walk.runtimeModules!, real).split(sep).join('/')
  // A link to the installed packages folder itself names no one package the release carries.
  if (target === '') {
    walk.skipped.push(path)
    return
  }
  admit(walk, 0)
  walk.entries.push({ type: 'link', path, target, outside: true, runtime: true })
}

/**
 * The release a process's active directories link packages from: the one it runs from, or `runtimes/current` when it
 * runs from no installed release, as from a source checkout. A start re-points copies to it and the load check holds
 * them to it, so both use the same release.
 * @param home - the Delorun home.
 * @param runningRelease - the release this process runs from (`DELORUN_VERSION`), when it runs from one.
 * @returns the release, or undefined when neither names one.
 * @throws the filesystem error reading `runtimes/current` other than a missing file.
 */
export async function referenceRelease(home: string, runningRelease: string | undefined): Promise<string | undefined> {
  if (runningRelease !== undefined) return runningRelease
  const current = await readPointerFile(join(home, DELORUN_HOME_ENTRIES.runtimes, STORE_ENTRIES.current))
  return current === undefined || current === 'malformed' ? undefined : current
}

/**
 * @param home - the Delorun home's real path.
 * @param release - the release, or undefined for the one `runtimes/current` names ({@link referenceRelease}).
 * @returns the real path of its installed packages, `runtimes/<release>/app/node_modules`, or undefined when no release
 *   is named, its name is no runtime version, or that folder does not exist.
 * @throws the filesystem error other than a missing file.
 */
export async function activeRuntimeModules(home: string, release?: string): Promise<string | undefined> {
  const version = await referenceRelease(home, release)
  if (version === undefined || parseRuntimeVersion(version) === undefined) return undefined
  return await realTarget(join(home, DELORUN_HOME_ENTRIES.runtimes, version, 'app', DEPENDENCY_DIRECTORY))
}

/**
 * @param walk - the scan.
 * @param real - a link's real target, with every link and `..` resolved.
 * @returns whether it lies in the active runtime's installed packages, which hold only the running release's verified files.
 */
function inRuntimeStore(walk: Walk, real: string): boolean {
  return walk.runtimeModules !== undefined && contains(walk.runtimeModules, real)
}

/** A version path a pnpm workspace links a package at: `node_modules/<name>`, below any directory. */
const DEPENDENCY_PATH = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/

/**
 * Whether a scan may follow a link out of the directory it walks to a target no included directory holds outside a
 * `.git` directory, as the module describes: never into the Delorun home or a system directory; to an installed package,
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
 * @returns whether the walk stays out of it: the Delorun home, or a system directory or anything below one.
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
 * @param directory - a package's directory.
 * @returns the fields of its `package.json`; undefined when it has none a scan can read: a missing file, a link or another
 *   kind of file, one over {@link MANIFEST_BYTE_LIMIT}, one that grew while it was read, or text that is not a JSON object.
 */
async function readManifest(directory: string): Promise<Record<string, unknown> | undefined> {
  let manifest: unknown
  try {
    const path = join(directory, 'package.json')
    const { handle, stats } = await openRegularFile(path)
    try {
      if (stats.size > MANIFEST_BYTE_LIMIT) return undefined
      const chunks: Buffer[] = []
      await readChunks(handle, { size: stats.size, path }, (chunk) => { chunks.push(Buffer.from(chunk)) })
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    // The reasons are listed above; the package names no dependency Delorun can include.
    return undefined
  }
  return typeof manifest === 'object' && manifest !== null ? manifest as Record<string, unknown> : undefined
}

/**
 * The dependency names a package's `package.json` lists.
 * @param directory - the package's directory.
 * @param listed - the `package.json` fields to read; {@link DEPENDENCY_FIELDS} by default.
 * @returns the valid package names of those fields, without the package's own, sorted in code-unit order;
 *   empty when it has no readable manifest.
 */
async function dependencyNames(directory: string, listed: readonly string[] = DEPENDENCY_FIELDS): Promise<readonly string[]> {
  const fields = await readManifest(directory)
  if (fields === undefined) return []
  const names = new Set<string>()
  for (const field of listed) {
    const listing = fields[field]
    if (typeof listing !== 'object' || listing === null) continue
    for (const name of Object.keys(listing)) {
      if (name !== fields.name && PACKAGE_NAME_PATTERN.test(name)) names.add(name)
    }
  }
  return [...names].sort(compareCodeUnits)
}

/**
 * @param modules - a folder's top-level `node_modules` directory.
 * @returns whether it holds an installed package as a real directory, as npm and yarn lay out, rather than only links
 *   into a store, as pnpm does; its dot-named entries, such as `.bin` and pnpm's `.pnpm`, and a scope directory
 *   that holds only links do not count.
 */
async function holdsInstalledPackages(modules: string): Promise<boolean> {
  for (const dirent of await readdir(modules, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    if (!dirent.name.startsWith('@')) return true
    if ((await readdir(join(modules, dirent.name), { withFileTypes: true })).some((scoped) => scoped.isDirectory())) return true
  }
  return false
}

/**
 * Find the directory Node resolves a dependency name to from a package, below the folder's top-level `node_modules`:
 * the `node_modules` of the package, then of each directory above it, up to the folder.
 * @param root - the folder's real path.
 * @param from - the package directory, or the folder itself, that names the dependency.
 * @param name - the package name.
 * @returns the path of the installed entry, which can be a link; undefined when no directory in reach holds it.
 */
async function installedAt(root: string, from: string, name: string): Promise<string | undefined> {
  for (let directory = from; contains(root, directory); directory = dirname(directory)) {
    const candidate = join(directory, DEPENDENCY_DIRECTORY, ...name.split('/'))
    if (await realTarget(candidate) !== undefined) return candidate
  }
  return undefined
}

/**
 * Add the top-level `node_modules` of an npm-style folder as the plugin can load it at run time: the packages that
 * the folder's `package.json` names in {@link DEPENDENCY_FIELDS} and, repeatedly, those each of them names, each found
 * where Node finds it, including npm's hoisted layout. A folder without a readable `package.json` keeps every package.
 * Development packages and the packages only they need stay out, as does each included package's own `node_modules`
 * directory, whose packages the closure reaches by name. The top-level installed packages not reached are listed among
 * the skipped paths, the first 25 by name and the rest as a count, so the review shows what the copy leaves out.
 * @param walk - the scan.
 * @param root - the folder's real path.
 */
async function addRuntimeModules(walk: Walk, root: string): Promise<void> {
  admit(walk, 0)
  const reached = new Set<string>()
  const queue: { readonly from: string, readonly name: string }[] = (await dependencyNames(root)).map((name) => ({ from: root, name }))
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const installed = await installedAt(root, next.from, next.name)
    if (installed === undefined || reached.has(installed)) continue
    reached.add(installed)
    const path = relative(root, installed).split(sep).join('/')
    if ((await lstat(installed)).isSymbolicLink()) {
      const real = (await realTarget(installed))!
      await addTarget(walk, real, path, true)
      // A package linked from inside the folder, as an npm workspace does, resolves its own dependencies from there.
      if (contains(root, real)) queue.push(...(await dependencyNames(real)).map((name) => ({ from: real, name })))
      continue
    }
    // A package installed below another directory of the folder, such as a workspace package's own install, is copied by
    // the folder's walk of that directory; only its dependencies are followed here.
    if (contains(join(root, DEPENDENCY_DIRECTORY), installed)) {
      walk.pruned.add(join(installed, DEPENDENCY_DIRECTORY))
      await walkDirectory(walk, root, installed, path, true)
    }
    queue.push(...(await dependencyNames(installed)).map((name) => ({ from: installed, name })))
  }
  const left = (await installedNames(join(root, DEPENDENCY_DIRECTORY))).filter((name) => !reached.has(join(root, DEPENDENCY_DIRECTORY, ...name.split('/'))))
  for (const name of left.slice(0, LEFT_OUT_LISTED)) walk.skipped.push(`${DEPENDENCY_DIRECTORY}/${name}`)
  if (left.length > LEFT_OUT_LISTED) walk.skipped.push(`${DEPENDENCY_DIRECTORY} (and ${String(left.length - LEFT_OUT_LISTED)} more packages left out)`)
}

/** The most left-out installed packages a scan names one by one; the rest are counted in one entry. */
const LEFT_OUT_LISTED = 25

/**
 * @param modules - a folder's top-level `node_modules` directory.
 * @returns the names of the packages installed in it, scoped ones as `@scope/name`, without dot-named entries.
 */
async function installedNames(modules: string): Promise<readonly string[]> {
  const names: string[] = []
  for (const dirent of await readdir(modules, { withFileTypes: true })) {
    if (dirent.name.startsWith('.')) continue
    if (!dirent.name.startsWith('@')) {
      names.push(dirent.name)
      continue
    }
    for (const scoped of await readdir(join(modules, dirent.name))) names.push(`${dirent.name}/${scoped}`)
  }
  return names
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
  const dirents = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const dirent of dirents) {
    if (performance.now() >= walk.pauseAt) await pause(walk)
    const path = directory === '' ? dirent.name : `${directory}/${dirent.name}`
    // The directory's path is normalised and a name holds no separator, so joining them needs no normalising.
    const child = absolute.endsWith(sep) ? `${absolute}${dirent.name}` : `${absolute}${sep}${dirent.name}`
    if (dirent.name.includes('\\')) {
      // A version path is `/`-separated and cannot hold a backslash, so a file named with one is not content.
      walk.skipped.push(path)
    } else if (dirent.isDirectory()) {
      const nested = dependencies || (dirent.name === DEPENDENCY_DIRECTORY && directory !== '')
      if (walk.pruned.has(child)) continue
      if (directory === '' && dirent.name === DEPENDENCY_DIRECTORY && walk.dependencies === 'include' && await readManifest(root) !== undefined && await holdsInstalledPackages(child)) {
        await addRuntimeModules(walk, root)
      } else if (dirent.name !== EXCLUDED_DIRECTORY) {
        await walkDirectory(walk, root, child, path, nested)
      }
    } else if (dirent.isFile()) {
      // Most files of a large folder have a cached digest, taken here without opening the file or awaiting a promise.
      if (!addCachedFile(walk, child, path)) await addFile(walk, child, path)
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
 * @param options - a plugin folder's scan with the Delorun home, or an active directory's; the scan cache and the clock.
 * @returns the entries, the files with where they were read, and the skipped paths, each sorted by path; `.` when the
 *   folder is the Delorun home or in a system directory, which the scan does not read.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when a file is replaced by a link or another kind, or grows, while it
 *   is read; `CONTENT_TOO_LARGE` when the version would pass the scan's limits, {@link CONTENT_LIMITS} by default.
 * @throws the filesystem error, such as `ENOENT`, when the folder cannot be read.
 */
export async function scanFolder(folder: string, options: ScanOptions): Promise<ScannedFolder> {
  const now = options.now ?? Date.now
  const root = await realpath(folder)
  const cacheFolders = options.cache === undefined ? undefined : await readCache(options.cache)
  const cached = cacheFolders?.get(root)
  const home = 'home' in options ? await realTarget(resolve(options.home)) ?? resolve(options.home) : undefined
  const walk: Walk = {
    cached: cached ?? new Map(),
    recorded: new Map(),
    settledBefore: now() - CACHE_SETTLE_MS,
    memo: options.memo,
    entries: [],
    files: [],
    skipped: [],
    included: new Map([[root, '']]),
    dependencies: 'home' in options ? options.dependencies ?? 'include' : 'active',
    home,
    // A folder scan reads against runtimes/current, which packs/current and so a pack source's links always follow; an
    // active directory is written and checked against the running release ({@link referenceRelease}).
    runtimeModules: 'active' in options ? await runtimeModulesOf(options.runtimeHome, options.runtimeRelease) : await runtimeModulesOf(home, undefined),
    folder,
    limits: options.limits ?? CONTENT_LIMITS,
    pruned: new Set(),
    pauseAt: performance.now() + SCAN_SLICE_MS,
    count: 0,
    bytes: 0,
  }
  await walkDirectory(walk, root, root, '', false)
  // A cache that holds what the scan would record is not written again, so a read of an unchanged folder writes nothing.
  if (options.cache !== undefined && (cached === undefined || !sameCache(cached, walk.recorded))) {
    // Another folder's entries stay, so the scans of a profile's plugin folders do not replace one another's.
    const folders: CacheFolders = new Map(cacheFolders)
    folders.delete(root)
    folders.set(root, walk.recorded)
    for (const oldest of [...folders.keys()].slice(0, Math.max(0, folders.size - SCAN_CACHE_FOLDERS))) folders.delete(oldest)
    const cache: ScanCache = {
      schema: SCAN_CACHE_SCHEMA,
      folders: Object.fromEntries([...folders].map(([folder, recorded]) => [folder, Object.fromEntries([...recorded].sort(([a], [b]) => compareCodeUnits(a, b)))])),
    }
    await mkdir(dirname(options.cache), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(options.cache, `${JSON.stringify(cache)}\n`)
  }
  return {
    entries: walk.entries.sort((a, b) => compareCodeUnits(a.path, b.path)),
    files: walk.files.sort((a, b) => compareCodeUnits(a.entry.path, b.entry.path)),
    skipped: walk.skipped.sort(compareCodeUnits),
  }
}

/** What {@link scanFile} found at a path of an active directory. */
export type ScannedPath =
  /** A regular file, hashed now. */
  | { readonly kind: 'file', readonly file: ScannedFile }
  /** Nothing the directory's scan would list as a file: no entry, a directory, or an entry below a link, a file or a `.git` directory. */
  | { readonly kind: 'absent' }
  /** An entry the directory's scan would list among its links or skipped entries: a symbolic link, socket, FIFO or device. */
  | { readonly kind: 'skipped' }

/**
 * Read one path of an active directory as its scan ({@link scanFolder} with {@link ActiveScanOptions}) would: each
 * directory above it must be a directory, not a link and not named `.git`, and a regular file is hashed from its bytes,
 * never taken from a scan cache. The other entries of the directory are not read, so a problem elsewhere in it, or the
 * directory passing the limits as a whole, is not seen.
 * @param folder - the active directory.
 * @param path - the `/`-separated relative path, free of empty, `.` and `..` segments.
 * @param limits - the limits the one file is held to; {@link CONTENT_LIMITS} by default.
 * @returns what the path holds.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the file is replaced by a link or another kind, or grows, while it
 *   is read; `CONTENT_TOO_LARGE` when the file passes the byte limit.
 * @throws the filesystem error, such as `EACCES`, when an entry cannot be read.
 */
export async function scanFile(folder: string, path: string, limits: ScanLimits = CONTENT_LIMITS): Promise<ScannedPath> {
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    if (segment.includes('\\')) return index === segments.length - 1 ? { kind: 'skipped' } : { kind: 'absent' }
    const absolute = join(folder, ...segments.slice(0, index + 1))
    let stats: Stats
    try {
      stats = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { kind: 'absent' }
      throw error
    }
    if (index < segments.length - 1) {
      if (!stats.isDirectory() || segment === EXCLUDED_DIRECTORY) return { kind: 'absent' }
    } else if (stats.isDirectory()) {
      return { kind: 'absent' }
    } else if (!stats.isFile()) {
      return { kind: 'skipped' }
    }
  }
  const walk: Walk = {
    cached: new Map(),
    recorded: new Map(),
    settledBefore: Number.NEGATIVE_INFINITY,
    memo: undefined,
    entries: [],
    files: [],
    skipped: [],
    included: new Map(),
    dependencies: 'active',
    home: undefined,
    runtimeModules: undefined,
    folder,
    limits: { entries: 1, bytes: limits.bytes },
    pruned: new Set(),
    pauseAt: Number.POSITIVE_INFINITY,
    count: 0,
    bytes: 0,
  }
  await addFile(walk, join(folder, ...segments), path)
  return { kind: 'file', file: walk.files[0]! }
}
