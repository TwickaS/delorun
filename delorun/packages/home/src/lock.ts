/**
 * The home lock `run/<profile>/home.lock` (contract C1, "The home lock"): one holder per CLI profile, a JSON record
 * created by exclusive creation at mode 0600, a lock whose holder is dead replaced, and a live holder never taken
 * over. A holder is dead when its process no longer exists or another process has taken its process id, and a holder
 * recorded in another pid namespace is never dead ([holder](./holder.ts)). Creation, takeover guards and removal are the shared lock file's ([lock file](./lock-file.ts)),
 * with the record's random `startId` naming its takeover guard `home.lock.takeover-<startId>`.
 *
 * @module @delorun/home/lock
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RUN_ENTRIES, type HomeLockRecord, type RuntimeVersion, type StartId } from '@delorun/contract-home-layout'
import { HomeLayoutError } from './errors.ts'
import { currentHolder, holderAlive, holderIdentity, holderOf, parseHolder, type ProcessHolder } from './holder.ts'
import { isLockId, LockFile, randomLockId } from './lock-file.ts'

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
  /**
   * Hand the lock to a successor home process (contract C19, "The update
   * handshake"): the record is replaced atomically with the successor's, with
   * the successor's start identity read now, while the file still holds this
   * holder's record, and this handle's {@link release} does nothing afterwards.
   * @param successor - the successor's process id, start id and runtime.
   * @returns the successor's record.
   * @throws {Error} when the file no longer holds this holder's record; the lock is then left as it is.
   */
  handOver(successor: Pick<HomeLockRecord, 'pid' | 'startId' | 'runtime'>): HomeLockRecord
}

/** What {@link acquireHomeLock} needs. */
export interface AcquireOptions {
  /** The profile's run directory, `run/<profile>/`, which must exist. */
  readonly runDirectory: string
  /** The runtime version the holder runs. */
  readonly runtime: RuntimeVersion
  /** Asks a live holder for its status; decides between `HOME_RUNNING` and `HOME_UNRESPONSIVE`. */
  readonly probe: HolderProbe
  /** The start id the record carries, from {@link newStartId}; the holder logs under it from before it takes the lock. */
  readonly startId: StartId
}

/**
 * How long a contender keeps waiting while another contender removes a stale
 * lock, in milliseconds. A removal takes a few system calls; the wait bounds a
 * contender only when that other contender's process hangs mid-removal.
 */
const TAKEOVER_WAIT_MS = 10_000

/**
 * A new start id (contract C1, "The home lock"): random, never reused, not a secret.
 * @returns the start id.
 */
export function newStartId(): StartId {
  return brandString<StartId>(randomLockId())
}

/**
 * Parse a lock record.
 * @param record - the lock file's JSON object.
 * @returns the record, or `undefined` when the object is not one.
 */
function parseRecord(record: Readonly<Record<string, unknown>>): HomeLockRecord | undefined {
  const holder = parseHolder(record)
  if (holder === undefined || record.v !== 1 || !isLockId(record.startId)) return undefined
  if (typeof record.runtime !== 'string' || typeof record.startedAt !== 'string') return undefined
  return {
    v: 1,
    pid: holder.pid,
    startId: brandString<StartId>(record.startId),
    runtime: brandString<RuntimeVersion>(record.runtime),
    startedAt: record.startedAt,
    ...holderIdentity(holder),
  }
}

/**
 * The home lock file of a run directory.
 * @param runDirectory - the profile's run directory.
 * @returns the lock file.
 */
function homeLockFile(runDirectory: string): LockFile<HomeLockRecord> {
  return new LockFile(join(runDirectory, RUN_ENTRIES.lock), {
    label: 'home lock',
    remedy: 'once no delorun process runs for this profile',
    parse: parseRecord,
    id: record => record.startId,
  })
}

/**
 * A lock record, its fields in C1's order.
 * @param holder - the holder's process id, start identity and pid namespace.
 * @param startId - its start id.
 * @param runtime - the runtime it runs.
 * @returns the record, taken now.
 */
function lockRecord(holder: ProcessHolder, startId: StartId, runtime: RuntimeVersion): HomeLockRecord {
  return {
    v: 1,
    pid: holder.pid,
    startId,
    runtime,
    startedAt: new Date().toISOString(),
    ...holderIdentity(holder),
  }
}

