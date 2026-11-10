/**
 * The batch's reports, for the integrator and for each lane's owner: one Markdown file per lane set aside or faulted,
 * naming why and the command that reproduces it in the lane's own worktree, a summary of the batch, and the `--plan`
 * text.
 *
 * @module @delo/tools/batch/report
 */
import { SPEC_LANES } from './logs.ts'
import { RUN_CHECKS, TSX } from './process.ts'
import type { FailedCheck, Fault, Lane, Outcome, SetAside } from './state.ts'

/** A lane set aside, and the round it was set aside in: 0 while the lanes were first replayed. */
export interface SetAsideLane {
  readonly lane: string
  readonly reason: SetAside
  readonly round: number
}

/** A faulted group of lanes and the failing checks it was faulted for. */
export interface FaultedGroup {
  readonly fault: Fault
  readonly failures: readonly FailedCheck[]
}

/** What the batch did, for its reports. */
export interface BatchSummary {
  readonly id: string
  readonly remote: string
  readonly trunk: string
  /** The trunk commit the batch started from. */
  readonly start: string
  /** The lanes of the last candidate, which landed or passed when the outcome says so. */
  readonly included: readonly string[]
  readonly setAside: readonly SetAsideLane[]
  readonly faults: readonly FaultedGroup[]
  /** Checks that failed and then passed when rerun on the same candidate. */
  readonly flaky: readonly string[]
  readonly outcome: Outcome
}

/**
 * A commit id as reports print it.
 * @param id - the full id.
 * @returns its first 12 characters.
 */
function short(id: string): string {
  return id.slice(0, 12)
}

/**
 * Why a lane was set aside, in one line.
 * @param entry - the lane.
 * @returns the sentence.
 */
function setAsideLine(entry: SetAsideLane): string {
  const when = entry.round === 0 ? '' : ' when the candidate was rebuilt without the faulted lanes'
  switch (entry.reason.kind) {
    case 'conflict': return `commit ${short(entry.reason.commit)} conflicts with the candidate${when} in ${entry.reason.paths.join(', ')}`
    case 'merge-commits': return `it holds merge commits (${entry.reason.commits.map(short).join(', ')}), which the batch does not replay; rebase the lane onto the trunk without merges`
    case 'no-commits': return 'it has no commit beyond the trunk'
    case 'pick-failed': return `git cherry-pick failed on ${short(entry.reason.commit)}${when}: ${entry.reason.detail}`
  }
}

/**
 * Why a group was faulted, in one line.
 * @param fault - the group.
 * @returns the sentence.
 */
function faultLine(fault: Fault): string {
  switch (fault.why) {
    case 'removal-fixes': return 'removing this lane alone from the candidate made every failing check pass'
    case 'fails-alone': return 'the failing checks fail on the trunk with this lane alone'
    case 'together': return `these lanes fail together: removing any one of them fixes the failure, and each passes alone on the trunk (${fault.lanes.join(', ')})`
  }
}

/**
 * The report of one lane set aside.
 * @param summary - the batch.
 * @param entry - the lane.
 * @returns the Markdown text.
 */
export function setAsideReport(summary: BatchSummary, entry: SetAsideLane): string {
  const rebase = entry.reason.kind === 'no-commits' ? [] : ['', 'Reproduce in the lane\'s worktree:', '', '```sh', `git fetch ${summary.remote} && git rebase ${summary.remote}/${summary.trunk}`, '```']
  return [`# Batch ${summary.id}: ${entry.lane} set aside`, '', `Set aside: ${setAsideLine(entry)}.`, ...rebase, ''].join('\n')
}

/**
 * The commands that reproduce a failing check in a lane's own worktree.
 * @param failure - the failing check.
 * @returns the command lines.
 */
function reproduce(failure: FailedCheck): string[] {
  const lane = SPEC_LANES[failure.check]
  const specs = lane === undefined ? [] : failure.specs.map(spec => `node_modules/.bin/vitest run --config ${lane.config} ${spec}`)
  return [`${TSX} ${RUN_CHECKS} --only ${failure.check} --changed --tier merge`, ...specs]
}

/**
 * The report of one lane in a faulted group.
 * @param summary - the batch.
 * @param lane - the lane.
 * @param group - its group.
 * @returns the Markdown text.
 */
export function faultReport(summary: BatchSummary, lane: string, group: FaultedGroup): string {
  const others = group.fault.lanes.filter(other => other !== lane)
  const sections = group.failures.flatMap(failure => [
    `## ${failure.check}`,
    '',
    ...failure.reason === null ? [] : [`Reason: ${failure.reason}`, ''],
    ...failure.excerpt.length === 0 ? [] : ['```text', ...failure.excerpt, '```', ''],
    'Reproduce in the lane\'s worktree:',
    '',
    '```sh',
    ...reproduce(failure),
    '```',
    '',
  ])
  return [
    `# Batch ${summary.id}: ${lane} faulted`,
    '',
    `Faulted: ${faultLine(group.fault)}.`,
    ...others.length === 0 ? [] : ['', `Fails together with: ${others.join(', ')}.`],
    '',
    ...sections,
  ].join('\n')
}

