/**
 * The content-addressed store of plugin content under `changes/store/`, and the active directories made from it.
 * An object file holds the bytes whose SHA-256 is its name and is never rewritten; a version file lists one content
 * version and is named by its version id. Every read checks the name against the content, so a store file that was
 * altered is refused rather than loaded. Storing a folder's content approves nothing: only the profile's record says
 * which version is approved.
 *
 * @module @delo/changes/store
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, rmdir, symlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PRIVATE_DIR_MODE, PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { HomeLayoutError, readProtectedFile, writeProtectedFile } from '@delo/home'
import { ChangesError } from './errors.ts'
import { objectsDirectory, versionsDirectory } from './paths.ts'
import { compareCodeUnits, isDigest, manifestOf, openRegularFile, readChunks, scanFolder, versionOf } from './tree.ts'
import { VERSION_MANIFEST_SCHEMA, type ContentVersion, type ObjectDigest, type VersionEntry, type VersionManifest } from './types.ts'

/** The mode of an active file whose owner execute bit is set. */
const EXECUTABLE_FILE_MODE = 0o700

/** How {@link storeFolder} reads the folder. */
export interface StoreOptions {
  /** The scan cache file, such as `changes/profiles/<profile>/scan-cache.json`; see the scan's `cache` option. */
  readonly scanCache?: string
  /** Called after each file's bytes were copied into the store, with its relative path. A test hook. */
  readonly onCopied?: (path: string) => Promise<void> | void
}

/** A folder's content, stored. */
export interface StoredFolder {
  readonly version: ContentVersion
  readonly manifest: VersionManifest
  /** Sockets, FIFOs and devices the folder holds, which are not part of the content. */
  readonly skipped: readonly string[]
}

/**
 * The path of a sibling temporary file in the same directory, so a rename over the path is atomic.
 * @param path - the path the temporary file replaces.
 * @returns the temporary path.
 */
function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.delo-tmp-${randomBytes(8).toString('hex')}`)
}

/**
 * Copy an open file's bytes to a new file at a path, hashing them while copying, and rename it over the path only when
 * the digest is the expected one.
 * @param source - the open source file, read from its start.
 * @param path - the file to write.
 * @param mode - the new file's mode.
 * @param expected - the digest the bytes must have.
 * @returns whether the bytes read have the digest `expected`; when they do not, nothing was written.
 */
async function copyHashing(source: FileHandle, path: string, mode: number, expected: ObjectDigest): Promise<boolean> {
  const temporary = temporaryPath(path)
  const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  let matches = false
  try {
    try {
      const hash = createHash('sha256')
      await readChunks(source, async (chunk) => {
        hash.update(chunk)
        await target.write(chunk)
      })
      await target.sync()
      matches = hash.digest('hex') === expected
    } finally {
      await target.close()
    }
    if (matches) await rename(temporary, path)
  } finally {
    if (!matches) await rm(temporary, { force: true })
  }
  return matches
}

/**
 * Store a folder's current content: copy each file into `objects/` unless the store holds its digest, then write the
 * version file.
 * @param home - the Delo home.
 * @param folder - the plugin folder.
 * @param options - the scan cache and the test hook.
 * @returns the version, its manifest and the skipped paths.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when a file's bytes while copying differ from the scan, or the folder's
 * version after copying differs from before.
 */
export async function storeFolder(home: string, folder: string, options: StoreOptions = {}): Promise<StoredFolder> {
  const objects = objectsDirectory(home)
  const versions = versionsDirectory(home)
  await mkdir(objects, { recursive: true, mode: PRIVATE_DIR_MODE })
  await mkdir(versions, { recursive: true, mode: PRIVATE_DIR_MODE })
  const scanOptions = options.scanCache === undefined ? {} : { cache: options.scanCache }
  const scanned = await scanFolder(folder, scanOptions)
  for (const { entry, source } of scanned.files) {
    if (await objectExists(join(objects, entry.digest))) continue
    const { handle } = await openRegularFile(source)
    let copied: boolean
    try {
      copied = await copyHashing(handle, join(objects, entry.digest), PROTECTED_FILE_MODE, entry.digest)
    } finally {
      await handle.close()
    }
    if (!copied) throw new ChangesError('CHANGED_WHILE_READING', source, `${source} changed while it was copied into the store`)
    await options.onCopied?.(entry.path)
  }
  const version = versionOf(scanned.entries)
  const again = await scanFolder(folder, scanOptions)
  if (versionOf(again.entries) !== version) throw new ChangesError('CHANGED_WHILE_READING', folder, `${folder} changed while it was read; nothing was stored as its content`)
  const manifest = manifestOf(scanned.entries)
  await writeProtectedFile(join(versions, `${version}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  return { version, manifest, skipped: scanned.skipped }
}

