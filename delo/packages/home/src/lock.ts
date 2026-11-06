/**
 * The home lock `run/<profile>/home.lock` (contract C1, "The home lock"): one
 * holder per CLI profile, a JSON record created by exclusive creation at mode
 * 0600, a stale lock replaced only when its process no longer exists, and a
 * live holder never taken over.
 *
 * Every file this module creates is written to a temporary file and
 * hard-linked to its path, so it appears with its whole record or not at all,
 * and of any number of contenders exactly one link succeeds.
 *
 * A stale lock is removed under a takeover guard, `home.lock.takeover-<id>`,
 * named after the stale record's random `startId` and created the same way, so
 * one contender at a time may remove that one record. Holding the guard, it
 * removes the lock only when the file still holds that `startId`. A `startId`
 * is never reused, and only the guard holder may remove that record, so a
 * contender never removes a lock other than the stale one it found, however
 * late it runs. A guard left by a contender that died is itself removed under a
 * guard named after its own random id.
 *
 * @module @delo/home/lock
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
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

/**
 * How long a contender keeps waiting while another contender removes a stale
 * lock, in milliseconds. A removal takes a few system calls; the wait bounds a
 * contender only when that other contender's process hangs mid-removal.
 */
const TAKEOVER_WAIT_MS = 10_000

/** Nested takeovers of guards left by dead contenders before giving up; each level needs another contender to have died mid-removal. */
const MAX_TAKEOVER_DEPTH = 8

/** The largest lock or guard record read; a valid record is far smaller. */
const MAX_RECORD_BYTES = 4096

const RANDOM_ID = /^[0-9a-f]{32}$/

/**
 * A new random identifier: 16 bytes as 32 lowercase hexadecimal digits.
 * @returns the identifier.
 */
function randomId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Parse JSON text, or `undefined` when it is not JSON.
 * @param text - the text.
 * @returns the value.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON: the caller reports the file as not a record.
    return undefined
  }
}

/**
 * Parse a lock record, or `undefined` when the bytes are not one.
 * @param text - the lock file's contents.
 * @returns the record.
 */
function parseRecord(text: string): HomeLockRecord | undefined {
  const value = parseJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.v !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined
  if (typeof record.startId !== 'string' || !RANDOM_ID.test(record.startId)) return undefined
  if (typeof record.runtime !== 'string' || typeof record.startedAt !== 'string') return undefined
  return {
    v: 1,
    pid: record.pid as number,
    startId: brandString<StartId>(record.startId),
    runtime: brandString<RuntimeVersion>(record.runtime),
    startedAt: record.startedAt,
  }
}

/** The contents of a takeover guard. */
interface GuardRecord {
  /** The guard holder's process id. */
  readonly pid: number
  /** The guard's own random id, which names the guard that removes it. */
  readonly id: string
}

/**
 * Parse a guard record, or `undefined` when the bytes are not one.
 * @param text - the guard file's contents.
 * @returns the record.
 */
function parseGuard(text: string): GuardRecord | undefined {
  const value = parseJson(text)
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.id !== 'string' || !RANDOM_ID.test(record.id)) return undefined
  return { pid: record.pid as number, id: record.id }
}

/**
 * Read a small record file without following a symbolic link.
 * @param path - the file.
 * @returns its text, or `undefined` when it does not exist.
 * @throws {Error} naming the path when it is not a regular file of at most {@link MAX_RECORD_BYTES} bytes.
 */
function readSmallFile(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) throw new Error(`${path} is not a home lock file; remove it once no delorun process runs for this profile`)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the lock at a path.
 * @param path - the lock file.
 * @returns the record, or `undefined` when no lock exists.
 * @throws {Error} when the file is not a lock record; it names the path.
 */
function readLock(path: string): HomeLockRecord | undefined {
  const text = readSmallFile(path)
  if (text === undefined) return undefined
  const record = parseRecord(text)
  if (record === undefined) throw new Error(`${path} is not a home lock record; remove it once no delorun process runs for this profile`)
  return record
}

/**
 * Read a takeover guard.
 * @param path - the guard file.
 * @returns the record, or `undefined` when no guard exists.
 * @throws {Error} when the file is not a guard record; it names the path.
 */
function readGuard(path: string): GuardRecord | undefined {
  const text = readSmallFile(path)
  if (text === undefined) return undefined
  const record = parseGuard(text)
  if (record === undefined) throw new Error(`${path} is not a home lock takeover guard; remove it once no delorun process runs for this profile`)
  return record
}

/**
 * The random id a lock or guard file holds now: a lock's `startId` or a guard's `id`.
 * @param path - the file.
 * @param kind - which record the file holds.
 * @returns the id, or `undefined` when the file does not exist.
 */
function currentId(path: string, kind: 'lock' | 'guard'): string | undefined {
  return kind === 'lock' ? readLock(path)?.startId : readGuard(path)?.id
}

/**
 * Create a file with its whole contents at mode 0600, unless the path exists:
 * the text goes to a temporary sibling created exclusively and flushed, which
 * is hard-linked to the path and then removed.
 * @param path - the file to create.
 * @param text - its contents.
 * @returns true when this call created the file, false when the path existed.
 */
