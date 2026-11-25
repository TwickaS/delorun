/**
 * The text `delorun <command> --help` and `delorun help <command>` print: one table, one layout. The table imports no
 * command, so help answers without loading one, and it is the only place a command's usage lines, options and
 * description are written for a person to read. Each command's usage-error output points here with
 * {@link helpPointer}.
 *
 * @module @delorun/cli/help
 */

/** One option or action a command's help lists. */
export interface HelpEntry {
  /** The option or action as typed, such as `--profile <name>`. */
  readonly name: string
  /** What it does, in one sentence. */
  readonly text: string
}

/** What one command's help shows. */
export interface CommandHelp {
  /** The usage lines, each beginning with `delorun`. */
  readonly usage: readonly string[]
  /** What the command does, one line per paragraph. */
  readonly about: readonly string[]
  /** The actions or arguments the command takes, listed under `Actions:`. */
  readonly actions?: readonly HelpEntry[]
  /** The options the command takes, listed under `Options:` before `--help`. */
  readonly options?: readonly HelpEntry[]
  /** Extra lines after the options, such as how a failure is reported. */
  readonly notes?: readonly string[]
  /** The exit codes when they differ from the common ones. */
  readonly exitCodes?: string
}

/** The exit codes every command shares, unless its help says otherwise. */
export const COMMON_EXIT_CODES = 'Exit codes: 0 done, 1 failed, 2 wrong command line, 3 Delorun is not running.'

/** The line `delorun devices pin options` prints and its help gives: the options are stored but change nothing. */
export const PIN_OPTIONS_NO_EFFECT = 'These options have no effect: a device confirms each action with Face ID or the PIN, and nothing stays unlocked.'

const PROFILE: HelpEntry = { name: '--profile <name>', text: 'Use this profile instead of the default one (also DELORUN_PROFILE).' }
const JSON_OUTPUT: HelpEntry = { name: '--json', text: 'Print the result as JSON.' }