/**
 * Whether the store holds an object file by its name. Its content is checked when it is read; a symbolic link in its
 * place is not an object, so the copy replaces it.
 * @param path - the object file.
 * @returns whether a regular file is there.
 */
async function objectExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * The failure of opening a store file: `STORE_CORRUPT` for a missing file or one that is not a regular protected file,
 * the filesystem error otherwise.
 * @param error - what opening it threw.
 * @param path - the file.
 * @param subject - what the person reads it as.
 * @returns the error to throw.
 */
function storeFileFailure(error: unknown, path: string, subject: string): unknown {
  if (error instanceof HomeLayoutError || error instanceof ChangesError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new ChangesError('STORE_CORRUPT', path, `the store has no usable ${subject} at ${path}`, { cause: error })
  }
  return error
}

/**
 * Read a store file, turning a missing or refused file into `STORE_CORRUPT`.
 * @param path - the file.
 * @param subject - what the person reads it as.
 * @returns its bytes.
 * @throws {ChangesError} `STORE_CORRUPT` when the file is missing or not a protected file.
 * @throws the filesystem error otherwise.
 */
async function readStoreFile(path: string, subject: string): Promise<Buffer> {
  try {
    return await readProtectedFile(path)
  } catch (error) {
    throw storeFileFailure(error, path, subject)
  }
}

/**
 * Whether a relative path is one a version may hold.
 * @param path - the path.
 * @returns whether it is relative, `/`-separated and without an empty, `.` or `..` segment.
 */
function validPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * One entry of a version file, with only the fields a version has.
 * @param value - the parsed value.
 * @returns the entry, or undefined when it is not one.
 */
function parseEntry(value: unknown): VersionEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.path !== 'string' || !validPath(entry.path)) return undefined
  if (entry.type === 'file') {
    if (typeof entry.digest !== 'string' || !isDigest(entry.digest) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || typeof entry.executable !== 'boolean') return undefined
    return { type: 'file', path: entry.path, digest: brandString<ObjectDigest>(entry.digest), size: entry.size as number, executable: entry.executable }
  }
  if (entry.type === 'link') {
    if (typeof entry.target !== 'string' || entry.target === '' || typeof entry.outside !== 'boolean') return undefined
    return { type: 'link', path: entry.path, target: entry.target, outside: entry.outside }
  }
  return undefined
}

/**
 * Validate parsed version entries.
 * @param value - the parsed `entries` field.
 * @returns the entries, or undefined when one is invalid, they are not sorted and unique, or a path is below another
 * entry's path.
 */
function parseEntries(value: unknown): VersionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: VersionEntry[] = []
  for (const item of value as unknown[]) {
    const entry = parseEntry(item)
    const previous = entries.at(-1)
    if (entry === undefined || (previous !== undefined && compareCodeUnits(previous.path, entry.path) >= 0)) return undefined
    entries.push(entry)
  }
  const paths = new Set(entries.map((entry) => entry.path))
  for (const entry of entries) {
    const segments = entry.path.split('/')
    for (let length = 1; length < segments.length; length++) {
      if (paths.has(segments.slice(0, length).join('/'))) return undefined
    }
  }
  return entries
}

/**
 * Read a content version from the store.
 * @param home - the Delo home.
 * @param version - the version id.
 * @returns its manifest.
 * @throws {ChangesError} `STORE_CORRUPT` when the version file is missing, not one Delo wrote, or lists content whose
 * version id is not its name.
 */
