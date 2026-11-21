/**
 * The harness facts of contract C3's report for the CLI home: each file the running runtime runs other than its signed
 * one (`@delorun/changes`'s record, without a change a failed start left out), merged with the target release's file as
 * its signed file list names it. The target's files are read from its installation after C1's start check verified the
 * whole tree, and each file read is checked again against the signed list's length and digest, so a file changed after
 * the check is refused instead of merged. A runtime without approved files has no harness fact and the target is not
 * read. A carried file's fact holds the SHA-256 and execute bit of what the target runs, which the apply compares with
 * its own plan ([harness carry](./harness-carry.ts)), and a merged file's fact holds the bounded diff the person reads.
 *
 * @module @delorun/cli/update/harness-items
 */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { mergedDiffs, planHarnessCarry, readHarnessLog, readHarnessRecord, runningHarnessRecord, signedHarnessReader, type HarnessCarryPlan, type HarnessMergeResult, type SignedRuntime } from '@delorun/changes'
import type { Sha256Hex } from '@delorun/contract-release-manifest'
import type { HarnessMerge, HarnessResult } from '@delorun/contract-update-report'
import type { HarnessFact } from '@delorun/update'

/**
 * The report's name for a file's merge.
 * @param result - the merge's outcome.
 * @returns `in-release` when the target already holds the person's content, otherwise how it carried or conflicted.
 */
export function mergeOf(result: HarnessMergeResult): HarnessMerge {
  switch (result.outcome) {
    case 'same':
      return 'in-release'
    case 'carried':
      return result.carry
    case 'conflict':
      return result.conflict
    default:
      return assertNever(result)
  }
}

/**
 * What the target runs of a file whose change carries.
 * @param result - the merge's outcome.
 * @returns the SHA-256 and execute bit of the content the target runs, or `undefined` when the change does not carry or
 *   carries the file's removal.
 */
function resultOf(result: HarnessMergeResult): HarnessResult | undefined {
  if (result.outcome !== 'carried' || result.result === undefined) return undefined
  return { sha256: brandString<Sha256Hex>(createHash('sha256').update(result.result.bytes).digest('hex')), executable: result.result.executable }
}

/**
 * The report's harness facts of a plan, without diffs: what an apply compares with the facts the person confirmed.
 * @param plan - the plan.
 * @returns one fact per file, in the plan's order.
 */
export function harnessFacts(plan: HarnessCarryPlan): readonly HarnessFact[] {
  return plan.entries.map((entry) => {
    const result = resultOf(entry.merge)
    return { file: entry.file, merge: mergeOf(entry.merge), ...result === undefined ? {} : { result } }
  })
}

/**
 * The report's harness facts of a plan, each merged file with its diff from the target's file, bounded as Changes'
 * diffs are.
 * @param plan - the plan.
 * @returns one fact per file, in the plan's order.
 */
export function reportedHarnessFacts(plan: HarnessCarryPlan): readonly HarnessFact[] {
  const diffs = mergedDiffs(plan)
  return harnessFacts(plan).map((fact) => {
    const diff = diffs.get(fact.file)
    return diff === undefined ? fact : { ...fact, diff }
  })
}

/**
 * Read the harness facts of an update from the running runtime to a target.
 * @param home - the resolved Delorun home.
 * @param running - the running runtime's version.
 * @param target - checks the target with C1's start check and returns its signed installation; called only when the
 *   running runtime runs an approved harness file.
 * @returns one fact per approved file, in path order.
 * @throws {ChangesError} `RECORD_UNREADABLE` or `STORE_CORRUPT` when the record, the log or a version cannot be read;
 *   `RUNTIME_CHANGED` when a target file differs from its signed list.
 * @throws {RuntimeStoreError} when the target fails its start check.
 */
export async function readHarnessFacts(home: string, running: string, target: () => Promise<SignedRuntime>): Promise<readonly HarnessFact[]> {
  const record = runningHarnessRecord(await readHarnessLog(home), await readHarnessRecord(home, running))
  if (Object.keys(record.files).length === 0) return []
  return reportedHarnessFacts(await planHarnessCarry(home, record, signedHarnessReader(await target())))
}
