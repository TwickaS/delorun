/**
 * `delorun devices pin set | options | off | resume | status`: turn PIN mode on and off at the computer ([C14](../../../../docs/contracts/c14-oidc-passkeys.md#pin-mode)).
 *
 * - `set` asks for the PIN or passcode twice with the characters hidden, or reads one line from standard input with
 *   `--stdin`. The secret is never read from an argument or an environment variable and never printed or logged. The
 *   command applies the PIN and passcode rules before it sends anything, then sends `pin.set` over the home socket (C19),
 *   which only the person's own command may call.
 * - `options` changes the idle minutes and lock-when-hidden of a mode that is on, with no secret, by sending `pin.options`.
 * - `off` sends `pin.off`; `resume` sends `pin.resume`.
 * - `status` reads the PIN files in the home, without the home running, and never reads the hash.
 *
 * @module @delorun/cli/devices/pin
 */
import { join } from 'node:path'
import { HomeAuthError, PinModeStore, checkNewSecret, readPinSetBacks } from '@delorun/home-auth'
import type { ResponseLine, UnsignedRequest } from '@delorun/home-process'
import { PIN_MODE_LIMITS } from '@delorun/contract-oidc-passkeys'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, type CommandContext } from '../command.ts'
import { printable } from '../terminal-text.ts'

/** The usage line of the `pin` actions. */
export const PIN_USAGE = 'Usage: delorun devices pin set [--idle-minutes <1-60>] [--lock-when-hidden] [--stdin] | options [--idle-minutes <1-60>] [--lock-when-hidden|--no-lock-when-hidden] | off | resume | status [--profile <name>]'

/** What the PIN actions run against. */
export interface PinDependencies {
  /**
   * Whether the profile's home process runs.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the home socket with the token file's token.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @param request - the request.
   * @returns the response lines.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<ResponseLine[]>
  /**
   * Ask for a secret with the typed characters hidden.
   * @param message - the question.
   * @returns the answer, or undefined when the person cancelled.
   */
  readonly secret: (message: string) => Promise<string | undefined>
  /**
   * Read one line from standard input.
   * @returns the line without its line ending, or undefined at the end of input.
   */
  readonly stdinLine: () => Promise<string | undefined>
  /** Whether standard input and output are both a terminal, which a hidden prompt needs. */
  readonly interactive: boolean
  /** Whether standard input is a terminal, which echoes a line typed for `--stdin`. */
  readonly stdinIsTerminal: boolean
  /** The clock for `status`, in milliseconds. */
  readonly now: () => number
}

/** One invocation. */
interface PinWhere {
  readonly home: string
  readonly profile: string
  readonly context: CommandContext
  readonly dependencies: PinDependencies
}

/**
 * Run one `pin` action.
 * @param action - `set`, `options`, `off`, `resume` or `status`.
 * @param options - the options after the action.
 * @param where - the home, profile, output and dependencies.
 * @returns the exit code.
 * @throws {CliError} with the usage code for a wrong action or option.
 */
export async function runPin(action: string | undefined, options: readonly string[], where: PinWhere): Promise<ExitCode> {
  switch (action) {
    case 'set': return set(options, where)
    case 'options': return options_(options, where)
    case 'off': return off(options, where)
    case 'resume': return resume(options, where)
    case 'status': return status(options, where)
    default: throw new CliError(EXIT.usage, `delorun devices pin: ${action === undefined ? 'choose an action' : 'unknown action'}\n${PIN_USAGE}`)
  }
}

/**
 * Read the secret from the terminal twice or from one line of standard input.
 * @param stdin - whether `--stdin` was given.
 * @param where - the invocation.
 * @returns the secret, or undefined after a message when none was read.
 */
async function readSecret(stdin: boolean, where: PinWhere): Promise<string | undefined> {
  const { dependencies, context } = where
  if (stdin) {
    if (dependencies.stdinIsTerminal) {
      context.stderr('delorun devices pin set: standard input is a terminal, which would show the PIN or passcode as you type. Run it without --stdin to be asked with the characters hidden, or pipe one line. Nothing was changed.\n')
      return undefined
    }
    const line = await dependencies.stdinLine()
    if (line === undefined || line === '') {
      context.stderr('delorun devices pin set: standard input held no PIN or passcode. Nothing was changed.\n')
      return undefined
    }
    return line
  }
  if (!dependencies.interactive) {
    context.stderr('delorun devices pin set: there is no terminal to ask for the PIN or passcode on. Run it in a terminal, or add --stdin and pipe one line. Nothing was changed.\n')
    return undefined
  }
  const first = await dependencies.secret('New PIN or passcode')
  if (first === undefined) {
    context.stderr('delorun devices pin set: cancelled. Nothing was changed.\n')
    return undefined
  }
  const second = await dependencies.secret('Type it again')
  if (second !== first) {
    context.stderr(second === undefined ? 'delorun devices pin set: cancelled. Nothing was changed.\n' : 'delorun devices pin set: the two entries differ. Nothing was changed.\n')
    return undefined
  }
  return first
}

