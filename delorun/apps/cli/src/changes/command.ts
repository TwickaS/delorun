/**
 * `delorun changes` (contract C21, "Commands"): what waits for your review, and applying, discarding and undoing a
 * change, turning one plugin off or on, the protection setting, and working on a plugin with live reload.
 *
 * | Subcommand | What it does |
 * | --- | --- |
 * | `list` (the default) `[--json]` | changes waiting for review, then the decided ones, the protection setting and any work session |
 * | `show <id> [--diff] [--json]` | one change: the plugin, its folder, the files, the risk summary and, with `--diff`, the diff |
 * | `apply <id>` | shows the diff a page at a time, then the plugin runs exactly the content the change showed; a change the checks flag asks twice; an agent's plugin request runs upstream's plugin operation for its spec |
 * | `discard <id>` | the change never runs; the folder is not touched |
 * | `undo <id>` | an applied change is taken back |
 * | `off <plugin>`, `on <plugin>` | one plugin stops running, or runs again |
 * | `protection [on \| off]` | prints the setting, or changes it after saying what the new setting means and asking |
 * | `work <plugin> [--for <minutes>]`, `done <plugin>` | edits in the plugin's folder load live for at most `--for` minutes; `done` shows the folder's version and approves exactly it ([work command](./work-command.ts)) |
 * | `edit-harness [--discard]` | makes the person's writable copy of the installed release, whose saved files are changes to Delorun itself; `--discard` takes every such change back ([harness command](./harness-command.ts)) |
 *
 * `list`, `show`, `apply`, `discard` and `undo` reach a change to Delorun itself by its id as they reach a plugin's.
 *
 * Every subcommand that changes something first needs the person at a terminal, standard input and output both, and
 * refuses otherwise before it reads or writes anything; then it asks for confirmation. Everything printed from a folder,
 * a diff, a log entry or a failure goes through [terminal text](../terminal-text.ts). While Delorun runs for the profile,
 * the change is written under the profile's write lock and the running Host reloads through the update channel's
 * `changes.reload`; while it does not, the command holds the profile's home lock, so no start runs meanwhile, and the
 * next start loads the change.
 *
 * @module @delorun/cli/changes/command
 */
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  applyChange,
  applyInstallChange,
  attestTerminal,
  changeProtection,
  discardChange,
  isChangesError,
  isPluginRequest,
  leftOutFact,
  leftOutWords,
  listChanges,
  markShownAtUpgrade,
  PACKAGE_NAME_PATTERN,
  parseChangeId,
  PROFILE_LOCK_WAIT_MS,
  PROTECTION_LEVELS,
  readProtection,
  riskKindPhrase,
  riskLines,
  showChange,
  turnOff,
  turnOn,
  undoChange,
  unshownAtUpgrade,
  type ActionResult,
  type AtComputer,
  type BoundedDiff,
  type ChangeEntry,
  type ChangeId,
  type ChangesContext,
  type HarnessContext,
  type InstallResult,
  type ListedChange,
  type PluginOperation,
  type ProtectionLevel,
  type ReloadHost,
  type ReloadOutcome,
  type ShownChange,
} from '@delorun/changes'
import { HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import { acquireHomeLock, newStartId, runDirectory } from '@delorun/home'
import { queryHomeStatus, sendHomeRequest, updateChannelProbe } from '@delorun/home-process'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printable, printableJson, printableLines } from '../terminal-text.ts'
import { askOnTerminal, isYes } from '../trash/terminal.ts'
import { runtimeOfFile, type RunningRuntime } from '../update/runtime.ts'
import { upgradeLine } from '../verify/changes.ts'
import { upstreamPluginOperation } from './plugin-operation.ts'
import { applyHarness, diffLines, discardHarness, findHarnessTarget, harnessListLines, isHarnessSubcommand, readHarnessListing, runHarnessCommand, showHarness, undoHarness, type HarnessTarget } from './harness-command.ts'
import { harnessContextOf, outputLogger } from './harness-start.ts'
import { isWorkSubcommand, runWorkCommand } from './work-command.ts'