/** Every command's help, by command name. */
export const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  setup: {
    usage: ['delorun setup [<section>] [--profile <name>] [--yes] [--phone | --devices] [--import-dsh] [--port <n>] [--list]'],
    about: [
      'Sets up Delorun with a few questions: whether to use it from your other devices too, whether to copy your DeepSeek Harness chats (only when you have some), and the studio port when 3080 is busy. You add your model key in the studio.',
      'Without a terminal, delorun setup takes the safe defaults and asks nothing, as --yes does.',
      'Name a section (key, prompts, background, autostart, privacy, reach, changes-protection, profile) to answer one question again. delorun setup --list shows the sections.',
    ],
    options: [
      PROFILE,
      { name: '--list', text: 'List the sections you can run again.' },
      { name: '--yes', text: 'Accept the defaults without asking (for scripts). Also the form without a terminal.' },
      { name: '--phone', text: 'Turn on access from your other devices over Tailscale (phone, tablet, another computer); --devices means the same. Fails with the reason when Tailscale is not ready. In a terminal it pre-selects Yes.' },
      { name: '--import-dsh', text: 'Copy your DeepSeek Harness chats after printing what is copied and what stays behind. Only when a DeepSeek Harness home exists.' },
      { name: '--port <n>', text: 'The studio port, from 1024 to 65535, instead of 3080 or the next free port.' },
      { name: '--config <file>', text: 'Take the answers from a JSON answers file instead of asking.' },
      { name: '--check-key', text: 'Check the typed key with the provider before saving it.' },
      { name: '--no-update-check', text: 'Turn off the daily check for new releases.' },
      { name: '--provider <id>', text: 'The model provider to use (with --yes or --config).' },
      { name: '--model <name>', text: 'The model new chats start on.' },
      { name: '--base-url <url>', text: 'The provider\'s API address, for a provider that needs one.' },
      { name: '--key-env <name>', text: 'Read the key from this environment variable each time Delorun starts.' },
    ],
  },
  start: {
    usage: ['delorun start [--foreground | --background] [--open] [--profile <name>]'],
    about: ['Starts Delorun. Without a flag, your setup answer chooses between the two.'],
    options: [
      { name: '--background', text: 'Keep Delorun running after you close this terminal.' },
      { name: '--foreground', text: 'Run Delorun in this terminal; closing the terminal stops it.' },
      { name: '--open', text: 'Open the studio in your browser once Delorun runs.' },
      PROFILE,
    ],
  },
  open: {
    usage: ['delorun open [--print] [--port <n>] [--profile <name>]'],
    about: ['Opens the studio in your browser with a link that signs you in once.'],
    options: [
      { name: '--print', text: 'Print the link instead of opening it. Anyone who has the link can use your studio.' },
      { name: '--port <n>', text: 'Use this port in the link, for a forwarded port.' },
      PROFILE,
    ],
  },
  stop: {
    usage: ['delorun stop [--now] [--profile <name>]'],
    about: ['Stops Delorun once the chats that are running end.'],
    options: [{ name: '--now', text: 'Stop at once and end running chats.' }, PROFILE],
  },
  status: {
    usage: ['delorun status [--verbose] [--json] [--profile <name>]'],
    about: ['Shows whether Delorun is running, its version, the studio address and how many chats are running.'],
    options: [
      { name: '--verbose', text: 'Also show the process id, the start id and the profile.' },
      { name: '--json', text: 'Print everything, including the process id and start id, as JSON.' },
      PROFILE,
    ],
    exitCodes: 'Exit codes: 0 Delorun is running, 1 failed, 2 wrong command line, 3 Delorun is not running.',
  },
  doctor: {
    usage: ['delorun doctor [--port <n>]'],
    about: [
      'Checks your Delorun folder, the Docker engine, the format of your DeepSeek API key, the studio port, the sandbox (on Linux), the recorded release-log check and the last check for a newer release.',
      'Then it reports your changes: the protection setting, any work session, and for each plugin you link from a folder whether it loaded at the last start, whether it runs the content you approved, its version requirements and what it registers that changes a consent, a guard or the sandbox policy, with the change to undo when it did not load.',
      'Then the profile\'s plugins, and each plugin by name: the installed packages and the bundle list, where each package comes from and whether it is enabled, version ranges this Delorun does not meet, packages a shipped package of the same name hides, enabled bundles that are not installed, safe mode, and the plugin rows that did not activate at the last start.',
      'Prints one line per check: pass on standard output, warn or fail on standard error. Warnings do not change the exit code.',
      'No model is contacted and no request is sent. The only commands run are the read-only probe docker version and, on Linux, bwrap --ro-bind / / true; no container starts and no plugin code is imported. The key is checked by its format and never printed.',
    ],
    options: [{ name: '--port <n>', text: 'The loopback port to check, 1 to 65535 (default: the profile\'s studio port, or 3080).' }],
    exitCodes: 'Exit codes: 0 no check failed, 1 a check failed, 2 wrong command line.',
  },
  logs: {
    usage: [
      'delorun logs [<surface>] [-n <count>] [--follow] [--since <duration>] [--session <id>] [--turn <n>] [--json]',
      'delorun logs [<surface>] --path',
      'delorun logs --clear [<surface>]',
      'delorun logs --prune',
    ],
    about: ['Shows where each log is and the recent records of the log you name; without a name, the records of the running Delorun.'],
    options: [
      { name: '-n <count>', text: 'Show this many records.' },
      { name: '--follow', text: 'Keep printing new records.' },
      { name: '--since <duration>', text: 'Only records from the last duration: a number and s, m, h or d, such as 30m or 2d.' },
      { name: '--session <id>', text: 'Only records of one chat.' },
      { name: '--turn <n>', text: 'Only records of one turn of that chat.' },
      JSON_OUTPUT,
      { name: '--path', text: 'Print only the log\'s location.' },
      { name: '--clear', text: 'Delete the log you name, or all logs.' },
      { name: '--prune', text: 'Delete the records older than the retention period.' },
      PROFILE,
    ],
  },
  update: {
    usage: ['delorun update [--check | --report | --yes] [--from <folder|https-address>] [--data-copy | --no-data-copy] [--profile <name>]'],
    about: ['Fetches the newest release, shows what it changes, and applies it after you confirm.'],
    options: [
      { name: '--check', text: 'Only say whether a newer release exists.' },
      { name: '--report', text: 'Show what the update changes and apply nothing.' },
      { name: '--yes', text: 'Apply the update without asking (refused when the update changes something you should read first).' },
      { name: '--from <folder|https-address>', text: 'Install the release that a folder or an https address holds, instead of the newest one from the release channel. Takes neither --check nor --report.' },
      { name: '--data-copy', text: 'Copy your chats before updating so you can go back.' },
      { name: '--no-data-copy', text: 'Do not copy your chats before updating.' },
      PROFILE,
    ],
  },
  recover: {
    usage: ['delorun recover [status | rollback [--profile-only] | restore <version> | safe-mode [--reason <text>] | exit-safe-mode | discard <path> | workspaces [--yes]] [--profile <name>] [--json]'],
    about: ['Shows where your profile stands after an update, and the way back.'],
    actions: [
      { name: 'status', text: 'Where the profile stands (the default).' },
      { name: 'rollback', text: 'Go back to the previous release.' },
      { name: 'restore <version>', text: 'Restore a version of the profile from its history.' },
      { name: 'safe-mode', text: 'Start with your extra plugins left out.' },
      { name: 'exit-safe-mode', text: 'Load everything again.' },
      { name: 'discard <path>', text: 'Delete a copy that an update or rollback set aside.' },
      { name: 'workspaces', text: 'Bring back the previous good copy of the workspace list, after showing what it replaces and asking. The current file is kept aside.' },
    ],
    options: [
      { name: '--profile-only', text: 'With rollback: go back in the profile and keep your chats as they are.' },
      { name: '--reason <text>', text: 'With safe-mode: a note for the profile\'s history.' },
      { name: '--yes', text: 'With workspaces: answer yes to the question, for a script.' },
      JSON_OUTPUT,
      PROFILE,
    ],
  },
  reach: {
    usage: ['delorun reach status [--profile <name>]', 'delorun reach on tailscale [--yes] [--profile <name>]', 'delorun reach off [--profile <name>]'],
    about: ['Lets you reach the studio from your phone over your own Tailscale network.'],
    actions: [
      { name: 'status', text: 'Whether remote access is on.' },
      { name: 'on tailscale', text: 'Turn it on. This changes Tailscale on this computer, so it asks you first.' },
      { name: 'off', text: 'Turn it off and stop Tailscale from serving the studio.' },
    ],
    options: [
      { name: '--yes', text: 'With on tailscale: skip the question. Required when there is no terminal.' },
      PROFILE,
    ],
  },
  devices: {
    usage: ['delorun devices list | approve | elevate | remove <device id> | code | pin set|options|off|resume|status [--profile <name>]'],
    about: ['Manages the devices you let sign in to your studio. Run it at this computer.'],
    actions: [
      { name: 'list', text: 'The devices you trust.' },
      { name: 'approve', text: 'Approve a device that asked to sign in. Needs a terminal, and Delorun must be running.' },
      { name: 'elevate', text: 'Answer a device\'s request for the older code unlock, which no longer admits any action: a device confirms each action with Face ID or its PIN. Needs a terminal.' },
      { name: 'remove <device id>', text: 'Stop trusting a device.' },
      { name: 'code', text: 'Show the code that signs in a new device.' },
      { name: 'pin set', text: 'Turn PIN mode on, or change the PIN or passcode. Asks with the characters hidden; --stdin reads one line instead.' },
      { name: 'pin options', text: `Change the stored idle minutes (--idle-minutes 1-60) or lock when hidden (--lock-when-hidden, --no-lock-when-hidden). ${PIN_OPTIONS_NO_EFFECT}` },
      { name: 'pin off', text: 'Turn PIN mode off and drop the PIN.' },
      { name: 'pin resume', text: 'Resume the PIN and Face ID after ten wrong tries paused them.' },
      { name: 'pin status', text: 'Say whether PIN mode is on and how it is set.' },
    ],
    options: [PROFILE],
  },
  workspace: {
    usage: ['delorun workspace full-access [<folder> on|off] [--profile <name>]', 'delorun workspace external-agents [<folder> <agent> on|off]'],
    about: ['Changes, at this computer, what chats may do in one folder.'],
    actions: [
      { name: 'full-access', text: 'Let chats in a folder use full access, or stop them. Without a folder, lists the folders that have it.' },
      { name: 'external-agents', text: 'Let an outside agent such as Claude Code start in a folder without asking, or stop it.' },
    ],
    options: [PROFILE],
  },
  agents: {
    usage: ['delorun agents login <claude-code|codex> [--profile <name>]', 'delorun agents status [claude-code|codex] [--refresh] [--json] [--profile <name>]'],
    about: [
      'Signs an agent you added in, using the provider\'s own sign-in from the copy Delorun brought, so you need no separately installed command. Run it in a terminal.',
      'Shows whether each agent is signed in, its plan, and how much of each plan limit is used, with when each resets and when Delorun last saw the figures. While Delorun runs it checks an agent after you add it or sign in.',
    ],
    actions: [
      { name: 'login', text: 'Run the agent\'s own sign-in, interactively. Add the agent first, in setup or in Plugins. A running Delorun then checks its plan limits.' },
      { name: 'status', text: 'Show sign-in, plan and limits for each agent, or the one named. Without a running Delorun it shows the figures last seen.' },
    ],
    options: [
      { name: '--refresh', text: 'Ask the running Delorun to check now, by starting the agent\'s own program with no task. Soon after the last check nothing starts, and the answer says when the next check can run.' },
      JSON_OUTPUT,
      PROFILE,
    ],
  },
  preview: {
    usage: ['delorun preview list [--profile <name>]', 'delorun preview on <flag> [--profile <name>]', 'delorun preview off <flag> [--profile <name>]'],
    about: [
      'Shows the studio features that plugins mark as previews, and turns one on or off for a profile. A preview is off until you turn it on, and it changes what the studio shows, never what a model reads.',
      'A change applies the next time Delorun starts.',
    ],
    actions: [
      { name: 'list', text: 'Show each preview flag, whether it is on, and the plugin it belongs to.' },
      { name: 'on <flag>', text: 'Turn a flag on. A flag no plugin of the profile declares is refused, with the known flags.' },
      { name: 'off <flag>', text: 'Turn a flag off.' },
    ],
    options: [PROFILE],
  },
  mcp: {
    usage: ['delorun mcp list | accept <server> | decline <server> | revoke <server> [--profile <name>]'],
    about: ['Answers, at this computer, the questions about tool servers that chats want to start.'],
    actions: [
      { name: 'list', text: 'The servers waiting for your answer and the ones you allowed.' },
      { name: 'accept <server>', text: 'Allow a waiting server.' },
      { name: 'decline <server>', text: 'Refuse a waiting server.' },
      { name: 'revoke <server>', text: 'Stop allowing a server you allowed before.' },
    ],
    options: [PROFILE],
  },
  trash: {
    usage: ['delorun trash list [--json] | restore <id> | purge <id> [--clear-logs] | empty [--clear-logs] [--profile <name>]'],
    about: ['Shows deleted chats and workspaces, brings one back, or deletes them for good.'],
    actions: [
      { name: 'list', text: 'What was deleted and when it is deleted for good.' },
      { name: 'restore <id>', text: 'Bring a chat back.' },
      { name: 'purge <id>', text: 'Delete one item for good.' },
      { name: 'empty', text: 'Delete everything in the trash for good.' },
    ],
    options: [JSON_OUTPUT, { name: '--clear-logs', text: 'With purge or empty: also delete the log lines that mention the items.' }, PROFILE],
  },
  export: {
    usage: ['delorun export <chat-or-workspace-id> --out <file> [--profile <name>]'],
    about: ['Writes a chat, or a workspace with its chats, as an archive signed by this computer.'],
    options: [{ name: '--out <file>', text: 'Where to write the archive.' }, PROFILE],
  },
  import: {
    usage: ['delorun import <file> [--profile <name>]'],
    about: ['Checks an archive, shows who signed it and what it holds, and imports it after you confirm.'],
    options: [PROFILE],
  },
  'import-home': {
    usage: ['delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>] [--profile <name>]'],
    about: ['Copies your DeepSeek Harness folder (~/.dsh) into Delorun after a preview. Your DeepSeek Harness folder is only read.'],
    options: [
      { name: '--from <dir>', text: 'The DeepSeek Harness folder to copy (default: ~/.dsh).' },
      { name: '--dry-run', text: 'Show the preview and copy nothing.' },
      { name: '--merge', text: 'Add to chats Delorun already holds instead of refusing.' },
      { name: '--max-size <bytes>', text: 'Refuse a folder larger than this many bytes.' },
      PROFILE,
    ],
  },
  verify: {
    usage: ['delorun verify [--release <version>] [--offline] [--json]'],
    about: [
      'Checks the running release, or an installed one, against its signed manifest, the freshness of the stored timestamp and its release-log entry, and checks the release log online unless you pass --offline.',
      'Prints one line per check: passed, failed or not run, with the reason. A release log that cannot be reached leaves the release unchecked against it, with a warning, and does not fail.',
    ],
    options: [
      { name: '--release <version>', text: 'The installed release to check (default: the running one).' },
      { name: '--offline', text: 'Make no online check.' },
      JSON_OUTPUT,
    ],
    exitCodes: 'Exit codes: 0 no check failed, 1 a check failed, 2 wrong command line.',
  },
  plugin: {
    usage: ['delorun plugin check <directory> [--json]', 'delorun plugin new <name>', 'delorun plugin dev <folder>', 'delorun plugin mirror on|off [--profile <name>]', 'delorun plugin <pnpm arguments> [--profile <name>]'],
    about: ['Manages a profile\'s plugins. Other arguments go to pnpm in the profile\'s folder, as dsh plugin does.'],
    actions: [
      { name: 'check <directory>', text: 'Show which Delorun versions a plugin\'s version ranges admit; engines.delorun decides alone when it is declared. With --json, print the decision as JSON.' },
      { name: 'new <name>', text: 'Start a plugin in a new folder.' },
      { name: 'dev <folder>', text: 'Link a plugin folder, rebuild it when it changes and reload it.' },
      { name: 'mirror on|off', text: 'Install plugins from the npm mirror, or not.' },
      { name: 'add <pkg>, remove <pkg>, why <pkg>, …', text: 'Run the pnpm command in the profile\'s folder.' },
    ],
    options: [PROFILE, { name: '--allow-advisory <id>', text: 'Install despite a known critical advisory with this id.' }],
  },
  changes: {
    usage: ['delorun changes [list | show <id> [--diff] | apply <id> | discard <id> | undo <id> | off <plugin> | on <plugin> | protection [on|off]] [--profile <name>] [--json]', 'delorun changes work <plugin> [--for <minutes>] | done <plugin> | edit-harness [--discard] [--profile <name>]'],
    about: [
      'Shows what waits for your review and acts on it: the changes to your plugins and to Delorun itself. Without an action it lists them.',
      'Applying, discarding and turning protection on need you at a terminal.',
    ],
    actions: [
      { name: 'list', text: 'What waits for your review, and what you approved.' },
      { name: 'show <id>', text: 'One change, with its diff when you pass --diff.' },
      { name: 'apply <id>', text: 'Approve a change so that it loads.' },
      { name: 'discard <id>', text: 'Throw a waiting change away.' },
      { name: 'undo <id>', text: 'Take an applied change back.' },
      { name: 'off <plugin>, on <plugin>', text: 'Stop a plugin loading, or load it again.' },
      { name: 'protection [on|off]', text: 'Show or change whether changes wait for your review before they load.' },
      { name: 'work <plugin>, done <plugin>', text: 'Open or close a work session on a plugin you link from a folder.' },
      { name: 'edit-harness', text: 'Open a writable copy of Delorun itself; --discard drops it.' },
    ],
    options: [JSON_OUTPUT, { name: '--diff', text: 'With show: print the changed lines.' }, { name: '--for <minutes>', text: 'With work: how long the session lasts.' }, PROFILE],
  },
  headless: {
    usage: ['delorun headless [options] [task...]'],
    about: [
      'Answers one task and exits, as dsh headless does, under Delorun\'s protections. The answer goes to standard output and diagnostics to standard error.',
      'The task is the words after the options; - reads it from standard input. It needs a DeepSeek API key: set DEEPSEEK_API_KEY or run delorun setup key.',
    ],
    options: [
      { name: '--json', text: 'Write the run\'s events as JSON lines instead of the final answer.' },
      { name: '--session-id <id>', text: 'Continue the saved chat with this id.' },
      { name: '--permission-mode <preset>', text: 'Use this permission preset for the task.' },
      { name: '--approval-policy <policy>', text: 'ask or never.' },
      { name: '--add-dir <path>', text: 'Allow one more absolute folder for the task (repeat it for more).' },
    ],
  },
}

