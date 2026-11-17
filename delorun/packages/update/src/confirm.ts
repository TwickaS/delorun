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

/** What a person has to accept in a report before it applies: the indexes of the items, and the release-log check. */
export interface ConfirmationNeeds {
  /** Indexes into `report.items` of each item that disables or removes something, merges a harness file or rests on unverified metadata. */
  readonly items: readonly number[]
  /** Whether the release-log check did not pass (`unchecked` or `failed`). */
  readonly log: boolean
}

/**
 * What the report needs the person to accept, by the rule above. The terminal asks about these and the studio asks for a
 * tick for each, so the two cannot diverge.
 * @param report - the report.
 * @returns the items and the log check.
 */
export function confirmationNeeds(report: UpdateReport): ConfirmationNeeds {
  const items: number[] = []
  report.items.forEach((item, index) => {
    if (item.effect === 'disabled' || item.effect === 'removed' || item.reason === 'harness-change-merged' || item.verification === 'unverified') items.push(index)
  })
  return { items, log: report.release.log !== 'passed' }
}

/**
 * Whether the report can be confirmed without asking the person.
 * @param report - the report `delorun update --yes` would confirm.
 * @returns true when it holds no `disabled` or `removed` item, no `harness-change-merged` item and no unverified item,
 *   and its log check passed.
 */
export function confirmsWithoutAsking(report: UpdateReport): boolean {
  const needs = confirmationNeeds(report)
  return needs.items.length === 0 && !needs.log
}