/** The usage line. */
const USAGE = 'usage: delorun changes [list | show <id> [--diff] | apply <id> | discard <id> | undo <id> | off <plugin> | on <plugin> | protection [on|off] | work <plugin> [--for <minutes>] | done <plugin> | edit-harness [--discard]] [--profile <name>] [--json]'

/** The refusal when the command does not run at a terminal. */
export const NOT_AT_TERMINAL = 'This needs you at your computer: run it in a terminal.'

/** What the command reaches outside itself; specs replace each. */
export interface ChangesCommandDependencies {
  /** The streams whose being terminals proves the person is at their computer; this process's by default. */
  readonly streams: Parameters<typeof attestTerminal>[0]
  /**
   * Ask one question on the terminal.
   * @param question - the question with its prompt suffix.
   * @returns the trimmed answer; empty when nobody answers.
   */
  readonly ask: (question: string) => Promise<string>
  /**
   * Run a change with the Host's reload: through the running home process, or under the profile's home lock when
   * none runs ({@link withProfileHost} by default).
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @param run - the change, given the reload.
   * @returns what the change returned.
   */
  readonly withHost: <T>(home: string, profile: string, run: (reload: ReloadHost) => Promise<T>) => Promise<T>
  /**
   * Upstream's plugin operation for the profile, which applying an agent's plugin request runs
   * ({@link upstreamPluginOperation} by default).
   * @param ctx - the profile.
   * @param context - the command's output.
   * @returns the operation.
   */
  readonly pluginOperation: (ctx: ChangesContext, context: CommandContext) => PluginOperation
  /**
   * How many lines of a diff `apply` prints before it waits for Enter; the terminal's height less two in a real run.
   * Absent, the diff is printed without waiting.
   */
  readonly pageLines?: number
  /**
   * The harness the command works on: the running runtime's when `delorun` runs from the runtime store, whose signed
   * installation the store's start check reads when an action needs it ({@link harnessContextOf} by default).
   * @param home - the Delorun home.
   * @param context - the environment and output.
   * @returns the harness, or undefined outside the runtime store.
   */
  readonly harness: (home: string, context: CommandContext) => HarnessContext | undefined
}

/** One subcommand and its argument. */
type Requested =
  | { readonly kind: 'list' }
  | { readonly kind: 'show', readonly id: ChangeId, readonly diff: boolean }
  | { readonly kind: 'apply' | 'discard' | 'undo', readonly id: ChangeId }
  | { readonly kind: 'off' | 'on', readonly plugin: string }
  | { readonly kind: 'protection', readonly level?: ProtectionLevel }

/** The subcommands, in usage order, and whether each takes an argument. */
const SUBCOMMANDS = { list: 'none', show: 'id', apply: 'id', discard: 'id', undo: 'id', off: 'plugin', on: 'plugin', protection: 'optional' } as const

/**
 * @param message - what is wrong.
 * @returns the usage error.
 */
function usageError(message: string): CliError {
  return new CliError(EXIT.usage, `delorun changes: ${message}\n${USAGE}`)
}

/**
 * Read the subcommand from the command line.
 * @param args - the arguments after `changes`.
 * @returns the subcommand and the options.
 * @throws {CliError} with the usage code for an unknown subcommand, a missing or malformed argument, or an option
 *   another subcommand owns.
 */
function requested(args: readonly string[]): { readonly action: Requested, readonly profile: string | undefined, readonly json: boolean } {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { profile: { type: 'string' }, json: { type: 'boolean' }, diff: { type: 'boolean' } }, strict: true, allowPositionals: true })
  } catch (error) {
    throw usageError((error as Error).message)
  }
  const [name = 'list', argument, ...extra] = parsed.positionals
  const takes = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name as keyof typeof SUBCOMMANDS] : undefined
  if (takes === undefined || extra.length > 0 || (takes === 'none' && argument !== undefined) || ((takes === 'id' || takes === 'plugin') && argument === undefined)) {
    throw usageError(`${JSON.stringify(parsed.positionals.join(' '))} is not a subcommand`)
  }
  const json = parsed.values.json === true
  if (json && name !== 'list' && name !== 'show') throw usageError('--json belongs to list and show')
  if (parsed.values.diff === true && name !== 'show') throw usageError('--diff belongs to show')
  return { action: actionOf(name as keyof typeof SUBCOMMANDS, argument, parsed.values.diff === true), profile: parsed.values.profile, json }
}

