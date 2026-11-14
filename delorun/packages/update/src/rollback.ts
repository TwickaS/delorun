/**
 * The one rollback function of contract C3 ("Rollback"): the handshake's `rollback`, the automatic rollback after a
 * failed health check, the restart after an interrupted update and `delorun recover rollback` with no home process all
 * call {@link rollbackUpdate}, which reads the update record and applies C3's table. The caller owns only the way its
 * path checks the version rolled back to, marks the record and switches the runtime pointers, which it passes in;
 * nothing else swaps them.
 *
 * | Data differs | Target started | Usable copy | What happens |
 * | --- | --- | --- | --- |
 * | no | either | — | profile snapshot and runtime; chats written since stay |
 * | yes | no | either | the same; the target never opened the data |
 * | yes | yes | yes | the live data is set aside, the copy put back, then the profile snapshot and the runtime |
 * | yes | yes | no | refused with `ROLLBACK_NEEDS_DATA_COPY`; `--profile-only` restores the snapshot alone |
 *
 * A copy is usable when the update record says one was taken, `data-copies/<to>/` holds a whole copy, and the copy was
 * taken no earlier than the update started; a copy from an earlier attempt at the same version is never restored.
 *
 * @module @delorun/update/rollback
 */
import { readCopyRecord, recoverDataCopies, restoreDataCopy, type CopyRecord, type RestoreResult } from './data-copy.ts'
import { DataSafetyError } from './errors.ts'

/** The update record's phase while a rollback that passed its checks runs. */
export const ROLLING_BACK_PHASE = 'rolling-back'

/** The update record's facts the table reads. */
export interface UpdateRecordFacts {
  /** The version the update started from, which a rollback returns to. */
  readonly from: string
  /** The version it moved to. */
  readonly to: string
  /** Whether the two releases' chat data differs. */
  readonly dataDiffers: boolean
  /** Whether the target's process was spawned. */
  readonly targetStarted: boolean
  /** Whether the update record says a session-data copy was taken. */
  readonly copy: boolean
  /** RFC 3339 time the update started. */
  readonly startedAt: string
  /** The record's phase; {@link ROLLING_BACK_PHASE} means a rollback already passed its checks and began. */
  readonly phase: string
}

/** Which row of C3's table applies. */
export type RollbackDecision =
  /** The data needs nothing: the profile snapshot and the runtime go back. */
  | 'plain'
  /** The copy goes back and the newer data is set aside, then the profile snapshot and the runtime. */
  | 'restore-copy'
  /** The data differs, the target started and no usable copy exists. */
  | 'refuse'
  /** The person asked for the profile snapshot alone; the runtime and the data stay. */
  | 'profile-only'

/**
 * C3's rollback table.
 * @param record - the update record's facts.
 * @param copyUsable - whether a usable copy for the update's target exists.
 * @param profileOnly - whether the person asked for the profile snapshot alone.
 * @returns the row that applies.
 */
export function decideRollback(record: UpdateRecordFacts, copyUsable: boolean, profileOnly: boolean): RollbackDecision {
  if (profileOnly) return 'profile-only'
  if (!record.dataDiffers || !record.targetStarted) return 'plain'
  return copyUsable ? 'restore-copy' : 'refuse'
}

/** What {@link rollbackUpdate} needs. */
export interface RollbackRequest {
  /** The resolved Delorun home, whose lock the caller holds with no Host running on the data. */
  readonly home: string
  /** The update record's facts. */
  readonly record: UpdateRecordFacts
  /** Restore only the profile snapshot and keep the running runtime. */
  readonly profileOnly: boolean
  /** The current time, which names a set-aside directory. */
  readonly now: Date
  /**
   * Check that the version rolled back to is installed and passes its start check; it changes nothing.
   * @returns when the check passed.
   * @throws {Error} when it did not; the error reaches the caller of {@link rollbackUpdate} unchanged.
   */
  readonly preflight: () => Promise<void>
  /**
   * Write the phase {@link ROLLING_BACK_PHASE} into the update record, durably.
   * @returns when the record is synced.
   */
  readonly markRollingBack: () => Promise<void>
  /**
   * Restore the profile snapshot the update took.
   * @returns when the profile is restored.
   */
  readonly restoreProfile: () => Promise<void>
  /**
   * Switch the runtime pointers back, in the way the caller's path does it.
   * @returns when the pointers name the version rolled back to.
   */
  readonly switchRuntime: () => Promise<void>
}

