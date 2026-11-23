/**
 * The `delorun` command (contract C1; contract C19's `start`, `stop` and
 * `status`):
 *
 * | Command | What it does |
 * | --- | --- |
 * | `delorun [--profile <name>] [--foreground \| --background]` | runs setup on a home without the CLI profile; otherwise starts the home process detached from the terminal, or in this terminal, as `--background`, `--foreground` or else setup's answer says, and opens the studio |
 * | `delorun setup [<section>] [--profile <name>] [--yes] [--phone \| --devices] [--import-dsh] [--port <n>] [--list]` | setup, or one section again ([setup](./setup/index.ts)) |
 * | `delorun setup export --out <file>`, `delorun setup import <file> [--dry-run]` | the plugins, model choices and settings of a profile as one signed archive, and its import, which replaces the profile's setup after showing what changes ([transfer](./changes/setup-transfer.ts)) |
 * | `delorun start [--foreground \| --background] [--open] [--profile <name>] [--patch <file>]... [--inspect [--yes]]` | the home process detached from the terminal, or in this terminal, with the person's overlays and, once confirmed, a debugger port ([start](./start.ts), [inspector](./inspector.ts)) |
 * | `delorun open [--print] [--profile <name>]` | the studio in the browser with a link that signs in once, or that link printed ([open](./open/command.ts)) |
 * | `delorun stop [--now] [--profile <name>]` | stops the home process through its update channel ([stop](./stop.ts)) |
 * | `delorun status [--profile <name>] [--json]` | the home, the profile and its home process's state ([status](./status.ts)) |
 * | `delorun logs [<surface>] [options]` | each operational log's location and recent records, following, clearing and pruning them (contract C20; [logs](./logs/command.ts)) |
 * | `delorun update [--check \| --yes] [--data-copy \| --no-data-copy]` | the newest release's report, and the update through the home process (contracts C3, C19; [update](./update/command.ts)) |
 * | `delorun recover [status \| rollback [--profile-only] \| restore <version> \| safe-mode \| exit-safe-mode \| discard <path> \| workspaces [--yes]]` | where the profile stands after an update, and the way back (contract C3; [recover](./recover.ts)) |
 * | `delorun changes [list \| show <id> [--diff] \| apply <id> \| discard <id> \| undo <id> \| off <plugin> \| on <plugin> \| protection [block \| warn \| off]]` | what waits for your review, and the decisions about it (contract C21; [changes](./changes/command.ts)) |
 * | `delorun trash list \| restore <id> \| purge <id> \| empty` | the trash: what was deleted, restoring an item and deleting one or all forever (contract C8; [trash](./trash/command.ts)) |
 * | `delorun export <chat-or-workspace> --out <file>` | a chat, or a workspace with its chats, as an archive signed by this home (contract C8; [export](./export/command.ts)) |
 * | `delorun import <file>` | an archive checked, shown and imported after the person confirms (contract C8; [import](./import/command.ts)) |
 * | `delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>]` | a DeepSeek Harness home previewed, then copied after the person confirms (contract C8; [import-home](./import-home/index.ts)) |
 * | `delorun verify [--release <version>] [--offline] [--json]` | the release against its signed manifest and the release log (contracts C15 and C18; [verify](./verify/index.ts)) |
 * | `delorun reach status \| on tailscale \| off` | remote access to the studio over the person's tailnet (contract C7; [reach](./reach/command.ts)) |
 * | `delorun devices list \| approve \| remove <id> \| code` | the devices this home trusts, managed at this computer (contract C5; [devices](./devices/command.ts)) |
 * | `delorun workspace full-access [<folder> on \| off]` | a workspace's full access, turned on after a confirmation at this computer or off (contract C1; [workspace](./workspace/command.ts)) |
 * | `delorun agents login <claude-code \| codex>` | signs an added agent in with the provider's own program from the agent's package, at a terminal ([agents](./agents/command.ts)) |
 * | `delorun agents status [claude-code \| codex] [--refresh] [--json]` | each added agent's sign-in, plan and plan-limit windows with their reset times and when they were seen, from the running Host (`agents.accounts`, contract C19) or the accounts file; `--refresh` asks the running Host to check now ([status](./agents/status.ts)) |
 * | `delorun workspace external-agents [<folder> <agent> on \| off]` | the external agents, such as Claude Code, that start in a workspace without asking, allowed after a confirmation at this computer or revoked (contract C14; [external agents](./workspace/external-agents.ts)) |
 * | `delorun mcp list \| accept <server> \| decline <server> \| revoke <command>` | the stdio MCP servers the running studio holds stopped, answered at this computer, and the server commands it allows (contract C19; [mcp](./mcp/command.ts)) |
 * | `delorun preview list \| on <flag> \| off <flag>` | the studio features a plugin declares as previews, and the profile row that turns one on ([preview](./preview/command.ts)) |
 * | `delorun --version [--json]` | Delorun's version and the DSH version it runs on (contract C17; [version](./version.ts)) |
 * | `delorun plugin …`, `delorun headless …` | upstream's profile commands for the CLI profile, with a build approval for `plugin` ([upstream](./upstream.ts)) |
 * | `delorun plugin new <name>`, `plugin dev <folder>`, `plugin check <directory>` | a new plugin package, the author's reload loop, and what a plugin's version ranges admit ([upstream](./upstream.ts)) |
 *
 * Every invocation but `--help` and `--version` first prunes the home's expired operational logs (contract C20;
 * [startup pruning](./logs/startup.ts)), and every one exports Delorun's version as `DELORUN_VERSION` before any
 * upstream module runs (contract C17; [version](./version.ts)). Every command resolves the Delorun home, `DELORUN_HOME` or `~/.delorun`, and every
 * command but `status` creates its tree at mode 0700 and refuses a laxer one
 * before upstream code runs. A failed command prints what Delorun did, why and what the person can do, in the refusal
 * format `delorun` shares with its npm launcher ([refusals](./refusals.ts)), redacted, and never a stack; a failure no
 * command caught, after {@link main} returned included, prints the same way through the last-resort handler the
 * [entry point](./bin.ts) installs. Exit codes are {@link EXIT}'s. A command's module loads when its name is parsed, so
 * `--help` and `--version` import no command ({@link COMMANDS}), and the failure report's describers load only when a command fails.
 *
 * @module @delorun/cli
 */
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { asksForHelp, commandHelp } from './help.ts'
import { closestMatch } from './output.ts'
import { pruneLogsAtStart } from './logs/startup.ts'
import { mainHelp } from './main-help.ts'
import { sandboxHomeFailure } from './sandbox-home.ts'
import { styleOf } from './style.ts'
import { applyDelorunVersionEnvironment, delorunVersion, versionCommand } from './version.ts'

