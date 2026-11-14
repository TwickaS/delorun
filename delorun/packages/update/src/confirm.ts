/**
 * The gate `delorun update --yes` must pass, in contract C3's words: "`delorun update --yes` confirms a report that
 * has no `disabled` or `removed` item, no `harness-change-merged` item, no unverified item and a release-log check that
 * passed" ("Applying an update", step 1). Anything else needs the person: an item the update disables or removes is a
 * change they have to accept, a harness file merged into content neither side had is one they have to read, an item
 * whose prediction rests on metadata Delorun could not read is never counted as safe (R3), and a release whose log check
 * did not complete (`unchecked`) is not known to be the release the log holds.
 *
 * A report with other `changed` items alone is confirmable: the update changes something, but nothing leaves and
 * nothing is disabled. The function states the rule; the CLI prints the report and asks when it returns false.
 *
 * @module @delorun/update/confirm
 */
import type { UpdateReport } from '@delorun/contract-update-report'

/**
 * Whether the report can be confirmed without asking the person.
 * @param report - the report `delorun update --yes` would confirm.
 * @returns true when it holds no `disabled` or `removed` item, no `harness-change-merged` item and no unverified item,
 *   and its log check passed.
 */
export function confirmsWithoutAsking(report: UpdateReport): boolean {
  return report.release.log === 'passed' && !report.items.some(item => item.effect === 'disabled' || item.effect === 'removed' || item.reason === 'harness-change-merged' || item.verification === 'unverified')
}
