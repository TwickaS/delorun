/**
 * Collection of the content store under `changes/store/`: removing the version and object files no record names.
 *
 * A version is kept when any profile under `changes/profiles/` names it: the approved record in the profile's
 * `package.json`, the `from` or `to` of a change-log entry that is `pending`, `applied` or `left-out-at-start`, an entry
 * of `active.json`, or the work session's `from`, `lastLoaded` or `lastFailed`. A version file modified less than
 * {@link COLLECT_GRACE_MS} ago is kept too. An object is kept when a kept version lists it. Everything else named like a
 * version file (`<sha256>.json`) or an object (`<sha256>`) is removed, and so is a temporary file the store left behind
 * (`.<name>.delo-tmp-<16 hex>`) once it is older than the grace period; other names stay.
 *
 * The references are read and the files removed while the store's lock is held, so no version is being stored meanwhile.
 * A collection does not wait for the lock: when another holder has it, nothing is removed. When a record or a kept
 * version cannot be read, nothing is removed either, because a reference it holds is unknown. Removal stops once
 * {@link COLLECT_TIME_LIMIT_MS} have passed; the next collection removes the rest.
 *
 * @module @delo/changes/collect
 */
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CHANGES_ENTRIES, changesDirectory, objectsDirectory, versionsDirectory } from './paths.ts'
import { readActiveRecord, readApproved, readChangeLog, readWorkSession } from './records.ts'
import { readVersion, withStoreLock } from './store.ts'
import type { ChangeState, ContentVersion } from './types.ts'

/** How long one collection may remove files, in milliseconds, before it stops; the rest waits for the next collection. */
export const COLLECT_TIME_LIMIT_MS = 2_000

/**
 * How recently a version file may have been modified, in milliseconds, and still be kept without a record naming it,
 * so a change computed for review but not yet logged keeps its content until it is decided. A leftover temporary file
 * younger than this stays too.
 */
export const COLLECT_GRACE_MS = 3_600_000

/** The change states whose `from` and `to` versions a collection keeps. */
const KEPT_STATES: ReadonlySet<ChangeState> = new Set(['pending', 'applied', 'left-out-at-start'])

/** A version file's name. */
const VERSION_FILE = /^([0-9a-f]{64})\.json$/

/** An object file's name. */
const OBJECT_FILE = /^[0-9a-f]{64}$/

/** A temporary file the store writes before renaming it into place. */
const TEMPORARY_FILE = /^\..+\.delo-tmp-[0-9a-f]{16}$/

/** The message of `withFileLock`'s timeout, which is the store's lock being held. */
const LOCK_TIMEOUT_MESSAGE = 'atomic-write: timed out waiting for the writer lock'

/** What one collection is asked to do. */
export interface CollectRequest {
  /** The Delo home. */
  readonly home: string
  /**
   * Maps a profile's name to its directory, whose `package.json` holds the approved record.
   * @param profile - the profile's name, a directory name under `changes/profiles/`.
   * @returns the profile's directory.
   */
  readonly profileDirectory: (profile: string) => string
  /**
   * The wall clock, in milliseconds since the epoch; `Date.now` by default.
   * @returns the time now.
   */
  readonly now?: () => number
  /** How long removal may run, in milliseconds; {@link COLLECT_TIME_LIMIT_MS} by default. */
  readonly timeLimitMs?: number
}

/** What one collection did. */
export interface CollectResult {
  /** Whether every file to remove was removed. */
  readonly complete: boolean
  /** How many version files were removed. */
  readonly removedVersions: number
  /** How many object files were removed. */
  readonly removedObjects: number
  /** Why nothing was removed, when the lock was held or a record or kept version could not be read. */
  readonly skipped?: string
}

/** What a collection keeps. */
interface Kept {
  readonly versions: ReadonlySet<string>
  readonly objects: ReadonlySet<string>
}

/**
 * Remove the store's version and object files that no profile names, under the store's lock, within a time limit.
 * @param request - the home, how profile names map to directories, the clock and the time limit.
 * @returns how many files were removed and whether that was all; `skipped` says why nothing was removed when the store's
 * lock was held or a record or kept version could not be read.
 * @throws the filesystem error of listing or removing a store file, or of taking the lock other than its timeout.
 */
export async function collectStore(request: CollectRequest): Promise<CollectResult> {
  const now = request.now ?? Date.now
  const timeLimitMs = request.timeLimitMs ?? COLLECT_TIME_LIMIT_MS
  const started = now()
  try {
    return await withStoreLock(request.home, async () => {
      let kept: Kept
      try {
        kept = await keptContent(request, now())
      } catch (error) {
        return skipped(`a record or kept version cannot be read: ${firstLine(error)}`)
      }
      return await remove(request.home, kept, () => now() - started >= timeLimitMs, now())
    }, 0)
  } catch (error) {
    if (String(error).includes(LOCK_TIMEOUT_MESSAGE)) return skipped('the store is in use')
    throw error
  }
}

