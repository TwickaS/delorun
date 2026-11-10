/**
 * `delorun update` (contracts C3 and C19): the update of the CLI home through its home process. The home process
 * fetches and verifies the channel's newest release with `@delo/install`, installs it into C1's store and builds C3's
 * report; this command prints the report, asks, and applies it with the person's choice about the session-data copy.
 * The switch, the drain, the health check and the automatic rollback are the home process's. The profile history's
 * snapshot and every rollback run git, so the command refuses before it asks the home process for anything when git
 * cannot run on this computer.
 *
 * - `--check` prints the report and changes nothing in the profile or the active runtime.
 * - `--yes` confirms a report with no `disabled` or `removed` item and no unverified item, and takes the copy when the
 *   data differs.
 * - `--data-copy` takes a copy when the data does not differ; `--no-data-copy` declines it when it does.
 *
 * @module @delo/cli/update/command
 */
import { confirm, isCancel, select } from '@clack/prompts'
import { HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import type { UpdateReport } from '@delo/contract-update-report'
import { queryHomeStatus, sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delo/home-process'
import { historyGitProblem } from '@delo/profile-safety'
import { confirmsWithoutAsking, dataCopyNote, reasonMessage, uncheckedMessage, UNVERIFIED_NOTE } from '@delo/update'
import { CliError, EXIT } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandOutput, type CommandResult } from '../command.ts'

/** The questions the command asks; specs answer them. */
export interface UpdatePrompts {
  /**
   * Ask whether to apply the update.
   * @param message - the question.
   * @returns the answer; false when the person declines or no terminal can ask.
   */
  confirm(message: string): Promise<boolean>
  /**
   * Ask whether to take the session-data copy.
   * @param note - what declining costs.
   * @returns true to take it.
   */
  copy(note: string): Promise<boolean>
}

/** The questions on a terminal; without one, nothing is confirmed. */
export const TERMINAL_PROMPTS: UpdatePrompts = {
  async confirm(message) {
    if (process.stdin.isTTY !== true) return false
    const answer = await confirm({ message, initialValue: false })
    return !isCancel(answer) && answer
  },
  async copy(note) {
    if (process.stdin.isTTY !== true) return true
    const answer = await select({ message: 'The chat data changes format. Take a copy first?', options: [{ value: true, label: 'Copy the chat data (recommended)' }, { value: false, label: 'Continue without the copy', hint: note }], initialValue: true })
    return isCancel(answer) ? true : answer
  },
}

/** The options `delorun update` takes. */
const UPDATE_OPTIONS = {
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  'data-copy': { type: 'boolean' },
  'no-data-copy': { type: 'boolean' },
} as const

/**
 * A size in mebibytes, for a person.
 * @param bytes - the size.
 * @returns the text.
 */
function mebibytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`
}

/**
 * The report as the person reads it.
 * @param report - C3's report.
 * @returns the lines.
 */
export function reportLines(report: UpdateReport): readonly string[] {
  const versions = { from: report.from, to: report.to }
  const lines = [
    `Update from Delo ${report.from.delo} (DSH ${report.from.dsh}) to Delo ${report.to.delo} (DSH ${report.to.dsh}) on the ${report.to.channel} channel.`,
    `Release checks: signature ${report.release.signature}, freshness ${report.release.freshness}, log ${report.release.log}.`,
    `Installations: ${report.installations.map(entry => `${entry.id} ${entry.delo ?? ''} ${entry.state}`.replace(/ +/gu, ' ')).join('; ')}.`,
  ]
  const changes = report.items.filter(item => item.kind !== 'data')
  lines.push(changes.length === 0 ? 'No plugin, bundle or profile row changes.' : `Changes (${String(changes.length)}):`)
  for (const item of changes) {
    lines.push(`  - ${item.effect}: ${reasonMessage(item, versions)}${item.verification === 'unverified' ? ` ${UNVERIFIED_NOTE}` : ''}`)
  }
  for (const source of report.notChecked) lines.push(`Not checked: ${uncheckedMessage(source)}`)
  for (const item of report.items) {
    if (item.kind !== 'data') continue
    lines.push(`Chat data: ${reasonMessage(item, versions)}${item.verification === 'unverified' ? ` ${UNVERIFIED_NOTE}` : ''}`)
    const copy = item.detail.copy
    if (copy !== undefined) lines.push(`  A copy holds ${String(copy.files)} file(s), ${mebibytes(copy.bytes)}; ${mebibytes(copy.free)} is free.`)
    lines.push(`  ${dataCopyNote(versions)}`)
  }
  return lines
}

/** One `update.*` request as {@link ask} sends it, with what a refusal says about it. */
interface Asked {
  /** The request, for the refusal: `to prepare the update`. */
  readonly what: string
  /** The field the request's final line carries: `reportId` for `update.prepare`, `outcome` for `update.apply`. */
  readonly field: string
  /** What the person can do when no final line came. */
  readonly unanswered: string
}

/**
 * Send a request and return its final line, or a refusal naming it. A connection that ends after progress lines, or
 * with no line, carries no final line: the home process failed in a way it does not report on the channel, and its
 * log records it.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param request - the request.
 * @param output - where the progress lines are printed.
 * @param asked - what the refusal says.
 * @returns the final line, whose `ok` is true.
 * @throws {CliError} when the home process refused, the connection failed, or the request ended without a final line.
 */
async function ask(home: string, profile: string, request: UnsignedRequest, output: CommandOutput, asked: Asked): Promise<ResponseLine> {
  const unanswered = (why: string): CliError => new CliError(EXIT.failed, `delorun update: ${why}. ${asked.unanswered} Its log records why: delorun logs home`)
  let lines: readonly ResponseLine[]
  try {
    lines = await sendHomeRequest(home, profile, request, { onLine: phases(output) })
  } catch (error) {
    throw unanswered(`the connection to the home process failed during the request ${asked.what} (${error instanceof Error ? error.message : String(error)})`)
  }
  const final = lines.at(-1)
  if (final?.ok === false) throw new CliError(EXIT.failed, `delorun update: the home process refused ${asked.what}: ${String(final.error)}${typeof final.detail === 'string' ? `\n${final.detail}` : ''}`)
  if (final === undefined || !(asked.field in final)) throw unanswered(`the home process ended the request ${asked.what} without an answer`)
  return final
}

/**
 * Print each phase as it arrives, and each line of the target's install progress as the home process wrote it.
 * @param output - where the command writes.
 * @returns the listener.
 */
function phases(output: CommandOutput): (line: ResponseLine) => void {
  return (line) => {
    if (line.ok && typeof line.phase === 'string') output.stdout(`… ${line.phase}\n`)
    if (line.ok && typeof line.line === 'string') output.stdout(line.line)
  }
}

/** What one `delorun update` decides before it applies. */
interface Decision {
  readonly apply: boolean
  readonly dataCopy: boolean
}

/**
 * Decide whether to apply and whether to copy, from the options and the person's answers.
 * @param report - the report.
 * @param values - the parsed options.
 * @param prompts - the questions.
 * @param output - where the command writes.
 * @returns the decision.
 * @throws {CliError} when `--yes` meets a report that needs the person, or both copy options are given.
 */
async function decide(report: UpdateReport, values: { readonly yes?: boolean, readonly 'data-copy'?: boolean, readonly 'no-data-copy'?: boolean }, prompts: UpdatePrompts, output: CommandOutput): Promise<Decision> {
  if (values['data-copy'] === true && values['no-data-copy'] === true) throw new CliError(EXIT.usage, 'delorun update: choose --data-copy or --no-data-copy, not both')
  const data = report.items.find(item => item.kind === 'data')
  if (values.yes === true && !confirmsWithoutAsking(report)) {
    throw new CliError(EXIT.failed, 'delorun update: the report disables or removes something, or holds an item Delo cannot predict, so --yes does not confirm it; run delorun update without --yes to decide')
  }
  const apply = values.yes === true || await prompts.confirm(`Apply the update to Delo ${report.to.delo}?`)
  if (!apply) return { apply, dataCopy: false }
  let dataCopy: boolean
  if (values['no-data-copy'] === true) dataCopy = false
  else if (values['data-copy'] === true) dataCopy = true
  else if (data === undefined) dataCopy = false
  else dataCopy = values.yes === true || await prompts.copy(dataCopyNote({ from: report.from, to: report.to }))
  const size = data?.detail.copy
  if (dataCopy && size !== undefined && size.bytes > size.free) {
    throw new CliError(EXIT.failed, `delorun update: DATA_COPY_NO_SPACE: the copy needs ${mebibytes(size.bytes)} and ${mebibytes(size.free)} is free; free space, or run delorun update --no-data-copy`)
  }
  if (data !== undefined && !dataCopy) output.stdout(`Continuing without the copy. ${dataCopyNote({ from: report.from, to: report.to })}\n`)
  return { apply, dataCopy }
}

/**
 * Run `delorun update`.
 * @param args - the arguments after `update`.
 * @param context - the environment and output.
 * @param prompts - the questions; the terminal's by default.
 * @returns 0 when the update committed, nothing needed updating, `--check` printed the report or the person declined;
 *   1 when it was refused, rolled back or failed; 3 when no home process runs.
 */
export async function runUpdate(args: readonly string[], context: CommandContext, prompts: UpdatePrompts = TERMINAL_PROMPTS): Promise<CommandResult> {
  const values = parseOptions('update', args, UPDATE_OPTIONS)
  const { home, profile } = await prepareHome(context, values.profile)
  try {
    await queryHomeStatus(home.path, profile, HOME_STATUS_TIMEOUT_MS)
  } catch (_notRunning) {
    // No token, socket or answer: the update needs the home process.
    context.stderr(`delorun update: Delo is not running for the profile ${profile}; run delorun start, then delorun update.\n`)
    return EXIT.notRunning
  }
  const gitProblem = await historyGitProblem({})
  if (gitProblem !== undefined) {
    throw new CliError(EXIT.failed, `delorun update: Delo saves the profile's history with git before it updates, so it can go back, and git cannot run here: ${gitProblem}. Install git, then run delorun update again. Nothing was fetched or changed.`)
  }
  const prepared = await ask(home.path, profile, { op: 'update.prepare', args: {} }, context, { what: 'to prepare the update', field: 'reportId', unanswered: 'Nothing was applied.' })
  const report = prepared.report as UpdateReport
  const reportId = String(prepared.reportId)
  if (report.to.delo === report.from.delo) {
    context.stdout(`Delo ${report.from.delo} is the newest release on the ${report.from.channel} channel.\n`)
    return EXIT.ok
  }
  for (const line of reportLines(report)) context.stdout(`${line}\n`)
  if (values.check === true) return EXIT.ok
  const decision = await decide(report, values, prompts, context)
  if (!decision.apply) {
    context.stdout('Nothing changed.\n')
    return EXIT.ok
  }
  const final = await ask(home.path, profile, { op: 'update.apply', args: { reportId, wait: 'drain', dataCopy: decision.dataCopy } }, context, { what: 'to apply the update', field: 'outcome', unanswered: 'Whether the update applied is unknown; delorun status shows which version runs.' })
  switch (final.outcome) {
    case 'committed':
      context.stdout(`Delo ${report.to.delo} runs now.${decision.dataCopy ? ` The chat data from before is copied in data-copies/${report.to.delo}.` : ''}\n`)
      return EXIT.ok
    case 'rolled-back':
      context.stderr(`delorun update: Delo ${report.to.delo} failed its health check (${String(final.criterion ?? final.reason ?? 'no reason')}); Delo ${report.from.delo} runs again with the profile from before. See delorun logs.\n`)
      return EXIT.failed
    case 'failed':
      context.stderr(`delorun update: Delo ${report.to.delo} failed its health check, and going back needs the chat-data copy that was not taken. Run delorun recover rollback --profile-only, or delorun recover safe-mode.\n`)
      return EXIT.failed
    default:
      context.stderr(`delorun update: the update ended ${String(final.outcome)}${typeof final.reason === 'string' ? ` (${final.reason})` : ''}; nothing changed.\n`)
      return EXIT.failed
  }
}

/** `delorun update [--yes] [--check] [--data-copy | --no-data-copy] [--profile <name>]`. */
export const updateCommand: CliCommand = {
  name: 'update',
  summary: 'Fetch the newest release, show what it changes, and apply it: --check, --yes, --data-copy, --no-data-copy',
  run: async (args, context) => runUpdate(args, context),
}
