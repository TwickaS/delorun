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
 * @returns one line per pack that has no applied entry decided by the update, or has a change still waiting; empty when
 *   the update's baseline applied to every pack and nothing waits.
 */
export function updateChangeProblems(text: string, plugins: readonly string[]): string[] {
  const entries = ((JSON.parse(text) as { entries?: readonly LogEntry[] }).entries ?? [])
  const problems: string[] = []
  for (const plugin of plugins) {
    const own = entries.filter(entry => entry.subject?.plugin === plugin)
    if (!own.some(entry => entry.state === 'applied' && entry.decidedFrom === 'update')) problems.push(`${plugin}: the change log has no change applied by the update`)
    if (own.some(entry => entry.state === 'pending')) problems.push(`${plugin}: a change waits for review after the update`)
  }
  return problems
}
