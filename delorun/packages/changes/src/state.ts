/**
 * What the studio's `state` route reads of the changes waiting for review: only the records, so a read that any
 * admitted session repeats, the studio every 15 seconds, writes nothing, stores no content and reads no plugin's folder.
 * Whether an approved plugin's folder holds edits is known only once its folder is read, which `listChanges` does for
 * the studio's `show?pending` and `delorun changes list`.
 *
 * @module @delorun/changes/state
 */
import type { ChangesContext } from './actions.ts'
import { managedPlugins } from './boot-record.ts'
import { isPluginRequest } from './install-actions.ts'
import { approvedOf, readApproved, readChangeLog, readChangeLogWithAgent, readHarnessLog } from './records.ts'
import type { ChangeEntry } from './types.ts'

/** One plugin under Changes, as its records name it. */
export interface RecordedFolder {
  readonly plugin: string
  /** The folder it is linked from. */
  readonly source: string
  /**
   * `plugin-install` while nothing of it is approved, so its folder waits for review as a whole; `plugin-edit` for an
   * approved plugin, whose folder may or may not hold edits.
   */
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** The changes waiting for review as the records name them. */
export interface RecordedChanges {
  /** Every plugin under Changes with its folder, by name in code-unit order. */
  readonly folders: readonly RecordedFolder[]
  /** The agent's plugin requests that wait for review, in log order. */
  readonly requests: readonly ChangeEntry[]
}

/**
 * The plugins under Changes and the agent's plugin requests that wait for review, from the profile's approved record
 * and change log alone. Nothing is written and no folder is read.
 * @param ctx - the home, the profile and its directory.
 * @returns what the records name.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the profile's `package.json` or the change log is not one Delorun wrote.
 */
export async function recordedChanges(ctx: Pick<ChangesContext, 'home' | 'profile' | 'profileDir'>): Promise<RecordedChanges> {
  const approved = await readApproved(ctx.profileDir)
  const log = await readChangeLog(ctx.home, ctx.profile)
  return {
    folders: managedPlugins(approved, log).map(({ plugin, source }) => ({ plugin, source, kind: approvedOf(approved, plugin) === undefined ? 'plugin-install' : 'plugin-edit' })),
    requests: log.entries.filter(entry => entry.state === 'pending' && isPluginRequest(entry)),
  }
}

/**
 * How many changes loaded without review since protection was last turned off: the entries of the profile's log and
 * of the log of changes to Delorun itself decided `unreviewed` at or after the newest applied `guard-weakening` entry of
 * the protection setting. Reads the records only.
 * @param ctx - the profile.
 * @returns the count; 0 when protection was never turned off.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a log is not one Delorun wrote.
 */
export async function unreviewedSinceOff(ctx: Pick<ChangesContext, 'home' | 'profile'>): Promise<number> {
  return countUnreviewedSinceOff((await readChangeLogWithAgent(ctx.home, ctx.profile)).entries, (await readHarnessLog(ctx.home)).entries)
}

/**
 * {@link unreviewedSinceOff} over logs already read.
 * @param profile - the entries of the profile's log.
 * @param harness - the entries of the log of changes to Delorun itself.
 * @returns the count; 0 when protection was never turned off.
 */
export function countUnreviewedSinceOff(profile: readonly ChangeEntry[], harness: readonly ChangeEntry[]): number {
  const off = profile.findLast(entry => entry.kind === 'guard-weakening' && entry.state === 'applied' && entry.subject.setting === 'protection')
  if (off === undefined) return 0
  const since = Date.parse(off.decidedAt ?? off.createdAt)
  const loaded = (entry: ChangeEntry): boolean => entry.decidedFrom === 'unreviewed' && Date.parse(entry.decidedAt ?? entry.createdAt) >= since
  return profile.filter(loaded).length + harness.filter(loaded).length
}