/** The names of the commands that have help, in table order. */
export const HELPED_COMMANDS: readonly string[] = Object.keys(COMMAND_HELP)

/**
 * The help for a command.
 * @param name - the command name.
 * @returns the text, ending in a newline; `undefined` for a name with no help.
 */
export function commandHelp(name: string): string | undefined {
  const help = COMMAND_HELP[name]
  if (help === undefined) return undefined
  const width = (entries: readonly HelpEntry[] | undefined): number => Math.max(0, ...(entries ?? []).map(entry => entry.name.length))
  const listed = (title: string, entries: readonly HelpEntry[], pad: number): string[] => ['', `${title}:`, ...entries.map(entry => `  ${entry.name.padEnd(pad)}  ${entry.text}`)]
  const help_: HelpEntry = { name: '-h, --help', text: 'Show this help.' }
  const options = [...help.options ?? [], help_]
  const pad = Math.max(width(help.actions), width(options))
  return [
    `Usage: ${help.usage.join('\n       ')}`,
    '',
    ...help.about.flatMap(paragraph => [paragraph, '']).slice(0, -1),
    ...help.actions === undefined ? [] : listed('Actions', help.actions, pad),
    ...listed('Options', options, pad),
    ...help.notes === undefined ? [] : ['', ...help.notes],
    '',
    help.exitCodes ?? COMMON_EXIT_CODES,
    '',
  ].join('\n')
}

/**
 * The line a usage error ends with.
 * @param command - the command name, or `''` for `delorun` itself.
 * @returns the sentence that names the help command.
 */
export function helpPointer(command: string): string {
  const name = command.split(' ')[0]!
  return `Run delorun ${name === '' ? '' : `${name} `}--help for usage.`
}

/**
 * Whether the arguments ask for help: `-h` or `--help` before any `--`.
 * @param args - the arguments after the command's name.
 * @returns true when help is asked for.
 */
export function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf('--')
  return (end < 0 ? args : args.slice(0, end)).some(argument => argument === '--help' || argument === '-h')
}
