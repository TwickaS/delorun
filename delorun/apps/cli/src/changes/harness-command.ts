/**
 * The harness half of `delorun changes` (contract C21, "Harness edits"): `edit-harness` makes the person's writable copy
 * of the installed release's `app/` directory, `edit-harness --discard` takes back every change to the harness itself,
 * and `list`, `show`, `apply`, `discard` and `undo` reach a harness change by its id as they reach a plugin's. The
 * signed installation is never written; an applied harness change runs from the next start, through the composed tree
 * ([harness start](./harness-start.ts)).
 *
 * Every subcommand that changes something needs the person at a terminal before anything is read or written, as the
 * rest of `delorun changes` does. Harness edits apply to an installed release: in a source checkout `edit-harness` and
 * every harness decision are refused.
 *
 * @module @delorun/cli/changes/harness-command
 */
import { parseArgs } from 'node:util'
import {
  applyHarnessChange,
  createHarnessCopy,
  discardAllHarnessChanges,
  discardHarnessChange,
  findEntry,
  findHarnessChange,
  isChangesError,
  leftOutFact,
  leftOutWords,
  listHarness,
  readHarnessLog,
  riskKindPhrase,
  riskLines,
  showHarnessChange,
  undoHarnessChange,
  type AtComputer,
  type BoundedDiff,
  type ChangeEntry,
  type ChangeId,
  type HarnessChange,
  type HarnessContext,
  type HarnessListing,
  type HarnessReview,
} from '@delorun/changes'
import { prepareHome, type CommandContext, type CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { printableJson, printableLines, printableText } from '../terminal-text.ts'
import { isYes } from '../trash/terminal.ts'
import type { ChangesCommandDependencies } from './command.ts'

/** The usage line of `edit-harness`. */
const USAGE = 'usage: delorun changes edit-harness [--discard]'

/** The refusal outside the runtime store. */
export const NOT_INSTALLED = 'Changes to Delorun itself apply to an installed release of Delorun; this delorun runs from a source checkout or a development build, which has no signed release to change.'

/** A harness change an id names. */
export type HarnessTarget =
  | { readonly kind: 'pending', readonly change: HarnessChange }
  | { readonly kind: 'logged', readonly entry: ChangeEntry }

/**
 * Whether `delorun changes` runs `edit-harness`.
 * @param args - the arguments after `changes`.
 * @returns whether the first positional argument is `edit-harness`.
 */
export function isHarnessSubcommand(args: readonly string[]): boolean {
  const [name] = parseArgs({ args: [...args], options: { discard: { type: 'boolean' }, profile: { type: 'string' } }, strict: false, allowPositionals: true }).positionals
  return name === 'edit-harness'
}

/**
 * Print lines made safe for the terminal.
 * @param write - the stream.
 * @param lines - lines, some holding text from files.
 */
function print(write: (text: string) => void, lines: readonly string[]): void {
  write(`${lines.flatMap(line => printableLines(line)).join('\n')}\n`)
}

/**
 * Ask a yes-or-no question.
 * @param dependencies - the terminal.
 * @param question - the question, without its suffix.
 * @returns whether the answer is yes.
 */
async function confirmed(dependencies: ChangesCommandDependencies, question: string): Promise<boolean> {
  return isYes(await dependencies.ask(`${question} [y/N] `))
}

/**
 * @param context - the output.
 * @returns the exit code of a question the person did not answer yes.
 */
function declined(context: CommandContext): CommandResult {
  context.stdout('Nothing was changed.\n')
  return EXIT.ok
}

/**
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @returns it.
 * @throws {CliError} {@link NOT_INSTALLED} outside the store.
 */
function installed(harness: HarnessContext | undefined): HarnessContext {
  if (harness === undefined) throw new CliError(EXIT.failed, `delorun changes: ${NOT_INSTALLED}`)
  return harness
}

/**
 * Run `delorun changes edit-harness [--discard]`.
 * @param args - the arguments after `changes`.
 * @param context - the environment and output.
 * @param dependencies - the terminal and the harness.
 * @param attest - the terminal proof, or the refusal when standard input or output is not a terminal.
 * @returns the exit code.
 * @throws {CliError} with the usage code for extra arguments, and when the command does not run at a terminal or runs
 *   outside the runtime store.
 */
export async function runHarnessCommand(args: readonly string[], context: CommandContext, dependencies: ChangesCommandDependencies, attest: () => AtComputer): Promise<CommandResult> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { discard: { type: 'boolean' }, profile: { type: 'string' } }, strict: true, allowPositionals: true })
  } catch (error) {
    throw new CliError(EXIT.usage, `delorun changes: ${(error as Error).message}\n${USAGE}`)
  }
  if (parsed.positionals.length !== 1) throw new CliError(EXIT.usage, `delorun changes: ${JSON.stringify(parsed.positionals.join(' '))} is not a subcommand\n${USAGE}`)
  // The person must be at the terminal before anything is read or written, the home's tree included.
  const presence = attest()
  const { home } = await prepareHome(context, parsed.values.profile)
  const harness = installed(dependencies.harness(home.path, context))
  try {
    if (parsed.values.discard !== true) {
      const copy = await createHarnessCopy(harness, presence)
      print(context.stdout, copy.created
        ? [`Your copy of Delorun ${harness.runtime} is in ${copy.directory}.`, 'Each file you save there becomes a change waiting for your review: delorun changes list. Delorun runs it once you apply it, from its next start.']
        : [`Your copy of Delorun ${harness.runtime} is in ${copy.directory}; nothing was changed.`])
      return EXIT.ok
    }
    if (!await confirmed(dependencies, `Discard every change to Delorun ${harness.runtime} itself? It returns to the signed release.`)) return declined(context)
    const reset = await discardAllHarnessChanges(harness, presence)
    print(context.stdout, [
      `Discarded ${String(reset.discarded.length)} waiting and undid ${String(reset.undone.length)} applied changes to Delorun ${harness.runtime}; it runs the signed release from its next start.`,
      ...reset.unread === undefined ? [] : [`Your copy of Delorun ${harness.runtime} could not be read, so the changes waiting in it were removed with it without being listed: ${reset.unread}`],
    ])
    return EXIT.ok
  } catch (error) {
    if (!isChangesError(error)) throw error
    print(context.stderr, [`delorun changes: ${error.detail}`])
    return EXIT.failed
  }
}