function createWhole(path: string, text: string): boolean {
  const candidate = `${path}.new-${randomBytes(8).toString('hex')}`
  const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PROTECTED_FILE_MODE)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(candidate, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(candidate)
  }
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
 * Remove a lock or guard whose process was found dead, under the takeover
 * guard named after its id. The file is removed only when it still holds that
 * id, so a file another contender has meanwhile created is never touched.
 * @param lockPath - the home lock's path, which names every guard.
 * @param path - the file found dead: the lock or a guard.
 * @param kind - which record it holds.
 * @param id - the dead record's random id.
 * @param depth - how many guards of dead contenders this removal is nested in.
 * @returns `done` when the dead record is gone, by this call or another;
 *   `busy` when a live contender holds its guard.
 */
async function removeDead(lockPath: string, path: string, kind: 'lock' | 'guard', id: string, depth: number): Promise<'done' | 'busy'> {
  if (depth > MAX_TAKEOVER_DEPTH) throw new Error(`could not take ${lockPath}: ${String(depth)} nested takeovers were abandoned by processes that died; remove ${lockPath}.takeover-* once no delorun process runs for this profile`)
  const guardPath = `${lockPath}.takeover-${id}`
  const guard: GuardRecord = { pid: process.pid, id: randomId() }
  for (;;) {
    if (createWhole(guardPath, JSON.stringify(guard))) {
      try {
        if (currentId(path, kind) === id) unlinkSync(path)
      } finally {
        unlinkSync(guardPath)
      }
      return 'done'
    }
    const holder = readGuard(guardPath)
    if (holder === undefined) continue
    if (processExists(holder.pid)) return 'busy'
    if (await removeDead(lockPath, guardPath, 'guard', holder.id, depth + 1) === 'busy') return 'busy'
  }
}

/**
 * Read the home lock of a profile, for `delorun status`.
 * @param runDirectory - the profile's run directory.
 * @returns the record, or `undefined` when no lock exists.
 * @throws {Error} when the file is not a lock record.
 */
export function readHomeLock(runDirectory: string): HomeLockRecord | undefined {
  return readLock(join(runDirectory, RUN_ENTRIES.lock))
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
 * Remove the profile's lock when it still holds the record with this start id
 * and that record's process no longer exists, under the record's takeover
 * guard. A contender that found the record stale calls this however late it
 * runs: a lock created since, by any process, is left as it is.
 * @param runDirectory - the profile's run directory.
 * @param startId - the start id of the record found stale.
 * @returns `done` when that record is gone, `busy` when a live contender is removing it.
 * @throws {Error} when the lock or a takeover guard is not a record of this module.
 */
export async function removeStaleLock(runDirectory: string, startId: StartId): Promise<'done' | 'busy'> {
  const path = join(runDirectory, RUN_ENTRIES.lock)
  const found = readLock(path)
  if (found?.startId !== startId || processExists(found.pid)) return 'done'
  return removeDead(path, path, 'lock', startId, 0)
}

/**
 * Take the profile's home lock, replacing a stale one.
 * @param options - the run directory, the runtime version and the holder probe.
 * @returns the held lock.
 * @throws {HomeLayoutError} `HOME_RUNNING` when a live holder answers the probe, `HOME_UNRESPONSIVE` when it does not;
 *   both name the holder's process id, and neither takes the lock over.
 * @throws {Error} when the lock or a takeover guard is not a record of this module, or another contender's removal of
 *   a stale lock does not finish within {@link TAKEOVER_WAIT_MS}.
 */
export async function acquireHomeLock(options: AcquireOptions): Promise<HomeLock> {
  const path = join(options.runDirectory, RUN_ENTRIES.lock)
  const record: HomeLockRecord = {
    v: 1,
    pid: process.pid,
    startId: brandString<StartId>(randomId()),
    runtime: options.runtime,
    startedAt: new Date().toISOString(),
  }
  const deadline = Date.now() + TAKEOVER_WAIT_MS
  for (;;) {
    if (createWhole(path, JSON.stringify(record))) return heldLock(path, record)
    const found = readLock(path)
    if (found === undefined) continue
    if (processExists(found.pid)) {
      const answer = await options.probe(found)
      const holder = `process ${String(found.pid)}, started ${found.startedAt}`
      if (answer === 'answered') throw new HomeLayoutError('HOME_RUNNING', path, `a home process for this profile is already running (${holder})`)
      throw new HomeLayoutError('HOME_UNRESPONSIVE', path, `${holder} holds ${path} but did not answer within 2 seconds; stop that process, or remove the file if it is not a delorun process`)
    }
    if (await removeStaleLock(options.runDirectory, found.startId) === 'done') continue
    if (Date.now() > deadline) throw new Error(`could not take ${path}: another process kept replacing the stale lock for ${String(TAKEOVER_WAIT_MS / 1000)} seconds`)
    await sleep(5 + Math.floor(Math.random() * 20))
  }
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
      let current: HomeLockRecord | undefined
      try {
        current = readLock(path)
      } catch {
        // Not a lock record any more: not this holder's, so it is left for its writer.
        return
      }
      if (current?.startId === record.startId) removeIfPresent(path)
    },
  }
}
