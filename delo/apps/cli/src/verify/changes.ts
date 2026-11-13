/**
 * What `delorun verify` prints about Changes (contract C21, "What verify and doctor report"): after the release's check
 * lines, the changes the person approved by plugin and folder, then the changes that loaded without review while
 * protection was off, then everything present that they did not approve: each pending change and each invariant of
 * Changes that does not hold. A run from the runtime store also names the person's changes to the harness itself: each
 * approved file among the changes they approved, or among those that loaded without review, each change waiting in
 * their copy among what they did not approve, and the composed tree a start runs, whose failed check never reads as a
 * pass ([harness tree](../../../../packages/changes/src/harness-tree.ts)). A run from outside the runtime store says
 * that there is no signed release to compare its files with. The block names the protection setting, which is not a
 * fault in either setting; the summary line never reads as a plain pass while anything is not approved or loaded
 * without review, and the run exits 1 while an invariant does not hold or the composed tree fails its check. Every
 * line goes through [terminal text](../terminal-text.ts), since plugin names, folders and invariant lines come from
 * files a person or a plugin wrote.
 *
 * @module @delo/cli/verify/changes
 */
import { changesStatus, harnessStatus, leftOutFact, notApprovedCount, type ChangesStatus, type HarnessStatus, type PendingStatus, type ProtectionLevel, type SignedRuntime } from '@delo/changes'
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
  /** The harness of the release checked, when this `delorun` runs from the runtime store. */
  readonly harness?: HarnessStatus
}