/**
 * Read the home lock of a profile, for `delorun status`.
 * @param runDirectory - the profile's run directory.
 * @returns the record, or `undefined` when no lock exists.
 * @throws {Error} when the file is not a lock record.
 */
export function readHomeLock(runDirectory: string): HomeLockRecord | undefined {
  return homeLockFile(runDirectory).read()
}

/**
 * Remove the profile's lock when it still holds the record with this start id
 * and that record's holder is dead, under the record's takeover guard. A
 * contender that found the record stale calls this however late it runs: a
 * lock created since, by any process, is left as it is.
 * @param runDirectory - the profile's run directory.
 * @param startId - the start id of the record found stale.
 * @returns `done` when that record is gone, `busy` when a live contender is removing it.
 * @throws {Error} when the lock or a takeover guard is not a record of this module.
 */
export async function removeStaleLock(runDirectory: string, startId: StartId): Promise<'done' | 'busy'> {
  return homeLockFile(runDirectory).removeDead(startId)
}

/**
 * Take the profile's home lock, replacing one whose holder is dead.
 * @param options - the run directory, the runtime version, the holder probe and the start id.
 * @returns the held lock.
 * @throws {HomeLayoutError} `HOME_RUNNING` when a live holder answers the probe, `HOME_UNRESPONSIVE` when it does not;
 *   both name the holder's process id, and neither takes the lock over.
 * @throws {Error} when the lock or a takeover guard is not a record of this module, or another contender's removal of
 *   a stale lock does not finish within {@link TAKEOVER_WAIT_MS}.
 */
export async function acquireHomeLock(options: AcquireOptions): Promise<HomeLock> {
  const file = homeLockFile(options.runDirectory)
  const record = lockRecord(currentHolder(), options.startId, options.runtime)
  const deadline = Date.now() + TAKEOVER_WAIT_MS
  for (;;) {
    if (file.create(record)) return heldLock(file, record)
    const found = file.read()
    if (found === undefined) continue
    if (holderAlive(found)) {
      const answer = await options.probe(found)
      const holder = `process ${String(found.pid)}, started ${found.startedAt}`
      if (answer === 'answered') throw new HomeLayoutError('HOME_RUNNING', file.path, `a home process for this profile is already running (${holder})`)
      throw new HomeLayoutError('HOME_UNRESPONSIVE', file.path, `${holder} holds ${file.path} but did not answer within 2 seconds; stop that process, or remove the file if it is not a delorun process`)
    }
    if (await file.removeDead(found.startId) === 'done') continue
    if (Date.now() > deadline) throw new Error(`could not take ${file.path}: another process kept replacing the stale lock for ${String(TAKEOVER_WAIT_MS / 1000)} seconds`)
    await sleep(5 + Math.floor(Math.random() * 20))
  }
}

/**
 * Take over the lock a predecessor handed to this process with
 * {@link HomeLock.handOver}.
 * @param runDirectory - the profile's run directory.
 * @param startId - the start id the predecessor assigned to this process.
 * @returns the held lock.
 * @throws {Error} when the lock does not hold that start id with this process's id.
 */
export function adoptHomeLock(runDirectory: string, startId: StartId): HomeLock {
  const file = homeLockFile(runDirectory)
  const record = file.read()
  if (record?.startId !== startId || record.pid !== process.pid) throw new Error(`${file.path} was not handed to this process (start ${startId})`)
  return heldLock(file, record)
}

/**
 * The handle of a lock this process holds.
 * @param file - the lock file.
 * @param record - this holder's record.
 * @returns the handle.
 */
function heldLock(file: LockFile<HomeLockRecord>, record: HomeLockRecord): HomeLock {
  let released = false
  return {
    path: file.path,
    record,
    handOver(successor) {
      if (released || file.read()?.startId !== record.startId) throw new Error(`${file.path} no longer holds this home process's record; it was not handed over`)
      const next = lockRecord(holderOf(successor.pid), successor.startId, successor.runtime)
      file.replace(next)
      released = true
      return next
    },
    release() {
      if (released) return
      released = true
      file.release(record.startId)
    },
  }
}
