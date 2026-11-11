/**
 * `delorun mcp list | accept <server> | decline <server>`: the stdio MCP servers whose start the running studio's
 * add-time consent (`@delo/plugin-mcp-consent`) holds stopped, answered at the home's own computer.
 *
 * - `list` shows each pending server: its command, arguments, working directory, the names of its configured
 *   environment variables without their values, and why it waits.
 * - `accept` shows the server's start and records it only after the person confirms at a terminal; without a terminal,
 *   or without a yes, nothing is recorded. The running studio then starts the server again.
 * - `decline` sets the review aside; the server stays stopped until its row starts again.
 *
 * The reviews live in the running studio, which reviews each server as it starts it, so every action needs Delo to run;
 * the command reaches it over the update channel (`mcp.list`, `mcp.accept` and `mcp.decline`, contract C19), whose
 * answers only the person's own command may give. An answer names the review it was shown, and a server whose start
 * changed meanwhile is refused as a stale review.
 *
 * @module @delo/cli/mcp/command
 */
import { resolveDeloHome } from '@delo/home'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delo/home-process'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { printable } from '../terminal-text.ts'
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
const USAGE = 'Usage: delorun mcp list | accept <server> | decline <server> [--profile <name>]'

/** One pending server as `mcp.list` answers it. */
interface PendingServer {
  readonly serverName: string
  readonly reviewId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly envNames: readonly string[]
  readonly reason: string
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
    summary: 'The MCP servers waiting for your answer: list, accept, decline',
    async run(args, context) {
      const { values, positionals } = parseCommandLine('mcp', args, { profile: { type: 'string' } })
      const [action, server, extra] = positionals
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDeloHome(context.env)).path
      const where = { home, profile, context, dependencies }
      if (action === 'list' && server === undefined) return list(where)
      if ((action === 'accept' || action === 'decline') && server !== undefined && extra === undefined) {
        return action === 'accept' ? accept(where, server) : decline(where, server)
      }
      throw new CliError(EXIT.usage, `delorun mcp: ${action === undefined ? 'choose an action' : `${JSON.stringify(action)} is not list, accept <server> or decline <server>`}\n${USAGE}`)
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
 * The pending servers the running studio holds.
 * @param where - the invocation.
 * @returns the servers.
 * @throws {CliError} {@link EXIT.notRunning} when Delo does not run, and {@link EXIT.failed} for a refusal or an
 *   answer this command cannot read.
 */
async function pending(where: Where): Promise<readonly PendingServer[]> {
  const { home, profile, dependencies } = where
  if (!dependencies.running(home, profile)) {
    throw new CliError(EXIT.notRunning, 'delorun mcp: Delo is not running. The studio reviews each MCP server as it starts it; start Delo with delorun start, then run delorun mcp list')
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.list' }))
  if (answer.ok !== true) throw new CliError(EXIT.failed, `delorun mcp: the home refused: ${refusal(answer)}`)
  const servers = serversOf(answer.servers)
  if (servers === undefined) throw new CliError(EXIT.failed, 'delorun mcp: the home answered with a list of servers this command cannot read')
  return servers
}

/**
 * Read the servers of an `mcp.list` answer.
 * @param value - the answer's `servers` field.
 * @returns the servers, or undefined when the field is not a list of servers.
 */
function serversOf(value: unknown): readonly PendingServer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: readonly unknown[] = value
  const servers: PendingServer[] = []
  const isStrings = (list: unknown): list is readonly string[] => Array.isArray(list) && list.every(item => typeof item === 'string')
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const [serverName, reviewId, command, args, cwd, envNames, reason] = ['serverName', 'reviewId', 'command', 'args', 'cwd', 'envNames', 'reason']
      .map((key): unknown => Reflect.get(entry, key))
    if (typeof serverName !== 'string' || typeof reviewId !== 'string' || typeof command !== 'string' || typeof cwd !== 'string' || typeof reason !== 'string') return undefined
    if (!isStrings(args) || !isStrings(envNames)) return undefined
    servers.push({ serverName, reviewId, command, args, cwd, envNames, reason })
  }
  return servers
}

/**
 * One server's start, as lines.
 * @param server - the server.
 * @returns what it would run, and why it waits.
 */
function startLines(server: PendingServer): string {
  return [
    `${printable(server.serverName)}`,
    `    command: ${printable(server.command)}`,
    `    arguments: ${server.args.length === 0 ? 'none' : printable(server.args.map(argument => JSON.stringify(argument)).join(' '))}`,
    `    working directory: ${server.cwd === '' ? 'the studio\'s own' : printable(server.cwd)}`,
    `    environment variables (values not shown): ${server.envNames.length === 0 ? 'none' : printable(server.envNames.join(', '))}`,
    `    waits because: ${printable(server.reason)}`,
  ].join('\n')
}

/**
 * `delorun mcp list`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function list(where: Where): Promise<ExitCode> {
  const servers = await pending(where)
  where.context.stdout(servers.length === 0
    ? 'No MCP server is waiting for your answer.\n'
    : `${servers.map(startLines).join('\n')}\nAccept one with delorun mcp accept <server>, or keep it stopped with delorun mcp decline <server>.\n`)
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
  const server = named(await pending(where), name)
  if (!dependencies.terminal) {
    return failed(context, 'accepting a server asks you to confirm at a terminal, so nothing was accepted. Run the command in a terminal on this computer')
  }
  context.stdout(`${startLines(server)}\nThis command runs on this computer with your access, outside the sandbox, each time Delo starts it.\n`)
  if (await dependencies.confirm(`Accept ${printable(server.serverName)} and start it?`) !== true) {
    return failed(context, `nothing was accepted; ${printable(server.serverName)} stays stopped`)
  }
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.accept', args: { serverName: server.serverName, reviewId: server.reviewId } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer))
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
  const server = named(await pending(where), name)
  const answer = final(await dependencies.send(home, profile, { op: 'mcp.decline', args: { serverName: server.serverName, reviewId: server.reviewId } }))
  if (answer.ok !== true) return failed(context, answerRefusal(answer))
  context.stdout(`${printable(server.serverName)} stays stopped. It is reviewed again the next time Delo starts it.\n`)
  return EXIT.ok
}

/**
 * What a refused answer says.
 * @param answer - the final line.
 * @returns the sentence: the stale review's own, or the code with its detail.
 */
function answerRefusal(answer: ResponseLine): string {
  if (answer.error === 'STALE_REVIEW') return 'the server\'s start changed after it was shown, so nothing was recorded. Look at it again with delorun mcp list'
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