/**
 * What PIN mode allows, in words.
 * @param kind - the secret's kind.
 * @param idleMinutes - the minutes of idleness after which a page locks, or undefined for the home's default.
 * @param lockWhenHidden - whether a hidden page locks at once.
 * @returns the lines.
 */
function allowedLines(kind: string, idleMinutes: number | undefined, lockWhenHidden: boolean | undefined): readonly string[] {
  return [
    `PIN mode is on, with a ${kind}.`,
    `A device you approved can now unlock sensitive actions on its own page by typing the ${kind}, without a code from this computer.`,
    'It covers the Tailscale private address only. Setting or changing the PIN, turning the mode on or off, and approving a device stay at this computer.',
    `A page locks again after ${idleMinutes === undefined ? 'the idle time you set (the home\'s default when you did not)' : `${String(idleMinutes)} idle minutes`}${lockWhenHidden === true ? ', and at once when it is hidden' : ''}.`,
    `Ten wrong tries across the home pause PIN unlocks until you run delorun devices pin resume; five on one device remove that device and sign it out, and you approve it again at this computer.`,
    'Turn it off with delorun devices pin off.',
  ]
}

/**
 * The text of a refused answer; home-auth's detail never holds the secret.
 * @param answer - the final line.
 * @returns the sentence.
 */
function refusal(answer: ResponseLine): string {
  return `${String(answer.error)}${typeof answer.detail === 'string' ? ` (${printable(answer.detail)})` : ''}`
}

/**
 * The final response line.
 * @param lines - the lines.
 * @returns the last, or a failure when there is none.
 */
function final(lines: readonly ResponseLine[]): ResponseLine {
  return lines.at(-1) ?? { ok: false, error: 'NO_ANSWER' }
}

/**
 * Send one request to the running home.
 * @param request - the request.
 * @param where - the invocation.
 * @returns the answer, or undefined after a message when the home does not run.
 */
async function ask(request: UnsignedRequest, where: PinWhere): Promise<ResponseLine | undefined> {
  const { home, profile, context, dependencies } = where
  if (!dependencies.running(home, profile)) {
    context.stderr(`delorun devices pin: Delorun is not running, and PIN mode changes only through the running home. Start it with delorun start${profile === 'default' ? '' : ` --profile ${profile}`}, then run this again. Nothing was changed.\n`)
    return undefined
  }
  return final(await dependencies.send(home, profile, request))
}

/**
 * Parse the options of a `pin` action without echoing an argument: a person who typed the PIN as an argument must not see
 * it again in a usage message.
 * @param action - the action's name.
 * @param options - the options.
 * @param spec - the options the action takes.
 * @returns the parsed values.
 * @throws {CliError} with the usage code and a fixed message for any argument or option the action does not take.
 */
function parseActionOptions<T extends NonNullable<Parameters<typeof parseOptions>[2]>>(action: string, options: readonly string[], spec: T): ReturnType<typeof parseOptions<T>> {
  try {
    return parseOptions(`devices pin ${action}`, options, spec)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    throw new CliError(EXIT.usage, `delorun devices pin ${action}: an argument or option it does not take. It never takes the PIN or passcode as an argument; set asks for it, or reads one line with --stdin.\n${PIN_USAGE}`)
  }
}

/**
 * Parse the options of `set` without echoing an argument: a person who typed the PIN as an argument must not see it
 * again in a usage message.
 * @param options - the options.
 * @returns the parsed values.
 * @throws {CliError} with the usage code and a fixed message for any argument or option `set` does not take.
 */
function parseSetOptions(options: readonly string[]): ReturnType<typeof parseOptions<{ profile: { type: 'string' }, 'idle-minutes': { type: 'string' }, 'lock-when-hidden': { type: 'boolean' }, stdin: { type: 'boolean' } }>> {
  return parseActionOptions('set', options, { profile: { type: 'string' }, 'idle-minutes': { type: 'string' }, 'lock-when-hidden': { type: 'boolean' }, stdin: { type: 'boolean' } })
}