/** What a rollback did. */
export interface RollbackResult {
  /** The row of C3's table that applied. */
  readonly decision: Exclude<RollbackDecision, 'refuse'>
  /** The data restore this call ran, for `restore-copy`. */
  readonly restored?: RestoreResult
  /** What the person reads, one line each. */
  readonly lines: readonly string[]
}

/**
 * The update's copy when it is usable: the record says a copy was taken, a whole copy for the target exists, and it
 * was taken no earlier than the update started.
 * @param home - the resolved Delorun home.
 * @param record - the update record's facts.
 * @returns the copy's record, or `undefined`.
 */
async function usableCopy(home: string, record: UpdateRecordFacts): Promise<CopyRecord | undefined> {
  if (!record.copy) return undefined
  const copy = await readCopyRecord(home, record.to)
  return copy !== undefined && Date.parse(copy.created) >= Date.parse(record.startedAt) ? copy : undefined
}

/**
 * Go back from an update through C3's rollback table. With `profileOnly` only the profile snapshot is restored.
 * Otherwise, when the table refuses, nothing runs; else the caller's preflight runs before anything changes, the record
 * is marked {@link ROLLING_BACK_PHASE}, then the copy is put back when the table says so, the profile snapshot is
 * restored and the runtime switched. A record already marked {@link ROLLING_BACK_PHASE} completes that rollback: it is
 * never refused, a restore a kill interrupted is completed, the copy is put back only while a usable one remains, and
 * the profile and runtime steps run again.
 * @param request - the home, the record, the person's choice, the time and the caller's four steps.
 * @returns the row that applied, the data restore this call ran and the lines to print.
 * @throws {DataSafetyError} `ROLLBACK_NEEDS_DATA_COPY` when the table refuses; nothing has changed then.
 * @throws {Error} whatever `preflight` throws, unchanged; nothing has changed then.
 */
export async function rollbackUpdate(request: RollbackRequest): Promise<RollbackResult> {
  const { home, record } = request
  if (request.profileOnly) {
    await request.restoreProfile()
    return { decision: 'profile-only', lines: [`Restored the profile from before the update to Delorun ${record.to}; Delorun ${record.to} keeps running.`] }
  }
  const resuming = record.phase === ROLLING_BACK_PHASE
  if (resuming) {
    await request.preflight()
    await recoverDataCopies(home)
  }
  const copy = await usableCopy(home, record)
  const row = decideRollback(record, copy !== undefined, false)
  if (row === 'refuse' && !resuming) {
    throw new DataSafetyError('ROLLBACK_NEEDS_DATA_COPY', `Delorun ${record.to} has opened the chat data and keeps it in a format Delorun ${record.from} may not read, and no copy was taken before this update, so going back to ${record.from} could lose chats. Run delorun recover rollback --profile-only to restore the profile and keep Delorun ${record.to}.`)
  }
  if (!resuming) {
    await request.preflight()
    await request.markRollingBack()
  }
  // A resumed rollback whose row now refuses had a usable copy when it was marked, and its restore consumed it.
  const decision = row === 'refuse' ? 'restore-copy' : row
  const restored = copy !== undefined && row === 'restore-copy' ? await restoreDataCopy(home, copy, request.now) : undefined
  await request.restoreProfile()
  await request.switchRuntime()
  const lines = [`Went back from Delorun ${record.to} to Delorun ${record.from} and restored the profile from before the update.`]
  if (restored !== undefined) {
    lines.push(`${String(restored.changedChats)} chat(s) created or changed since the update are set aside in ${restored.setAside}, not deleted; the chats from before the update are back.`)
  } else if (decision === 'restore-copy') {
    lines.push('The chats from before the update were put back when this rollback began; the newer chats are set aside under data-set-aside/, not deleted.')
  } else {
    lines.push('Chats written since the update stay as they are.')
  }
  return { decision, ...restored === undefined ? {} : { restored }, lines }
}