/**
 * A command listed for `delorun --help` and loaded only when it is named: most commands import a large part of upstream
 * and Delorun's packages, so a process that runs one command does not load the others.
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
  { name: 'setup', summary: 'Set up Delorun, or run one section again: delorun setup <section>; --list lists them; export and import move a setup between computers', load: async () => (await import('./setup/index.ts')).setupCommand },
  { name: 'start', summary: 'Start the home process: --background detaches it from the terminal, --foreground keeps it in this terminal; without either, setup\'s answer chooses; --patch adds overlays', load: async () => (await import('./start.ts')).startCommand },
  { name: 'open', summary: 'Open the studio in your browser, or print a link that signs in once with --print (--port for a forwarded port)', load: async () => (await import('./open/command.ts')).openCommand },
  { name: 'stop', summary: 'Stop the home process once running chats end, or at once with --now', load: async () => (await import('./stop.ts')).stopCommand },
  { name: 'status', summary: 'Show whether Delorun is running, its studio address and its running chats; --verbose adds process details', load: async () => (await import('./status.ts')).statusCommand },
  { name: 'doctor', summary: 'Check Docker, the DeepSeek API key format, the home, the studio port, the sandbox, the release-log check, the last update check, your changes, the workspace registry and the plugins', load: async () => (await import('./doctor/index.ts')).doctorCommand },
  { name: 'logs', summary: 'Show where each operational log is and its recent records; follow, clear or prune them', load: async () => (await import('./logs/command.ts')).logsCommand },
  { name: 'update', summary: 'Fetch the newest release, show what it changes, and apply it: --check only says whether one exists; --report shows what it changes and applies nothing; --from installs a release from a folder or https address; --yes, --data-copy, --no-data-copy', load: async () => (await import('./update/command.ts')).updateCommand },
  { name: 'recover', summary: 'Where the profile stands after an update, and the way back: status, rollback [--profile-only], restore <version>, safe-mode, exit-safe-mode, discard <path>, workspaces [--yes], packs', load: async () => (await import('./recover.ts')).recoverCommand },
  { name: 'changes', summary: 'What waits for your review, and apply <id>, discard <id>, undo <id>, off <plugin>, on <plugin>, protection, work <plugin>, done <plugin>, edit-harness', load: async () => (await import('./changes/command.ts')).changesCommand },
  { name: 'reach', summary: 'Reach the studio from your phone over your own tailnet: status, on tailscale, off', load: async () => (await import('./reach/command.ts')).reachCommand },
  { name: 'devices', summary: 'The devices you let sign in to your studio: list, approve, elevate, remove, code, pin', load: async () => (await import('./devices/command.ts')).devicesCommand },
  { name: 'workspace', summary: 'A workspace\'s full access and the external agents that start there without asking, changed at this computer: full-access [<folder> on|off], external-agents [<folder> <agent> on|off]', load: async () => (await import('./workspace/command.ts')).workspaceCommand },
  { name: 'agents', summary: 'Sign an added agent in, or see its sign-in and plan limits: login <claude-code|codex>, status', load: async () => (await import('./agents/command.ts')).agentsCommand },
  { name: 'mcp', summary: 'The MCP servers waiting for your answer and the ones allowed: list, accept, decline, revoke', load: async () => (await import('./mcp/command.ts')).mcpCommand },
  { name: 'trash', summary: 'List deleted chats and workspaces; restore a chat, or delete one item or all forever', load: async () => (await import('./trash/command.ts')).trashCommand },
  { name: 'export', summary: 'Write a chat, or a workspace with its chats, as an archive signed by this home', load: async () => (await import('./export/command.ts')).exportCommand },
  { name: 'import', summary: 'Check an archive, show who signed it and what it holds, and import it after you confirm', load: async () => (await import('./import/command.ts')).importCommand },
  { name: 'import-home', summary: 'Copy a DeepSeek Harness home (~/.dsh) into this Delorun home after a preview; --dry-run only shows it', load: async () => (await import('./import-home/command.ts')).importHomeCommand },
  { name: 'verify', summary: 'Check the release against its signed manifest and the release log: --release <version>, --offline, --json', load: async () => (await import('./verify/index.ts')).verifyCommand },
  { name: 'preview', summary: 'Turn a preview feature of the studio on or off: list, on <flag>, off <flag>', load: async () => (await import('./preview/command.ts')).previewCommand },
  { name: 'plugin', summary: 'Manage a profile\'s plugins, as dsh plugin does; check, new and dev help you write one; mirror on|off', load: async () => (await import('./upstream.ts')).pluginCommand },
  { name: 'headless', summary: 'Answer one task and exit, as dsh headless does, under Delorun\'s protections', load: async () => (await import('./upstream.ts')).headlessCommand },
]

/**
 * The help text.
 * @param env - the environment, which decides the colour.
 * @returns the grouped command list, the words used and the exit codes, wrapped to the terminal.
 */
