/**
 * `delorun mcp list | accept <server> | decline <server> | revoke <server>`: the stdio MCP servers whose start the
 * running studio's add-time consent (`@delo/plugin-mcp-consent`) holds stopped, answered at the home's own computer, and
 * the servers it allows, one acceptance per server name.
 *
 * - `list` shows each pending server: what changed since the person allowed it (for an environment change, which
 *   variables), whether the person declined it or revoked it, its command, arguments, working directory and configured
 *   environment variables, the absolute executable that runs, on Windows the command shell that runs a batch file, and
 *   the file it links to when that differs, the directory it runs in, the files it runs, which the acceptance pins by
 *   their contents, the ones of those and the directory that chats can write, and why it waits; then each allowed
 *   server with the same start fields, whether a
 *   configured server has its name, and when it was allowed. A variable's value is
 *   printed only for a variable that changes what runs (`NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH`,
 *   `PYTHONPATH`, `DYLD_*`).
 * - `accept` shows the server's start, resolved paths included, and records it only after the person confirms at a terminal; without a terminal,
 *   or without a yes, nothing is recorded. The running studio then starts the server again. A declined or revoked
 *   server is accepted the same way.
 * - `decline` sets the review aside; the server stays stopped, listed as declined, until its start changes.
 * - `revoke` shows an allowed server and withdraws its acceptance only after the person confirms at a terminal; the
 *   running studio then stops that server, which stays stopped, listed as revoked, until its start changes or the person
 *   accepts it again. Every other server's acceptance is unchanged.
 *
 * The reviews live in the running studio, which reviews each server as it starts it, so every action needs Delo to run;
 * the command reaches it over the update channel (`mcp.list`, `mcp.accept`, `mcp.decline` and `mcp.revoke`, contract
 * C19), whose answers only the person's own command may give. An answer names the review it was shown, and a revoke
 * the acceptance id it was shown; a server whose start or acceptance changed meanwhile is refused as a stale review.
 *
 * @module @delo/cli/mcp/command
 */
import { resolveDeloHome } from '@delo/home'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delo/home-process'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { printable, quoted } from '../terminal-text.ts'
import { confirmInTerminal } from '../workspace/command.ts'

/** What the command runs against. */
export interface McpDependencies {
  /**
   * Whether the profile's home process runs.
   * @param home - the Delo home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the home socket with the token file's token.
   * @param home - the Delo home.
   * @param profile - the CLI profile.
   * @param request - the request.
   * @returns the response lines.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<ResponseLine[]>
  /**
   * Ask the person a yes-or-no question, defaulting to no.
   * @param message - the question.
   * @returns the answer, or undefined when the person cancelled.
   */
  readonly confirm: (message: string) => Promise<boolean | undefined>
  /** Whether standard input and output are a terminal, where the person can answer. */
  readonly terminal: boolean
}

/** The usage line. */
const USAGE = 'Usage: delorun mcp list | accept <server> | decline <server> | revoke <server> [--profile <name>]'

/** What a pending review asks about, in the words `list` and `accept` print. */
const CHANGE_WORDS = {
  new: 'new server',
  command: 'its command changed',
  arguments: 'its arguments changed',
  directory: 'its working directory changed',
  environment: 'its environment variables changed',
  resolved: 'its command or working directory now resolves to another place on this computer',
  contents: 'a file it runs changed since you accepted it',
  unreadable: 'the acceptance list could not be read',
} as const

/** One code of {@link CHANGE_WORDS}, as `mcp.list` answers it. */
type ServerChange = keyof typeof CHANGE_WORDS

/** Where a pending review stands, in the words `list` prints after what changed; a waiting review adds none. */
const STATE_WORDS = {
  waiting: '',
  declined: 'you declined it; it stays stopped until its start changes or you accept it',
  revoked: 'you revoked it; it stays stopped until its start changes or you accept it again',
} as const

/** One code of {@link STATE_WORDS}, as `mcp.list` answers it. */
type ServerState = keyof typeof STATE_WORDS

/** One configured environment variable, with its value only where the studio shows it. */
interface EnvVariable {
  readonly name: string
  readonly value?: string
}

