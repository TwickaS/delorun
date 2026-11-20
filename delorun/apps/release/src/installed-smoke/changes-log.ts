/**
 * The change-log check of the installed-release smoke's update step: after an update, the successor's first boot must
 * have replaced each installed pack's approved content with the release's own files ("Replaced by the update"), so no
 * change to a pack waits for a person's review.
 *
 * @module @delorun/release/installed-smoke/changes-log
 */

/** What the check reads of one change-log entry. */
interface LogEntry {
  readonly state?: unknown
  readonly decidedFrom?: unknown
  readonly subject?: { readonly plugin?: unknown }
}

/**
 * The problems of a profile's change log after an update.
 * @param text - the text of `changes/profiles/<profile>/log.json`.
 * @param plugins - the package names of the packs installed before the update.
 * @param changed - the packs whose signed files differ between the previous release and the new one
 *   (`packsChangedBetween`). The update applies a change only to those packs; a pack with equal files has nothing to replace.
 * @returns one line per pack that has a change waiting; that is in `changed` and has no applied entry decided by the
 *   update; or is not in `changed` and has one. Empty when the log is as the release pair requires.
 */
export function updateChangeProblems(text: string, plugins: readonly string[], changed: ReadonlySet<string>): string[] {
  const entries = ((JSON.parse(text) as { entries?: readonly LogEntry[] }).entries ?? [])
  const problems: string[] = []
  for (const plugin of plugins) {
    const own = entries.filter(entry => entry.subject?.plugin === plugin)
    const applied = own.some(entry => entry.state === 'applied' && entry.decidedFrom === 'update')
    if (changed.has(plugin) && !applied) problems.push(`${plugin}: the change log has no change applied by the update`)
    if (!changed.has(plugin) && applied) problems.push(`${plugin}: the change log has a change applied by the update, but the release's signed files for the pack are unchanged`)
    if (own.some(entry => entry.state === 'pending')) problems.push(`${plugin}: a change waits for review after the update`)
  }
  return problems
}