/**
 * Find the harness change an id names, after no plugin change had it: in the running runtime's copy, or in the
 * harness's change log, which a source checkout reads too.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param home - the Delorun home.
 * @param id - the id.
 * @returns the change, or undefined when no harness change has the id.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the id names content the copy no longer holds.
 */
export async function findHarnessTarget(harness: HarnessContext | undefined, home: string, id: ChangeId): Promise<HarnessTarget | undefined> {
  if (harness !== undefined) return findHarnessChange(harness, id)
  const entry = findEntry(await readHarnessLog(home), id)
  return entry === undefined ? undefined : { kind: 'logged', entry }
}

/**
 * @param review - a harness change waiting for review.
 * @param diff - whether to include the diff.
 * @returns the lines that describe it.
 */
function reviewLines(review: HarnessReview, diff: boolean): string[] {
  const lines = [
    `Change ${review.id}: a change to Delorun ${review.runtime} itself, waiting for your review`,
    `File: ${review.file} (${review.status})`,
    'Once you apply it, Delorun runs it from its next start; the signed release is not changed.',
    '',
    ...riskLines(review.risk),
  ]
  if (diff) lines.push('', ...diffLines(review))
  return lines
}

/**
 * A change's bounded diff as terminal lines ({@link printableText}), `apply` and `show --diff` of a plugin's change or a
 * harness change print.
 * @param change - a change with a bounded diff.
 * @returns its diff as terminal lines, and what the bound left out.
 */