/**
 * @param reason - why nothing was removed.
 * @returns the result of a collection that removed nothing.
 */
function skipped(reason: string): CollectResult {
  return { complete: false, removedVersions: 0, removedObjects: 0, skipped: reason }
}

/**
 * @param error - a thrown value.
 * @returns its text's first line.
 */
function firstLine(error: unknown): string {
  return String(error).split('\n', 1)[0]!
}

/**
 * The names in a directory.
 * @param directory - the directory.
 * @returns its entries; none when it does not exist.
 */
async function entriesOf(directory: string): Promise<{ readonly name: string, readonly directory: boolean }[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * @param path - a directory.
 * @returns whether it exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * The versions one profile's records name.
 * @param request - the home and how profile names map to directories.
 * @param profile - the profile's name.
 * @returns the version ids.
 * @throws when a record cannot be read.
 */
async function profileVersions(request: CollectRequest, profile: string): Promise<ContentVersion[]> {
  const versions: (ContentVersion | undefined)[] = []
  const profileDir = request.profileDirectory(profile)
  if (await exists(profileDir)) {
    versions.push(...Object.values((await readApproved(profileDir)).plugins).map(plugin => plugin.version))
  }
  for (const entry of (await readChangeLog(request.home, profile)).entries) {
    if (KEPT_STATES.has(entry.state)) versions.push(entry.from, entry.to)
  }
  versions.push(...Object.values((await readActiveRecord(request.home, profile)).plugins).map(content => content.version))
  const session = await readWorkSession(request.home, profile)
  if (session !== undefined) versions.push(session.from, session.lastLoaded, session.lastFailed)
  return versions.filter(version => version !== undefined)
}

/**
 * Every version and object a collection keeps.
 * @param request - the home and how profile names map to directories.
 * @param at - the time now, for the grace period.
 * @returns the kept version ids and object digests.
 * @throws when a record or a kept version cannot be read.
 */
async function keptContent(request: CollectRequest, at: number): Promise<Kept> {
  const versions = new Set<string>()
  for (const entry of await entriesOf(join(changesDirectory(request.home), CHANGES_ENTRIES.profiles))) {
    if (!entry.directory) continue
    for (const version of await profileVersions(request, entry.name)) versions.add(version)
  }
  const versionDir = versionsDirectory(request.home)
  for (const entry of await entriesOf(versionDir)) {
    const id = VERSION_FILE.exec(entry.name)?.[1]
    if (id === undefined || entry.directory) continue
    if (at - (await lstat(join(versionDir, entry.name))).mtimeMs < COLLECT_GRACE_MS) versions.add(id)
  }
  const objects = new Set<string>()
  for (const version of versions) {
    for (const file of (await readVersion(request.home, brandString<ContentVersion>(version))).entries) {
      if (file.type === 'file') objects.add(file.digest)
    }
  }
  return { versions, objects }
}

/** Counts of removed files, updated as removal runs. */
interface Removed {
  versions: number
  objects: number
}

/**
 * Remove the files of one store directory that are not kept.
 * @param directory - the store directory.
 * @param unkept - for a file name, whether it is a store file that is not kept.
 * @param at - the time now, for the grace period of temporary files.
 * @param expired - whether the time limit has passed.
 * @param count - called after each removal of an unkept store file.
 * @returns whether every such file was removed before the time limit.
 */
async function removeIn(directory: string, unkept: (name: string) => boolean, at: number, expired: () => boolean, count: () => void): Promise<boolean> {
  for (const entry of await entriesOf(directory)) {
    if (entry.directory) continue
    const path = join(directory, entry.name)
    const store = unkept(entry.name)
    if (!store && !(TEMPORARY_FILE.test(entry.name) && at - (await lstat(path)).mtimeMs >= COLLECT_GRACE_MS)) continue
    if (expired()) return false
    await rm(path, { force: true })
    if (store) count()
  }
  return true
}

/**
 * Remove the version files, then the object files, that are not kept, and old temporary files.
 * @param home - the Delo home.
 * @param kept - what stays.
 * @param expired - whether the time limit has passed.
 * @param at - the time now, for the grace period of temporary files.
 * @returns the collection's result.
 */
async function remove(home: string, kept: Kept, expired: () => boolean, at: number): Promise<CollectResult> {
  const removed: Removed = { versions: 0, objects: 0 }
  const unkeptVersion = (name: string): boolean => {
    const id = VERSION_FILE.exec(name)?.[1]
    return id !== undefined && !kept.versions.has(id)
  }
  const unkeptObject = (name: string): boolean => OBJECT_FILE.test(name) && !kept.objects.has(name)
  const complete = await removeIn(versionsDirectory(home), unkeptVersion, at, expired, () => { removed.versions++ })
    && await removeIn(objectsDirectory(home), unkeptObject, at, expired, () => { removed.objects++ })
  return { complete, removedVersions: removed.versions, removedObjects: removed.objects }
}
