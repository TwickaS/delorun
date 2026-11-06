/**
 * The home lock `run/<profile>/home.lock` (contract C1, "The home lock"): one
 * holder per CLI profile, a JSON record created by exclusive creation at mode
 * 0600, a stale lock replaced only when its process no longer exists, and a
 * live holder never taken over.
 *
 * The record is written to a temporary file first and hard-linked to the lock
 * path, so the lock appears with its whole record or not at all, and of two
 * contenders exactly one link succeeds. A stale lock is moved aside by rename
 * and removed only when the moved file is the one found stale; a contender that
 * moved a lock another contender had just created links it back.
 *
 * @module @delo/cli/home/lock
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PROTECTED_FILE_MODE, RUN_ENTRIES, type HomeLockRecord, type RuntimeVersion, type StartId } from '@delo/contract-home-layout'
import { HomeLayoutError } from './errors.ts'

/** Whether a live holder answered the update channel's `status` request in time. */
export type HolderAnswer = 'answered' | 'silent'

/**
 * Ask a live lock holder for its status, within C1's two seconds.
 * @param record - the holder's lock record.
 * @returns whether it answered.
 */
export type HolderProbe = (record: HomeLockRecord) => Promise<HolderAnswer>

/** A held home lock. */
export interface HomeLock {
  /** The lock file's path. */
  readonly path: string
  /** The record this holder wrote. */
  readonly record: HomeLockRecord
  /**
   * Remove the lock when it still holds this holder's record. Synchronous, so
   * a process `exit` listener can call it; a second call does nothing.
   */
  release(): void
}

/** What {@link acquireHomeLock} needs. */
export interface AcquireOptions {
  /** The profile's run directory, `run/<profile>/`, which must exist. */
  readonly runDirectory: string
  /** The runtime version the holder runs. */
  readonly runtime: RuntimeVersion
  /** Asks a live holder for its status; decides between `HOME_RUNNING` and `HOME_UNRESPONSIVE`. */
  readonly probe: HolderProbe
}

/** Contention rounds before a contender gives up; each round ends in a link, a refusal or a removed stale lock. */
const MAX_ROUNDS = 16

/** The largest lock record read; a valid record is far smaller. */
const MAX_RECORD_BYTES = 4096

const START_ID = /^[0-9a-f]{32}$/

/**
 * Parse a lock record, or `undefined` when the bytes are not one.
 * @param text - the lock file's contents.
 * @returns the record.
 */
function parseRecord(text: string): HomeLockRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the caller reports the file as not a lock record.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.v !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined
  if (typeof record.startId !== 'string' || !START_ID.test(record.startId)) return undefined
  if (typeof record.runtime !== 'string' || typeof record.startedAt !== 'string') return undefined
  return {
    v: 1,
    pid: record.pid as number,
    startId: brandString<StartId>(record.startId),
    runtime: brandString<RuntimeVersion>(record.runtime),
    startedAt: record.startedAt,
  }
}

/** A lock file read together with the identity of the file read. */
interface ReadLock {
  readonly record: HomeLockRecord
  readonly ino: number
  readonly dev: number
}

/**
 * Read the lock at a path.
 * @param path - the lock file.
 * @returns the record and file identity, or `undefined` when no lock exists.
 * @throws {Error} when the file is not a lock record; it names the path.
 */
function readLock(path: string): ReadLock | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stats = fstatSync(fd)
    const record = stats.isFile() && stats.size <= MAX_RECORD_BYTES ? parseRecord(readFileSync(fd, 'utf8')) : undefined
    if (record === undefined) throw new Error(`${path} is not a home lock record; remove it once no delorun process runs for this profile`)
    return { record, ino: stats.ino, dev: stats.dev }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the home lock of a profile, for `delorun status`.
 * @param runDirectory - the profile's run directory.
 * @returns the record, or `undefined` when no lock exists.
 * @throws {Error} when the file is not a lock record.
 */