/**
 * `delorun devices pin set`.
 * @param options - the options.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function set(options: readonly string[], where: PinWhere): Promise<ExitCode> {
  const values = parseSetOptions(options)
  const idle = values['idle-minutes']
  if (idle !== undefined && !/^[0-9]+$/.test(idle)) throw new CliError(EXIT.usage, `delorun devices pin set: --idle-minutes is a whole number of minutes from 1 to ${String(PIN_MODE_LIMITS.maxIdleMinutes)}\n${PIN_USAGE}`)
  const idleMinutes = idle === undefined ? undefined : Number(idle)
  if (idleMinutes !== undefined && (idleMinutes < 1 || idleMinutes > PIN_MODE_LIMITS.maxIdleMinutes)) {
    throw new CliError(EXIT.usage, `delorun devices pin set: --idle-minutes is a whole number of minutes from 1 to ${String(PIN_MODE_LIMITS.maxIdleMinutes)}\n${PIN_USAGE}`)
  }
  const presented = await readSecret(values.stdin === true, where)
  if (presented === undefined) return EXIT.failed
  let checked: ReturnType<typeof checkNewSecret>
  try {
    checked = checkNewSecret(presented)
  } catch (error) {
    if (!(error instanceof HomeAuthError)) throw error
    where.context.stderr(`delorun devices pin set: ${error.detail}. Nothing was changed.\n`)
    return EXIT.failed
  }
  const args = {
    secret: checked.secret,
    ...(idleMinutes === undefined ? {} : { idleMinutes }),
    ...(values['lock-when-hidden'] === true ? { lockWhenHidden: true } : {}),
  }
  const answer = await ask({ op: 'pin.set', args }, where)
  if (answer === undefined) return EXIT.failed
  if (answer.ok !== true) {
    where.context.stderr(`delorun devices pin set: Delorun refused: ${refusal(answer)}. Nothing was changed.\n`)
    return EXIT.failed
  }
  const kind = answer.secret === 'passcode' ? 'passcode' : 'PIN'
  where.context.stdout(`${allowedLines(kind, idleMinutes, values['lock-when-hidden']).join('\n')}\n`)
  return EXIT.ok
}

/**
 * Read `--idle-minutes` as a whole number of minutes.
 * @param text - the option's text, or undefined when absent.
 * @param command - the command's name, for the message.
 * @returns the minutes, or undefined when absent.
 * @throws {CliError} with the usage code for text that is not a whole number from 1 to the maximum.
 */
function idleMinutesOf(text: string | undefined, command: string): number | undefined {
  if (text === undefined) return undefined
  const minutes = Number(text)
  if (!/^[0-9]+$/.test(text) || minutes < 1 || minutes > PIN_MODE_LIMITS.maxIdleMinutes) {
    throw new CliError(EXIT.usage, `delorun devices pin ${command}: --idle-minutes is a whole number of minutes from 1 to ${String(PIN_MODE_LIMITS.maxIdleMinutes)}\n${PIN_USAGE}`)
  }
  return minutes
}

/**
 * `delorun devices pin options`: change the idle minutes and lock-when-hidden of a mode that is on, with no secret.
 * @param options - the options.
 * @param where - the invocation.
 * @returns the exit code.
 * @throws {CliError} with the usage code for no option to change, a conflicting pair or a bad value.
 */
async function options_(options: readonly string[], where: PinWhere): Promise<ExitCode> {
  const values = parseActionOptions('options', options, { profile: { type: 'string' }, 'idle-minutes': { type: 'string' }, 'lock-when-hidden': { type: 'boolean' }, 'no-lock-when-hidden': { type: 'boolean' } })
  const idleMinutes = idleMinutesOf(values['idle-minutes'], 'options')
  if (values['lock-when-hidden'] === true && values['no-lock-when-hidden'] === true) {
    throw new CliError(EXIT.usage, `delorun devices pin options: choose --lock-when-hidden or --no-lock-when-hidden, not both\n${PIN_USAGE}`)
  }
  const lockWhenHidden = values['lock-when-hidden'] === true ? true : values['no-lock-when-hidden'] === true ? false : undefined
  if (idleMinutes === undefined && lockWhenHidden === undefined) {
    throw new CliError(EXIT.usage, `delorun devices pin options: name --idle-minutes or --lock-when-hidden or --no-lock-when-hidden\n${PIN_USAGE}`)
  }
  const answer = await ask({ op: 'pin.options', args: { ...(idleMinutes === undefined ? {} : { idleMinutes }), ...(lockWhenHidden === undefined ? {} : { lockWhenHidden }) } }, where)
  if (answer === undefined) return EXIT.failed
  if (answer.ok !== true) {
    where.context.stderr(`delorun devices pin options: Delorun refused: ${refusal(answer)}. Nothing was changed.\n`)
    return EXIT.failed
  }
  where.context.stdout(`A page now locks after ${String(answer.idleMinutes)} idle minutes${answer.lockWhenHidden === true ? ', and at once when it is hidden' : ''}. The PIN is unchanged.\n`)
  return EXIT.ok
}

