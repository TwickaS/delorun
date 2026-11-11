/**
 * What every `delorun` command receives and how one is declared. A new
 * command, such as `doctor` or `logs`, is a module under `src/<name>/` that
 * exports one {@link CliCommand}, listed once in `main.ts`'s command table.
 *
 * @module @delo/cli/command
 */
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { ensureHomeTree, resolveDeloHome, type DeloHome } from '@delo/home'
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
  readonly home: DeloHome
  /** The CLI profile. */
  readonly profile: string
}

/**
 * Resolve the home and the CLI profile, create the home's tree at C1's modes
 * and set the launch variables on this process. Every command that starts or
 * changes something runs this before any upstream code.
 * @param context - the command's context.
 * @param profileFlag - the `--profile` value, if given.
 * @returns the home and profile.
 * @throws {HomeLayoutError} for a refused home or a laxer home, `secrets/` or `run/<profile>/`.
 * @throws {CliError} for a refused profile name.
 */
export async function prepareHome(context: CommandContext, profileFlag: string | undefined): Promise<PreparedHome> {
  const profile = selectProfile(profileFlag, context.env)
  const home = await resolveDeloHome(context.env)
  await ensureHomeTree(home.path, profile)
  applyLaunchEnvironment(home.path, profile)
  return { home, profile }
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
    // parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for an unknown or malformed option.
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') === true) {
      throw new CliError(EXIT.usage, `delorun${command === '' ? '' : ` ${command}`}: ${error.message}`)
    }
    throw error
  }
}

/**
 * Parse a command's options strictly, keeping its positional arguments, and report a wrong option as a usage error.
 * A positional argument that begins with `-` follows `--`.
 * @param command - the command's name, for the message.
 * @param args - the arguments.
 * @param options - the options it takes.
 * @returns the parsed values and the positional arguments in order.
 * @throws {CliError} with the usage code for an unknown or malformed option.
 */
export function parseCommandLine<T extends NonNullable<ParseArgsConfig['options']>>(command: string, args: readonly string[], options: T): {
  readonly values: ReturnType<typeof parseArgs<{ args: string[], options: T, strict: true, allowPositionals: true }>>['values']
  readonly positionals: readonly string[]
} {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options, strict: true, allowPositionals: true })
    return { values, positionals }
  } catch (error) {
    // parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for an unknown or malformed option.
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') === true) {
      throw new CliError(EXIT.usage, `delorun ${command}: ${error.message}`)
    }
    throw error
  }
}
