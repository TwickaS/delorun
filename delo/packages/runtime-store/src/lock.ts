/**
 * `runtimes/store.lock` (contract C1, "The runtime store"): taken by install, switch, rollback and removal, waited for
 * at most 30 seconds before `STORE_BUSY`. The lock file holds `{"v":1,"pid":<integer>,"id":"<32 hex>"}` at mode
 * 0600, with the holder's `processStart` and `pidNamespace` where the platform reports them; a record without them is read too. It is
 * `@delo/home`'s lock file: created whole by a hard link, and a record whose holder is dead (its process no longer
 * exists, or another process has taken its process id) removed under a takeover guard `store.lock.takeover-<id>`.
 *
 * @module @delo/runtime-store/lock
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { currentHolder, holderAlive, holderIdentity, isLockId, LockFile, parseHolder, randomLockId, type ProcessHolder } from '@delo/home'
import { RuntimeStoreError } from './errors.ts'

/** The lock's record. */
interface LockRecord extends ProcessHolder {
  /** Record version. */
  readonly v: 1
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

/**
 * Parse a lock record.
 * @param record - the lock file's JSON object.
 * @returns the record, or `undefined` when the object is not one.
 */
function parseRecord(record: Readonly<Record<string, unknown>>): LockRecord | undefined {
  const holder = parseHolder(record)
  if (holder === undefined || record.v !== 1 || !isLockId(record.id)) return undefined
  return { v: 1, pid: holder.pid, id: record.id, ...holderIdentity(holder) }
}

/**
 * The store lock file at a path.
 * @param path - the lock's path.
 * @returns the lock file.
 */
function storeLockFile(path: string): LockFile<LockRecord> {
  return new LockFile(path, { label: 'store lock', remedy: 'once no delorun process changes the runtime store', parse: parseRecord, id: record => record.id })
}

/**
 * Take `store.lock`, waiting while a live process holds it and replacing a lock whose holder is dead.
 * @param path - the lock's path.
 * @param waitMs - how long to wait for a live holder: C1's 30 seconds.
 * @returns the held lock.
 * @throws {RuntimeStoreError} `STORE_BUSY` naming the holder's process id when the lock is not free in time.
 * @throws {Error} when the lock or a guard is not a record of this module.
 */
export async function acquireStoreLock(path: string, waitMs: number): Promise<StoreLock> {
  const file = storeLockFile(path)
  const holder = currentHolder()
  const record: LockRecord = { v: 1, pid: holder.pid, id: randomLockId(), ...holderIdentity(holder) }
  const deadline = Date.now() + waitMs
  for (;;) {
    if (file.create(record)) return heldLock(file, record)
    const found = file.read()
    if (found === undefined) continue
    if (!holderAlive(found) && await file.removeDead(found.id) === 'done') continue
    if (Date.now() >= deadline) throw new RuntimeStoreError('STORE_BUSY', path, `process ${String(found.pid)} has held ${path} for longer than ${String(waitMs / 1000)} seconds; try again once it finishes`)
    await sleep(Math.min(20 + Math.floor(Math.random() * 60), Math.max(1, deadline - Date.now())))
  }
}

/**
 * The handle of a lock this process holds.
 * @param file - the lock file.
 * @param record - this holder's record.
 * @returns the handle.
 */
function heldLock(file: LockFile<LockRecord>, record: LockRecord): StoreLock {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      file.release(record.id)
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