/**
 * Every lane report the batch writes.
 * @param summary - the batch.
 * @returns each lane's report, by lane name.
 */
export function laneReports(summary: BatchSummary): { readonly lane: string, readonly text: string }[] {
  return [
    ...summary.setAside.map(entry => ({ lane: entry.lane, text: setAsideReport(summary, entry) })),
    ...summary.faults.flatMap(group => group.fault.lanes.map(lane => ({ lane, text: faultReport(summary, lane, group) }))),
  ]
}

/**
 * How the batch ended, in one line.
 * @param summary - the batch.
 * @returns the sentence.
 */
export function outcomeLine(summary: BatchSummary): string {
  const outcome = summary.outcome
  const rerun = `rerun with --resume ${summary.id} or start a new batch`
  switch (outcome.kind) {
    case 'landed': return `landed: ${summary.remote}/${summary.trunk} moved from ${short(summary.start)} to ${short(outcome.commit)}`
    case 'passed': return `passed the merge tier at ${short(outcome.commit)}; nothing was pushed (--no-land), and ${summary.remote}/${summary.trunk} stays at ${short(summary.start)}`
    case 'trunk-moved': return `stopped: ${summary.remote}/${summary.trunk} moved while the batch ran and the push was refused (${outcome.detail}); nothing was rewritten, start a new batch`
    case 'gate-error': return `stopped: the gate failed without a failing check (${outcome.detail}); ${rerun}`
    case 'not-attributable': return `stopped: ${outcome.checks.join(', ')} fail with every suspect lane removed, so the trunk, the environment or a flake is at fault; nothing landed`
    case 'flaky': return `stopped: ${outcome.checks.join(', ')} failed again after passing on a rerun; nothing landed, ${rerun}`
    case 'nothing-to-land': return 'stopped: every lane was set aside or faulted; nothing landed'
  }
}

/**
 * The batch's summary.
 * @param summary - the batch.
 * @returns the Markdown text.
 */
export function summaryText(summary: BatchSummary): string {
  const reached = summary.outcome.kind === 'landed' || summary.outcome.kind === 'passed'
  const bullets = (items: readonly string[]): string[] => items.length === 0 ? ['- none'] : items.map(item => `- ${item}`)
  return [
    `# Batch ${summary.id} onto ${summary.remote}/${summary.trunk}`,
    '',
    `Outcome: ${outcomeLine(summary)}.`,
    '',
    `## ${reached ? (summary.outcome.kind === 'landed' ? 'Landed' : 'Passed') : 'Last candidate'}`,
    '',
    ...bullets(summary.included),
    '',
    '## Set aside',
    '',
    ...bullets(summary.setAside.map(entry => `${entry.lane}: ${setAsideLine(entry)}`)),
    '',
    '## Faulted',
    '',
    ...bullets(summary.faults.map(group => `${group.fault.lanes.join(', ')}: ${group.fault.checks.join(', ')} (${group.fault.why})`)),
    '',
    '## Flaky',
    '',
    ...bullets(summary.flaky),
    '',
  ].join('\n')
}

/** One lane of a `--plan`. */
export interface PlannedLane {
  readonly lane: Lane
  /** The package directories its changed paths lie in. */
  readonly packages: readonly string[]
  /** The checks its changed paths select in the merge tier. */
  readonly checks: readonly string[]
}

/**
 * The `--plan` text: the order, each lane's commit count and packages, and each check's would-be suspects.
 * @param remote - the remote.
 * @param trunk - the trunk.
 * @param start - the trunk commit.
 * @param lanes - the lanes, in batch order.
 * @returns the text.
 */
export function planText(remote: string, trunk: string, start: string, lanes: readonly PlannedLane[]): string {
  const order = lanes.map(({ lane, packages }, index) => {
    const refused = lane.merges.length > 0 ? '; refused: it holds merge commits' : ''
    return `  ${String(index + 1)}. ${lane.name}: ${String(lane.commits.length)} commit(s); packages: ${packages.length === 0 ? 'none' : packages.join(', ')}${refused}`
  })
  const checks = [...new Set(lanes.flatMap(lane => lane.checks))]
  const suspects = checks.map(check => `  ${check}: ${lanes.filter(lane => lane.checks.includes(check)).map(lane => lane.lane.name).join(', ')}`)
  return [
    `delo batch (plan): ${String(lanes.length)} lane(s) onto ${remote}/${trunk} at ${short(start)}`,
    ...order,
    'suspects by check (merge tier, each lane\'s own changed paths):',
    ...suspects.length === 0 ? ['  none'] : suspects,
    '',
  ].join('\n')
}
