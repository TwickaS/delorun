/**
 * The gate `delorun update --yes` must pass, in contract C3's words: "`delorun update --yes` confirms a report that
 * has no `disabled` or `removed` item and no unverified item" ("Applying an update", step 1). Anything else needs the
 * person: an item the update disables or removes is a change they have to accept, and an item whose prediction rests
 * on metadata Delo could not read is never counted as safe (R3).
 *
 * A report with `changed` items alone is confirmable: the update changes something, but nothing leaves and nothing is
 * disabled. The function states the rule; the CLI prints the report and asks when it returns false.
 *
 * @module @delo/update/confirm
 */
import type { UpdateReport } from '@delo/contract-update-report'

/**
 * Whether the report can be confirmed without asking the person.
 * @param report - the report `delorun update --yes` would confirm.
 * @returns true when it holds no `disabled` or `removed` item and no unverified item.
 */
export function confirmsWithoutAsking(report: UpdateReport): boolean {
  return !report.items.some(item => item.effect === 'disabled' || item.effect === 'removed' || item.verification === 'unverified')
}
