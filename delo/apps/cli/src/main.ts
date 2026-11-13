/**
 * The `delorun` command (contract C1; contract C19's `start`, `stop` and
 * `status`):
 *
 * | Command | What it does |
 * | --- | --- |
 * | `delorun [--profile <name>] [--foreground \| --background]` | runs setup on a home without the CLI profile; otherwise starts the home process detached from the terminal, or in this terminal, as `--background`, `--foreground` or else setup's answer says, and opens the studio |
 * | `delorun setup [<section>] [--profile <name>] [--list]` | setup, Quick or Full, or one section again ([setup](./setup/index.ts)) |
 * | `delorun start [--foreground \| --background] [--open] [--profile <name>]` | the home process detached from the terminal, or in this terminal ([start](./start.ts)) |
 * | `delorun open [--print] [--profile <name>]` | the studio in the browser with a link that signs in once, or that link printed ([open](./open/command.ts)) |
 * | `delorun stop [--now] [--profile <name>]` | stops the home process through its update channel ([stop](./stop.ts)) |
 * | `delorun status [--profile <name>] [--json]` | the home, the profile and its home process's state ([status](./status.ts)) |
 * | `delorun logs [<surface>] [options]` | each operational log's location and recent records, following, clearing and pruning them (contract C20; [logs](./logs/command.ts)) |
 * | `delorun update [--check \| --yes] [--data-copy \| --no-data-copy]` | the newest release's report, and the update through the home process (contracts C3, C19; [update](./update/command.ts)) |
 * | `delorun recover [status \| rollback [--profile-only] \| restore <version> \| safe-mode \| exit-safe-mode \| discard <path>]` | where the profile stands after an update, and the way back (contract C3; [recover](./recover.ts)) |
 * | `delorun changes [list \| show <id> [--diff] \| apply <id> \| discard <id> \| undo <id> \| off <plugin> \| on <plugin> \| protection [block \| warn \| off]]` | what waits for your review, and the decisions about it (contract C21; [changes](./changes/command.ts)) |
 * | `delorun trash list \| restore <id> \| purge <id> \| empty` | the trash: what was deleted, restoring an item and deleting one or all forever (contract C8; [trash](./trash/command.ts)) |
 * | `delorun export <chat-or-workspace> --out <file>` | a chat, or a workspace with its chats, as an archive signed by this home (contract C8; [export](./export/command.ts)) |
 * | `delorun import <file>` | an archive checked, shown and imported after the person confirms (contract C8; [import](./import/command.ts)) |
 * | `delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>]` | a DeepSeek Harness home previewed, then copied after the person confirms (contract C8; [import-home](./import-home/index.ts)) |
 * | `delorun verify [--release <version>] [--offline] [--json]` | the release against its signed manifest and the release log (contracts C15 and C18; [verify](./verify/index.ts)) |
 * | `delorun reach status \| on tailscale \| off` | remote access to the studio over the person's tailnet (contract C7; [reach](./reach/command.ts)) |
 * | `delorun devices list \| approve \| remove <id> \| code` | the devices this home trusts, managed at this computer (contract C5; [devices](./devices/command.ts)) |
 * | `delorun workspace full-access [<folder> on \| off]` | a workspace's full access, turned on after a confirmation at this computer or off (contract C1; [workspace](./workspace/command.ts)) |
 * | `delorun workspace external-agents [<folder> <agent> on \| off]` | the external agents, such as Claude Code, that start in a workspace without asking, allowed after a confirmation at this computer or revoked (contract C14; [external agents](./workspace/external-agents.ts)) |
 * | `delorun mcp list \| accept <server> \| decline <server> \| revoke <command>` | the stdio MCP servers the running studio holds stopped, answered at this computer, and the server commands it allows (contract C19; [mcp](./mcp/command.ts)) |
 * | `delorun --version [--json]` | Delo's version and the DSH version it runs on (contract C17; [version](./version.ts)) |
 * | `delorun plugin …`, `delorun headless …` | upstream's profile commands, passed through unchanged ([upstream](./upstream.ts)) |
 *
 * Every invocation but `--help` and `--version` first prunes the home's expired operational logs (contract C20;
 * [startup pruning](./logs/startup.ts)), and every one exports Delo's version as `DELO_VERSION` before any
 * upstream module runs (contract C17; [version](./version.ts)). Every command resolves the Delo home, `DELO_HOME` or `~/.delo`, and every
 * command but `status` creates its tree at mode 0700 and refuses a laxer one
 * before upstream code runs. A failed command prints what Delo did, why and what the person can do, in the refusal
 * format `delorun` shares with its npm launcher ([refusals](./refusals.ts)), redacted, and never a stack; a failure no
 * command caught, after {@link main} returned included, prints the same way through the last-resort handler the
 * [entry point](./bin.ts) installs. Exit codes are {@link EXIT}'s. A command's module loads when its name is parsed, so
 * `--help` and `--version` import no command ({@link COMMANDS}), and the failure report's describers load only when a command fails.
 *
 * @module @delo/cli
 */
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { pruneLogsAtStart } from './logs/startup.ts'
import { applyDeloVersionEnvironment, versionCommand } from './version.ts'

