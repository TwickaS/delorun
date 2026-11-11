/**
 * A start that fails right after a change starts again without that change (contract C21, "When a start fails"). A
 * failed upstream boot cannot be repeated in the same process, so the second start is a new `delorun start
 * --foreground` process.
 *
 * - A fresh start of the home process (never an update's successor, never the second start itself) whose profile
 *   runner throws, whose booted Host is refused, or in which a row of the plugin of the newest change Changes may leave
 *   out did not activate, leaves that change out ([`@delo/changes`](../../../../packages/changes/src/left-out.ts)) and
 *   fails with {@link EXIT.changeLeftOut} and words that name it. Nothing in the profile is written: the second start's
 *   pre-start step `changes` makes the plugin's active directory hold what it held before the change.
 * - In the terminal, the start prints those words and runs `delorun start --foreground` once more in a child process
 *   with the same terminal and {@link CHANGES_RETRY_ENV}, forwarding `SIGTERM` and `SIGHUP` to it; the child's exit code
 *   becomes this process's.
 * - `delorun start` in the background marks its child with {@link CHANGES_STARTER_ENV}, so the child exits with the code
 *   instead, and starts it once more with {@link CHANGES_RETRY_ENV}.
 * - The second start never leaves a change out; when it fails, the start prints {@link SECOND_FAILURE_LINE}.
 * - When the signed installation handed off and the composed tree's `delorun` exited with a failure before its start ran
 *   ([harness start](./harness-start.ts)), the signed process leaves the runtime's newest harness change out, prints the
 *   words that name it and starts once more in the same process with {@link CHANGES_RETRY_ENV} set, through the same
 *   decision, which composes without the change or runs the signed installation ({@link retryHandOff}). A start already
 *   marked as the second one, or one with no harness change to leave out, prints {@link harnessFailureWords} instead.
 *
 * Both markers are read from the environment `delorun` was started with and removed from this process's environment,
 * so nothing the Host starts inherits them. Neither weakens a check: the retry marker only stops a start from leaving a
 * change out, and the starter marker only hands the second start to the starter.
 *
 * @module @delo/cli/changes/retry
 */
import { isChangesError, lastLeftOut, leaveOutNewestChange, leaveOutNewestHarnessChange, leftOutFact, leftOutWords, newestAppliedHarnessChange, newestLeavableChange, pluginRows, SECOND_FAILURE_LINE, type ChangeId } from '@delo/changes'
import type { DeloLogger } from '@delo/logs'
import type { CommandOutput, CommandResult } from '../command.ts'
import type { BootedRow } from '../delo-bundles.ts'
import { CliError, EXIT } from '../exit.ts'
import { profileDirectory } from '../profile.ts'
import { printableText } from '../terminal-text.ts'
import { runChild, startEntry } from './harness-start.ts'

export { SECOND_FAILURE_LINE }

/** Set to `1` on the second start, which leaves no change out. */
export const CHANGES_RETRY_ENV = 'DELO_CHANGES_RETRY'

/** Set to `detached` on a home process `delorun start` started in the background, whose starter runs the second start. */
export const CHANGES_STARTER_ENV = 'DELO_CHANGES_STARTER'

/** The environment a start reads its markers from. */
type Environment = Readonly<Record<string, string | undefined>>

/** The start a {@link StartRetry} is for. */
export interface StartRetryRequest {
  /** The Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The environment `delorun` was started with. */
  readonly env: Environment
  /** Whether this start is an update's or a rollback's successor, which never leaves a change out. */
  readonly successor: boolean
  /** Where the second start's failure line goes. */
  readonly output: CommandOutput
  /** The home process's logger, which records a failure to leave a change out. */
  readonly logger: DeloLogger
  /** The runtime version the start runs from the runtime store, whose harness changes it may leave out; absent outside the store. */
  readonly runtime?: string
}

