/**
 * `runtimes/store.lock` (contract C1, "The runtime store"): taken by install, switch, rollback and removal, waited for
 * at most 30 seconds before `STORE_BUSY`. The lock file holds `{"v":1,"pid":<integer>,"id":"<32 hex>"}` at mode
 * 0600, written to a temporary file and hard-linked to its path, so it appears whole or not at all and exactly one
 * contender's link succeeds.
 *
 * A lock whose process no longer exists (`ESRCH`) is stale. It is removed under a takeover guard
 * `store.lock.takeover-<id>`, named after the stale record's random id and created the same way, so one contender at
 * a time may remove that one record; holding the guard, the contender removes the lock only while it still holds
 * that id. A guard left by a contender that died is removed the same way, under a guard named after its own id. This
 * is the algorithm of `@delo/home`'s home lock, applied to the store's record.
 *
 * @module @delo/runtime-store/lock
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { processExists } from '@delo/home'
import { RuntimeStoreError } from './errors.ts'

/** Nested takeovers of guards left by dead contenders before giving up; each level needs a contender to have died mid-removal. */
const MAX_TAKEOVER_DEPTH = 8

/** The largest record read; a valid one is far smaller. */
const MAX_RECORD_BYTES = 1024

const RANDOM_ID = /^[0-9a-f]{32}$/u

/** The record of the lock and of each takeover guard. */
interface LockRecord {
  /** Record version. */
  readonly v: 1
  /** The holder's process id. */
  readonly pid: number
  /** A random id, never reused, naming the guard that may remove this record. */
  readonly id: string
}

/** A held `store.lock`. */
export interface StoreLock {
  /**
   * Remove the lock while it still holds this holder's record; a second call does nothing.
   */
  release(): void
}

function newRecord(): LockRecord {
  return { v: 1, pid: process.pid, id: randomBytes(16).toString('hex') }
}

/**
 * Read a lock or guard record without following a symbolic link.
 * @param path - the file.
 * @returns the record, or `undefined` when the file does not exist.
 * @throws {Error} naming the path when the file is not a record of this module.
 */
function readRecord(path: string): LockRecord | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let text: string
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) throw new Error(`${path} is not a store lock record; remove it once no delorun process changes the runtime store`)
    text = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON; reported below as not a record.
    value = undefined
  }
  const record = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof LockRecord, unknown>>
  if (record.v !== 1 || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.id !== 'string' || !RANDOM_ID.test(record.id)) {
    throw new Error(`${path} is not a store lock record; remove it once no delorun process changes the runtime store`)
  }
  return { v: 1, pid: record.pid, id: record.id }
}

/**
 * Create a file with its whole record at mode 0600 unless the path exists.
 * @param path - the file.
 * @param record - its record.
 * @returns true when this call created it.
 */
function createWhole(path: string, record: LockRecord): boolean {
  const candidate = `${path}.new-${randomBytes(8).toString('hex')}`
  const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PROTECTED_FILE_MODE)
  try {
    writeSync(fd, JSON.stringify(record))
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
 * Remove a lock or guard record whose process was found dead, under the takeover guard named after its id.
 * @param lockPath - `store.lock`, which names every guard.
 * @param path - the file found dead.
 * @param id - its record's id.
 * @param depth - how many guards of dead contenders this removal is nested in.
 * @returns `done` when that record is gone, `busy` when a live contender holds its guard.
 * @throws {Error} after {@link MAX_TAKEOVER_DEPTH} nested abandoned guards, naming the files to remove.
 */
async function removeDead(lockPath: string, path: string, id: string, depth: number): Promise<'done' | 'busy'> {
  if (depth > MAX_TAKEOVER_DEPTH) throw new Error(`could not take ${lockPath}: ${String(depth)} nested takeovers were abandoned by processes that died; remove ${lockPath}.takeover-* once no delorun process changes the runtime store`)
  const guardPath = `${lockPath}.takeover-${id}`
  for (;;) {
    if (createWhole(guardPath, newRecord())) {
      try {
        if (readRecord(path)?.id === id) unlinkSync(path)
      } finally {
        unlinkSync(guardPath)
      }
      return 'done'
    }
    const holder = readRecord(guardPath)
    if (holder === undefined) continue
    if (processExists(holder.pid)) return 'busy'
    if (await removeDead(lockPath, guardPath, holder.id, depth + 1) === 'busy') return 'busy'
  }
}

/**
 * Take `store.lock`, waiting while a live process holds it and replacing a lock whose process no longer exists.
 * @param path - the lock's path.
 * @param waitMs - how long to wait for a live holder: C1's 30 seconds.
 * @returns the held lock.
 * @throws {RuntimeStoreError} `STORE_BUSY` naming the holder's process id when the lock is not free in time.
 * @throws {Error} when the lock or a guard is not a record of this module.
 */
export async function acquireStoreLock(path: string, waitMs: number): Promise<StoreLock> {
  const record = newRecord()
  const deadline = Date.now() + waitMs
  for (;;) {
    if (createWhole(path, record)) return heldLock(path, record)
    const found = readRecord(path)
    if (found === undefined) continue
    if (!processExists(found.pid) && await removeDead(path, path, found.id, 0) === 'done') continue
    if (Date.now() >= deadline) throw new RuntimeStoreError('STORE_BUSY', path, `process ${String(found.pid)} has held ${path} for longer than ${String(waitMs / 1000)} seconds; try again once it finishes`)
    await sleep(Math.min(20 + Math.floor(Math.random() * 60), Math.max(1, deadline - Date.now())))
  }
}

/**
 * The handle of a lock this process holds.
 * @param path - the lock's path.
 * @param record - this holder's record.
 * @returns the handle.
 */
function heldLock(path: string, record: LockRecord): StoreLock {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      let found: LockRecord | undefined
      try {
        found = readRecord(path)
      } catch {
        // Not a record of this module: not this holder's lock, so it is left for whoever wrote it.
        return
      }
      if (found?.id !== record.id) return
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

/**
 * Run work while holding `store.lock`.
 * @param path - the lock's path.
 * @param waitMs - how long to wait for a live holder.
 * @param work - the work.
 * @returns the work's result.
 */
export async function withStoreLock<T>(path: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  const lock = await acquireStoreLock(path, waitMs)
  try {
    return await work()
  } finally {
    lock.release()
  }
}