export function diffLines(change: { readonly diff: BoundedDiff }): string[] {
  const lines = change.diff.text === '' ? ['The diff shows no lines.'] : printableText(change.diff.text.trimEnd())
  if (change.diff.truncated) lines.push(`The diff was cut short at its size limit; left out: ${change.diff.omitted.join(', ')}`)
  return lines
}

/**
 * @param entry - a logged harness change.
 * @returns the lines that describe it.
 */
function entryLines(entry: ChangeEntry): string[] {
  const lines = [`Change ${entry.id}: ${entry.summary}`, `State: ${entry.state}${entry.decidedAt === undefined ? '' : ` since ${entry.decidedAt}`}`]
  if (entry.leftOut !== undefined) lines.push(`A start left it out at ${entry.leftOut.at} because it failed: ${entry.leftOut.failure}`)
  return lines
}

/**
 * The review of a harness change waiting for review, its two sides stored.
 * @param harness - the running runtime's harness.
 * @param change - the change.
 * @returns the review.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the copy changed since the change was found.
 */
async function reviewOf(harness: HarnessContext, change: HarnessChange): Promise<HarnessReview> {
  const review = await showHarnessChange(harness, change.id)
  if (review === undefined) throw new CliError(EXIT.failed, `delorun changes: the file of change ${change.id} changed in your copy of Delorun while it was read; see the change it holds now: delorun changes list`)
  return review
}

/**
 * `show` of a harness change.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param target - the change.
 * @param diff - whether to print the diff.
 * @param json - whether to print JSON.
 * @param context - the output.
 * @returns the exit code.
 */
export async function showHarness(harness: HarnessContext | undefined, target: HarnessTarget, diff: boolean, json: boolean, context: CommandContext): Promise<CommandResult> {
  if (target.kind === 'logged') {
    if (json) context.stdout(`${printableJson({ kind: 'logged', entry: target.entry })}\n`)
    else print(context.stdout, entryLines(target.entry))
    return EXIT.ok
  }
  const review = await reviewOf(installed(harness), target.change)
  if (json) context.stdout(`${printableJson({ kind: 'harness', change: review })}\n`)
  else print(context.stdout, [...reviewLines(review, diff), '', `Apply it: delorun changes apply ${review.id}    Discard it: delorun changes discard ${review.id}`])
  return EXIT.ok
}

/**
 * `apply` of a harness change: the summary and risk lines, the diff a page at a time, a confirmation, a second one
 * naming the kinds the checks flagged and each file whose content the diff does not show, and the change.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param target - the change.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal.
 * @param context - the output.
 * @param pagedDiff - prints a diff a page at a time.
 * @returns the exit code.
 */
export async function applyHarness(harness: HarnessContext | undefined, target: HarnessTarget, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext, pagedDiff: (change: { readonly diff: BoundedDiff }) => Promise<void>): Promise<CommandResult> {
  const runtime = installed(harness)
  const id = target.kind === 'pending' ? target.change.id : target.entry.id
  let review: HarnessReview | undefined
  if (target.kind === 'pending') {
    review = await reviewOf(runtime, target.change)
    print(context.stdout, [...reviewLines(review, false), ''])
    await pagedDiff(review)
    context.stdout('\n')
  } else {
    print(context.stdout, [...entryLines(target.entry), ''])
  }
  if (!await confirmed(dependencies, `Apply ${id}?`)) return declined(context)
  if (review?.risk.needsSecondConfirmation === true) {
    const kinds = review.risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')
    const hidden = review.risk.findings.filter(finding => finding.kind === 'not-shown').map(finding => `  Not shown: ${finding.excerpt}`)
    print(context.stdout, [`This change ${kinds}. Delorun's own code can do anything Delorun can.`, ...hidden])
    if (!await confirmed(dependencies, 'Apply it anyway?')) return declined(context)
  }
  await applyHarnessChange(runtime, id, presence)
  context.stdout(`Applied ${id}. Delorun runs it from its next start.\n`)
  return EXIT.ok
}

