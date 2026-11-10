/**
 * `delorun changes work <plugin> [--for <minutes>]` and `delorun changes done <plugin>` (contract C21, "Work
 * sessions"): opening a work session, whose edits load live for at most `--for` minutes, and ending it at the
 * person's word.
 *
 * `done` stores the folder's content and prints its short version digest, its files, the risk summary and the bounded
 * diff against the approved content, every line through the terminal escaper, asks, asks a second time when a check
 * found something, and then approves exactly that digest; when the folder changed meanwhile it approves nothing and the
 * session stays open (`CHANGED_SINCE_REVIEW`). Both subcommands need the person at a terminal before anything is read
 * or written, like every subcommand of `delorun changes` that changes something.
 *
 * @module @delo/cli/changes/work-command
 */
import { parseArgs } from 'node:util'
import {
  finishWork,
  isChangesError,
  reviewWork,
  riskKindPhrase,
  riskLines,
  shortVersion,
  startWork,
  WORK_SESSION_DEFAULT_MINUTES,
  WORK_SESSION_MAX_MINUTES,
  workFinishedLine,
  type AtComputer,
  type ChangesContext,
  type WorkDone,
  type WorkReview,
  type WorkStarted,
} from '@delo/changes'
import { prepareHome, type CommandContext, type CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printable } from '../terminal-text.ts'
import { isYes } from '../trash/terminal.ts'
import type { ChangesCommandDependencies } from './command.ts'

/** How many minutes a work session lasts when `--for` is not given; `@delo/changes` owns it. */
export { WORK_SESSION_DEFAULT_MINUTES }

/** The usage line of the two subcommands. */
const USAGE = 'usage: delorun changes work <plugin> [--for <minutes>] [--profile <name>] | delorun changes done <plugin> [--profile <name>]'

/** The options the two subcommands take. */
const OPTIONS = { profile: { type: 'string' }, for: { type: 'string' } } as const

/** A work-session subcommand and its arguments. */
type WorkRequested =
  | { readonly kind: 'work', readonly plugin: string, readonly minutes: number }
  | { readonly kind: 'done', readonly plugin: string }

/**
 * Whether `delorun changes` runs a work-session subcommand. The subcommand is the first positional argument, read
 * without refusing an option, so the caller can hand the whole command line to {@link runWorkCommand}.
 * @param args - the arguments after `changes`.
 * @returns whether the subcommand is `work` or `done`.
 */
export function isWorkSubcommand(args: readonly string[]): boolean {
  const [name] = parseArgs({ args: [...args], options: OPTIONS, strict: false, allowPositionals: true }).positionals
  return name === 'work' || name === 'done'
}

/**
 * @param message - what is wrong.
 * @returns the usage error.
 */
function usageError(message: string): CliError {
  return new CliError(EXIT.usage, `delorun changes: ${message}\n${USAGE}`)
}

/**
 * Resolve `--for`: {@link WORK_SESSION_DEFAULT_MINUTES} when absent, otherwise whole minutes from 1 to
 * `WORK_SESSION_MAX_MINUTES`.
 * @param text - the option's value.
 * @returns the minutes.
 * @throws {CliError} with the usage code for any other value.
 */
function minutesOf(text: string | undefined): number {
  if (text === undefined) return WORK_SESSION_DEFAULT_MINUTES
  const minutes = /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : 0
  if (minutes < 1 || minutes > WORK_SESSION_MAX_MINUTES) throw usageError(`--for takes whole minutes from 1 to ${String(WORK_SESSION_MAX_MINUTES)}; ${JSON.stringify(text)} is not`)
  return minutes
}

/**
 * Read `work` or `done` from the command line.
 * @param args - the arguments after `changes`.
 * @returns the subcommand and the profile flag.
 * @throws {CliError} with the usage code for a missing plugin, an extra argument, an unknown option, or `--for` on `done`.
 */
function requested(args: readonly string[]): { readonly request: WorkRequested, readonly profile: string | undefined } {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw usageError((error as Error).message)
  }
  const [name, plugin, ...extra] = parsed.positionals
  if (plugin === undefined || extra.length > 0) throw usageError(`${JSON.stringify(parsed.positionals.join(' '))} is not a subcommand`)
  if (name === 'done' && parsed.values.for !== undefined) throw usageError('--for belongs to work')
  const request: WorkRequested = name === 'work' ? { kind: 'work', plugin, minutes: minutesOf(parsed.values.for) } : { kind: 'done', plugin }
  return { request, profile: parsed.values.profile }
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
 * @param lines - lines, some holding text from the plugin's folder.
 */