/**
 * @param name - the subcommand.
 * @param argument - its argument.
 * @param diff - whether `--diff` was given.
 * @returns the subcommand.
 * @throws {CliError} with the usage code for a malformed change id or protection level.
 */
function actionOf(name: keyof typeof SUBCOMMANDS, argument: string | undefined, diff: boolean): Requested {
  switch (name) {
    case 'list':
      return { kind: 'list' }
    case 'show':
    case 'apply':
    case 'discard':
    case 'undo': {
      const id = parseChangeId(argument!)
      if (id === undefined) throw usageError(`${JSON.stringify(argument)} is not a change id; ids look like c0123456789 (see delorun changes list)`)
      return name === 'show' ? { kind: 'show', id, diff } : { kind: name, id }
    }
    case 'off':
    case 'on':
      if (!PACKAGE_NAME_PATTERN.test(argument!)) throw usageError(`${JSON.stringify(argument)} is not a package name`)
      return { kind: name, plugin: argument! }
    case 'protection': {
      if (argument === undefined) return { kind: 'protection' }
      const level = PROTECTION_LEVELS.find(candidate => candidate === argument)
      if (level === undefined) throw usageError(`${JSON.stringify(argument)} is not a protection setting; use on or off`)
      return { kind: 'protection', level }
    }
  }
}

/**
 * Whether the profile's home process answers on the update channel.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns true when it answers `status`.
 */
async function homeAnswers(home: string, profile: string): Promise<boolean> {
  try {
    await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
    return true
  } catch (_notRunning) {
    // No token file, no socket or no answer: no home process runs for the profile.
    return false
  }
}

/**
 * Ask the running home process to reload its Host: C19's `changes.reload`.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the Host's answer, or a failure naming why the home process gave none.
 */
export async function reloadThroughChannel(home: string, profile: string): Promise<ReloadOutcome> {
  let lines
  try {
    lines = await sendHomeRequest(home, profile, { op: 'changes.reload' })
  } catch (error) {
    return { ok: false, error: `the home process did not answer: ${(error as Error).message}` }
  }
  const last = lines.at(-1)
  // C19's answer to `changes.reload` is `{"ok":true,"reload":{…}}`, or a refusal with its code.
  if (last?.ok === true && last.reload !== undefined) return last.reload as ReloadOutcome
  return { ok: false, error: `the home process refused the reload: ${String(last?.error)}` }
}

/**
 * Run a change with the Host's reload. While the profile's home process answers, the reload goes through its update
 * channel; otherwise this process holds the profile's home lock for the change, so no start runs meanwhile, and the
 * reload answers that Delorun is not running.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param run - the change, given the reload.
 * @returns what the change returned.
 * @throws {HomeLayoutError} `HOME_RUNNING` or `HOME_UNRESPONSIVE` when a start took the lock meanwhile.
 */
export async function withProfileHost<T>(home: string, profile: string, run: (reload: ReloadHost) => Promise<T>): Promise<T> {
  if (await homeAnswers(home, profile)) return run(() => reloadThroughChannel(home, profile))
  const lock = await acquireHomeLock({ runDirectory: runDirectory(home, profile), runtime: runtimeOfFile(home, fileURLToPath(import.meta.url)).version, probe: updateChannelProbe(home, profile), startId: newStartId() })
  try {
    return await run(() => Promise.resolve(undefined))
  } finally {
    lock.release()
  }
}

/**
 * The dependencies of a real run: this process's streams, the terminal's questions and the home process's reload.
 * @returns them.
 */
export function terminalDependencies(): ChangesCommandDependencies {
  return { streams: { stdin: process.stdin, stdout: process.stdout }, ask: askOnTerminal, withHost: withProfileHost, pluginOperation: upstreamPluginOperation, pageLines: pageLinesOf(process.stdout.rows), harness: runningHarness }
}

/**
 * The harness of the runtime this `delorun` runs, whose runtime store's warnings go to standard error.
 * @param home - the Delorun home.
 * @param context - the environment and output.
 * @param runtime - the runtime this `delorun` runs; this module's by default.
 * @returns the harness, or undefined outside the runtime store.
 */
