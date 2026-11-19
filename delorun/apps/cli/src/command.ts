/**
 * What every `delorun` command receives and how one is declared. A new
 * command, such as `doctor` or `logs`, is a module under `src/<name>/` that
 * exports one {@link CliCommand}, listed once in `main.ts`'s command table.
 *
 * @module @delorun/cli/command
 */
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { helpPointer } from './help.ts'
import { ensureHomeTree, insideBwrapSandbox, resolveDelorunHome, type DelorunHome } from '@delorun/home'
import { applyLaunchEnvironment } from './launch-environment.ts'
import { selectProfile } from './profile.ts'

/** Where a command writes. */
export interface CommandOutput {
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Write to standard error. */
  readonly stderr: (text: string) => void
}

/** What a command runs with. */
export interface CommandContext extends CommandOutput {
  /** The environment `delorun` inherited, before it set the launch variables. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * A command's outcome: its exit code, or `undefined` when it handed the
 * process to upstream's profile runner, which then sets the exit code itself.
 */
export type CommandResult = ExitCode | undefined

/** One `delorun` command. */
export interface CliCommand {
  /** The word that selects it: `delorun <name>`. */
  readonly name: string
  /** One line for `delorun --help`. */
  readonly summary: string
  /**
   * Run the command.
   * @param args - the arguments after the command's name, unparsed.
   * @param context - the environment and output.
   * @returns the exit code, or `undefined` when upstream's profile runner owns it.
   */
  run(args: readonly string[], context: CommandContext): Promise<CommandResult>
}

/** A home ready for a command: resolved, its tree created and checked, and the launch variables set. */
export interface PreparedHome {
  /** The resolved home. */
  readonly home: DelorunHome
  /** The CLI profile. */
  readonly profile: string
}

/**
 * Resolve the home and the CLI profile, create the home's tree at C1's modes
 * and set the launch variables on this process. Every command that starts or
 * changes something runs this before any upstream code.
 * @param context - the command's context.
 * @param profileFlag - the `--profile` value, if given.
 * @param allowSandboxView - whether the home's mode bits are not checked when this process runs inside a Delorun chat sandbox; `start`, `setup` and `update` pass false and always check.
 * @returns the home and profile.
 * @throws {HomeLayoutError} for a refused home or a laxer home, `secrets/` or `run/<profile>/`.
 * @throws {CliError} for a refused profile name.
 */
export async function prepareHome(context: CommandContext, profileFlag: string | undefined, allowSandboxView = true): Promise<PreparedHome> {
  const profile = selectProfile(profileFlag, context.env)
  const home = await resolveDelorunHome(context.env)
  // Inside a Delorun chat sandbox bwrap shows the home's real 0700 as 0755, so the mode bits are not checked there.
  await ensureHomeTree(home.path, profile, { insideSandbox: allowSandboxView && insideBwrapSandbox(undefined, context.env) })
  applyLaunchEnvironment(home.path, profile)
  return { home, profile }
}

/**
 * A command-line parser failure as a person reads it: what was wrong, then where the usage is.
 * @param command - the command's name, or `''` for `delorun` itself.
 * @param error - what `parseArgs` threw, or any other failure.
 * @returns the usage error for a parser failure (an `ERR_PARSE_ARGS_*` code); `error` itself for any other failure.
 */
export function parseFailure(command: string, error: unknown): unknown {
  if (!(error instanceof TypeError) || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') !== true) return error
  const unknown = /^Unknown option '([^']+)'/.exec(error.message)
  // The library's own advice about `--` is for scripts; the pointer to --help is for a person.
  const problem = unknown === null ? error.message.replace(/\. To specify.*$/s, '').replace(/\.$/, '') : `unknown option ${unknown[1]!}`
  return new CliError(EXIT.usage, `delorun${command === '' ? '' : ` ${command}`}: ${problem}. ${helpPointer(command)}`)
}

/**
 * Parse a command's options strictly, reporting a wrong one as a usage error.
 * @param command - the command's name, for the message.
 * @param args - the arguments.
 * @param options - the options it takes.
 * @returns the parsed values.
 * @throws {CliError} with the usage code for an unknown or malformed option or a stray argument.
 */
export function parseOptions<T extends NonNullable<ParseArgsConfig['options']>>(command: string, args: readonly string[], options: T): ReturnType<typeof parseArgs<{ args: string[], options: T, strict: true, allowPositionals: false }>>['values'] {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values
  } catch (error) {
    throw parseFailure(command, error)
  }
}

/**
 * Parse a command's options strictly and keep its positional arguments, reporting a wrong option as a usage error.
 * @param command - the command's name, for the message.
 * @param args - the arguments.
 * @param options - the options it takes.
 * @returns the parsed values and the positional arguments, in order.
 * @throws {CliError} with the usage code for an unknown or malformed option.
 */
export function parseCommandLine<T extends NonNullable<ParseArgsConfig['options']>>(command: string, args: readonly string[], options: T): ReturnType<typeof parseArgs<{ args: string[], options: T, strict: true, allowPositionals: true }>> {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: true })
  } catch (error) {
    throw parseFailure(command, error)
  }
}
