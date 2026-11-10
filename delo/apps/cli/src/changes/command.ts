/**
 * `delorun changes` (contract C21, "Commands"): what waits for your review, and applying, discarding and undoing a
 * change, turning one plugin off or on, the protection setting, and working on a plugin with live reload.
 *
 * | Subcommand | What it does |
 * | --- | --- |
 * | `list` (the default) `[--json]` | changes waiting for review, then the decided ones, the protection setting and any work session |
 * | `show <id> [--diff] [--json]` | one change: the plugin, its folder, the files, the risk summary and, with `--diff`, the diff |
 * | `apply <id>` | the plugin runs exactly the content the change showed; a change with a risk finding asks twice; an agent's plugin request runs upstream's plugin operation for its spec |
 * | `discard <id>` | the change never runs; the folder is not touched |
 * | `undo <id>` | an applied change is taken back |
 * | `off <plugin>`, `on <plugin>` | one plugin stops running, or runs again |
 * | `protection [block \| warn \| off]` | prints the setting, or changes it |
 * | `work <plugin>`, `done <plugin>` | edits in the plugin's folder load live, until `done` makes them its approved version |
 *
 * Every subcommand that changes something first needs the person at a terminal, standard input and output both, and
 * refuses otherwise before it reads or writes anything; then it asks for confirmation. While Delo runs for the profile,
 * the change is written under the profile's write lock and the running Host reloads through the update channel's
 * `changes.reload`; while it does not, the command holds the profile's home lock, so no start runs meanwhile, and the
 * next start loads the change.
 *
 * @module @delo/cli/changes/command
 */
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  applyChange,
  applyInstallChange,
  attestTerminal,
  changeProtection,
  discardChange,
  finishWork,
  isChangesError,
  isPluginRequest,
  listChanges,
  parseChangeId,
  PROTECTION_LEVELS,
  readProtection,
  riskKindPhrase,
  riskLines,
  showChange,
  startWork,
  turnOff,
  turnOn,
  undoChange,
  workFinishedLine,
  type ActionResult,
  type AtComputer,
  type ChangeEntry,
  type ChangeId,
  type ChangesContext,
  type InstallResult,
  type ListedChange,
  type PluginOperation,
  type ProtectionLevel,
  type ReloadHost,
  type ReloadOutcome,
  type WorkStarted,
} from '@delo/changes'
import { HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import { acquireHomeLock, newStartId, runDirectory } from '@delo/home'
import { queryHomeStatus, sendHomeRequest, updateChannelProbe } from '@delo/home-process'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { askOnTerminal, isYes } from '../trash/terminal.ts'
import { runtimeOfFile } from '../update/runtime.ts'
import { upstreamPluginOperation } from './plugin-operation.ts'

/** The usage line. */
const USAGE = 'usage: delorun changes [list | show <id> [--diff] | apply <id> | discard <id> | undo <id> | off <plugin> | on <plugin> | protection [block|warn|off] | work <plugin> | done <plugin>] [--profile <name>] [--json]'

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
   * @param home - the Delo home.
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
}

/** One subcommand and its argument. */
type Requested =
  | { readonly kind: 'list' }
  | { readonly kind: 'show', readonly id: ChangeId, readonly diff: boolean }
  | { readonly kind: 'apply' | 'discard' | 'undo', readonly id: ChangeId }
  | { readonly kind: 'off' | 'on' | 'work' | 'done', readonly plugin: string }
  | { readonly kind: 'protection', readonly level?: ProtectionLevel }

/** The subcommands, in usage order, and whether each takes an argument. */
const SUBCOMMANDS = { list: 'none', show: 'id', apply: 'id', discard: 'id', undo: 'id', off: 'plugin', on: 'plugin', protection: 'optional', work: 'plugin', done: 'plugin' } as const

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
    case 'work':
    case 'done':
      return { kind: name, plugin: argument! }
    case 'protection': {
      if (argument === undefined) return { kind: 'protection' }
      const level = PROTECTION_LEVELS.find(candidate => candidate === argument)
      if (level === undefined) throw usageError(`${JSON.stringify(argument)} is not a protection level; use block, warn or off`)
      return { kind: 'protection', level }
    }
  }
}

/**
 * Whether the profile's home process answers on the update channel.
 * @param home - the Delo home.
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
 * @param home - the Delo home.
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
 * reload answers that Delo is not running.
 * @param home - the Delo home.
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
  return { streams: { stdin: process.stdin, stdout: process.stdout }, ask: askOnTerminal, withHost: withProfileHost, pluginOperation: upstreamPluginOperation }
}

/** What each protection level means, in the person's words. */
const PROTECTION_MEANING: Readonly<Record<ProtectionLevel, string>> = {
  block: 'changed plugins run only after you apply their changes',
  warn: 'changed plugins run without your review, and every start names them',
  off: 'changed plugins run without your review, and nothing says so',
}

/**
 * @param change - a change waiting for review.
 * @returns its line in the list.
 */
