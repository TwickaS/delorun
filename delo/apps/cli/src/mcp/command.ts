/**
 * `delorun mcp list | accept <server> | decline <server> | revoke <command>`: the stdio MCP servers whose start the
 * running studio's add-time consent (`@delo/plugin-mcp-consent`) holds stopped, answered at the home's own computer, and
 * the server commands it allows.
 *
 * - `list` shows each pending server: what changed since the person allowed it, its command, arguments, working
 *   directory, the names of its configured environment variables without their values, and why it waits; then each
 *   allowed command with its arguments, working directory, environment variable names, the configured servers that use
 *   it and when it was allowed.
 * - `accept` shows the server's start and records it only after the person confirms at a terminal; without a terminal,
 *   or without a yes, nothing is recorded. The running studio then starts the server again.
 * - `decline` sets the review aside; the server stays stopped until its row starts again.
 * - `revoke` shows an allowed command and the servers that use it, and withdraws it only after the person confirms at a
 *   terminal; the running studio then stops those servers, and each waits for an answer before it starts again.
 *
 * The reviews live in the running studio, which reviews each server as it starts it, so every action needs Delo to run;
 * the command reaches it over the update channel (`mcp.list`, `mcp.accept`, `mcp.decline` and `mcp.revoke`, contract
 * C19), whose answers only the person's own command may give. An answer names the review it was shown, and a revoke
 * the acceptance time it was shown; a server whose start, or a command whose acceptance, changed meanwhile is refused as
 * a stale review.
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
const USAGE = 'Usage: delorun mcp list | accept <server> | decline <server> | revoke <command> [--profile <name>]'

/** What a pending review asks about, in the words `list` and `accept` print. */
const CHANGE_WORDS = {
  new: 'new server',
  arguments: 'its arguments changed',
  directory: 'its working directory changed',
  environment: 'its environment variables changed',
  unreadable: 'the acceptance list could not be read',
} as const

/** One code of {@link CHANGE_WORDS}, as `mcp.list` answers it. */
type ServerChange = keyof typeof CHANGE_WORDS

/** The start fields a pending server and an allowed command share. */
interface ServerStart {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly envNames: readonly string[]
}

/** One pending server as `mcp.list` answers it. */
interface PendingServer extends ServerStart {
  readonly serverName: string
  readonly reviewId: string
  readonly reason: string
  readonly change: ServerChange
}

/** One allowed command as `mcp.list` answers it. */
interface AcceptedServer extends ServerStart {
  readonly acceptedAt: number
  readonly servers: readonly string[]
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
      throw new CliError(EXIT.usage, `delorun mcp: ${action === undefined ? 'choose an action' : `${JSON.stringify(action)} is not list, accept <server>, decline <server> or revoke <command>`}\n${USAGE}`)
    },
  }
}

/** `delorun mcp`, over the home socket and a terminal prompt. */
export const mcpCommand: CliCommand = createMcpCommand({
  running: homeRuns,
  send: sendHomeRequest,
  confirm: confirmInTerminal,
  terminal: process.stdin.isTTY && process.stdout.isTTY,
})

/**
 * The pending servers and allowed commands the running studio holds.
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
 * Read the start fields of an `mcp.list` entry.
 * @param entry - the entry.
 * @returns the fields, or undefined when one is missing or of another type.
 */
function startOf(entry: object): ServerStart | undefined {
  const [command, args, cwd, envNames] = ['command', 'args', 'cwd', 'envNames'].map((key): unknown => Reflect.get(entry, key))
  if (typeof command !== 'string' || typeof cwd !== 'string' || !isStrings(args) || !isStrings(envNames)) return undefined
  return { command, args, cwd, envNames }
}

/**
 * Read one pending server of an `mcp.list` answer.
 * @param entry - the entry.
 * @returns the server, or undefined when the entry is not one.
 */
function pendingOf(entry: object): PendingServer | undefined {
  const start = startOf(entry)
  const [serverName, reviewId, reason, change] = ['serverName', 'reviewId', 'reason', 'change'].map((key): unknown => Reflect.get(entry, key))
  if (start === undefined || typeof serverName !== 'string' || typeof reviewId !== 'string' || typeof reason !== 'string') return undefined
  if (!isChange(change)) return undefined
  return { ...start, serverName, reviewId, reason, change }
}