export function runningHarness(home: string, context: CommandContext, runtime: RunningRuntime = runtimeOfFile(home, fileURLToPath(import.meta.url))): HarnessContext | undefined {
  return harnessContextOf(home, runtime, context.env, outputLogger(context))
}

/**
 * How many diff lines `apply` shows before it waits for the person.
 * @param rows - the terminal's height, when it reports one.
 * @returns the diff lines `apply` prints per page: the height less the prompt line and one line of context, and at
 *   least ten; 22 when the terminal reports no height.
 */
export function pageLinesOf(rows: number | undefined): number {
  return Math.max(10, (rows ?? 24) - 2)
}

/**
 * Print lines a command composed, each made safe for the terminal ({@link printableLines}): a line break, control or
 * bidirectional character in a file name, folder, diff, summary or failure message is written as an escape, and a long
 * line continues on the next.
 * @param write - the stream.
 * @param lines - the lines, without line endings.
 */
function print(write: (text: string) => void, lines: readonly string[]): void {
  write(`${lines.flatMap(line => printableLines(line)).join('\n')}\n`)
}

/** What each protection setting means, in the person's words. */
const PROTECTION_MEANING: Readonly<Record<ProtectionLevel, string>> = {
  on: "a changed plugin, an edit of Delorun itself and the agent's plugin installs and removals load only after you apply them, and the agent asks before it first changes an approved plugin in a chat",
  off: "changes load without your review and are still recorded: a changed plugin loads at the next start and when you save while Delorun runs, edits of Delorun itself apply at the next start, and the agent installs and removes plugins with the full-access approval alone; see and undo each with delorun changes list",
}

/**
 * @param change - a change waiting for review.
 * @returns its lines in the list.
 */
function pendingLines(change: ListedChange): string[] {
  const what = change.kind === 'plugin-install' ? 'new plugin' : `${String(change.files.length)} changed ${change.files.length === 1 ? 'file' : 'files'}`
  const failed = change.lastFailure === undefined ? [] : [`    It failed to load when applied: ${change.lastFailure.failure}`]
  return [`  ${change.id}  ${change.plugin} from ${change.source} (${what})`, ...failed]
}

/**
 * @param entry - an agent's plugin request waiting for review.
 * @returns its lines in the list.
 */
function requestLines(entry: ChangeEntry): string[] {
  const failed = entry.lastFailure === undefined ? [] : [`    Applying it failed: ${entry.lastFailure.failure}`]
  return [`  ${entry.id}  ${entry.summary} (asked in a chat)`, ...failed]
}

/**
 * Record that this terminal showed the plugins approved at upgrade, under the profile's write lock.
 * @param ctx - the profile.
 * @param approvals - the plugins shown.
 */
async function markShown(ctx: ChangesContext, approvals: readonly { readonly plugin: string }[]): Promise<void> {
  const plugins = approvals.map(({ plugin }) => plugin)
  await markShownAtUpgrade({ home: ctx.home, profile: ctx.profile, profileDir: ctx.profileDir, lockWaitMs: ctx.lockWaitMs ?? PROFILE_LOCK_WAIT_MS }, plugins, new Date().toISOString())
}

/**
 * @param entry - a logged change.
 * @returns its line in the list.
 */
function entryLine(entry: ChangeEntry): string {
  const failed = entry.lastFailure === undefined ? '' : ` (it failed to load: ${entry.lastFailure.failure})`
  return `  ${entry.id}  ${entry.state.padEnd(9)}  ${entry.decidedAt ?? entry.createdAt}  ${entry.summary}${failed}`
}

/**
 * `list`. The plugins the first start under Changes approved as they were lead the list until a terminal showed them;
 * a list printed to a terminal records that it did.
 * @param ctx - the profile.
 * @param json - whether to print JSON.
 * @param context - the output.
 * @param dependencies - the streams, which say whether the list reaches a terminal.
 * @returns the exit code.
 */
