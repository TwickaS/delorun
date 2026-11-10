/**
 * The `delorun` command (contract C1; contract C19's `start`, `stop` and
 * `status`):
 *
 * | Command | What it does |
 * | --- | --- |
 * | `delorun [--profile <name>]` | runs setup on a home without the CLI profile; otherwise starts the home process in this terminal and opens the studio |
 * | `delorun setup [<section>] [--profile <name>] [--list]` | setup, Quick or Full, or one section again ([setup](./setup/index.ts)) |
 * | `delorun start [--foreground] [--profile <name>]` | the home process in the background, or in this terminal ([start](./start.ts)) |
 * | `delorun stop [--now] [--profile <name>]` | stops the home process through its update channel ([stop](./stop.ts)) |
 * | `delorun status [--profile <name>] [--json]` | the home, the profile and its home process's state ([status](./status.ts)) |
 * | `delorun logs [<surface>] [options]` | each operational log's location and recent records, following, clearing and pruning them (contract C20; [logs](./logs/command.ts)) |
 * | `delorun recover [--rollback \| --restore <version> \| --safe-mode \| --exit-safe-mode]` | where the profile stands after an update, and the way back (contract C3; [recover](./recover.ts)) |
 * | `delorun --version [--json]` | Delo's version and the DSH version it runs on (contract C17; [version](./version.ts)) |
 * | `delorun plugin …`, `delorun headless …` | upstream's profile commands, passed through unchanged ([upstream](./upstream.ts)) |
 *
 * Every invocation but `--help` and `--version` first prunes the home's expired operational logs (contract C20;
 * [startup pruning](./logs/startup.ts)), and every one exports Delo's version as `DELO_VERSION` before any
 * upstream module runs (contract C17; [version](./version.ts)). Every command resolves the Delo home, `DELO_HOME` or `~/.delo`, and every
 * command but `status` creates its tree at mode 0700 and refuses a laxer one
 * before upstream code runs. Exit codes are {@link EXIT}'s.
 *
 * @module @delo/cli
 */
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { HomeLayoutError } from '@delo/home'
import { hasCliProfile } from './profile.ts'
import { runSetup, setupCommand } from './setup/index.ts'
import { SetupCancelled } from './setup/prompts.ts'
import { startCommand, startForeground } from './start.ts'
import { statusCommand } from './status.ts'
import { stopCommand } from './stop.ts'
import { doctorCommand } from './doctor/index.ts'
import { logsCommand } from './logs/command.ts'
import { recoverCommand } from './recover.ts'
import { pruneLogsAtStart } from './logs/startup.ts'
import { headlessCommand, pluginCommand } from './upstream.ts'
import { applyDeloVersionEnvironment, DeloVersionError, versionCommand } from './version.ts'

/** Every command, in `delorun --help` order. A new command adds its row here. */
export const COMMANDS: readonly CliCommand[] = [setupCommand, startCommand, stopCommand, statusCommand, doctorCommand, logsCommand, recoverCommand, pluginCommand, headlessCommand]

/**
 * The help text.
 * @returns the usage lines and one line per command.
 */
function usage(): string {
  const width = Math.max(...COMMANDS.map(command => command.name.length))
  return [
    'Usage: delorun [--profile <name>]',
    '       delorun <command> [options]',
    '',
    'With no command, delorun sets up a new home, or starts Delo and opens the studio.',
    '',
    'Commands:',
    ...COMMANDS.map(command => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'The home is ~/.delo, or DELO_HOME; the CLI profile is default, or DELO_PROFILE or --profile.',
    'delorun --version prints Delo\'s and DSH\'s versions; --json prints them as one JSON line.',
    'Exit codes: 0 done, 1 failed, 2 wrong command line, 3 the home process is not running.',
    '',
  ].join('\n')
}

/**
 * `delorun` with no command: setup on a home without the CLI profile, otherwise a foreground start that opens the studio.
 * @param args - the options.
 * @param context - the environment and output.
 * @returns the command's result.
 */
async function bare(args: readonly string[], context: CommandContext): Promise<CommandResult> {
  const values = parseOptions('', args, { profile: { type: 'string' } })
  const { home, profile } = await prepareHome(context, values.profile)
  if (!hasCliProfile(home.path, profile)) return runSetup({ home: home.path, profile, output: context, env: context.env, form: { kind: 'interactive' } })
  return startForeground({ home: home.path, profile, open: true, output: context })
}

/**
 * Run one `delorun` invocation and report its failure.
 * @param argv - the arguments after the script.
 * @param context - the environment and output; this process's by default.
 * @returns the exit code, or `undefined` when upstream's profile runner owns it.
 */
export async function main(argv: readonly string[], context: CommandContext = {
  env: { ...process.env },
  stdout: text => void process.stdout.write(text),
  stderr: text => void process.stderr.write(text),
}): Promise<CommandResult> {
  const [first, ...rest] = argv
  try {
    if (first === '--help' || first === '-h' || first === 'help') {
      context.stdout(usage())
      return EXIT.ok
    }
    if (first === '--version' || first === '-v') return versionCommand(rest, context)
    applyDeloVersionEnvironment()
    await pruneLogsAtStart(context, Date.now())
    if (first === undefined || first.startsWith('-')) return await bare(argv, context)
    const command = COMMANDS.find(candidate => candidate.name === first)
    if (command === undefined) throw new CliError(EXIT.usage, `delorun: unknown command ${JSON.stringify(first)}\n\n${usage()}`)
    return await command.run(rest, context)
  } catch (error) {
    return report(error, context)
  }
}

/**
 * Report a failure on standard error.
 * @param error - the failure.
 * @param context - the output.
 * @returns its exit code.
 * @throws the error itself when it is neither a {@link CliError}, a {@link SetupCancelled}, a {@link DeloVersionError} nor a {@link HomeLayoutError}.
 */
function report(error: unknown, context: CommandContext): ExitCode {
  if (error instanceof CliError) {
    context.stderr(`${error.message}\n`)
    return error.exit
  }
  if (error instanceof SetupCancelled) {
    context.stderr(`${error.message}\n`)
    return EXIT.failed
  }
  if (error instanceof DeloVersionError) {
    context.stderr(`${error.message}\n`)
    return EXIT.failed
  }
  if (error instanceof HomeLayoutError) {
    context.stderr(`delorun: ${error.message}\n`)
    return EXIT.failed
  }
  throw error
}