function usage(env: Readonly<Record<string, string | undefined>>): string {
  return mainHelp({ commands: COMMANDS.map(command => command.name), version: String(delorunVersion()), columns: process.stdout.columns > 0 ? process.stdout.columns : 80, style: styleOf(env) })
}

/**
 * `delorun help <command>`.
 * @param names - the words after `help`.
 * @param context - the output.
 * @returns the exit code.
 * @throws {CliError} with the usage code for a name that is not a command, or more than one name.
 */
function helpFor(names: readonly string[], context: CommandContext): CommandResult {
  const [name, ...extra] = names
  const text = name === undefined || extra.length > 0 ? undefined : commandHelp(name)
  if (text === undefined) throw new CliError(EXIT.usage, `delorun help: ${names.length === 1 ? `${JSON.stringify(name)} is not a command` : 'name one command'}. Run delorun help to list them.`)
  context.stdout(text)
  return EXIT.ok
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
  const { home, profile } = await prepareHome(context, values.profile, false)
  if (!hasCliProfile(home.path, profile)) {
    startChoice('', flags, profileDirectory(home.path, profile))
    const { runSetup } = await import('./setup/index.ts')
    const { terminalForeground } = await import('./setup/foreground.ts')
    return runSetup({ home: home.path, profile, output: context, env: context.env, form: { kind: 'interactive' }, foreground: terminalForeground() })
  }
  // The options and the setup answer decide as they do for `delorun start`; either way the studio opens once Delorun runs.
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
    if (first === '--help' || first === '-h' || (first === 'help' && rest.length === 0)) {
      context.stdout(usage(context.env))
      return EXIT.ok
    }
    if (first === 'help') return helpFor(rest, context)
    if (first === '--version' || first === '-v') return versionCommand(rest, context)
    applyDelorunVersionEnvironment()
    await pruneLogsAtStart(context, Date.now())
    if (first === undefined || first.startsWith('-')) return await bare(argv, context)
    const entry = COMMANDS.find(candidate => candidate.name === first)
    if (entry === undefined) {
      const near = closestMatch(first, COMMANDS.map(command => command.name))
      throw new CliError(EXIT.usage, `✗ Unknown command ${JSON.stringify(first)}.${near === undefined ? '' : ` Did you mean ${JSON.stringify(near)}?`} delorun --help lists commands.`)
    }
    if (asksForHelp(rest)) {
      context.stdout(commandHelp(entry.name) ?? usage(context.env))
      return EXIT.ok
    }
    return await (await entry.load()).run(rest, context)
  } catch (error) {
    // Every failure reaches the person in the refusal format, redacted and without a stack: `delorun` keeps no log of
    // its own failures, so the message is all a person has.
    const { cliRefusal } = await import('./refusals.ts')
    const refusal = cliRefusal(sandboxHomeFailure(error, context.env), argv)
    context.stderr(refusal.text)
    return refusal.exit
  }
}
