/**
 * `delorun update` (contracts C3 and C19): the update of the CLI home through its home process. The home process
 * fetches and verifies the channel's newest release with `@delorun/install`, installs it into C1's store and builds C3's
 * report; this command prints the report, asks, and applies it with the person's choice about the session-data copy.
 * The switch, the drain, the health check and the automatic rollback are the home process's. The profile history's
 * snapshot and every rollback run git, so the command refuses before it asks the home process for anything when git
 * cannot run on this computer.
 *
 * - `--check` runs the update check ([notice](./notice.ts)) on demand, whatever the profile's switch says: it fetches
 *   and verifies only the channel's signed metadata, needs no home process, prints the notice's line, and installs and
 *   changes nothing.
 * - `--yes` confirms a report with no `disabled` or `removed` item, no merged harness file, no unverified item and a
 *   release-log check that passed, so never one with a conflicted or merged harness file, and takes the copy when the
 *   data differs.
 * - `--data-copy` takes a copy when the data does not differ; `--no-data-copy` declines it when it does.
 * - `--from <folder|https-address>` installs the release a person-supplied source holds ([from](./from.ts)) through the
 *   same checks, then updates to it. It relaxes only the timestamp's freshness, after the person agrees at a terminal.
 *
 * A harness file whose change merges with the target's into content neither side had is printed with its diff from
 * the target's file, as the report bounds it.
 *
 * @module @delorun/cli/update/command
 */
import { fileURLToPath } from 'node:url'
import { confirm, isCancel, select } from '@clack/prompts'
import { HOME_STATUS_TIMEOUT_MS, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { HarnessDiffNotShown, ReportItem, UpdateReport } from '@delorun/contract-update-report'
import { queryHomeStatus, sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delorun/home-process'
import { historyGitProblem } from '@delorun/profile-safety'
import { confirmsWithoutAsking, dataCopyNote, exemptionNote, reasonMessage, uncheckedMessage, UNVERIFIED_NOTE } from '@delorun/update'
import { UPDATE_CHECK_DEFAULTS } from '@delorun/bundle-local/update-check'
import semver from 'semver'
import { CliError, EXIT } from '../exit.ts'
import { notRunningText } from '../messages.ts'
import { commandRows, styleOf, type Style } from '../style.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandOutput, type CommandResult } from '../command.ts'
import { hostRefusal } from '@delorun/npm-launcher'
import { runtimePlatformOf } from './channel.ts'
import { updateDisplay } from './progress.ts'
import { checkForUpdate, failureText, noticeLines, noticeOf, profileReader, runningRelease, type CheckOptions } from './notice.ts'
import { installFrom, type InstallFromOptions } from './from.ts'
import { runtimeOfFile, type RunningRuntime } from './runtime.ts'
import { fullCheckDaysOf } from './store-support.ts'
import { launcherAnchor } from './trusted-root.ts'
import { RuntimeStore } from '@delorun/runtime-store'
import { SILENT } from '../recover.ts'

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
  /**
   * Ask whether to install a release the release channel cannot confirm (`--from`).
   * @param message - the question.
   * @returns the answer; `undefined` when no terminal can ask.
   */
  agree(message: string): Promise<boolean | undefined>
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
  async agree(message) {
    if (process.stdin.isTTY !== true) return undefined
    const answer = await confirm({ message, initialValue: false })
    return !isCancel(answer) && answer
  },
}

/**
 * Install the release a person-supplied source holds into this home's runtime store.
 * @param options - the source, `--yes` and the question.
 * @returns the version to prepare.
 */
export type ManualInstall = (options: { readonly home: string, readonly from: string, readonly yes: boolean, readonly confirm: InstallFromOptions['confirm'], readonly report: InstallFromOptions['report'], readonly env: Readonly<Record<string, string | undefined>> }) => Promise<RuntimeVersion>

/**
 * {@link installFrom} over this machine's store and the launcher's roots.
 * @param options - the home, the source, `--yes`, the question, the install-step listener and the environment.
 * @returns the version to prepare.
 */
export const MANUAL_INSTALL: ManualInstall = async (options) => {
  const { home, from, yes, confirm: ask, report, env } = options
  const running = runtimeOfFile(home, fileURLToPath(import.meta.url))
  if (!running.store) throw new CliError(EXIT.failed, 'delorun update --from: this Delorun does not run from the runtime store, so it has no release to replace; install Delorun with its launcher.')
  return installFrom({
    home, from, yes, confirm: ask, report,
    running: running.version,
    anchor: launcherAnchor(home, env),
    store: new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger: SILENT }),
    fullCheckDays: fullCheckDaysOf(env),
  })
}