/**
 * A command listed for `delorun --help` and loaded only when it is named: most commands import a large part of upstream
 * and Delo's packages, so a process that runs one command does not load the others.
 */
export interface CommandEntry {
  /** The word that selects it; the loaded command has the same {@link CliCommand.name}. */
  readonly name: string
  /** The line `delorun --help` shows; the loaded command has the same {@link CliCommand.summary}. */
  readonly summary: string
  /**
   * Import the command's module.
   * @returns the command.
   */
  load(): Promise<CliCommand>
}

/**
 * Every command, in `delorun --help` order. A new command adds its row here, with a literal `import()` path so the
 * release transpiler rewrites it to JavaScript.
 */
export const COMMANDS: readonly CommandEntry[] = [
  { name: 'setup', summary: 'Set up Delorun (Quick or Full), or run one section again: delorun setup <section>; --list lists them', load: async () => (await import('./setup/index.ts')).setupCommand },
  { name: 'start', summary: 'Start the home process: --background detaches it from the terminal, --foreground keeps it in this terminal; without either, setup\'s answer chooses', load: async () => (await import('./start.ts')).startCommand },
  { name: 'open', summary: 'Open the studio in your browser, or print a link that signs in once with --print (--port for a forwarded port)', load: async () => (await import('./open/command.ts')).openCommand },
  { name: 'stop', summary: 'Stop the home process once running chats end, or at once with --now', load: async () => (await import('./stop.ts')).stopCommand },
  { name: 'status', summary: 'Show the home, the CLI profile and the state of its home process', load: async () => (await import('./status.ts')).statusCommand },
  { name: 'doctor', summary: 'Check Docker, the DeepSeek API key format, the home, the studio port, the sandbox, the release-log check and the last update check', load: async () => (await import('./doctor/index.ts')).doctorCommand },
  { name: 'logs', summary: 'Show where each operational log is and its recent records; follow, clear or prune them', load: async () => (await import('./logs/command.ts')).logsCommand },
  { name: 'update', summary: 'Fetch the newest release, show what it changes, and apply it: --check only says whether one exists; --report shows what it changes and applies nothing; --yes, --data-copy, --no-data-copy', load: async () => (await import('./update/command.ts')).updateCommand },
  { name: 'recover', summary: 'Where the profile stands after an update, and the way back: status, rollback [--profile-only], restore <version>, safe-mode, exit-safe-mode, discard <path>', load: async () => (await import('./recover.ts')).recoverCommand },
  { name: 'changes', summary: 'What waits for your review, and apply <id>, discard <id>, undo <id>, off <plugin>, on <plugin>, protection, work <plugin>, done <plugin>, edit-harness', load: async () => (await import('./changes/command.ts')).changesCommand },
  { name: 'reach', summary: 'Reach the studio from your phone over your own tailnet: status, on tailscale, off', load: async () => (await import('./reach/command.ts')).reachCommand },
  { name: 'devices', summary: 'The devices this home trusts: list, approve, elevate, remove, code', load: async () => (await import('./devices/command.ts')).devicesCommand },
  { name: 'workspace', summary: 'A workspace\'s full access and the external agents that start there without asking, changed at this computer: full-access [<folder> on|off], external-agents [<folder> <agent> on|off]', load: async () => (await import('./workspace/command.ts')).workspaceCommand },
  { name: 'mcp', summary: 'The MCP servers waiting for your answer and the ones allowed: list, accept, decline, revoke', load: async () => (await import('./mcp/command.ts')).mcpCommand },
  { name: 'trash', summary: 'List deleted chats and workspaces; restore a chat, or delete one item or all forever', load: async () => (await import('./trash/command.ts')).trashCommand },
  { name: 'export', summary: 'Write a chat, or a workspace with its chats, as an archive signed by this home', load: async () => (await import('./export/command.ts')).exportCommand },
  { name: 'import', summary: 'Check an archive, show who signed it and what it holds, and import it after you confirm', load: async () => (await import('./import/command.ts')).importCommand },
  { name: 'import-home', summary: 'Copy a DeepSeek Harness home (~/.dsh) into this Delo home after a preview; --dry-run only shows it', load: async () => (await import('./import-home/command.ts')).importHomeCommand },
  { name: 'verify', summary: 'Check the release against its signed manifest and the release log: --release <version>, --offline, --json', load: async () => (await import('./verify/index.ts')).verifyCommand },
  { name: 'plugin', summary: 'Manage a profile\'s plugins, as dsh plugin does; check <directory> shows what a plugin\'s version ranges admit; mirror on|off', load: async () => (await import('./upstream.ts')).pluginCommand },
  { name: 'headless', summary: 'Answer one task and exit, as dsh headless does, under Delo\'s protections', load: async () => (await import('./upstream.ts')).headlessCommand },
]