/** The start fields a pending server and an allowed server share. */
interface ServerStart {
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The absolute executable that runs. */
  readonly resolvedCommand: string
  /** The canonical directory it runs in. */
  readonly resolvedCwd: string
  /** On Windows, the command shell that runs a batch file. */
  readonly resolvedShell?: string
  readonly env: readonly EnvVariable[]
  /** The canonical paths of the files the start runs: the executable, then each file an argument names. */
  readonly files: readonly string[]
}

/** One pending server as `mcp.list` answers it. */
interface PendingServer extends ServerStart {
  readonly reviewId: string
  /** The working directory and pinned files that lie where chats can write. */
  readonly writableByChats: readonly string[]
  readonly reason: string
  readonly change: ServerChange
  readonly changedVariables: readonly string[]
  readonly state: ServerState
}

/** One allowed server as `mcp.list` answers it. */
interface AcceptedServer extends ServerStart {
  readonly acceptanceId: string
  readonly acceptedAt: number
  readonly configured: boolean
}

/** What `mcp.list` answers. */
interface Listed {
  readonly servers: readonly PendingServer[]
  readonly accepted: readonly AcceptedServer[]
}

/** One invocation's home, profile, output and dependencies. */
interface Where {
  readonly home: string
  readonly profile: string
  readonly context: CommandContext
  readonly dependencies: McpDependencies
}

/**
 * Build the command over its dependencies.
 * @param dependencies - the running check, the home socket, the prompt and the terminal check.
 * @returns the command.
 */
export function createMcpCommand(dependencies: McpDependencies): CliCommand {
  return {
    name: 'mcp',
    summary: 'The MCP servers waiting for your answer and the ones allowed: list, accept, decline, revoke',
    async run(args, context) {
      const { values, positionals } = parseCommandLine('mcp', args, { profile: { type: 'string' } })
      const [action, target, extra] = positionals
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDeloHome(context.env)).path
      const where = { home, profile, context, dependencies }
      if (action === 'list' && target === undefined) return list(where)
      if (target !== undefined && extra === undefined) {
        if (action === 'accept') return accept(where, target)
        if (action === 'decline') return decline(where, target)
        if (action === 'revoke') return revoke(where, target)
      }
      throw new CliError(EXIT.usage, `delorun mcp: ${action === undefined ? 'choose an action' : `${JSON.stringify(action)} is not list, accept <server>, decline <server> or revoke <server>`}\n${USAGE}`)
    },
  }
}

/** `delorun mcp`, over the home socket and a terminal prompt. */
export const mcpCommand: CliCommand = createMcpCommand({
  running: homeRuns,
  send: sendHomeRequest,
  confirm: confirmInTerminal,
  terminal: [process.stdin, process.stdout].every(stream => stream.isTTY === true),
})

/**
 * The pending servers and allowed servers the running studio holds.
 * @param where - the invocation.
 * @returns them.
 * @throws {CliError} {@link EXIT.notRunning} when Delo does not run, and {@link EXIT.failed} for a refusal or an
 *   answer this command cannot read.
 */