/**
 * `discard` of a harness change waiting for review: the copy holds what Delorun runs for the file again.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param target - the change.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal.
 * @param context - the output.
 * @returns the exit code.
 */
export async function discardHarness(harness: HarnessContext | undefined, target: HarnessTarget, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  const runtime = installed(harness)
  const id = target.kind === 'pending' ? target.change.id : target.entry.id
  print(context.stdout, [...target.kind === 'pending' ? reviewLines(await reviewOf(runtime, target.change), false) : entryLines(target.entry), ''])
  if (!await confirmed(dependencies, `Discard ${id}? Your copy of Delorun gets back what Delorun runs for that file.`)) return declined(context)
  await discardHarnessChange(runtime, id, presence)
  context.stdout(`Discarded ${id}.\n`)
  return EXIT.ok
}

/**
 * `undo` of an applied harness change, or one a failed start left out.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param target - the change.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal.
 * @param context - the output.
 * @returns the exit code.
 */
export async function undoHarness(harness: HarnessContext | undefined, target: HarnessTarget, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  const runtime = installed(harness)
  const id = target.kind === 'pending' ? target.change.id : target.entry.id
  const what = target.kind === 'pending' ? target.change.file : target.entry.summary
  if (!await confirmed(dependencies, `Undo ${id}: ${what}?`)) return declined(context)
  await undoHarnessChange(runtime, id, presence)
  context.stdout(`Undid ${id}. Delorun runs the file as before from its next start.\n`)
  return EXIT.ok
}

/**
 * Read the harness's part of `list`. A copy that cannot be read is named instead of failing the list.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param home - the Delorun home.
 * @returns the listing, and the reason the copy could not be read.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's log is not one Delorun wrote.
 */
export async function readHarnessListing(harness: HarnessContext | undefined, home: string): Promise<{ readonly listing: HarnessListing, readonly problem?: string }> {
  try {
    return { listing: await listHarness(harness, home) }
  } catch (error) {
    if (!isChangesError(error) || error.code === 'RECORD_UNREADABLE') throw error
    return { listing: await listHarness(undefined, home), problem: error.detail }
  }
}

/**
 * The lines `list` prints for the harness.
 * @param read - the harness's listing and the reason its copy could not be read.
 * @returns the waiting lines, and the other lines printed after the plugins' recent changes.
 */
export function harnessListLines(read: { readonly listing: HarnessListing, readonly problem?: string }): { readonly waiting: string[], readonly others: string[] } {
  const { listing, problem } = read
  const waiting = listing.changes.map(change => `  ${change.id}  Delorun ${change.runtime} itself: ${change.file} (${change.status})`)
  const others: string[] = []
  if (problem !== undefined) others.push('', `Your copy of Delorun could not be read: ${problem}`)
  if (listing.leftOut.length > 0) others.push('', 'Left out because Delorun did not start with them:', ...listing.leftOut.flatMap(entry => leftOutWords(leftOutFact(entry)).split('\n').map(line => `  ${line}`)))
  if (listing.entries.length > 0) others.push('', 'Changes to Delorun itself, newest first:', ...listing.entries.map(entry => `  ${entry.id}  ${entry.state.padEnd(9)}  ${entry.decidedAt ?? entry.createdAt}  ${entry.summary}`))
  if (listing.copy !== undefined) others.push('', `Your copy of Delorun ${String(listing.runtime)} is in ${listing.copy}; each file you save there waits for your review.`)
  if (listing.skipped.length > 0) others.push(`Not changes, because they are not regular files under app/: ${listing.skipped.join(', ')}`)
  if (listing.keptBeside.length > 0) others.push(`Kept beside a file an update could not merge: ${listing.keptBeside.join(', ')}`)
  return { waiting, others }
}