export async function readVersion(home: string, version: ContentVersion): Promise<VersionManifest> {
  const path = join(versionsDirectory(home), `${version}.json`)
  const bytes = await readStoreFile(path, `version ${version}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new ChangesError('STORE_CORRUPT', path, `the version file ${path} is not JSON`, { cause: error })
  }
  const manifest = parsed as Partial<VersionManifest> | null
  const entries = manifest?.schema === VERSION_MANIFEST_SCHEMA ? parseEntries(manifest.entries) : undefined
  if (entries === undefined) throw new ChangesError('STORE_CORRUPT', path, `the version file ${path} is not a version Delo wrote`)
  if (versionOf(entries) !== version) throw new ChangesError('STORE_CORRUPT', path, `the version file ${path} does not hold version ${version}`)
  return manifestOf(entries)
}

/**
 * Read an object from the store.
 * @param home - the Delo home.
 * @param digest - the object's digest.
 * @returns its bytes.
 * @throws {ChangesError} `STORE_CORRUPT` when the object file is missing or its bytes do not have the digest.
 */
export async function readObject(home: string, digest: ObjectDigest): Promise<Buffer> {
  const path = join(objectsDirectory(home), digest)
  const bytes = await readStoreFile(path, `object ${digest}`)
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new ChangesError('STORE_CORRUPT', path, `the object ${path} does not hold the bytes its name says`)
  return bytes
}

/**
 * Whether two entries for one path hold the same content.
 * @param a - one entry.
 * @param b - the other.
 * @returns whether type, bytes, execute bit or target are all equal.
 */
function sameEntry(a: VersionEntry, b: VersionEntry): boolean {
  if (a.type === 'file') return b.type === 'file' && a.digest === b.digest && a.executable === b.executable
  return b.type === 'link' && a.target === b.target
}

/**
 * Remove a path's directories below a root that are empty, deepest first.
 * @param root - the directory never removed.
 * @param path - a relative path whose parent directories are tried.
 */
async function removeEmptyParents(root: string, path: string): Promise<void> {
  const segments = path.split('/')
  for (let length = segments.length - 1; length > 0; length--) {
    try {
      await rmdir(join(root, ...segments.slice(0, length)))
    } catch {
      // Any rmdir error, usually ENOTEMPTY or EEXIST because the directory holds other entries: it and its parents stay.
      // An empty directory left behind is not content, since a scan lists only files and links.
      return
    }
  }
}

/**
 * Write one entry into a directory by renaming a new file or link over its path.
 * @param home - the Delo home.
 * @param target - the directory.
 * @param entry - the entry.
 */
async function writeEntry(home: string, target: string, entry: VersionEntry): Promise<void> {
  const path = join(target, ...entry.path.split('/'))
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  if (entry.type === 'link') {
    const temporary = temporaryPath(path)
    await symlink(entry.target, temporary)
    await rename(temporary, path)
    return
  }
  const objectPath = join(objectsDirectory(home), entry.digest)
  let opened
  try {
    opened = await openRegularFile(objectPath)
  } catch (error) {
    throw storeFileFailure(error, objectPath, `object ${entry.digest}`)
  }
  let copied: boolean
  try {
    copied = await copyHashing(opened.handle, path, entry.executable ? EXECUTABLE_FILE_MODE : PROTECTED_FILE_MODE, entry.digest)
  } finally {
    await opened.handle.close()
  }
  if (!copied) throw new ChangesError('STORE_CORRUPT', objectPath, `the object ${objectPath} does not hold the bytes its name says`)
}

/**
 * Make a directory hold exactly one content version, changing only what differs: a changed file or link is written to
 * a temporary name in its directory and renamed over its path, an entry the version lacks is removed with its emptied
 * directories, and an unchanged file is left as it is, so its inode, size and times stay. Directories are created at
 * 0700, files at 0600, or 0700 when the version sets the execute bit.
 * @param home - the Delo home.
 * @param version - the version to hold.
 * @param target - the directory; created when missing.
 * @param previous - the manifest the directory holds, when the caller knows it; otherwise the directory is scanned.
 * @returns the version's manifest.
 * @throws {ChangesError} `STORE_CORRUPT` when the store does not hold the version or its objects, or the directory does
 * not hold the version afterwards.
 */
export async function materialize(home: string, version: ContentVersion, target: string, previous?: VersionManifest): Promise<VersionManifest> {
  const manifest = await readVersion(home, version)
  await mkdir(target, { recursive: true, mode: PRIVATE_DIR_MODE })
  let current: readonly VersionEntry[]
  let strays: readonly string[] = []
  if (previous === undefined) {
    const scanned = await scanFolder(target)
    current = scanned.entries
    strays = scanned.skipped
  } else {
    current = previous.entries
  }
  const wanted = new Map(manifest.entries.map((entry) => [entry.path, entry]))
  const removed = [...current.filter((entry) => !wanted.has(entry.path)).map((entry) => entry.path), ...strays]
  for (const path of removed) {
    await rm(join(target, ...path.split('/')), { force: true })
    await removeEmptyParents(target, path)
  }
  const held = new Map(current.map((entry) => [entry.path, entry]))
  for (const entry of manifest.entries) {
    const before = held.get(entry.path)
    if (before === undefined || !sameEntry(before, entry)) await writeEntry(home, target, entry)
  }
  if (!await holdsVersion(target, version)) throw new ChangesError('STORE_CORRUPT', target, `${target} does not hold version ${version} after it was written`)
  return manifest
}

/**
 * Whether a directory holds a content version.
 * @param target - the directory.
 * @param version - the version id.
 * @returns whether a scan of it gives the version; false when it does not exist.
 */
export async function holdsVersion(target: string, version: ContentVersion): Promise<boolean> {
  try {
    return versionOf((await scanFolder(target)).entries) === version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
