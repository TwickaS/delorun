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
import { approvedOf, readApproved, readChangeLog } from './records.ts'
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