/** What `delorun update --check` reads outside this module; specs replace them. */
export interface UpdateCheckDependencies {
  /**
   * The runtime this command runs.
   * @param home - the resolved Delorun home.
   * @returns its version and whether it runs from the store.
   */
  readonly runtime: (home: string) => RunningRuntime
  /** The fetch, the clock and the publication the check uses; contract C2's by default. */
  readonly check?: Pick<CheckOptions, 'fetch' | 'now' | 'publication'>
}

/** The check's dependencies in a real run. */
export const CHECK_DEPENDENCIES: UpdateCheckDependencies = {
  runtime: home => runtimeOfFile(home, fileURLToPath(import.meta.url)),
}

/** What `--check` and `--report` print for a copy that did not come from the launcher, so it has no release store to update. */
export const SOURCE_BUILD_TEXT = "This is a source build, so it doesn't update itself. Install Delorun with: npx delorun"

/**
 * The line that says no newer release exists.
 * @param style - the styles.
 * @param version - the running Delorun version.
 * @param channel - the release channel.
 * @returns the line without its newline.
 */
function upToDateLine(style: Style, version: string, channel: string): string {
  return style.mark('ok', `Up to date · ${version} ${style.dim(`(newest on the ${channel} channel)`)}`)
}

/**
 * `delorun update --check`: run the update check now and print what it found.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile, whose record the check writes and whose plugins it counts.
 * @param context - where the command writes.
 * @param dependencies - the runtime and the check's fetch, clock and publication.
 * @returns 0 when the check verified the channel's newest release, 1 when it failed.
 */
async function runCheck(home: string, profile: string, context: CommandContext, dependencies: UpdateCheckDependencies): Promise<CommandResult> {
  const style = styleOf(context.env)
  const runtime = dependencies.runtime(home)
  if (!runtime.store) {
    context.stderr(`${SOURCE_BUILD_TEXT}\n`)
    return EXIT.failed
  }
  const platform = runtimePlatformOf(process.platform, process.arch)
  const anchor = launcherAnchor(home, context.env)
  const record = await checkForUpdate({ home, profile, platform, running: runtime.version, anchor, timeoutMs: UPDATE_CHECK_DEFAULTS.timeoutSeconds * 1000, ...dependencies.check })
  if (record.failure !== undefined) {
    context.stderr(`delorun update --check: the check failed, so nothing is known about a newer release: ${failureText(record.failure)}\n`)
    return EXIT.failed
  }
  const running = await runningRelease(home, platform, runtime.version, await anchor.root())
  const notice = await noticeOf(record, running, profileReader(home, profile))
  if (notice === undefined) {
    context.stdout(`${upToDateLine(style, running.delorun, running.channel)}\n`)
    return EXIT.ok
  }
  const [headline = '', ...rest] = noticeLines(notice)
  for (const line of [style.mark('note', headline), ...rest, ...commandRows(style, [['delorun update --report', 'see what changes'], ['delorun update', 'install it']])]) context.stdout(`${line}\n`)
  return EXIT.ok
}

/** The options `delorun update` takes. */
const UPDATE_OPTIONS = {
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  report: { type: 'boolean', default: false },
  'data-copy': { type: 'boolean' },
  'no-data-copy': { type: 'boolean' },
  from: { type: 'string' },
} as const

/**
 * A size in mebibytes, for a person.
 * @param bytes - the size.
 * @returns the text.
 */
function mebibytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`
}

/** Why a merged file's diff is not printed, after `The diff is not shown: `. */
const DIFF_NOT_SHOWN: Readonly<Record<HarnessDiffNotShown, string>> = {
  'binary': 'one side is not text.',
  'too-large': 'one side is larger than 1 MiB.',
  'cut-short': 'the report\'s diffs passed 256 KiB before it.',
}

/**
 * The lines of a merged harness file's diff, indented under its item.
 * @param item - the `harness-change-merged` item.
 * @returns the diff's lines, or why it is not shown.
 */
function mergedDiffLines(item: ReportItem): readonly string[] {
  const diff = item.detail.diff
  if (diff === undefined) return []
  if (diff.notShown !== undefined) return [`    The diff is not shown: ${DIFF_NOT_SHOWN[diff.notShown]} Decline the update to keep your change as it runs now.`]
  return diff.text.replace(/\n$/u, '').split('\n').map(line => `    ${line}`)
}

/**
 * The report as the person reads it.
 * @param report - C3's report.
 * @returns the lines.
 */
export function reportLines(report: UpdateReport): readonly string[] {
  const versions = { from: report.from, to: report.to }
  const lines = [
    `Update from Delorun ${report.from.delorun} (DSH ${report.from.dsh}) to Delorun ${report.to.delorun} (DSH ${report.to.dsh}) on the ${report.to.channel} channel.`,
    `Release checks: signature ${report.release.signature}, freshness ${report.release.freshness}, log ${report.release.log}.`,
    ...report.release.freshness === 'unchecked' ? ['The release channel could not confirm that this release is current when it was installed, so only its signature and release-log entry vouch for it.'] : [],
    ...report.release.log === 'unchecked' ? ['The release log could not be reached when this release was installed, so it is not yet known to be the release the public log holds.'] : [],
    `Installations: ${report.installations.map(entry => `${entry.id} ${entry.delorun ?? ''} ${entry.state}`.replace(/ +/gu, ' ')).join('; ')}.`,
  ]
  const changes = report.items.filter(item => item.kind !== 'data' && item.kind !== 'harness')
  lines.push(changes.length === 0 ? 'No plugin, bundle or profile row changes.' : `Changes (${String(changes.length)}):`)
  for (const item of changes) {
    lines.push(`  - ${item.effect}: ${reasonMessage(item, versions)}${item.verification === 'unverified' ? ` ${UNVERIFIED_NOTE}` : ''}`)
    const note = exemptionNote(item, versions)
    if (note !== undefined) lines.push(`    ${note}`)
  }
  const harness = report.items.filter(item => item.kind === 'harness')
  if (harness.length > 0) lines.push(`Your changes to Delorun's own files (${String(harness.length)}):`)
  for (const item of harness) {
    lines.push(`  - ${reasonMessage(item, versions)}`)
    if (item.reason === 'harness-change-merged') lines.push(...mergedDiffLines(item))
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
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param request - the request.
 * @param context - where the progress lines are printed, and the environment.
 * @param asked - what the refusal says.
 * @returns the final line, whose `ok` is true.
 * @throws {CliError} when the home process refused, the connection failed, or the request ended without a final line.
 */
async function ask(home: string, profile: string, request: UnsignedRequest, context: CommandContext, asked: Asked): Promise<ResponseLine> {
  const unanswered = (why: string): CliError => new CliError(EXIT.failed, `delorun update: ${why}. ${asked.unanswered} Its log records why: delorun logs home`)
  const display = updateDisplay(context, context.env)
  let lines: readonly ResponseLine[]
  try {
    lines = await sendHomeRequest(home, profile, request, { onLine: display.onLine })
  } catch (error) {
    display.fail()
    throw unanswered(`the connection to the home process failed during the request ${asked.what} (${error instanceof Error ? error.message : String(error)})`)
  }
  const final = lines.at(-1)
  if (final?.ok === false) display.fail()
  else display.close()
  if (final?.ok === false) throw new CliError(EXIT.failed, `delorun update: the home process refused ${asked.what}: ${String(final.error)}${typeof final.detail === 'string' ? `\n${final.detail}` : ''}`)
  if (final === undefined || !(asked.field in final)) throw unanswered(`the home process ended the request ${asked.what} without an answer`)
  return final
}

/**
 * Install the release `--from` names, drawing the install's progress.
 * @param from - the folder or address.
 * @param yes - whether `--yes` was given.
 * @param home - the resolved Delorun home.
 * @param prompts - the questions.
 * @param manual - installs the release.
 * @param context - the environment and output.
 * @returns the installed version.
 */
async function installedFrom(from: string, yes: boolean, home: string, prompts: UpdatePrompts, manual: ManualInstall, context: CommandContext): Promise<RuntimeVersion> {
  const display = updateDisplay(context, context.env)
  try {
    const version = await manual({ home, from, yes, confirm: question => display.asking(() => prompts.agree(question)), report: display.report, env: context.env })
    display.close()
    return version
  } catch (error) {
    display.fail()
    throw error
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
  if (values.yes === true && report.release.freshness !== 'passed') {
    throw new CliError(EXIT.failed, `delorun update: the release channel could not confirm that Delorun ${report.to.delorun} is current, so only its signature and release-log entry vouch for it, and --yes does not confirm it; run delorun update without --yes to decide`)
  }
  if (values.yes === true && report.release.log !== 'passed') {
    throw new CliError(EXIT.failed, `delorun update: the release-log check of Delorun ${report.to.delorun} did not complete, so nothing shows it is the release the public log holds, and --yes does not confirm it; run delorun update without --yes to decide, or again once the log answers`)
  }
  if (values.yes === true && !confirmsWithoutAsking(report)) {
    throw new CliError(EXIT.failed, 'delorun update: the report disables or removes something, merges your change to a file of Delorun itself, or holds an item Delorun cannot predict, so --yes does not confirm it; run delorun update without --yes to decide')
  }
  const apply = values.yes === true || await prompts.confirm(`Apply the update to Delorun ${report.to.delorun}?`)
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
 * @param checks - what `--check` reads; the real runtime and contract C2's publication by default.
 * @param manual - the installer a `--from` source runs; this machine's store by default.
 * @returns 0 when the update committed, nothing needed updating, `--check` verified the channel, `--report` printed the
 *   report or the person declined; 1 when it was refused, rolled back or failed, or `--check` failed; 2 for a wrong command line; 3 when no
 *   home process runs.
 */
export async function runUpdate(args: readonly string[], context: CommandContext, prompts: UpdatePrompts = TERMINAL_PROMPTS, checks: UpdateCheckDependencies = CHECK_DEPENDENCIES, manual: ManualInstall = MANUAL_INSTALL): Promise<CommandResult> {
  const values = parseOptions('update', args, UPDATE_OPTIONS)
  const host = hostRefusal(process.platform, undefined, process.arch)
  if (host !== undefined) throw new CliError(EXIT.failed, `delorun update: ${host}`)
  const { home, profile } = await prepareHome(context, values.profile, false)
  if (values.from !== undefined && (values.check === true || values.report === true)) {
    throw new CliError(EXIT.usage, 'delorun update: --from installs a release, so it takes neither --check nor --report')
  }
  if (values.check === true) {
    if (values.yes === true || values['data-copy'] !== undefined || values['no-data-copy'] !== undefined) throw new CliError(EXIT.usage, 'delorun update: --check applies nothing, so it takes no --yes, --data-copy or --no-data-copy')
    if (values.report === true) throw new CliError(EXIT.usage, 'delorun update: choose --check or --report, not both')
    return runCheck(home.path, profile, context, checks)
  }
  if (values.report === true && (values.yes === true || values['data-copy'] !== undefined || values['no-data-copy'] !== undefined)) {
    throw new CliError(EXIT.usage, 'delorun update: --report applies nothing, so it takes no --yes, --data-copy or --no-data-copy')
  }
  if (values.from === undefined && !checks.runtime(home.path).store) {
    context.stderr(`${SOURCE_BUILD_TEXT}\n`)
    return EXIT.failed
  }
  try {
    await queryHomeStatus(home.path, profile, HOME_STATUS_TIMEOUT_MS)
  } catch (_notRunning) {
    // No token, socket or answer: the update needs the home process.
    context.stderr(`${notRunningText(profile)}\n`)
    return EXIT.notRunning
  }
  const gitProblem = await historyGitProblem({})
  if (gitProblem !== undefined) {
    throw new CliError(EXIT.failed, `delorun update: Delorun saves the profile's history with git before it updates, so it can go back, and git cannot run here: ${gitProblem}. Install git, then run delorun update again. Nothing was fetched or changed.`)
  }
  const target = values.from === undefined ? undefined : await installedFrom(values.from, values.yes === true, home.path, prompts, manual, context)
  const prepared = await ask(home.path, profile, { op: 'update.prepare', args: target === undefined ? {} : { target } }, context, { what: 'to prepare the update', field: 'reportId', unanswered: 'Nothing was applied.' })
  const report = prepared.report as UpdateReport
  const reportId = String(prepared.reportId)
  if (report.to.delorun === report.from.delorun) {
    context.stdout(`${upToDateLine(styleOf(context.env), report.from.delorun, report.from.channel)}\n`)
    return EXIT.ok
  }
  if (semver.valid(report.to.delorun) === null || semver.valid(report.from.delorun) === null || semver.lt(report.to.delorun, report.from.delorun)) {
    throw new CliError(EXIT.failed, `delorun update: the update's target, Delorun ${report.to.delorun}, is not newer than Delorun ${report.from.delorun}, which runs now; an update never goes to a lower version, and nothing was applied. delorun recover rollback goes back to the version before the last update`)
  }
  for (const line of reportLines(report)) context.stdout(`${line}\n`)
  if (values.report === true) {
    context.stdout('Nothing changed. Run delorun update to apply it.\n')
    return EXIT.ok
  }
  const decision = await decide(report, values, prompts, context)
  if (!decision.apply) {
    context.stdout('Nothing changed.\n')
    return EXIT.ok
  }
  const final = await ask(home.path, profile, { op: 'update.apply', args: { reportId, wait: 'drain', dataCopy: decision.dataCopy } }, context, { what: 'to apply the update', field: 'outcome', unanswered: 'Whether the update applied is unknown; delorun status shows which version runs.' })
  switch (final.outcome) {
    case 'committed':
      context.stdout(`Delorun ${report.to.delorun} runs now.${decision.dataCopy ? ` The chat data from before is copied in data-copies/${report.to.delorun}.` : ''}\n`)
      return EXIT.ok
    case 'rolled-back':
      context.stderr(`delorun update: Delorun ${report.to.delorun} failed its health check (${String(final.criterion ?? final.reason ?? 'no reason')}); Delorun ${report.from.delorun} runs again with the profile from before. See delorun logs.\n`)
      return EXIT.failed
    case 'failed':
      context.stderr(`${failedRollbackLine(report, final.reason)}\n`)
      return EXIT.failed
    default:
      context.stderr(`delorun update: the update ended ${String(final.outcome)}${typeof final.reason === 'string' ? ` (${final.reason})` : ''}; nothing changed.\n`)
      return EXIT.failed
  }
}

/**
 * The line for an update whose automatic rollback did not complete, by the reason the home process gave.
 * @param report - the report the person confirmed.
 * @param reason - the final line's `reason`, when it carries one.
 * @returns the line, without its newline.
 */
function failedRollbackLine(report: UpdateReport, reason: unknown): string {
  const lead = `delorun update: Delorun ${report.to.delorun} failed its health check`
  switch (reason) {
    case 'ROLLBACK_NEEDS_DATA_COPY':
      return `${lead}, and going back needs the chat-data copy that was not taken. Run delorun recover rollback --profile-only, or delorun recover safe-mode.`
    case 'ROLLBACK_TARGET_UNUSABLE':
      return `${lead}, and Delorun ${report.from.delorun}, which it would go back to, is not installed or fails its start check. Run delorun recover status.`
    case 'CHATS_RUNNING':
      return `${lead}, and another process uses the chat data, so going back did not start. Stop that process; the next start completes the rollback.`
    case 'GIT_UNAVAILABLE':
      return `${lead}, and git, which restores the profile, cannot run, so going back did not start. Install git; the next start completes the rollback.`
    default:
      return `${lead}, and going back stopped after a step may have run. The next start completes the rollback; delorun logs home says why, and delorun recover status shows where it stands.`
  }
}

/** `delorun update [--check | --report | --yes] [--from <folder|https-address>] [--data-copy | --no-data-copy] [--profile <name>]`. */
export const updateCommand: CliCommand = {
  name: 'update',
  summary: 'Fetch the newest release, show what it changes, and apply it: --check only says whether one exists; --report shows what it changes and applies nothing; --from installs a release from a folder or https address; --yes, --data-copy, --no-data-copy',
  run: async (args, context) => runUpdate(args, context),
}