async function listed(where: Where): Promise<Listed> {
  const { home, profile, dependencies } = where
  if (!dependencies.running(home, profile)) {
    throw new CliError(EXIT.notRunning, 'delorun mcp: Delo is not running. The studio reviews each MCP server as it starts it; start Delo with delorun start, then run delorun mcp list')
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.list' }))
  if (answer.ok !== true) throw new CliError(EXIT.failed, `delorun mcp: the home refused: ${refusal(answer)}`)
  const servers = entriesOf(answer.servers, pendingOf)
  const accepted = entriesOf(answer.accepted, acceptedOf)
  if (servers === undefined || accepted === undefined) throw new CliError(EXIT.failed, 'delorun mcp: the home answered with a list of servers this command cannot read')
  return { servers, accepted }
}

/**
 * Read one list of an `mcp.list` answer.
 * @param value - the answer's field.
 * @param read - reads one entry, or answers undefined when it cannot.
 * @returns the entries, or undefined when the field is not a list or an entry cannot be read.
 */
function entriesOf<T>(value: unknown, read: (entry: object) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: readonly unknown[] = value
  const items: T[] = []
  for (const entry of entries) {
    const item = typeof entry === 'object' && entry !== null ? read(entry) : undefined
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

/**
 * Whether a field is a list of strings.
 * @param list - the field.
 * @returns true for an array of strings.
 */
function isStrings(list: unknown): list is readonly string[] {
  return Array.isArray(list) && list.every(item => typeof item === 'string')
}

/**
 * Read one environment variable of an `mcp.list` entry.
 * @param entry - the variable's entry.
 * @returns the variable, or undefined when its name is missing or a field is of another type.
 */
function variableOf(entry: object): EnvVariable | undefined {
  const [name, value] = ['name', 'value'].map((key): unknown => Reflect.get(entry, key))
  if (typeof name !== 'string' || (value !== undefined && typeof value !== 'string')) return undefined
  return value === undefined ? { name } : { name, value }
}

/**
 * Read the start fields of an `mcp.list` entry.
 * @param entry - the entry.
 * @returns the fields, or undefined when one is missing or of another type.
 */
function startOf(entry: object): ServerStart | undefined {
  const [serverName, command, args, cwd, resolvedCommand, resolvedCwd, resolvedShell] = ['serverName', 'command', 'args', 'cwd', 'resolvedCommand', 'resolvedCwd', 'resolvedShell']
    .map((key): unknown => Reflect.get(entry, key))
  const env = entriesOf(Reflect.get(entry, 'env'), variableOf)
  const files = entriesOf(Reflect.get(entry, 'files'), fileOf)
  if (typeof serverName !== 'string' || typeof command !== 'string' || typeof cwd !== 'string' || !isStrings(args) || env === undefined || files === undefined) return undefined
  if (typeof resolvedCommand !== 'string' || typeof resolvedCwd !== 'string' || (resolvedShell !== undefined && typeof resolvedShell !== 'string')) return undefined
  return { serverName, command, args, cwd, resolvedCommand, resolvedCwd, ...resolvedShell === undefined ? {} : { resolvedShell }, env, files }
}

/**
 * Read the path of one pinned file of an `mcp.list` entry.
 * @param entry - the file's entry.
 * @returns its canonical path, or undefined when the path is not a string.
 */
function fileOf(entry: object): string | undefined {
  const path: unknown = Reflect.get(entry, 'path')
  return typeof path === 'string' ? path : undefined
}

/**
 * Read one pending server of an `mcp.list` answer.
 * @param entry - the entry.
 * @returns the server, or undefined when the entry is not one.
 */
function pendingOf(entry: object): PendingServer | undefined {
  const start = startOf(entry)
  const [reviewId, reason, change, changedVariables, state, writableByChats] = ['reviewId', 'reason', 'change', 'changedVariables', 'state', 'writableByChats'].map((key): unknown => Reflect.get(entry, key))
  if (start === undefined || typeof reviewId !== 'string' || typeof reason !== 'string' || !isStrings(changedVariables) || !isStrings(writableByChats)) return undefined
  if (!isKey(CHANGE_WORDS, change) || !isKey(STATE_WORDS, state)) return undefined
  return { ...start, reviewId, reason, change, changedVariables, state, writableByChats }
}

/**
 * Whether a field names a key of a table of words.
 * @param words - the table.
 * @param value - the field.
 * @returns true for one of its keys.
 */
function isKey<T extends object>(words: T, value: unknown): value is keyof T {
  return typeof value === 'string' && Object.hasOwn(words, value)
}

/**
 * Read one allowed server of an `mcp.list` answer.
 * @param entry - the entry.
 * @returns the server, or undefined when the entry is not one.
 */
function acceptedOf(entry: object): AcceptedServer | undefined {
  const start = startOf(entry)
  const [acceptanceId, acceptedAt, configured] = ['acceptanceId', 'acceptedAt', 'configured'].map((key): unknown => Reflect.get(entry, key))
  if (start === undefined || typeof acceptanceId !== 'string' || typeof configured !== 'boolean') return undefined
  if (typeof acceptedAt !== 'number' || !Number.isSafeInteger(acceptedAt)) return undefined
  return { ...start, acceptanceId, acceptedAt, configured }
}

/**
 * A start's command, arguments, working directory, the executable, command shell and directory they resolve to, and its
 * environment variables, as indented lines. A variable's value is printed only when the studio sent it, which it does
 * only for a variable that changes what runs.
 * @param start - the start.
 * @returns the lines.
 */
function startFieldLines(start: ServerStart): string[] {
  const env = start.env.map(variable => (variable.value === undefined ? printable(variable.name) : `${printable(variable.name)}=${quoted(variable.value)}`))
  const hidden = start.env.some(variable => variable.value === undefined)
  return [
    `    command: ${printable(start.command)}`,
    `    arguments: ${start.args.length === 0 ? 'none' : printable(start.args.map(argument => JSON.stringify(argument)).join(' '))}`,
    `    working directory: ${start.cwd === '' ? 'the studio\'s own' : printable(start.cwd)}`,
    `    runs: ${printable(start.resolvedCommand)}${linksTo(start)}${start.resolvedShell === undefined ? '' : ` through the command shell ${printable(start.resolvedShell)}`}`,
    `    runs in: ${printable(start.resolvedCwd)}`,
    ...(start.files.length === 0 ? [] : [`    files it runs: ${printable(start.files.join(', '))}`]),
    `    environment variables${hidden ? ' (values not shown)' : ''}: ${env.length === 0 ? 'none' : env.join(', ')}`,
  ]
}

/**
 * The words naming the file a start's executable links to, which is the file that runs.
 * @param start - the start.
 * @returns `, which links to <file>` when the pinned executable differs from the resolved one; otherwise nothing.
 */
function linksTo(start: ServerStart): string {
  const [executable] = start.files
  return executable === undefined || executable === start.resolvedCommand ? '' : `, which links to ${printable(executable)}`
}

/**
 * One pending server's start, as lines.
 * @param server - the server.
 * @returns what changed and whether the person set it aside, what it would run, and why it waits.
 */
function startLines(server: PendingServer): string {
  const state = STATE_WORDS[server.state]
  return [
    `${printable(server.serverName)}: ${CHANGE_WORDS[server.change]}${state === '' ? '' : `; ${state}`}`,
    ...(server.changedVariables.length === 0 ? [] : [`    changed variables: ${printable(server.changedVariables.join(', '))}`]),
    ...startFieldLines(server),
    ...(server.writableByChats.length === 0 ? [] : [`    chats can write: ${printable(server.writableByChats.join(', '))}, so a chat can change what this server runs`]),
    `    waits because: ${printable(server.reason)}`,
  ].join('\n')
}

/**
 * One allowed server, as lines.
 * @param accepted - the allowed server.
 * @returns what it runs, whether a configured server has its name, and when it was allowed.
 */
function acceptedLines(accepted: AcceptedServer): string {
  return [
    printable(accepted.serverName),
    ...startFieldLines(accepted),
    ...(accepted.configured ? [] : ['    no configured server has this name now']),
    `    allowed: ${new Date(accepted.acceptedAt).toISOString()}`,
  ].join('\n')
}

/**
 * `delorun mcp list`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function list(where: Where): Promise<ExitCode> {
  const { servers, accepted } = await listed(where)
  const waiting = servers.length === 0
    ? 'No MCP server is waiting for your answer.\n'
    : `${servers.map(startLines).join('\n')}\nAccept one with delorun mcp accept <server>, or keep it stopped with delorun mcp decline <server>.\n`
  const allowed = accepted.length === 0
    ? 'No MCP server is allowed.\n'
    : `Allowed MCP servers:\n${accepted.map(acceptedLines).join('\n')}\nStop one and keep it stopped with delorun mcp revoke <server>.\n`
  where.context.stdout(`${waiting}\n${allowed}`)
  return EXIT.ok
}

/**
 * The pending server a person named.
 * @param servers - the pending servers.
 * @param name - the name typed.
 * @returns the server.
 * @throws {CliError} when no pending server has the name.
 */
function named(servers: readonly PendingServer[], name: string): PendingServer {
  const server = servers.find(entry => entry.serverName === name)
  if (server === undefined) throw new CliError(EXIT.failed, `delorun mcp: no MCP server named ${JSON.stringify(name)} is waiting for your answer; see delorun mcp list`)
  return server
}

/**
 * `delorun mcp accept <server>`.
 * @param where - the invocation.
 * @param name - the server.
 * @returns the exit code.
 */
async function accept(where: Where, name: string): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  const server = named((await listed(where)).servers, name)
  if (!dependencies.terminal) {
    return failed(context, 'accepting a server asks you to confirm at a terminal, so nothing was accepted. Run the command in a terminal on this computer')
  }
  context.stdout(`${startLines(server)}\nThis command runs on this computer with your access, outside the sandbox, each time Delo starts it.\n`)
  if (await dependencies.confirm(`Accept ${printable(server.serverName)} and start it?`) !== true) {
    return failed(context, `nothing was accepted; ${printable(server.serverName)} stays stopped`)
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.accept', args: { serverName: server.serverName, reviewId: server.reviewId } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer, 'the server\'s start changed after it was shown, so nothing was recorded'))
  context.stdout(Number(answer.started) > 0
    ? `Accepted ${printable(server.serverName)}; it is running.\n`
    : `Accepted ${printable(server.serverName)}; it starts the next time Delo starts.\n`)
  return EXIT.ok
}

/**
 * `delorun mcp decline <server>`.
 * @param where - the invocation.
 * @param name - the server.
 * @returns the exit code.
 */
async function decline(where: Where, name: string): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  const server = named((await listed(where)).servers, name)
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.decline', args: { serverName: server.serverName, reviewId: server.reviewId } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer, 'the server\'s start changed after it was shown, so nothing was recorded'))
  context.stdout(`${printable(server.serverName)} stays stopped until its start changes or you accept it.\n`)
  return EXIT.ok
}

