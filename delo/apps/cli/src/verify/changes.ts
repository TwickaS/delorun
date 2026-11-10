/**
 * What `delorun verify` prints about Changes (contract C21, "What verify and doctor report"): after the release's check
 * lines, the changes the person approved by plugin and folder, then everything present that they did not approve: each
 * pending change, each plugin running content they did not approve, and each invariant of Changes that does not hold.
 * A run from outside the runtime store says that there is no signed release to compare its files with. The summary
 * line never reads as a plain pass while anything is not approved, and the run exits 1 while unapproved content runs or
 * an invariant does not hold.
 *
 * @module @delo/cli/verify/changes
 */
import { changesStatus, notApprovedCount, type ChangesStatus, type PendingStatus } from '@delo/changes'
import { isCarriedPackage } from '../changes/start.ts'
import { EXIT, type ExitCode } from '../exit.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'

/** What the run found about Changes. */
export interface VerifyChanges {
  /** Whether this `delorun` runs from the runtime store, so a signed release is what it runs. */
  readonly fromStore: boolean
  /** The profile reported. */
  readonly profile: string
  /** The report; null when the home has no CLI profile. */
  readonly status: ChangesStatus | null
}

/** The line a run from outside the runtime store prints. */
export const NOT_FROM_STORE = 'This is a source checkout or a development build: there is no signed release to compare its files with.'

/**
 * Read Changes for the run. Nothing is written.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param fromStore - whether this `delorun` runs from the runtime store.
 * @returns what the run reports.
 */
export async function readVerifyChanges(home: string, profile: string, fromStore: boolean): Promise<VerifyChanges> {
  const status = hasCliProfile(home, profile) ? await changesStatus({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage }) : null
  return { fromStore, profile, status }
}

/**
 * @param count - a count.
 * @param one - the words for one.
 * @param many - the words for more or none.
 * @returns the count and the words.
 */
function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/**
 * @param change - a pending change.
 * @returns its line.
 */
function pendingLine(change: PendingStatus): string {
  const what = change.kind === 'plugin-install' ? `${change.plugin} from ${change.source} waits for your review` : `${change.plugin} has changes in ${change.source} waiting for your review`
  return `${what}: ${change.id === undefined ? 'run delorun changes list' : `delorun changes show ${change.id}`}`
}

/**
 * The block printed after the check lines.
 * @param changes - what the run found.
 * @returns the lines, each ending in a newline.
 */
export function changesLines(changes: VerifyChanges): string {
  const lines = ['Changes:']
  if (!changes.fromStore) lines.push(NOT_FROM_STORE)
  const { status } = changes
  if (status === null) {
    lines.push(`The profile ${changes.profile} is not set up, so no changes are recorded.`)
    return lines.map(line => `${line}\n`).join('')
  }
  lines.push(`${counted(status.approved.length, 'change', 'changes')} you approved${status.approved.length === 0 ? '.' : ':'}`)
  for (const approval of status.approved) lines.push(`  ${approval.plugin} from ${approval.source}${approval.approvedAtUpgrade ? ' (approved at upgrade)' : ''}`)
  const others = [
    ...status.pending.map(pendingLine),
    ...status.unapproved.map(({ plugin }) => `${plugin} runs content you have not approved`),
    ...status.invariants.map(line => `Not as Changes keeps it: ${line}`),
  ]
  if (others.length > 0) lines.push('Not approved:', ...others.map(line => `  ${line}`))
  return lines.map(line => `${line}\n`).join('')
}

/**
 * The words the summary line gains while anything is not approved.
 * @param changes - what the run found.
 * @returns `; …` clauses; empty when everything present is approved.
 */
export function changesSuffix(changes: VerifyChanges | undefined): string {
  const status = changes?.status
  if (status === undefined || status === null) return ''
  const parts: string[] = []
  const present = notApprovedCount(status)
  if (present > 0) parts.push(`${counted(present, 'change you have not approved is', 'changes you have not approved are')} present`)
  if (status.invariants.length > 0) parts.push(`${counted(status.invariants.length, 'part of your changes is', 'parts of your changes are')} not as Changes keeps them`)
  return parts.map(part => `; ${part}`).join('')
}

/**
 * The exit code Changes asks for: 1 while content the person did not approve runs or an invariant does not hold.
 * @param changes - what the run found.
 * @returns the exit code.
 */
export function changesExit(changes: VerifyChanges): ExitCode {
  const status = changes.status
  return status !== null && (status.unapproved.length > 0 || status.invariants.length > 0) ? EXIT.failed : EXIT.ok
}
