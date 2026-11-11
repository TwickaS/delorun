/**
 * The `delorun` command (contract C1; contract C19's `start`, `stop` and
 * `status`):
 *
 * | Command | What it does |
 * | --- | --- |
 * | `delorun [--profile <name>] [--foreground]` | runs setup on a home without the CLI profile; otherwise starts the home process in the background, or in this terminal when setup's answer or `--foreground` says so, and opens the studio |
 * | `delorun setup [<section>] [--profile <name>] [--list]` | setup, Quick or Full, or one section again ([setup](./setup/index.ts)) |
 * | `delorun start [--foreground] [--open] [--profile <name>] [--patch <file>]... [--inspect [--yes]]` | the home process in the background, or in this terminal, with the person's overlays and, once confirmed, a debugger port ([start](./start.ts), [inspector](./inspector.ts)) |
 * | `delorun open [--print] [--profile <name>]` | the studio in the browser with a link that signs in once, or that link printed ([open](./open/command.ts)) |
 * | `delorun stop [--now] [--profile <name>]` | stops the home process through its update channel ([stop](./stop.ts)) |
 * | `delorun status [--profile <name>] [--json]` | the home, the profile and its home process's state ([status](./status.ts)) |
 * | `delorun logs [<surface>] [options]` | each operational log's location and recent records, following, clearing and pruning them (contract C20; [logs](./logs/command.ts)) |
 * | `delorun update [--check \| --yes] [--data-copy \| --no-data-copy]` | the newest release's report, and the update through the home process (contracts C3, C19; [update](./update/command.ts)) |
 * | `delorun recover [status \| rollback [--profile-only] \| restore <version> \| safe-mode \| exit-safe-mode \| discard <path>]` | where the profile stands after an update, and the way back (contract C3; [recover](./recover.ts)) |
 * | `delorun trash list \| restore <id> \| purge <id> \| empty` | the trash: what was deleted, restoring an item and deleting one or all forever (contract C8; [trash](./trash/command.ts)) |
 * | `delorun export <chat-or-workspace> --out <file>` | a chat, or a workspace with its chats, as an archive signed by this home (contract C8; [export](./export/command.ts)) |
 * | `delorun import <file>` | an archive checked, shown and imported after the person confirms (contract C8; [import](./import/command.ts)) |
 * | `delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>]` | a DeepSeek Harness home previewed, then copied after the person confirms (contract C8; [import-home](./import-home/index.ts)) |
 * | `delorun verify [--release <version>] [--offline] [--json]` | the release against its signed manifest and the release log (contracts C15 and C18; [verify](./verify/index.ts)) |
 * | `delorun reach status \| on tailscale \| off` | remote access to the studio over the person's tailnet (contract C7; [reach](./reach/command.ts)) |
 * | `delorun devices list \| approve \| remove <id> \| code` | the devices this home trusts, managed at this computer (contract C5; [devices](./devices/command.ts)) |
 * | `delorun --version [--json]` | Delo's version and the DSH version it runs on (contract C17; [version](./version.ts)) |
 * | `delorun plugin …`, `delorun headless …` | upstream's profile commands for the CLI profile, with a build approval for `plugin` ([upstream](./upstream.ts)) |
 * | `delorun plugin new <name>`, `plugin dev <folder>`, `plugin check <directory>` | a new plugin package, the author's reload loop, and what a plugin's version ranges admit ([upstream](./upstream.ts)) |
 *
 * Every invocation but `--help` and `--version` first prunes the home's expired operational logs (contract C20;
 * [startup pruning](./logs/startup.ts)), and every one exports Delo's version as `DELO_VERSION` before any
 * upstream module runs (contract C17; [version](./version.ts)). Every command resolves the Delo home, `DELO_HOME` or `~/.delo`, and every
 * command but `status` creates its tree at mode 0700 and refuses a laxer one
 * before upstream code runs. A failed command prints what Delo did, why and what the person can do, in the refusal
 * format `delorun` shares with its npm launcher ([refusals](./refusals.ts)), redacted, and never a stack; a failure no
 * command caught, after {@link main} returned included, prints the same way through the last-resort handler the
 * [entry point](./bin.ts) installs. Exit codes are {@link EXIT}'s.
 *
 * @module @delo/cli
 */
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { cliRefusal } from './refusals.ts'
import { runSetup, setupCommand } from './setup/index.ts'
import { startCommand, startDetached, startForeground, startsDetached } from './start.ts'
import { statusCommand } from './status.ts'
import { stopCommand } from './stop.ts'
import { doctorCommand } from './doctor/index.ts'
import { logsCommand } from './logs/command.ts'
import { openCommand } from './open/command.ts'
import { recoverCommand } from './recover.ts'
import { trashCommand } from './trash/command.ts'
import { exportCommand } from './export/command.ts'
import { importCommand } from './import/command.ts'
import { updateCommand } from './update/command.ts'
import { importHomeCommand } from './import-home/command.ts'
import { pruneLogsAtStart } from './logs/startup.ts'
import { headlessCommand, pluginCommand } from './upstream.ts'
import { applyDeloVersionEnvironment, versionCommand } from './version.ts'
import { verifyCommand } from './verify/index.ts'
import { reachCommand } from './reach/command.ts'
import { devicesCommand } from './devices/command.ts'

/** Every command, in `delorun --help` order. A new command adds its row here. */
export const COMMANDS: readonly CliCommand[] = [setupCommand, startCommand, openCommand, stopCommand, statusCommand, doctorCommand, logsCommand, updateCommand, recoverCommand, reachCommand, devicesCommand, trashCommand, exportCommand, importCommand, importHomeCommand, verifyCommand, pluginCommand, headlessCommand]

/**
 * The help text.
 * @returns the usage lines and one line per command.
 */
function usage(): string {
  const width = Math.max(...COMMANDS.map(command => command.name.length))
  return [
    'Usage: delorun [--profile <name>] [--foreground]',
    '       delorun <command> [options]',
    '',
    'With no command, delorun sets up a new home, or starts Delo in the background and opens the studio.',
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
  const values = parseOptions('', args, { profile: { type: 'string' }, foreground: { type: 'boolean', default: false } })
  const { home, profile } = await prepareHome(context, values.profile)
  if (!hasCliProfile(home.path, profile)) return runSetup({ home: home.path, profile, output: context, env: context.env, form: { kind: 'interactive' } })
  // The setup answer decides as it does for `delorun start`; either way the studio opens once Delo runs.
  if (startsDetached(values.foreground === true, profileDirectory(home.path, profile))) return startDetached(home.path, profile, context, true)
  return startForeground({ home: home.path, profile, open: true, output: context, env: context.env })
}

/**
 * Run one `delorun` invocation and report its failure, whatever was thrown, as a refusal on standard error.
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
    // Every failure reaches the person in the refusal format, redacted and without a stack: `delorun` keeps no log of
    // its own failures, so the message is all a person has.
    const refusal = cliRefusal(error, argv)
    context.stderr(refusal.text)
    return refusal.exit
  }
}