/** What each protection setting means, as the lines of `verify` and `doctor` say it. */
export const PROTECTION_WORDS: Readonly<Record<ProtectionLevel, string>> = {
  on: 'changes load only after you apply them',
  off: 'changes load without your review and are recorded; turn it on with: delorun changes protection on',
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

/** The release whose harness a run reports. */
export interface VerifyHarness {
  /** The release's version. */
  readonly runtime: string
  /** Its signed installation, when the runtime store's start check passed; undefined when it did not. */
  readonly signed: SignedRuntime | undefined
}

/**
 * Read Changes for the run. Nothing is written.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param fromStore - whether this `delorun` runs from the runtime store.
 * @param harness - the release whose harness is reported, when the run reads one.
 * @returns what the run reports.
 */
export async function readVerifyChanges(home: string, profile: string, fromStore: boolean, harness?: VerifyHarness): Promise<VerifyChanges> {
  const status = hasCliProfile(home, profile) ? await changesStatus({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage }) : null
  return { fromStore, profile, status, ...harness === undefined ? {} : { harness: await harnessStatus(home, harness.runtime, harness.signed) } }
}

/**
 * The lines about the harness itself.
 * @param harness - its report.
 * @returns the approved files, the information lines, and the parts not approved or not as Changes keeps them.
 */
function harnessParts(harness: HarnessStatus | undefined): { readonly approved: string[], readonly unreviewed: string[], readonly notes: string[], readonly others: string[] } {
  if (harness === undefined) return { approved: [], unreviewed: [], notes: [], others: [] }
  const { runtime, tree } = harness
  const notes: string[] = []
  if (tree.kind === 'not-built') notes.push(`Your approved changes to Delo ${runtime} itself run from its next start.`)
  if (tree.kind === 'not-checked') notes.push(`The harness with your changes in ${tree.directory} was not checked, because the signed release did not verify.`)
  for (const entry of harness.leftOut) notes.push(`${leftOutFact(entry).plugin} runs without change ${entry.id}, which a failed start left out.`)
  return {
    approved: harness.approved.filter(({ unreviewed }) => !unreviewed).map(({ file }) => `  Delo ${runtime} itself: ${file}`),
    unreviewed: harness.approved.filter(({ unreviewed }) => unreviewed).map(({ file, change }) => `  Delo ${runtime} itself: ${file} (${change})`),
    notes,
    others: [
      ...harness.pending.map(change => `Delo ${runtime} itself: ${change.file} waits for your review: delorun changes show ${change.id}`),
      ...tree.kind === 'failed' ? [`Not as Changes keeps it: ${tree.problem}`] : [],
    ],
  }
}

/**
 * @param harness - the harness's report.
 * @returns whether its composed tree failed its check.
 */
function treeFailed(harness: HarnessStatus | undefined): boolean {
  return harness?.tree.kind === 'failed'
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
  const harness = harnessParts(changes.harness)
  if (status === null) {
    lines.push(`The profile ${changes.profile} is not set up, so no changes are recorded.`)
    if (harness.approved.length > 0) lines.push(`${counted(harness.approved.length, 'change', 'changes')} you approved:`, ...harness.approved)
    if (harness.unreviewed.length > 0) lines.push(`${unreviewedWords(harness.unreviewed.length, undefined)}:`, ...harness.unreviewed)
    lines.push(...harness.notes)
    if (harness.others.length > 0) lines.push('Not approved:', ...harness.others.map(line => `  ${line}`))
    return printed(lines)
  }
  if (status.protection !== undefined) lines.push(`Protection is ${status.protection}: ${PROTECTION_WORDS[status.protection]}.`)
  const reviewed = status.approved.filter(approval => !status.unreviewed.some(({ plugin }) => plugin === approval.plugin))
  const approved = reviewed.length + harness.approved.length
  lines.push(`${counted(approved, 'change', 'changes')} you approved${approved === 0 ? '.' : ':'}`)
  for (const approval of reviewed) lines.push(`  ${approval.plugin} from ${approval.source}${approval.approvedAtUpgrade ? ' (approved at upgrade)' : ''}`)
  lines.push(...harness.approved)
  const unreviewed = status.unreviewed.length + harness.unreviewed.length
  if (unreviewed > 0) {
    lines.push(`${unreviewedWords(unreviewed, status.protection)}:`)
    for (const approval of status.approved) {
      const loaded = status.unreviewed.find(({ plugin }) => plugin === approval.plugin)
      if (loaded !== undefined) lines.push(`  ${approval.plugin} from ${approval.source} (${loaded.id})`)
    }
    lines.push(...harness.unreviewed)
  }
  lines.push(...harness.notes)
  const others = [
    ...harness.others,
    ...status.pending.map(pendingLine),
    ...status.invariants.map(line => `Not as Changes keeps it: ${line}`),
  ]
  if (others.length > 0) lines.push('Not approved:', ...others.map(line => `  ${line}`))
  return printed(lines)
}

/**
 * @param count - how many changes loaded without review.
 * @param protection - the protection setting now; undefined when it was not read, as for a profile that is not set up.
 * @returns the words that count them and say why they loaded: `protection is off` only when the setting read is off.
 */
function unreviewedWords(count: number, protection: ProtectionLevel | undefined): string {
  return `${counted(count, 'change', 'changes')} loaded without review (${protection === 'off' ? 'protection is off' : 'while protection was off'})`
}

/**
 * The words the summary line gains while anything is not approved, loaded without review, or not as Changes keeps it.
 * @param changes - what the run found.
 * @returns `; …` clauses; empty when everything present is approved after review.
 */
export function changesSuffix(changes: VerifyChanges | undefined): string {
  const status = changes?.status
  if (changes === undefined || status === undefined) return ''
  const parts: string[] = []
  const present = (status === null ? 0 : notApprovedCount(status)) + (changes.harness?.pending.length ?? 0)
  if (present > 0) parts.push(`${counted(present, 'change you have not approved is', 'changes you have not approved are')} present`)
  const unreviewed = (status?.unreviewed.length ?? 0) + (changes.harness?.approved.filter(file => file.unreviewed).length ?? 0)
  if (unreviewed > 0) parts.push(unreviewedWords(unreviewed, status?.protection))
  const broken = (status?.invariants.length ?? 0) + (treeFailed(changes.harness) ? 1 : 0)
  if (broken > 0) parts.push(`${counted(broken, 'part of your changes is', 'parts of your changes are')} not as Changes keeps them`)
  return parts.map(part => `; ${part}`).join('')
}

/**
 * The exit code Changes asks for: 1 while an invariant does not hold or the composed tree of the person's harness
 * changes fails its check. Pending changes and changes that loaded without review are reported, not faults.
 * @param changes - what the run found.
 * @returns the exit code.
 */
export function changesExit(changes: VerifyChanges): ExitCode {
  const status = changes.status
  return treeFailed(changes.harness) || (status !== null && status.invariants.length > 0) ? EXIT.failed : EXIT.ok
}

/**
 * What `delorun status` says about Changes: each plugin approved at upgrade that no terminal has shown yet, and each
 * change waiting for review. `delorun start` runs the home process with its output in the log only, so this is where a
 * person reads what that start said. Nothing is written.
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
  ]
  return printed(lines.map(line => `changes: ${line}`))
}