function pendingLine(change: ListedChange): string {
  const what = change.kind === 'plugin-install' ? 'new plugin' : `${String(change.files.length)} changed ${change.files.length === 1 ? 'file' : 'files'}`
  const failed = change.lastFailure === undefined ? '' : `\n    It failed to load when applied: ${change.lastFailure.failure}`
  return `  ${change.id}  ${change.plugin} from ${change.source} (${what})${failed}`
}

/**
 * @param entry - an agent's plugin request waiting for review.
 * @returns its line in the list.
 */
function requestLine(entry: ChangeEntry): string {
  const failed = entry.lastFailure === undefined ? '' : `\n    Applying it failed: ${entry.lastFailure.failure}`
  return `  ${entry.id}  ${entry.summary} (asked in a chat)${failed}`
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
 * `list`.
 * @param ctx - the profile.
 * @param json - whether to print JSON.
 * @param context - the output.
 * @returns the exit code.
 */
async function list(ctx: ChangesContext, json: boolean, context: CommandContext): Promise<CommandResult> {
  const listing = await listChanges(ctx)
  if (json) {
    context.stdout(`${JSON.stringify(listing, undefined, 2)}\n`)
    return EXIT.ok
  }
  const waiting = [...listing.pending.map(pendingLine), ...listing.requests.map(requestLine)]
  const lines = waiting.length === 0
    ? ['Nothing waits for your review.']
    : ['Waiting for review:', ...waiting, 'See one with: delorun changes show <id>']
  if (listing.entries.length > 0) lines.push('', 'Recent changes, newest first:', ...listing.entries.map(entryLine))
  for (const { plugin, source } of listing.missing) lines.push('', `The folder of ${plugin}, ${source}, is gone; its approved copy still runs.`)
  lines.push('', `Protection: ${listing.protection}: ${PROTECTION_MEANING[listing.protection]}.`)
  if (listing.workSession !== undefined) lines.push(`Working on ${listing.workSession.plugin} since ${listing.workSession.startedAt}: edits in its folder load live.`)
  context.stdout(`${lines.join('\n')}\n`)
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
  if (diff) {
    lines.push('', change.diff.text.trimEnd())
    if (change.diff.truncated) lines.push(`The diff was cut short at its size limit; left out: ${change.diff.omitted.join(', ')}`)
  }
  return lines
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
  if (entry.lastFailure !== undefined) lines.push(`It failed to load at ${entry.lastFailure.at}: ${entry.lastFailure.failure}`)
  return lines
}

/**
 * `show`.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param diff - whether to print the diff.
 * @param json - whether to print JSON.
 * @param context - the output.
 * @returns the exit code.
 */
async function show(ctx: ChangesContext, id: ChangeId, diff: boolean, json: boolean, context: CommandContext): Promise<CommandResult> {
  const shown = await showChange(ctx, id)
  if (json) {
    context.stdout(`${JSON.stringify(shown, undefined, 2)}\n`)
    return EXIT.ok
  }
  const decide = `Apply it: delorun changes apply ${id}    Discard it: delorun changes discard ${id}`
  const lines = shown.kind === 'pending'
    ? [...changeLines(shown.change, diff), '', decide]
    : [...entryLines(shown.entry), ...isPluginRequest(shown.entry) && shown.entry.state === 'pending' ? ['', decide] : []]
  context.stdout(`${lines.join('\n')}\n`)
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
      context.stdout(`${done}. Delo runs it now.\n`)
      return EXIT.ok
    case 'not-running':
      context.stdout(`${done}. Delo is not running; the next start runs it.\n`)
      return EXIT.ok
    case 'went-back': {
      const { failure, again } = result.reload
      context.stderr(`delorun changes: ${done}, but Delo failed to load it: ${failure}\nDelo went back to what ran before, and the change waits for your review again.\n`)
      if (again?.ok === false) context.stderr(`Loading what ran before also failed: ${again.error}. Restart Delo: delorun stop, then delorun start.\n`)
      return EXIT.failed
    }
  }
}

/**
 * `apply`: the summary and risk lines, a confirmation, a second one naming the risk kinds when a check found any, and
 * the change.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param presence - the terminal proof.
 * @param dependencies - the terminal and the Host.
 * @param context - the output.
 * @returns the exit code.
 */
