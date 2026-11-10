/**
 * What `delorun verify` prints about Changes (contract C21, "What verify and doctor report"): after the release's check
 * lines, the changes the person approved by plugin and folder, then everything present that they did not approve: each
 * pending change, each plugin running content they did not approve, and each invariant of Changes that does not hold.
 * A run from outside the runtime store says that there is no signed release to compare its files with. The block names
 * the protection setting; the summary line never reads as a plain pass while anything is not approved or protection is
 * lowered to `warn` or `off`, and the run exits 1 while unapproved content runs or an invariant does not hold. Every
 * line goes through [terminal text](../terminal-text.ts), since plugin names, folders and invariant lines come from
 * files a person or a plugin wrote.
 *
 * @module @delo/cli/verify/changes
 */
import { changesStatus, notApprovedCount, type ChangesStatus, type PendingStatus, type ProtectionLevel } from '@delo/changes'
import { isCarriedPackage } from '../changes/start.ts'
import { EXIT, type ExitCode } from '../exit.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printableLines } from '../terminal-text.ts'

/** What the run found about Changes. */
export interface VerifyChanges {
  /** Whether this `delorun` runs from the runtime store, so a signed release is what it runs. */
  readonly fromStore: boolean
  /** The profile reported. */
  readonly profile: string
  /** The report; null when the home has no CLI profile. */
  readonly status: ChangesStatus | null
}

/** What each protection setting means, as the lines of `verify` and `doctor` say it. */
export const PROTECTION_WORDS: Readonly<Record<ProtectionLevel, string>> = {
  block: 'changes you have not approved do not run',
  warn: 'changes you have not approved run, and every start says so',
  off: 'changes you have not approved run without notice',
}

/**
 * @param lines - the block's lines.
 * @returns them made safe for the terminal, each ending in a newline.
 */
function printed(lines: readonly string[]): string {
  return lines.flatMap(line => printableLines(line)).map(line => `${line}\n`).join('')
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
 * The line that names a plugin the first start under Changes approved as it was, which `delorun status` and
 * `delorun changes list` print until a terminal showed it.
 * @param approval - the plugin and its folder.
 * @returns the line.
 */
export function upgradeLine(approval: { readonly plugin: string, readonly source: string }): string {
  return `Delo runs the approved copy of ${approval.plugin}, linked from ${approval.source}, as it was when Changes began. Edits in that folder wait for your review.`
}

/**
 * The line verify prints for one change waiting for review.
 * @param change - a pending change.
 * @returns its line.
 */
export function pendingLine(change: PendingStatus): string {
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
    return printed(lines)
  }
  if (status.protection !== undefined) lines.push(`Protection is ${status.protection}: ${PROTECTION_WORDS[status.protection]}.`)
  lines.push(`${counted(status.approved.length, 'change', 'changes')} you approved${status.approved.length === 0 ? '.' : ':'}`)
  for (const approval of status.approved) lines.push(`  ${approval.plugin} from ${approval.source}${approval.approvedAtUpgrade ? ' (approved at upgrade)' : ''}`)
  const others = [
    ...status.pending.map(pendingLine),
    ...status.unapproved.map(({ plugin }) => `${plugin} runs content you have not approved`),
    ...status.invariants.map(line => `Not as Changes keeps it: ${line}`),
  ]
  if (others.length > 0) lines.push('Not approved:', ...others.map(line => `  ${line}`))
  return printed(lines)
}

/**
 * The words the summary line gains while anything is not approved or protection is lowered.
 * @param changes - what the run found.
 * @returns `; …` clauses; empty when everything present is approved and protection is `block`.
 */
export function changesSuffix(changes: VerifyChanges | undefined): string {
  const status = changes?.status
  if (status === undefined || status === null) return ''
  const parts: string[] = []
  const present = notApprovedCount(status)
  if (present > 0) parts.push(`${counted(present, 'change you have not approved is', 'changes you have not approved are')} present`)
  if (status.invariants.length > 0) parts.push(`${counted(status.invariants.length, 'part of your changes is', 'parts of your changes are')} not as Changes keeps them`)
  if (status.protection === 'warn' || status.protection === 'off') parts.push(`protection is lowered to ${status.protection}, so changes you have not approved run`)
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

/**
 * What `delorun status` says about Changes: each plugin approved at upgrade that no terminal has shown yet, each change
 * waiting for review, and protection when it is lowered. `delorun start` runs the home process with its output in the
 * log only, so this is where a person reads what that start said. Nothing is written.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns the lines, each ending in a newline; empty when there is nothing to say or the profile is not set up.
 */
export async function changesNotice(home: string, profile: string): Promise<string> {
  const { status } = await readVerifyChanges(home, profile, false)
  if (status === null) return ''
  const lines = [
    ...status.unshownAtUpgrade.map(upgradeLine),
    ...status.pending.map(pendingLine),
    ...status.protection === 'warn' || status.protection === 'off' ? [`Protection is ${status.protection}: ${PROTECTION_WORDS[status.protection]}.`] : [],
  ]
  return printed(lines.map(line => `changes: ${line}`))
}
