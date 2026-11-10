/**
 * The one rollback function of contract C3 ("Rollback"): the handshake's `rollback`, the automatic rollback after a
 * failed health check, the restart after an interrupted update and `delorun recover rollback` with no home process all
 * call {@link rollbackUpdate}, which reads the update record and applies C3's table. The caller owns only the way its
 * path switches the runtime pointers, which it passes in; nothing else swaps them.
 *
 * | Data differs | Target started | Copy | What happens |
 * | --- | --- | --- | --- |
 * | no | either | — | profile snapshot and runtime; chats written since stay |
 * | yes | no | either | the same; the target never opened the data |
 * | yes | yes | present | the live data is set aside, the copy put back, then the profile snapshot and the runtime |
 * | yes | yes | absent | refused with `ROLLBACK_NEEDS_DATA_COPY`; `--profile-only` restores the snapshot alone |
 *
 * @module @delo/update/rollback
 */
import { readCopyRecord, restoreDataCopy, type RestoreResult } from './data-copy.ts'
import { DataSafetyError } from './errors.ts'

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
}

/** Which row of C3's table applies. */
export type RollbackDecision =
  /** The data needs nothing: the profile snapshot and the runtime go back. */
  | 'plain'
  /** The copy goes back and the newer data is set aside, then the profile snapshot and the runtime. */
  | 'restore-copy'
  /** The data differs, the target started and no copy exists. */
  | 'refuse'
  /** The person asked for the profile snapshot alone; the runtime and the data stay. */
  | 'profile-only'

/**
 * C3's rollback table.
 * @param record - the update record's facts.
 * @param copy - whether a whole copy for the update's target exists.
 * @param profileOnly - whether the person asked for the profile snapshot alone.
 * @returns the row that applies.
 */
export function decideRollback(record: UpdateRecordFacts, copy: boolean, profileOnly: boolean): RollbackDecision {
  if (profileOnly) return 'profile-only'
  if (!record.dataDiffers || !record.targetStarted) return 'plain'
  return copy ? 'restore-copy' : 'refuse'
}

/** What {@link rollbackUpdate} needs. */
export interface RollbackRequest {
  /** The resolved Delo home, whose lock the caller holds with no Host running on the data. */
  readonly home: string
  /** The update record's facts. */
  readonly record: UpdateRecordFacts
  /** Restore only the profile snapshot and keep the running runtime. */
  readonly profileOnly: boolean
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
  /** The current time, which names a set-aside directory. */
  readonly now: Date
}

/** What a rollback did. */
export interface RollbackResult {
  /** The row of C3's table that applied. */
  readonly decision: Exclude<RollbackDecision, 'refuse'>
  /** The data restore, for `restore-copy`. */
  readonly restored?: RestoreResult
  /** What the person reads, one line each. */
  readonly lines: readonly string[]
}

/**
 * Go back from an update through C3's rollback table: refuse before anything changes when the table refuses,
 * otherwise put the copy back and set the newer data aside when the table says so, restore the profile snapshot and,
 * unless only the profile goes back, switch the runtime.
 * @param request - the home, the record, the person's choice and the caller's two steps.
 * @returns the row that applied, the data restore and the lines to print.
 * @throws {DataSafetyError} `ROLLBACK_NEEDS_DATA_COPY` when the table refuses; nothing has changed then.
 */
export async function rollbackUpdate(request: RollbackRequest): Promise<RollbackResult> {
  const { record } = request
  const copy = await readCopyRecord(request.home, record.to)
  const decision = decideRollback(record, copy !== undefined, request.profileOnly)
  if (decision === 'refuse') {
    throw new DataSafetyError('ROLLBACK_NEEDS_DATA_COPY', `Delo ${record.to} has opened the chat data and keeps it in a format Delo ${record.from} may not read, and no copy was taken before the update, so going back to ${record.from} could lose chats. Run delorun recover rollback --profile-only to restore the profile and keep Delo ${record.to}.`)
  }
  let restored: RestoreResult | undefined
  if (decision === 'restore-copy' && copy !== undefined) restored = await restoreDataCopy(request.home, copy, request.now)
  await request.restoreProfile()
  if (decision !== 'profile-only') await request.switchRuntime()
  const lines = decision === 'profile-only'
    ? [`Restored the profile from before the update to Delo ${record.to}; Delo ${record.to} keeps running.`]
    : [`Went back from Delo ${record.to} to Delo ${record.from} and restored the profile from before the update.`]
  if (restored !== undefined) {
    lines.push(`${String(restored.changedChats)} chat(s) created or changed since the update are set aside in ${restored.setAside}, not deleted; the chats from before the update are back.`)
  } else if (decision === 'plain') {
    lines.push('Chats written since the update stay as they are.')
  }
  return { decision, ...restored === undefined ? {} : { restored }, lines }
}
