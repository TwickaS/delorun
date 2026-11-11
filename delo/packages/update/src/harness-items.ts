/**
 * The report's `harness` items (contract C3, "Items"): one per file of the harness whose approved content differs from
 * the running release's signed file, saying whether the person's change carries over to the target as it is, merges
 * with the target's change into a file neither had, or conflicts with the target's file. The merge itself is `@delo/changes`'s; the CLI's report sources run it against the target's
 * verified files and pass each file's outcome here, so this package reads no harness record and no store.
 *
 * @module @delo/update/harness-items
 */
import type { HarnessDiff, HarnessMerge, HarnessResult, ItemDetail, ReportItem } from '@delo/contract-update-report'

/** One approved harness file and how it meets the target's file, as the report's sources read it. */
export interface HarnessFact {
  /** The file's path relative to the runtime's root, under `app/`. */
  readonly file: string
  /** How the approved content meets the target's file. */
  readonly merge: HarnessMerge
  /** What the target runs, for a `release-unchanged` or `merged` file the target runs. */
  readonly result?: HarnessResult
  /** The diff from the target's file to what runs, for a `merged` file. */
  readonly diff?: HarnessDiff
}

/** The merges that carry the person's change as it is; `merged` carries it into content neither side had. */
const CARRIED: ReadonlySet<HarnessMerge> = new Set<HarnessMerge>(['release-unchanged', 'in-release'])

/**
 * The item of one approved file.
 * @param fact - the file and its merge.
 * @returns the item.
 */
function harnessItem(fact: HarnessFact): ReportItem {
  const subject = { file: fact.file }
  const detail: ItemDetail = { merge: fact.merge, ...fact.result === undefined ? {} : { result: fact.result } }
  if (CARRIED.has(fact.merge)) return { kind: 'harness', subject, reason: 'harness-change-carried', effect: 'kept', verification: 'verified', detail, actions: [] }
  if (fact.merge === 'merged') {
    return { kind: 'harness', subject, reason: 'harness-change-merged', effect: 'changed', verification: 'verified', detail: { ...detail, ...fact.diff === undefined ? {} : { diff: fact.diff } }, actions: ['skip-update'] }
  }
  return { kind: 'harness', subject, reason: 'harness-change-conflicts', effect: 'disabled', verification: 'verified', detail: { merge: fact.merge }, actions: ['skip-update'] }
}

/**
 * One `harness` item per approved file: `harness-change-carried`, kept, when the change carries as it is;
 * `harness-change-merged`, changed, with the diff from the target's file, when the target runs a merge of both sides that
 * neither had, which the person must see, so it offers to skip the update and `--yes` does not confirm it; otherwise
 * `harness-change-conflicts`, disabled, which offers to skip the update, because the target's file runs in place of the
 * person's. Each is verified: every side of the merge was read from a signed file list or the approved-content store.
 * @param facts - the approved files and their merges.
 * @returns the items, in the order of the facts.
 */
export function harnessItems(facts: readonly HarnessFact[]): readonly ReportItem[] {
  return facts.map(harnessItem)
}