/**
 * What a start's failure paths call. Only a fresh first start (`first`) checks rows and leaves a change out; the second
 * start (`retry`) prints {@link SECOND_FAILURE_LINE} when it fails; a successor (`none`) does neither.
 */
export interface StartRetry {
  readonly role: 'first' | 'retry' | 'none'
  /**
   * Refuse a booted Host in which a row of the plugin of the newest change Changes may leave out did not activate.
   * @param rows - the Loader's rows after startup settled.
   * @throws {CliError} naming the plugin and its rows; the caller stops the Host and calls {@link StartRetry.afterFailure}.
   */
  readonly checkRows: (rows: readonly BootedRow[]) => Promise<void>
  /**
   * Leave the newest change out after the boot failed or the booted Host was refused.
   * @param error - what the start failed with; its message is recorded.
   * @returns when nothing was left out, so the caller reports the failure as before.
   * @throws {CliError} {@link EXIT.changeLeftOut}, with the words that name the change, when a change was left out.
   */
  readonly afterFailure: (error: unknown) => Promise<void>
  /** Print {@link SECOND_FAILURE_LINE} when the second start failed. */
  readonly stopped: () => void
}

/**
 * @param error - a thrown value.
 * @returns its message, without a stack.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param error - a thrown value.
 * @returns its words for the person: a Changes failure's detail, otherwise its message.
 */
function detailOf(error: unknown): string {
  return isChangesError(error) ? error.detail : messageOf(error)
}

/**
 * @param text - one or more lines of words.
 * @returns them escaped and wrapped for the terminal, each ending in a line break.
 */
function printed(text: string): string {
  return printableText(text).map(line => `${line}\n`).join('')
}

/**
 * The retry part of one start of the home process. Removes both markers from this process's environment.
 * @param request - the home, the profile, the start's environment, whether it is a successor, the output and the logger.
 * @returns what the start's failure paths call.
 */
export function startRetry(request: StartRetryRequest): StartRetry {
  const { home, profile, logger } = request
  delete process.env[CHANGES_RETRY_ENV]
  delete process.env[CHANGES_STARTER_ENV]
  const role = request.successor ? 'none' : request.env[CHANGES_RETRY_ENV] === '1' ? 'retry' : 'first'
  const ctx = { home, profile, profileDir: profileDirectory(home, profile) }
  /**
   * @param what - what Delo could not do, for the log.
   * @param error - why.
   */
  const warn = (what: string, error: unknown): void => {
    logger.warn(`${what}: ${detailOf(error)}`)
  }
  return {
    role,
    async checkRows(rows) {
      if (role !== 'first') return
      const newest = await newestLeavableChange(ctx, request.runtime).catch((error: unknown) => {
        warn('Delo could not read which change it would leave out', error)
        return undefined
      })
      // A change to the harness itself has no rows of its own; the start's failure decides it.
      if (newest === undefined || newest.kind === 'harness-edit') return
      const plugin = newest.subject.plugin!
      const inactive = pluginRows(plugin, rows).filter(row => !row.disabled && row.state !== 'active')
      if (inactive.length > 0) throw new CliError(EXIT.failed, `${plugin} did not load: ${inactive.map(row => `row ${row.id} is ${row.state}`).join(', ')}`)
    },
    async afterFailure(error) {
      if (role !== 'first') return
      const entry = await leaveOutNewestChange(ctx, messageOf(error), request.runtime).catch((leaveError: unknown) => {
        warn('Delo could not leave the newest change out after the start failed', leaveError)
        return undefined
      })
      if (entry !== undefined) throw new CliError(EXIT.changeLeftOut, leftOutWords(leftOutFact(entry)))
    },
    stopped() {
      if (role === 'retry') request.output.stderr(`${SECOND_FAILURE_LINE}\n`)
    },
  }
}