/**
 * `delorun devices pin off`.
 * @param options - the options.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function off(options: readonly string[], where: PinWhere): Promise<ExitCode> {
  parseActionOptions('off', options, { profile: { type: 'string' } })
  const answer = await ask({ op: 'pin.off' }, where)
  if (answer === undefined) return EXIT.failed
  if (answer.ok !== true) {
    where.context.stderr(`delorun devices pin off: Delorun refused: ${refusal(answer)}\n`)
    return EXIT.failed
  }
  where.context.stdout('PIN mode is off and the PIN is dropped. Devices unlock sensitive actions with a code from this computer again.\n')
  return EXIT.ok
}

/**
 * `delorun devices pin resume`.
 * @param options - the options.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function resume(options: readonly string[], where: PinWhere): Promise<ExitCode> {
  parseActionOptions('resume', options, { profile: { type: 'string' } })
  const answer = await ask({ op: 'pin.resume' }, where)
  if (answer === undefined) return EXIT.failed
  if (answer.ok !== true) {
    where.context.stderr(`delorun devices pin resume: Delorun refused: ${refusal(answer)}\n`)
    return EXIT.failed
  }
  where.context.stdout('PIN unlocks are resumed. The home-wide count of wrong tries starts again.\n')
  return EXIT.ok
}

/**
 * `delorun devices pin status`, from the files in the home.
 * @param options - the options.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function status(options: readonly string[], where: PinWhere): Promise<ExitCode> {
  parseOptions('devices pin status', options, { profile: { type: 'string' } })
  const store = new PinModeStore({ directory: join(where.home, 'secrets', 'home-auth'), now: where.dependencies.now })
  try {
    await store.load()
  } catch (error) {
    if (!(error instanceof HomeAuthError)) throw error
    where.context.stderr(`delorun devices pin status: ${error.detail}\n`)
    return EXIT.failed
  }
  const waiting = await readPinSetBacks(join(where.home, 'secrets', 'home-auth')).catch((_unreadable: unknown) => [])  // An unreadable record is the home's to report; status still shows the mode.
  where.context.stdout(`${[...pinStatusLines(store.summary()), ...setBackLines(store.summary().enabled, waiting)].join('\n')}\n`)
  return EXIT.ok
}

/**
 * The status in words.
 * @param summary - what the store reports.
 * @returns the lines.
 */
export function pinStatusLines(summary: ReturnType<PinModeStore['summary']>): readonly string[] {
  if (!summary.enabled) return ['PIN mode is off. Turn it on with delorun devices pin set.']
  const lines = [`PIN mode is on, with a ${summary.kind === 'passcode' ? 'passcode' : 'PIN'}; a page locks after ${String(summary.idleMinutes)} idle minutes${summary.lockWhenHidden ? ' and at once when it is hidden' : ''}.`]
  if (summary.paused) lines.push('PIN unlocks are paused after ten wrong tries across the home. Resume them with delorun devices pin resume.')
  return lines
}

/**
 * The line that names the settings a page loosened that wait to be set back once PIN mode is off.
 * @param enabled - whether the mode is on; a lift is then expected.
 * @param waiting - the recorded lifts' namespaces and fields.
 * @returns the lines.
 */
function setBackLines(enabled: boolean, waiting: readonly { readonly ns: string; readonly field: string }[]): readonly string[] {
  if (enabled || waiting.length === 0) return []
  return [`A setting a phone changed while PIN mode was on has not been set back yet: ${waiting.map(({ ns, field }) => `${ns}.${field}`).join(', ')}. The running home retries; check the log if it stays.`]
}

/**
 * The one line that tells a person with remote access on that PIN mode is available, when it is off.
 * @param home - the Delorun home.
 * @returns the line, or undefined when the mode is on or its files cannot be read (`devices pin status` reports that).
 */
export async function pinOffHint(home: string): Promise<string | undefined> {
  const store = new PinModeStore({ directory: join(home, 'secrets', 'home-auth'), now: Date.now })
  try {
    await store.load()
  } catch (error) {
    if (error instanceof HomeAuthError) return undefined
    throw error
  }
  return store.summary().enabled ? undefined : 'PIN mode is off: a device unlocks sensitive actions with a code from this computer. Set a PIN with delorun devices pin set.'
}