/**
 * Whether a field names a change {@link CHANGE_WORDS} has words for.
 * @param value - the field.
 * @returns true for one of its keys.
 */
function isChange(value: unknown): value is ServerChange {
  return typeof value === 'string' && Object.hasOwn(CHANGE_WORDS, value)
}

/**
 * Read one allowed command of an `mcp.list` answer.
 * @param entry - the entry.
 * @returns the command, or undefined when the entry is not one.
 */
function acceptedOf(entry: object): AcceptedServer | undefined {
  const start = startOf(entry)
  const [acceptedAt, servers] = ['acceptedAt', 'servers'].map((key): unknown => Reflect.get(entry, key))
  if (start === undefined || typeof acceptedAt !== 'number' || !Number.isSafeInteger(acceptedAt) || !isStrings(servers)) return undefined
  return { ...start, acceptedAt, servers }
}

/**
 * A start's arguments, working directory and environment variable names, as indented lines.
 * @param start - the start.
 * @returns the lines.
 */
function startFieldLines(start: ServerStart): string[] {
  return [
    `    arguments: ${start.args.length === 0 ? 'none' : printable(start.args.map(argument => JSON.stringify(argument)).join(' '))}`,
    `    working directory: ${start.cwd === '' ? 'the studio\'s own' : printable(start.cwd)}`,
    `    environment variables (values not shown): ${start.envNames.length === 0 ? 'none' : printable(start.envNames.join(', '))}`,
  ]
}

/**
 * One pending server's start, as lines.
 * @param server - the server.
 * @returns what changed, what it would run, and why it waits.
 */
function startLines(server: PendingServer): string {
  return [
    `${printable(server.serverName)}: ${CHANGE_WORDS[server.change]}`,
    `    command: ${printable(server.command)}`,
    ...startFieldLines(server),
    `    waits because: ${printable(server.reason)}`,
  ].join('\n')
}

/**
 * One allowed command, as lines.
 * @param accepted - the allowed command.
 * @returns what it runs, the servers that use it, and when it was allowed.
 */
function acceptedLines(accepted: AcceptedServer): string {
  return [
    printable(accepted.command),
    ...startFieldLines(accepted),
    `    used by: ${accepted.servers.length === 0 ? 'no configured server' : printable(accepted.servers.join(', '))}`,
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
    ? 'No MCP server command is allowed.\n'
    : `Allowed MCP server commands:\n${accepted.map(acceptedLines).join('\n')}\nStop one and have it ask again with delorun mcp revoke <command>.\n`
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
  context.stdout(`${printable(server.serverName)} stays stopped. It is reviewed again the next time Delo starts it.\n`)
  return EXIT.ok
}

/**
 * `delorun mcp revoke <command>`.
 * @param where - the invocation.
 * @param command - the allowed command, as `list` printed it.
 * @returns the exit code.
 */
async function revoke(where: Where, command: string): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  const accepted = (await listed(where)).accepted.find(entry => entry.command === command)
  if (accepted === undefined) throw new CliError(EXIT.failed, `delorun mcp: no allowed MCP server command is ${quoted(command)}; see delorun mcp list`)
  if (!dependencies.terminal) {
    return failed(context, 'revoking a command asks you to confirm at a terminal, so nothing was revoked. Run the command in a terminal on this computer')
  }
  const stops = accepted.servers.length === 0 ? 'No configured server uses it now.' : `The servers that use it stop: ${printable(accepted.servers.join(', '))}.`
  context.stdout(`${acceptedLines(accepted)}\n${stops} Each asks for your answer again before it next starts.\n`)
  if (await dependencies.confirm(`Revoke ${printable(accepted.command)} and stop the servers that use it?`) !== true) {
    return failed(context, `nothing was revoked; ${printable(accepted.command)} stays allowed`)
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.revoke', args: { command: accepted.command, acceptedAt: accepted.acceptedAt } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer, 'the allowed command changed after it was shown, so nothing was revoked'))
  const stopped = Number(answer.stopped)
  context.stdout(`Revoked ${printable(accepted.command)}; ${stopped === 0 ? 'no running server used it' : `${String(stopped)} running server${stopped === 1 ? '' : 's'} stopped`}.\n`)
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