async function list(ctx: ChangesContext, json: boolean, context: CommandContext, dependencies: ChangesCommandDependencies): Promise<CommandResult> {
  const listing = await listChanges(ctx)
  const harness = await readHarnessListing(dependencies.harness(ctx.home, context), ctx.home)
  if (json) {
    context.stdout(`${printableJson({ ...listing, harness: { ...harness.listing, ...harness.problem === undefined ? {} : { problem: harness.problem } } })}\n`)
    return EXIT.ok
  }
  const harnessLines = harnessListLines(harness)
  // The first start under Changes logs each approval with its plugin and folder.
  const unshown = listing.entries.filter(unshownAtUpgrade).flatMap(({ subject: { plugin, source } }) => plugin === undefined || source === undefined ? [] : [{ plugin, source }])
  const waiting = [...listing.pending.flatMap(pendingLines), ...listing.requests.flatMap(requestLines), ...harnessLines.waiting]
  const lines = [
    ...unshown.length === 0 ? [] : [...unshown.map(upgradeLine), ''],
    ...waiting.length === 0 ? ['Nothing waits for your review.'] : ['Waiting for review:', ...waiting, 'See one with: delorun changes show <id>'],
  ]
  if (listing.leftOut.length > 0) lines.push('', 'Left out because Delorun did not start with them:', ...listing.leftOut.flatMap(entry => leftOutWords(leftOutFact(entry)).split('\n').map(line => `  ${line}`)))
  if (listing.entries.length > 0) lines.push('', 'Recent changes, newest first:', ...listing.entries.map(entryLine))
  lines.push(...harnessLines.others)
  for (const { plugin, source } of listing.missing) lines.push('', `The folder of ${plugin}, ${source}, is gone; its approved copy still runs.`)
  lines.push('', `Protection: ${listing.protection}: ${PROTECTION_MEANING[listing.protection]}.`)
  if (listing.workSession !== undefined) lines.push(`Working on ${listing.workSession.plugin} since ${listing.workSession.startedAt}, until ${listing.workSession.endsAt} at the latest: edits in its folder load live.`)
  print(context.stdout, lines)
  if (unshown.length > 0 && dependencies.streams.stdout.isTTY === true) await markShown(ctx, unshown)
  return EXIT.ok
}

/**
 * The lines that describe a change waiting for review.
 * @param change - the change.
 * @param diff - whether to include the diff.
 * @returns the lines.
 */
function changeLines(change: ListedChange, diff: boolean): string[] {
  const own = change.files.filter(file => !file.dependency)
  const dependencies = change.files.filter(file => file.dependency)
  const lines = [
    `Change ${change.id}: ${change.kind === 'plugin-install' ? 'a new plugin' : 'changes to a plugin'}, waiting for your review`,
    `Plugin: ${change.plugin}`,
    `Folder: ${change.source}`,
    'Files:',
    ...own.map(file => `  ${file.status.padEnd(8)}  ${file.path}`),
  ]
  if (dependencies.length > 0) lines.push(`Dependency files (${String(dependencies.length)}):`, ...dependencies.map(file => `  ${file.status.padEnd(8)}  ${file.path}`))
  if (change.skipped.length > 0) lines.push(`Not included: ${change.skipped.join(', ')}`)
  if (change.lastFailure !== undefined) lines.push(`It failed to load when applied at ${change.lastFailure.at}: ${change.lastFailure.failure}`)
  lines.push('', ...riskLines(change.risk))
  if (diff) lines.push('', ...diffLines(change))
  return lines
}

/**
 * Print a change's diff before `apply` asks, a page at a time when the dependencies give a page size: after each full
 * page but the last the person presses Enter for the next page, or answers `a` for the rest without stopping.
 * @param change - the change.
 * @param dependencies - the terminal and the page size.
 * @param context - the output.
 */