/** The foreground start the second start repeats. */
export interface ForegroundRequest {
  /** The CLI profile. */
  readonly profile: string
  /** Whether the studio opens once Delo runs. */
  readonly open: boolean
  /** Where the words go. */
  readonly output: CommandOutput
  /** The environment `delorun` was started with. */
  readonly env: Environment
}

/**
 * How the second foreground start runs: `delorun start --foreground` with {@link CHANGES_RETRY_ENV} set.
 * @param request - the profile, the studio choice and the environment.
 * @returns the command's result.
 */
export type ForegroundRelaunch = (request: ForegroundRequest) => Promise<CommandResult>

/**
 * Run a foreground start, and when it left a change out, print the words that name it and run the second start. A
 * home process `delorun start` started in the background lets its starter run the second start instead.
 * @param request - the profile, the studio choice, the output and the environment.
 * @param start - the first start.
 * @param relaunch - the second start; {@link relaunchForeground} in a real start.
 * @returns the first start's result, or the second start's.
 * @throws what the first start threw, unless it left a change out in the terminal.
 */
export async function retryForeground(request: ForegroundRequest, start: () => Promise<CommandResult>, relaunch: ForegroundRelaunch): Promise<CommandResult> {
  try {
    return await start()
  } catch (error) {
    if (!(error instanceof CliError) || error.exit !== EXIT.changeLeftOut || request.env[CHANGES_STARTER_ENV] === 'detached') throw error
    request.output.stderr(printed(error.message))
    return relaunch(request)
  }
}

/**
 * Run the second foreground start in a child process with this terminal: `delorun start --foreground` for the same
 * profile, with `--open` when the first start opened the studio, and {@link CHANGES_RETRY_ENV} set. The child is the
 * signed installation's `delorun` ([harness start](./harness-start.ts)), never a composed tree's, so the signed code
 * composes the harness again without a harness change the first start left out. This process forwards `SIGTERM` and
 * `SIGHUP` to it and leaves `SIGINT`, which the terminal sends to both, to the child.
 * @param request - the profile, the studio choice and the environment `delorun` was started with.
 * @param command - the command's entry point, Node's options, such as a source checkout's loader, and the Node
 *   executable; this process's by default, mapped to the signed installation by {@link startEntry}.
 * @returns `undefined`, with this process's exit code set to the child's, or to {@link EXIT.failed} when a signal ended
 *   it.
 * @throws {CliError} when the entry point is unknown or the child cannot be started.
 */
export function relaunchForeground(request: ForegroundRequest, command: { readonly entry: string | undefined, readonly execArgv: readonly string[], readonly node?: string } = { entry: process.argv[1], execArgv: process.execArgv }): Promise<CommandResult> {
  const { entry, execArgv } = command
  if (entry === undefined) return Promise.reject(new CliError(EXIT.failed, 'delorun: the command\'s own entry point is unknown, so Delo cannot start again without the change'))
  const signed = startEntry({ node: command.node ?? process.execPath, entry })
  return runChild(
    { node: signed.node, args: [...execArgv, signed.entry, 'start', '--foreground', '--profile', request.profile, ...request.open ? ['--open'] : []] },
    { ...request.env, [CHANGES_RETRY_ENV]: '1' },
    'inherit',
    'delorun: Delo could not start again without the change',
  )
}

/** How one background start ended. */
export type DetachedOutcome =
  /** The home process reported `running`. */
  | { readonly kind: 'running' }
  /** It exited before it ran, with this code. */
  | { readonly kind: 'exited', readonly code: number | null }
  /** It did not report `running` in time. */
  | { readonly kind: 'timeout' }

/**
 * Start the home process in the background, and when it exited with {@link EXIT.changeLeftOut}, print the words that
 * name the change it left out and start it once more without it.
 * @param request - the home, the profile and the output.
 * @param launch - starts the home process detached with these variables added and waits for it.
 * @returns {@link EXIT.ok} when a start runs, otherwise {@link EXIT.failed}.
 */