async function apply(ctx: ChangesContext, id: ChangeId, presence: AtComputer, dependencies: ChangesCommandDependencies, context: CommandContext): Promise<CommandResult> {
  const shown = await showChange(ctx, id)
  context.stdout(`${(shown.kind === 'pending' ? changeLines(shown.change, false) : entryLines(shown.entry)).join('\n')}\n\n`)
  if (!await confirmed(dependencies, `Apply ${id}?`)) return declined(context)
  if (shown.kind === 'logged' && isPluginRequest(shown.entry)) {
    const operation = dependencies.pluginOperation(ctx, context)
    return reportedInstall(id, await dependencies.withHost(ctx.home, ctx.profile, reload => applyInstallChange(ctx, id, presence, { reload, run: operation })), context)
  }
  if (shown.kind === 'pending' && shown.change.risk.needsSecondConfirmation) {
    const kinds = shown.change.risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')
    context.stdout(`This change ${kinds}. A plugin's code can do anything Delo can.\n`)
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
      context.stdout(`Applied ${id}. Delo runs it now.${folder}\n`)
      return EXIT.ok
    case 'not-running':
      context.stdout(`Applied ${id}. Delo is not running; the next start runs it.${folder}\n`)
      return EXIT.ok
    case 'failed':
      context.stderr(`delorun changes: Applied ${id}, but Delo failed to load it: ${result.reload.failure}\nThe profile keeps the change; restart Delo, or undo it with delorun recover.${folder}\n`)
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
 * `protection`: print the setting, or change it after stating what a weaker one means and asking.
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
    context.stdout(`Protection: ${current}: ${PROTECTION_MEANING[current]}.\nChange it in a terminal: delorun changes protection block|warn|off\n`)
    return EXIT.ok
  }
  if (level !== 'block') {
    context.stdout(`Changed plugins will run without your review. With ${level}, ${PROTECTION_MEANING[level]}.\n`)
    if (!await confirmed(dependencies, `Set protection to ${level}?`)) return declined(context)
  }
  const changed = await changeProtection(ctx, level, presence!)
  context.stdout(`Protection is ${changed.level} (it was ${changed.before}); the next start uses it.\n`)
  return EXIT.ok
}

/**
 * Report how a work session started.
 * @param started - what starting it did.
 * @param context - the output.
 * @returns the exit code: failed when the folder's content failed to load.
 */
function reportedWork(started: WorkStarted, context: CommandContext): CommandResult {
  const { plugin, source } = started.session
  context.stdout(`Working on ${plugin}: edits in ${source} load live until delorun changes done ${plugin}.\n`)
  if (started.load.kind === 'loaded') return EXIT.ok
  const { failure, again } = started.load
  context.stderr(`delorun changes: ${plugin} failed to load from its folder: ${failure}\nDelo runs its approved version; your work session stays open, and the next edit in the folder loads again.\n`)
  if (again?.ok === false) context.stderr(`Loading the approved version also failed: ${again.error}. Restart Delo: delorun stop, then delorun start.\n`)
  return EXIT.failed
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
        return await list(ctx, json, context)
      case 'show':
        return await show(ctx, action.id, action.diff, json, context)
      case 'protection':
        return await protection(ctx, action.level, presence, dependencies, context)
      case 'apply':
        return await apply(ctx, action.id, presence!, dependencies, context)
      case 'discard': {
        const shown = await showChange(ctx, action.id)
        context.stdout(`${(shown.kind === 'pending' ? changeLines(shown.change, false) : entryLines(shown.entry)).join('\n')}\n\n`)
        if (!await confirmed(dependencies, `Discard ${action.id}? It will not run, and your folder stays as it is.`)) return declined(context)
        await dependencies.withHost(home.path, profile, () => discardChange(ctx, action.id, presence!))
        context.stdout(`Discarded ${action.id}; it shows again when the folder changes.\n`)
        return EXIT.ok
      }
      case 'undo': {
        const shown = await showChange(ctx, action.id)
        if (!await confirmed(dependencies, `Undo ${action.id}: ${shown.kind === 'pending' ? shown.change.plugin : shown.entry.summary}?`)) return declined(context)
        return reported(`Undid ${action.id}`, await dependencies.withHost(home.path, profile, reload => undoChange(ctx, action.id, presence!, { reload })), context)
      }
      case 'off':
      case 'on': {
        const question = action.kind === 'off' ? `Turn off ${action.plugin}? It stops running until you turn it on again.` : `Turn on ${action.plugin}?`
        if (!await confirmed(dependencies, question)) return declined(context)
        const result = await dependencies.withHost(home.path, profile, reload => (action.kind === 'off' ? turnOff : turnOn)(ctx, action.plugin, presence!, { reload }))
        return reported(`Turned ${action.kind} ${action.plugin}`, result, context)
      }
      case 'work': {
        if (!await confirmed(dependencies, `Work on ${action.plugin}? Edits in its folder will load without your review until you run delorun changes done ${action.plugin}.`)) return declined(context)
        return reportedWork(await dependencies.withHost(home.path, profile, reload => startWork(ctx, action.plugin, presence!, { reload })), context)
      }
      case 'done': {
        if (!await confirmed(dependencies, `End your work session on ${action.plugin}? What its folder holds becomes the approved version.`)) return declined(context)
        const finished = await dependencies.withHost(home.path, profile, reload => finishWork(ctx, action.plugin, presence!, { reload }))
        context.stdout(`Your work session on ${action.plugin} ended. ${workFinishedLine(finished)}\n`)
        return EXIT.ok
      }
    }
  } catch (error) {
    if (!isChangesError(error)) throw error
    context.stderr(`delorun changes: ${error.detail}\n`)
    return EXIT.failed
  }
}

/** `delorun changes`: review, apply, discard and undo changes to what Delo runs. */
export const changesCommand: CliCommand = {
  name: 'changes',
  summary: 'What waits for your review, and apply <id>, discard <id>, undo <id>, off <plugin>, on <plugin>, protection, work <plugin>, done <plugin>',
  run: (args, context) => runChanges(args, context),
}