function print(context: CommandContext, lines: readonly string[]): void {
  context.stdout(`${lines.map(printable).join('\n')}\n`)
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
 * Report how a work session started.
 * @param started - what starting it did.
 * @param context - the output.
 * @returns the exit code: failed when the folder's content failed to load.
 */
function reportedWork(started: WorkStarted, context: CommandContext): CommandResult {
  const { plugin, source, endsAt } = started.session
  print(context, [`Working on ${plugin}: edits in ${source} load live until delorun changes done ${plugin}, at the latest until ${endsAt}.`])
  if (started.load.kind === 'loaded') return EXIT.ok
  const { failure, again } = started.load
  context.stderr(`${[`delorun changes: ${plugin} failed to load from its folder: ${failure}`, 'Delo runs its approved version; your work session stays open, and the next edit in the folder loads again.', ...again?.ok === false ? [`Loading the approved version also failed: ${again.error}. Restart Delo: delorun stop, then delorun start.`] : []].map(printable).join('\n')}\n`)
  return EXIT.failed
}

/**
 * The lines `done` prints before it asks.
 * @param review - the session and the folder's content.
 * @returns the lines.
 */
function reviewLines(review: WorkReview): string[] {
  const { plugin, source, from, startedAt, endsAt } = review.session
  const lines = [`Your work session on ${plugin} started at ${startedAt} and ends at ${endsAt}.`]
  if (review.folder === undefined) return [...lines, `The folder of ${plugin}, ${source}, is gone; ending the session keeps its approved version (${shortVersion(from)}).`]
  const { change } = review
  if (change === undefined) return [...lines, `The folder of ${plugin} holds its approved version (${shortVersion(from)}); there is nothing new to approve.`]
  const own = change.files.filter(file => !file.dependency)
  const dependencies = change.files.filter(file => file.dependency)
  lines.push(`Version ${shortVersion(change.to)} of ${plugin}, in ${source}, against the approved version ${shortVersion(from)}:`, 'Files:', ...own.map(file => `  ${file.status.padEnd(8)}  ${file.path}`))
  if (dependencies.length > 0) lines.push(`Dependency files (${String(dependencies.length)}):`, ...dependencies.map(file => `  ${file.status.padEnd(8)}  ${file.path}`))
  if (change.skipped.length > 0) lines.push(`Not included: ${change.skipped.join(', ')}`)
  if (review.failedToLoad) lines.push('This version failed to load in your work session; approving it loads it again first.')
  lines.push('', ...riskLines(change.risk), '', ...change.diff.text.trimEnd().split('\n'))
  if (change.diff.truncated) lines.push(`The diff was cut short at its size limit; left out: ${change.diff.omitted.join(', ')}`)
  return lines
}

/**
 * Report what `done` did.
 * @param done - the result.
 * @param context - the output.
 * @returns the exit code: failed when the version failed to load.
 */
function reportedDone(done: WorkDone, context: CommandContext): CommandResult {
  if (done.kind === 'ended') {
    print(context, [`Your work session on ${done.plugin} ended. ${workFinishedLine(done)}`])
    return EXIT.ok
  }
  const { plugin, load } = done
  const lines = [`delorun changes: version ${shortVersion(load.version)} of ${plugin} failed to load: ${load.failure}`, 'Nothing was approved; Delo runs the version that last loaded, and your work session stays open.']
  if (load.again?.ok === false) lines.push(`Loading that version also failed: ${load.again.error}. Restart Delo: delorun stop, then delorun start.`)
  context.stderr(`${lines.map(printable).join('\n')}\n`)
  return EXIT.failed
}

/**
 * `done`: show the folder's version with its files, risk summary and diff, ask (twice when a check found something),
 * and approve exactly that version.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal and the Host.
 * @param context - the output.
 * @returns the exit code.
 */
async function done(ctx: ChangesContext, plugin: string, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  const review = await reviewWork(ctx, plugin)
  print(context, [...reviewLines(review), ''])
  const shown = review.change?.to
  const question = shown === undefined ? `End your work session on ${plugin}?` : `Approve version ${shortVersion(shown)} of ${plugin} and end your work session?`
  if (!await confirmed(dependencies, printable(question))) return declined(context)
  if (review.change?.risk.needsSecondConfirmation === true) {
    const kinds = review.change.risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')
    context.stdout(`This version ${kinds}. A plugin's code can do anything Delo can.\n`)
    if (!await confirmed(dependencies, 'Approve it anyway?')) return declined(context)
  }
  return reportedDone(await dependencies.withHost(ctx.home, ctx.profile, reload => finishWork(ctx, plugin, presence, { reload, approve: review.folder })), context)
}

/**
 * Run `delorun changes work` or `done`.
 * @param args - the arguments after `changes`.
 * @param context - the environment and output.
 * @param dependencies - the terminal and the Host.
 * @param attest - the terminal proof, or the refusal when standard input or output is not a terminal.
 * @returns the exit code.
 * @throws {CliError} with the usage code for malformed arguments, and when the command does not run at a terminal.
 */
export async function runWorkCommand(args: readonly string[], context: CommandContext, dependencies: ChangesCommandDependencies, attest: () => AtComputer): Promise<CommandResult> {
  const { request, profile: profileFlag } = requested(args)
  // The person must be at the terminal before anything is read or written, the home's tree included.
  const presence = attest()
  const { home, profile } = await prepareHome(context, profileFlag)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun changes: the CLI profile ${profile} is not set up in ${home.path}; run: delorun setup`)
  const ctx: ChangesContext = { home: home.path, profile, profileDir: profileDirectory(home.path, profile) }
  const plugin = request.plugin
  try {
    if (request.kind === 'done') return await done(ctx, plugin, presence, dependencies, context)
    const question = `Work on ${plugin} for ${String(request.minutes)} minutes? Edits in its folder will load without your review until you run delorun changes done ${plugin} or the time is up.`
    if (!await confirmed(dependencies, printable(question))) return declined(context)
    return reportedWork(await dependencies.withHost(home.path, profile, reload => startWork(ctx, plugin, presence, { reload, minutes: request.minutes })), context)
  } catch (error) {
    if (!isChangesError(error)) throw error
    context.stderr(`delorun changes: ${printable(error.detail)}\n`)
    return EXIT.failed
  }
}
