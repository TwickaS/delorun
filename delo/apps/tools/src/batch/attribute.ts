/**
 * Attribution: which lanes are suspects for a failing check, and which of them a failure belongs to, found by rerunning
 * only the failing checks on candidates without some lanes.
 *
 * A lane is a suspect for a check when the runner's selection over the lane's own changed paths picks the check. A test
 * lane's log that names failing spec files narrows the suspects to the lanes whose selection reaches those files, and a
 * range gate's log that names commits narrows them to the lanes that contributed those commits.
 *
 * @module @delo/tools/batch/attribute
 */
import type { SelectedCheck } from './plan-source.ts'
import type { FailedCheck, Fault, Verdict } from './state.ts'

/** What attribution knows about one lane of a candidate. */
export interface LaneFacts {
  readonly name: string
  /** The checks the lane's own changed paths select in the merge tier. */
  readonly selected: readonly SelectedCheck[]
  /** The lane's commit ids, on the lane and on the candidate. */
  readonly commits: readonly string[]
}

/** The suspects of one failing check. */
export interface Suspects {
  readonly check: string
  /** The suspect lanes, in batch order. */
  readonly lanes: readonly string[]
}

/**
 * The suspects of one failing check.
 * @param failure - the failing check, with the specs and commits its log names.
 * @param lanes - the candidate's lanes, in batch order.
 * @returns the lanes, in batch order; empty when no lane's selection picks the check.
 */
export function suspectsFor(failure: FailedCheck, lanes: readonly LaneFacts[]): string[] {
  const selecting = lanes.flatMap(lane => lane.selected.filter(check => check.id === failure.check).map(check => ({ lane: lane.name, scope: check.scope })))
  const reaching = selecting.filter(({ scope }) => scope === undefined || failure.specs.some(spec => scope.some(entry => spec.startsWith(entry))))
  if (failure.specs.length > 0 && reaching.length > 0) return reaching.map(({ lane }) => lane)
  const contributing = lanes.filter(lane => failure.commits.some(id => lane.commits.some(commit => commit.startsWith(id))))
  if (contributing.length > 0) return contributing.map(lane => lane.name)
  return selecting.map(({ lane }) => lane)
}

/**
 * The suspects of each failing check.
 * @param failures - the failing checks.
 * @param lanes - the candidate's lanes, in batch order.
 * @returns one entry per failing check, in failure order.
 */
export function suspectsOf(failures: readonly FailedCheck[], lanes: readonly LaneFacts[]): Suspects[] {
  return failures.map(failure => ({ check: failure.check, lanes: suspectsFor(failure, lanes) }))
}

/** The result of rerunning the failing checks on a candidate of some lanes; `unbuildable` when a lane does not apply without the others. */
export type TrialResult = 'passed' | 'failed' | 'unbuildable'

/**
 * Find which lanes a failure belongs to. The rules, in order:
 *
 * 1. With no suspect, the failure is not attributable.
 * 2. When removing exactly one suspect makes every failing check pass, that lane is at fault.
 * 3. When removing any one of several suspects does, each of them is run alone on the trunk: those that fail alone are
 *    at fault; when none does, they fail together and are faulted as one group.
 * 4. When no single removal does, every suspect is removed at once. When the failure persists, it is not attributable
 *    (the trunk, the environment or a flake). When it passes, each suspect runs alone on the trunk: those that fail alone
 *    are at fault; when none does, the suspects fail together.
 * @param included - the candidate's lanes, in batch order.
 * @param suspects - each failing check's suspects.
 * @param trial - reruns the failing checks on the trunk with the given lanes, in batch order.
 * @returns the verdict.
 */
export function narrow(included: readonly string[], suspects: readonly Suspects[], trial: (lanes: readonly string[]) => TrialResult): Verdict {
  const checks = suspects.map(entry => entry.check)
  const all = included.filter(lane => suspects.some(entry => entry.lanes.includes(lane)))
  if (all.length === 0) return { kind: 'not-attributable', checks }
  const without = (removed: readonly string[]): string[] => included.filter(lane => !removed.includes(lane))
  const fault = (lanes: readonly string[], why: Fault['why']): Fault => ({ lanes: [...lanes], why, checks: suspects.filter(entry => entry.lanes.some(lane => lanes.includes(lane))).map(entry => entry.check) })
  const aloneOrTogether = (group: readonly string[]): Verdict => {
    const alone = group.filter(lane => trial([lane]) === 'failed')
    return { kind: 'faulted', faults: alone.length > 0 ? alone.map(lane => fault([lane], 'fails-alone')) : [fault(group, 'together')] }
  }
  const fixers = all.filter(lane => trial(without([lane])) === 'passed')
  if (fixers.length === 1) return { kind: 'faulted', faults: [fault(fixers, 'removal-fixes')] }
  if (fixers.length > 1) return aloneOrTogether(fixers)
  if (trial(without(all)) !== 'passed') return { kind: 'not-attributable', checks }
  return aloneOrTogether(all)
}