async function pagedDiff(change: { readonly diff: BoundedDiff }, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<void> {
  const lines = diffLines(change)
  const size = Math.max(1, dependencies.pageLines ?? lines.length)
  let at = 0
  while (at + size < lines.length) {
    print(context.stdout, lines.slice(at, at + size))
    at += size
    if ((await dependencies.ask('-- more: Enter shows the next page, a shows the rest --')).toLowerCase() === 'a') break
  }
  print(context.stdout, lines.slice(at))
}

/**
 * @param entry - a logged change.
 * @returns the lines that describe it.
 */
function entryLines(entry: ChangeEntry): string[] {
  const lines = [`Change ${entry.id}: ${entry.summary}`, `State: ${entry.state}${entry.decidedAt === undefined ? '' : ` since ${entry.decidedAt}`}`]
  if (isPluginRequest(entry)) {
    const spec = entry.subject.spec!
    lines.push(entry.kind === 'plugin-remove'
      ? `Asked for in a chat. Applying it removes ${spec} from the profile, as delorun plugin remove does.`
      : `Asked for in a chat. Applying it adds ${spec} to the profile, as delorun plugin add does; a folder is added with nothing loaded, and its content waits for your review.`)
  }
  if (entry.leftOut !== undefined) lines.push(`A start left it out at ${entry.leftOut.at} because it failed: ${entry.leftOut.failure}`)
  if (entry.lastFailure !== undefined) lines.push(`It failed to load at ${entry.lastFailure.at}: ${entry.lastFailure.failure}`)
  return lines
}

/** What a change id names: a plugin's change, or a change to the harness itself. */
type Target =
  | { readonly kind: 'plugin', readonly shown: ShownChange }
  | { readonly kind: 'harness', readonly target: HarnessTarget }

/**
 * Find what a change id names: a plugin's change first, then a change to the harness itself.
 * @param ctx - the profile.
 * @param harness - the running runtime's harness, or undefined outside the store.
 * @param id - the id.
 * @returns the change.
 * @throws {ChangesError} `UNKNOWN_CHANGE` when neither has the id; `CHANGED_SINCE_REVIEW`.
 */
async function targetOf(ctx: ChangesContext, harness: HarnessContext | undefined, id: ChangeId): Promise<Target> {
  try {
    return { kind: 'plugin', shown: await showChange(ctx, id) }
  } catch (error) {
    if (!isChangesError(error) || error.code !== 'UNKNOWN_CHANGE') throw error
    const target = await findHarnessTarget(harness, ctx.home, id)
    if (target === undefined) throw error
    return { kind: 'harness', target }
  }
}

/**
 * `show` of a plugin's change.
 * @param shown - the change.
 * @param id - the change id.
 * @param diff - whether to print the diff.
 * @param json - whether to print JSON.
 * @param context - the output.
 * @returns the exit code.
 */
function show(shown: ShownChange, id: ChangeId, diff: boolean, json: boolean, context: CommandContext): CommandResult {
  if (json) {
    context.stdout(`${printableJson(shown)}\n`)
    return EXIT.ok
  }
  const decide = `Apply it: delorun changes apply ${id}    Discard it: delorun changes discard ${id}`
  const lines = shown.kind === 'pending'
    ? [...changeLines(shown.change, diff), '', decide]
    : [...entryLines(shown.entry), ...isPluginRequest(shown.entry) && shown.entry.state === 'pending' ? ['', decide] : []]
  print(context.stdout, lines)
  return EXIT.ok
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
 * Report what an action did.
 * @param done - what the person reads first, such as `Applied c0123456789`.
 * @param result - the action's result.
 * @param context - the output.
 * @returns the exit code: failed when the Host went back.
 */
function reported(done: string, result: ActionResult, context: CommandContext): CommandResult {
  switch (result.reload.kind) {
    case 'reloaded':
      context.stdout(`${done}. Delorun runs it now.\n`)
      return EXIT.ok
    case 'not-running':
      context.stdout(`${done}. Delorun is not running; the next start runs it.\n`)
      return EXIT.ok
    case 'went-back': {
      const { failure, again } = result.reload
      print(context.stderr, [`delorun changes: ${done}, but Delorun failed to load it: ${failure}`, 'Delorun went back to what ran before, and the change waits for your review again.'])
      if (again?.ok === false) print(context.stderr, [`Loading what ran before also failed: ${again.error}. Restart Delorun: delorun stop, then delorun start.`])
      return EXIT.failed
    }
  }
}

/**
 * `apply`: the summary and risk lines, the diff a page at a time, a confirmation, a second one naming the kinds the
 * checks flagged and each file whose content the diff does not show, and the change.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param shown - the change.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal and the Host.
 * @param context - the output.
 * @returns the exit code.
 */
async function apply(ctx: ChangesContext, id: ChangeId, shown: ShownChange, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  if (shown.kind === 'pending') {
    print(context.stdout, [...changeLines(shown.change, false), ''])
    await pagedDiff(shown.change, dependencies, context)
    context.stdout('\n')
  } else {
    print(context.stdout, [...entryLines(shown.entry), ''])
  }
  if (!await confirmed(dependencies, `Apply ${id}?`)) return declined(context)
  if (shown.kind === 'logged' && isPluginRequest(shown.entry)) {
    const operation = dependencies.pluginOperation(ctx, context)
    return reportedInstall(id, await dependencies.withHost(ctx.home, ctx.profile, reload => applyInstallChange(ctx, id, presence, { reload, run: operation })), context)
  }
  if (shown.kind === 'pending' && shown.change.risk.needsSecondConfirmation) {
    const { risk } = shown.change
    const kinds = risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')
    const hidden = risk.findings.filter(finding => finding.kind === 'not-shown').map(finding => `  Not shown: ${finding.excerpt}`)
    print(context.stdout, [`This change ${kinds}. A plugin's code can do anything Delorun can.`, ...hidden])
    if (!await confirmed(dependencies, `Apply it anyway?`)) return declined(context)
  }
  const result = await dependencies.withHost(ctx.home, ctx.profile, reload => applyChange(ctx, id, presence, { reload }))
  return reported(`Applied ${id}`, result, context)
}

/**
 * Report what applying an agent's plugin request did.
 * @param id - the change id.
 * @param result - what applying it did.
 * @param context - the output.
 * @returns the exit code: failed when the running Host failed to load it.
 */
function reportedInstall(id: ChangeId, result: InstallResult, context: CommandContext): CommandResult {
  const folder = result.folderChange === undefined ? '' : ` Its folder's content waits for your review: delorun changes show ${result.folderChange}`
  switch (result.reload.kind) {
    case 'reloaded':
      context.stdout(`Applied ${id}. Delorun runs it now.${folder}\n`)
      return EXIT.ok
    case 'not-running':
      context.stdout(`Applied ${id}. Delorun is not running; the next start runs it.${folder}\n`)
      return EXIT.ok
    case 'failed':
      print(context.stderr, [`delorun changes: Applied ${id}, but Delorun failed to load it: ${result.reload.failure}`, `The profile keeps the change; restart Delorun, or undo it with delorun recover.${folder}`])
      return EXIT.failed
  }
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
 * `protection`: print the setting, or change it after stating what the new setting means and asking.
 * @param ctx - the profile.
 * @param level - the new level, or undefined to print the setting.
 * @param presence - the terminal proof when a level is given.
 * @param dependencies - the terminal.
 * @param context - the output.
 * @returns the exit code.
 */
async function protection(ctx: ChangesContext, level: ProtectionLevel | undefined, presence: AtComputer | undefined, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  if (level === undefined) {
    const current = await readProtection(ctx.home)
    context.stdout(`Protection: ${current}: ${PROTECTION_MEANING[current]}.\nChange it in a terminal: delorun changes protection on|off\n`)
    return EXIT.ok
  }
  context.stdout(level === 'off'
    ? `Changes will load without your review. With protection off, ${PROTECTION_MEANING.off}.\n`
    : `Changes will wait for your review. With protection on, ${PROTECTION_MEANING.on}.\n`)
  if (!await confirmed(dependencies, `Turn protection ${level}?`)) return declined(context)
  const changed = await changeProtection(ctx, level, presence!)
  context.stdout(`Protection is ${changed.level} (it was ${changed.before}). Delorun uses it from its next decision, without a restart.\n`)
  return EXIT.ok
}

/**
 * @param dependencies - the streams.
 * @returns the terminal proof.
 * @throws {CliError} with {@link NOT_AT_TERMINAL} when standard input or output is not a terminal.
 */
function attestAtTerminal(dependencies: ChangesCommandDependencies): AtComputer {
  try {
    return attestTerminal(dependencies.streams)
  } catch (error) {
    if (!isChangesError(error)) throw error
    throw new CliError(EXIT.failed, `delorun changes: ${NOT_AT_TERMINAL}`)
  }
}

/**
 * Run `delorun changes`.
 * @param args - the arguments after `changes`.
 * @param context - the environment and output.
 * @param dependencies - the terminal and the Host; this process's by default.
 * @returns the exit code.
 */
export async function runChanges(args: readonly string[], context: CommandContext, dependencies: ChangesCommandDependencies = terminalDependencies()): Promise<CommandResult> {
  if (isWorkSubcommand(args)) return runWorkCommand(args, context, dependencies, () => attestAtTerminal(dependencies))
  if (isHarnessSubcommand(args)) return runHarnessCommand(args, context, dependencies, () => attestAtTerminal(dependencies))
  const { action, profile: profileFlag, json } = requested(args)
  // A change needs the person at the terminal before anything is read or written, the home's tree included.
  const reads = action.kind === 'list' || action.kind === 'show' || (action.kind === 'protection' && action.level === undefined)
  const presence = reads ? undefined : attestAtTerminal(dependencies)
  const { home, profile } = await prepareHome(context, profileFlag)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun changes: the CLI profile ${profile} is not set up in ${home.path}; run: delorun setup`)
  const ctx: ChangesContext = { home: home.path, profile, profileDir: profileDirectory(home.path, profile) }
  try {
    switch (action.kind) {
      case 'list':
        return await list(ctx, json, context, dependencies)
      case 'show': {
        const harness = dependencies.harness(home.path, context)
        const target = await targetOf(ctx, harness, action.id)
        return target.kind === 'plugin' ? show(target.shown, action.id, action.diff, json, context) : await showHarness(harness, target.target, action.diff, json, context)
      }
      case 'protection':
        return await protection(ctx, action.level, presence, dependencies, context)
      case 'apply': {
        const harness = dependencies.harness(home.path, context)
        const target = await targetOf(ctx, harness, action.id)
        if (target.kind === 'harness') return await applyHarness(harness, target.target, presence!, dependencies, context, change => pagedDiff(change, dependencies, context))
        return await apply(ctx, action.id, target.shown, presence!, dependencies, context)
      }
      case 'discard': {
        const harness = dependencies.harness(home.path, context)
        const target = await targetOf(ctx, harness, action.id)
        if (target.kind === 'harness') return await discardHarness(harness, target.target, presence!, dependencies, context)
        const { shown } = target
        print(context.stdout, [...shown.kind === 'pending' ? changeLines(shown.change, false) : entryLines(shown.entry), ''])
        if (!await confirmed(dependencies, `Discard ${action.id}? It will not run, and your folder stays as it is.`)) return declined(context)
        await dependencies.withHost(home.path, profile, () => discardChange(ctx, action.id, presence!))
        context.stdout(`Discarded ${action.id}; it shows again when the folder changes.\n`)
        return EXIT.ok
      }
      case 'undo': {
        const harness = dependencies.harness(home.path, context)
        const target = await targetOf(ctx, harness, action.id)
        if (target.kind === 'harness') return await undoHarness(harness, target.target, presence!, dependencies, context)
        const { shown } = target
        if (!await confirmed(dependencies, `Undo ${action.id}: ${printable(shown.kind === 'pending' ? shown.change.plugin : shown.entry.summary)}?`)) return declined(context)
        return reported(`Undid ${action.id}`, await dependencies.withHost(home.path, profile, reload => undoChange(ctx, action.id, presence!, { reload })), context)
      }
      case 'off':
      case 'on': {
        const question = action.kind === 'off' ? `Turn off ${action.plugin}? It stops running until you turn it on again.` : `Turn on ${action.plugin}?`
        if (!await confirmed(dependencies, question)) return declined(context)
        const result = await dependencies.withHost(home.path, profile, reload => (action.kind === 'off' ? turnOff : turnOn)(ctx, action.plugin, presence!, { reload }))
        return reported(`Turned ${action.kind} ${action.plugin}`, result, context)
      }
    }
  } catch (error) {
    if (!isChangesError(error)) throw error
    print(context.stderr, [`delorun changes: ${error.detail}`])
    return EXIT.failed
  }
}

/** `delorun changes`: review, apply, discard and undo changes to what Delorun runs. */
export const changesCommand: CliCommand = {
  name: 'changes',
  summary: 'What waits for your review, and apply <id>, discard <id>, undo <id>, off <plugin>, on <plugin>, protection, work <plugin>, done <plugin>, edit-harness',
  run: (args, context) => runChanges(args, context),
}