export function readHomeLock(runDirectory: string): HomeLockRecord | undefined {
  return readLock(join(runDirectory, RUN_ENTRIES.lock))?.record
}

/**
 * Whether a process exists. A process of another user still exists (`EPERM`).
 * @param pid - the process id.
 * @returns false only when the operating system reports `ESRCH`.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Write a new record to a temporary sibling of the lock, created exclusively at mode 0600 and flushed.
 * @param path - the lock path.
 * @param record - the record.
 * @returns the temporary file's path.
 */
function writeCandidate(path: string, record: HomeLockRecord): string {
  const candidate = `${path}.new-${randomBytes(8).toString('hex')}`
  const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PROTECTED_FILE_MODE)
  try {
    writeSync(fd, JSON.stringify(record))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return candidate
}

/**
 * Remove a file, ignoring one that is already gone.
 * @param path - the file.
 */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Move a stale lock aside and remove it, when the lock at the path is still
 * the file found stale. A lock that another contender created in between is
 * linked back. When a third contender has taken the path in the moment between
 * the move and the link back, the link fails, and the contender whose lock was
 * moved keeps running without a lock file; this needs three starts of one
 * profile within the same few system calls after a holder died.
 * @param path - the lock path.
 * @param stale - the stale lock as it was read.
 */
function removeStale(path: string, stale: ReadLock): void {
  const aside = `${path}.stale-${randomBytes(8).toString('hex')}`
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const moved = lstatSync(aside)
  if (moved.ino !== stale.ino || moved.dev !== stale.dev) {
    try {
      linkSync(aside, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  unlinkSync(aside)
}

/**
 * Take the profile's home lock, replacing a stale one.
 * @param options - the run directory, the runtime version and the holder probe.
 * @returns the held lock.
 * @throws {HomeLayoutError} `HOME_RUNNING` when a live holder answers the probe, `HOME_UNRESPONSIVE` when it does not;
 *   both name the holder's process id, and neither takes the lock over.
 * @throws {Error} when the lock file is not a lock record, or contention does not settle.
 */
export async function acquireHomeLock(options: AcquireOptions): Promise<HomeLock> {
  const path = join(options.runDirectory, RUN_ENTRIES.lock)
  const record: HomeLockRecord = {
    v: 1,
    pid: process.pid,
    startId: brandString<StartId>(randomBytes(16).toString('hex')),
    runtime: options.runtime,
    startedAt: new Date().toISOString(),
  }
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const candidate = writeCandidate(path, record)
    let linked = false
    try {
      linkSync(candidate, path)
      linked = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      unlinkSync(candidate)
    }
    if (linked) return heldLock(path, record)
    const found = readLock(path)
    if (found === undefined) continue
    if (processExists(found.record.pid)) {
      const answer = await options.probe(found.record)
      const holder = `process ${String(found.record.pid)}, started ${found.record.startedAt}`
      if (answer === 'answered') throw new HomeLayoutError('HOME_RUNNING', path, `a home process for this profile is already running (${holder})`)
      throw new HomeLayoutError('HOME_UNRESPONSIVE', path, `${holder} holds ${path} but did not answer within 2 seconds; stop that process, or remove the file if it is not a delorun process`)
    }
    removeStale(path, found)
  }
  throw new Error(`could not take ${path}: other processes kept changing it`)
}

/**
 * The handle of a lock this process holds.
 * @param path - the lock path.
 * @param record - this holder's record.
 * @returns the handle.
 */
function heldLock(path: string, record: HomeLockRecord): HomeLock {
  let released = false
  return {
    path,
    record,
    release() {
      if (released) return
      released = true
      let current: ReadLock | undefined
      try {
        current = readLock(path)
      } catch {
        // Not a lock record any more: not this holder's, so it is left for its writer.
        return
      }
      if (current?.record.startId === record.startId) removeIfPresent(path)
    },
  }
}
