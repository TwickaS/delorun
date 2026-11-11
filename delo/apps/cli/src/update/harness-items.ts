/**
 * The harness facts of contract C3's report for the CLI home: each file the running runtime runs other than its signed
 * one (`@delo/changes`'s record, without a change a failed start left out), merged with the target release's file as
 * its signed file list names it. The target's files are read from its installation after C1's start check verified the
 * whole tree, and each file read is checked again against the signed list's length and digest, so a file changed after
 * the check is refused instead of merged. A runtime without approved files has no harness fact and the target is not
 * read.
 *
 * @module @delo/cli/update/harness-items
 */
import { planHarnessCarry, readHarnessLog, readHarnessRecord, runningHarnessRecord, signedHarnessReader, type HarnessCarryPlan, type HarnessMergeResult, type SignedRuntime } from '@delo/changes'
import type { HarnessMerge } from '@delo/contract-update-report'
import type { HarnessFact } from '@delo/update'

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
  }
}

/**
 * The report's harness facts of a plan.
 * @param plan - the plan.
 * @returns one fact per file, in the plan's order.
 */
export function harnessFacts(plan: HarnessCarryPlan): readonly HarnessFact[] {
  return plan.entries.map(entry => ({ file: entry.file, merge: mergeOf(entry.merge) }))
}

/**
 * Read the harness facts of an update from the running runtime to a target.
 * @param home - the resolved Delo home.
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
  return harnessFacts(await planHarnessCarry(home, record, signedHarnessReader(await target())))
}
