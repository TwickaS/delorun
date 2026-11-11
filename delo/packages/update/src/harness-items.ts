/**
 * The report's `harness` items (contract C3, "Items"): one per file of the harness whose approved content differs from
 * the running release's signed file, saying whether the person's change carries over to the target or conflicts with
 * the target's file. The merge itself is `@delo/changes`'s; the CLI's report sources run it against the target's
 * verified files and pass each file's outcome here, so this package reads no harness record and no store.
 *
 * @module @delo/update/harness-items
 */
import type { HarnessMerge, ReportItem } from '@delo/contract-update-report'

/** One approved harness file and how it meets the target's file, as the report's sources read it. */
export interface HarnessFact {
  /** The file's path relative to the runtime's root, under `app/`. */
  readonly file: string
  /** How the approved content meets the target's file. */
  readonly merge: HarnessMerge
}

/** The merges that carry the person's change; every other {@link HarnessMerge} is a conflict. */
const CARRIED: ReadonlySet<HarnessMerge> = new Set<HarnessMerge>(['release-unchanged', 'merged', 'in-release'])

/**
 * One `harness` item per approved file: `harness-change-carried`, kept, when the change carries; otherwise
 * `harness-change-conflicts`, disabled, which offers to skip the update, because the target's file runs in place of the
 * person's. Both are verified: every side of the merge was read from a signed file list or the approved-content store.
 * @param facts - the approved files and their merges.
 * @returns the items, in the order of the facts.
 */
export function harnessItems(facts: readonly HarnessFact[]): readonly ReportItem[] {
  return facts.map((fact): ReportItem => CARRIED.has(fact.merge)
    ? { kind: 'harness', subject: { file: fact.file }, reason: 'harness-change-carried', effect: 'kept', verification: 'verified', detail: { merge: fact.merge }, actions: [] }
    : { kind: 'harness', subject: { file: fact.file }, reason: 'harness-change-conflicts', effect: 'disabled', verification: 'verified', detail: { merge: fact.merge }, actions: ['skip-update'] })
}