/**
 * `delorun mcp revoke <server>`.
 * @param where - the invocation.
 * @param name - the allowed server, as `list` printed it.
 * @returns the exit code.
 */
async function revoke(where: Where, name: string): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  const accepted = (await listed(where)).accepted.find(entry => entry.serverName === name)
  if (accepted === undefined) throw new CliError(EXIT.failed, `delorun mcp: no allowed MCP server is named ${quoted(name)}; see delorun mcp list`)
  if (!dependencies.terminal) {
    return failed(context, 'revoking a server asks you to confirm at a terminal, so nothing was revoked. Run the command in a terminal on this computer')
  }
  const server = printable(accepted.serverName)
  context.stdout(`${acceptedLines(accepted)}\n${server} stops and stays stopped until its start changes or you accept it again. Other servers stay allowed.\n`)
  if (await dependencies.confirm(`Revoke ${server} and stop it?`) !== true) {
    return failed(context, `nothing was revoked; ${server} stays allowed`)
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.revoke', args: { acceptanceId: accepted.acceptanceId } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer, 'the allowed server changed after it was shown, so nothing was revoked'))
  context.stdout(`Revoked ${server}; ${Number(answer.stopped) === 0 ? 'it was not running' : 'it stopped'}.\n`)
  return EXIT.ok
}

/**
 * What a refused answer says.
 * @param answer - the final line.
 * @param stale - what a stale review means for this action.
 * @returns the sentence: the stale review's own, or the code with its detail.
 */
function answerRefusal(answer: ResponseLine, stale: string): string {
  if (answer.error === 'STALE_REVIEW') return `${stale}. Look at it again with delorun mcp list`
  return `the home refused: ${refusal(answer)}`
}

/**
 * A refused answer's code and detail.
 * @param answer - the final line.
 * @returns the code, with the detail when there is one.
 */
function refusal(answer: ResponseLine): string {
  return `${String(answer.error)}${typeof answer.detail === 'string' ? ` (${answer.detail})` : ''}`
}

/**
 * The final response line.
 * @param lines - the lines.
 * @returns the last one, or a failure when there is none.
 */
function final(lines: readonly ResponseLine[]): ResponseLine {
  return lines.at(-1) ?? { ok: false, error: 'NO_ANSWER' }
}

/**
 * Report a failure.
 * @param context - the output.
 * @param message - the sentence.
 * @returns {@link EXIT.failed}.
 */
function failed(context: CommandContext, message: string): ExitCode {
  context.stderr(`delorun mcp: ${message}\n`)
  return EXIT.failed
}