/**
 * The help text.
 * @returns the usage lines and one line per command.
 */
function usage(): string {
  const width = Math.max(...COMMANDS.map(command => command.name.length))
  return [
    'Usage: delorun [--profile <name>] [--foreground | --background]',
    '       delorun <command> [options]',
    '',
    'With no command, delorun sets up a new home, or starts Delo and opens the studio: --background detaches it from the',
    'terminal and --foreground keeps it in this terminal; without either, setup\'s answer chooses (delorun setup background).',
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
 * `delorun` with no command: setup on a home without the CLI profile, otherwise a start that opens the studio, detached or
 * in this terminal as {@link startChoice} decides.
 * @param args - the options.
 * @param context - the environment and output.
 * @returns the command's result.
 */
async function bare(args: readonly string[], context: CommandContext): Promise<CommandResult> {
  const values = parseOptions('', args, { profile: { type: 'string' }, foreground: { type: 'boolean', default: false }, background: { type: 'boolean', default: false } })
  const flags = { foreground: values.foreground === true, background: values.background === true }
  const { foregroundHint, startChoice, startDetached, startForeground } = await import('./start.ts')
  const { home, profile } = await prepareHome(context, values.profile)
  if (!hasCliProfile(home.path, profile)) {
    startChoice('', flags, profileDirectory(home.path, profile))
    const { runSetup } = await import('./setup/index.ts')
    return runSetup({ home: home.path, profile, output: context, env: context.env, form: { kind: 'interactive' } })
  }
  // The options and the setup answer decide as they do for `delorun start`; either way the studio opens once Delo runs.
  const choice = startChoice('', flags, profileDirectory(home.path, profile))
  if (choice.detached) return startDetached(home.path, profile, context, true)
  const result = await startForeground({ home: home.path, profile, open: true, output: context, env: context.env })
  if (result === undefined && !choice.explicit) context.stdout(foregroundHint(profile))
  return result
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
    const entry = COMMANDS.find(candidate => candidate.name === first)
    if (entry === undefined) throw new CliError(EXIT.usage, `delorun: unknown command ${JSON.stringify(first)}\n\n${usage()}`)
    return await (await entry.load()).run(rest, context)
  } catch (error) {
    // Every failure reaches the person in the refusal format, redacted and without a stack: `delorun` keeps no log of
    // its own failures, so the message is all a person has.
    const { cliRefusal } = await import('./refusals.ts')
    const refusal = cliRefusal(error, argv)
    context.stderr(refusal.text)
    return refusal.exit
  }
}