export async function retryDetached(request: { readonly home: string, readonly profile: string, readonly output: CommandOutput }, launch: (variables: Readonly<Record<string, string>>) => Promise<DetachedOutcome>): Promise<CommandResult> {
  const first = await launch({ [CHANGES_STARTER_ENV]: 'detached' })
  if (first.kind === 'running') return EXIT.ok
  if (first.kind !== 'exited' || first.code !== EXIT.changeLeftOut) return EXIT.failed
  const left = await lastLeftOut(request.home, request.profile).catch((error: unknown) => {
    // The words come from the change log; the second start still runs, and its notice names the change.
    request.output.stderr(printed(`Delo left a change out but could not read which: ${detailOf(error)}`))
    return undefined
  })
  if (left !== undefined) request.output.stderr(printed(leftOutWords(left)))
  if ((await launch({ [CHANGES_STARTER_ENV]: 'detached', [CHANGES_RETRY_ENV]: '1' })).kind === 'running') return EXIT.ok
  request.output.stderr(`${SECOND_FAILURE_LINE}\n`)
  return EXIT.failed
}

/**
 * The words of a start whose composed tree's `delorun` failed before its start ran and that leaves no harness change
 * out: how to undo the newest change to Delo itself, and how to run the installed release without any.
 * @param id - the runtime's newest applied harness change, when there is one.
 * @returns the lines, joined by line breaks, without a final one.
 */
export function harnessFailureWords(id: ChangeId | undefined): string {
  return [
    'Delo did not start with your changes to Delo itself.',
    id === undefined ? 'See them with: delorun changes list.' : `To undo the newest one: delorun changes undo ${id}.`,
    'To start the installed release without any of them: delorun changes edit-harness --discard.',
  ].join('\n')
}

/** What a start does after the composed tree's `delorun` failed before its start ran. */
export type HandOffRetry =
  /** Start once more with this environment, which carries {@link CHANGES_RETRY_ENV}. */
  | { readonly kind: 'again', readonly env: Environment }
  /** End with this exit code. */
  | { readonly kind: 'stop', readonly code: number }

/**
 * Leave the runtime's newest harness change out after the composed tree's `delorun` exited with a failure before its
 * start ran. A start marked with {@link CHANGES_RETRY_ENV} leaves nothing out; a home process `delorun start` started in
 * the background ends with {@link EXIT.changeLeftOut} and lets its starter name the change and start again.
 * @param request - the home, the environment `delorun` was started with and the output.
 * @param failed - the runtime the start runs and the child's exit code.
 * @returns `again` with the second start's environment, or `stop` with the exit code.
 */
export async function retryHandOff(request: { readonly home: string, readonly env: Environment, readonly output: CommandOutput }, failed: { readonly runtime: string, readonly code: number }): Promise<HandOffRetry> {
  const { home, env, output } = request
  if (env[CHANGES_RETRY_ENV] !== '1') {
    const failure = `Delo's harness with your changes exited with code ${String(failed.code)} while it loaded, before it started`
    const entry = await leaveOutNewestHarnessChange(home, failed.runtime, failure).catch((error: unknown) => {
      output.stderr(printed(`Delo could not leave the newest change to Delo itself out: ${detailOf(error)}`))
      return undefined
    })
    if (entry !== undefined) {
      if (env[CHANGES_STARTER_ENV] === 'detached') return { kind: 'stop', code: EXIT.changeLeftOut }
      output.stderr(printed(leftOutWords(leftOutFact(entry))))
      return { kind: 'again', env: { ...env, [CHANGES_RETRY_ENV]: '1' } }
    }
  }
  const applied = await newestAppliedHarnessChange(home, failed.runtime).catch((_unreadable: unknown) => {
    // A harness log Delo cannot read names no change; the words then point to `delorun changes list`, which says why.
    return undefined
  })
  output.stderr(printed(harnessFailureWords(applied?.id)))
  return { kind: 'stop', code: failed.code }
}
