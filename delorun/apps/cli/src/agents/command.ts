/**
 * `delorun agents login <claude-code | codex>` and `delorun agents status [claude-code | codex] [--refresh] [--json]`.
 *
 * `login` signs an added agent in by running its own program's sign-in (`claude auth login`, `codex login`) from the
 * copy the agent's package brings, so no separately installed `claude` or `codex` command is needed. The sign-in is
 * interactive and stays with the provider: Delorun starts the program with the terminal and your environment and reads
 * nothing it prints. After a sign-in that ended well, a running Delorun checks that agent's plan limits
 * (`agents.refresh` with reason `signed-in`); with none running, the command leaves a mark in the accounts file and the
 * next start checks once. The command itself never starts a check.
 *
 * `status` prints each agent's sign-in, plan and limit windows ([status](./status.ts)).
 *
 * @module @delorun/cli/agents/command
 */
import { spawn } from 'node:child_process'
import { resolveDelorunHome } from '@delorun/home'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delorun/home-process'
import { accountsFilePath, parseRefreshAnswer, requestCheck } from '@delorun/external-agents/accounts'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, type CliCommand, type CommandContext } from '../command.ts'
import { requireTerminal } from '../needs-terminal.ts'
import { profileDirectory, selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { AGENT_PACKS, EXTERNAL_AGENTS, loginProgramFor, type LoginProgram, type Machine } from '@delorun/external-agents/locate'
import type { ExternalAgentName } from '@delorun/external-agents/contract'
import { agentsStatus, refreshLine } from './status.ts'

/** The usage lines. */
export const AGENTS_USAGE = [
  `Usage: delorun agents login <${EXTERNAL_AGENTS.join(' | ')}> [--profile <name>]`,
  `       delorun agents status [${EXTERNAL_AGENTS.join(' | ')}] [--refresh] [--json] [--profile <name>]`,
].join('\n')

/** What the command runs against. */
export interface AgentsDependencies {
  /** Whether standard input is a terminal, where the person can sign in. */
  readonly terminal: boolean
  /** The platform and architecture. */
  readonly machine: Machine
  /**
   * Find an agent's sign-in program.
   * @param agent - which agent.
   * @param profileDirectory - the CLI profile's directory.
   * @param machine - the platform and architecture.
   * @returns the program, or undefined when the agent is not added.
   */
  readonly find: (agent: ExternalAgentName, profileDirectory: string, machine: Machine) => LoginProgram | undefined
  /**
   * Run the program with the terminal and wait for it.
   * @param program - the program and its arguments.
   * @param env - the environment it runs with.
   * @returns its exit code; 1 when it could not start.
   */
  readonly run: (program: LoginProgram, env: Readonly<Record<string, string | undefined>>) => Promise<number>
  /**
   * Whether the profile's Delorun runs.
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @returns whether its home process holds the lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the profile's update channel.
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @param request - the request.
   * @returns the response lines.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<readonly ResponseLine[]>
  /**
   * The current time.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
}

/**
 * Read a named agent.
 * @param agent - the positional, or undefined.
 * @returns the agent, or undefined when none is named.
 * @throws {CliError} {@link EXIT.usage} for an agent this command does not know.
 */
function agentOf(agent: string | undefined): ExternalAgentName | undefined {
  if (agent === undefined) return undefined
  const known = EXTERNAL_AGENTS.find(name => name === agent)
  if (known === undefined) throw new CliError(EXIT.usage, `✗ Unknown agent ${JSON.stringify(agent)}. Choose ${EXTERNAL_AGENTS.join(' or ')}.`)
  return known
}

/**
 * Build the command.
 * @param dependencies - what it runs against.
 * @returns the command.
 */
export function createAgentsCommand(dependencies: AgentsDependencies): CliCommand {
  return {
    name: 'agents',
    summary: 'Sign an added agent in, or see its sign-in and plan limits: login <claude-code|codex>, status',
    async run(args, context): Promise<ExitCode> {
      const { values, positionals } = parseCommandLine('agents', args, { profile: { type: 'string' }, refresh: { type: 'boolean' }, json: { type: 'boolean' } })
      const [action, agent, extra] = positionals
      const profile = selectProfile(values.profile, context.env)
      const named = extra === undefined ? agentOf(agent) : undefined
      if (action === 'status' && extra === undefined) {
        const home = (await resolveDelorunHome(context.env)).path
        const directory = profileDirectory(home, profile)
        return agentsStatus({ home, profile, refresh: values.refresh === true, json: values.json === true, ...named === undefined ? {} : { agent: named } }, context, {
          running: dependencies.running,
          send: dependencies.send,
          installed: candidate => dependencies.find(candidate, directory, dependencies.machine) !== undefined,
          now: dependencies.now,
        })
      }
      if (action === 'login' && named !== undefined && values.refresh !== true && values.json !== true) {
        return login({ home: (await resolveDelorunHome(context.env)).path, profile, agent: named }, context, dependencies)
      }
      const problem = action === 'login' ? (named === undefined ? 'name one agent' : '--refresh and --json go with status')
        : action === 'status' ? 'name at most one agent' : 'the actions are login and status'
      throw new CliError(EXIT.usage, `delorun agents: ${problem}\n${AGENTS_USAGE}`)
    },
  }
}

/**
 * `delorun agents login <agent>`.
 * @param where - the home, profile and agent.
 * @param context - the terminal and output.
 * @param dependencies - what it runs against.
 * @returns {@link EXIT.ok} once the sign-in ended well.
 * @throws {CliError} when there is no terminal, the agent is not added, or the sign-in failed.
 */
async function login(where: { readonly home: string, readonly profile: string, readonly agent: ExternalAgentName }, context: CommandContext, dependencies: AgentsDependencies): Promise<ExitCode> {
  const { home, profile, agent } = where
  const title = AGENT_PACKS[agent].title
  requireTerminal('delorun agents login', undefined, { isTTY: dependencies.terminal })
  const program = dependencies.find(agent, profileDirectory(home, profile), dependencies.machine)
  if (program === undefined) {
    throw new CliError(EXIT.failed, `delorun agents login: ${title} is not added. Add it first, in the Agents step of setup or in Plugins, then run this again.`)
  }
  context.stdout(`Signing in to ${title} with its own sign-in. Follow what it asks.\n`)
  const code = await dependencies.run(program, context.env)
  if (code !== 0) throw new CliError(EXIT.failed, `delorun agents login: the ${title} sign-in ended with exit code ${code}.`)
  context.stdout(`${await checkAfterSignIn(where, dependencies)}\n`)
  return EXIT.ok
}

/**
 * Ask a running Delorun to check an agent's plan limits after a sign-in. The sign-in already ended well, so a check
 * that cannot be asked for is reported as a sentence, not a failure.
 * @param where - the home, profile and agent.
 * @param dependencies - the channel.
 * @returns the sentence to print.
 */
async function checkAfterSignIn(where: { readonly home: string, readonly profile: string, readonly agent: ExternalAgentName }, dependencies: AgentsDependencies): Promise<string> {
  const { home, profile, agent } = where
  const status = `delorun agents status ${agent}${profile === 'default' ? '' : ` --profile ${profile}`}`
  if (!dependencies.running(home, profile)) {
    try {
      await requestCheck(accountsFilePath(home), agent, dependencies.now())
    } catch (_unwritable) {
      // The sign-in stands; only the mark for the next start could not be left, and the sentence says how to check.
      return `Signed in. Start Delorun, then check the plan limits with: ${status} --refresh`
    }
    return `Signed in. Delorun checks ${AGENT_PACKS[agent].title}'s plan limits when it next starts; see them with: ${status}`
  }
  let lines: readonly ResponseLine[]
  try {
    lines = await dependencies.send(home, profile, { op: 'agents.refresh', args: { provider: agent, reason: 'signed-in' } })
  } catch (_unreachable) {
    // The sign-in stands; only the check could not be asked for, and the sentence says how to ask again.
    lines = []
  }
  const answer = lines.at(-1)?.ok === true ? parseRefreshAnswer(lines.at(-1)) : undefined
  if (answer === undefined) return `Signed in. Delorun did not check the plan limits now; check them with: ${status} --refresh`
  return `Signed in. ${refreshLine(agent, answer.outcome)} See the figures with: ${status}`
}

/** The command over the real machine. */
export const agentsCommand: CliCommand = createAgentsCommand({
  terminal: process.stdin.isTTY === true,
  machine: { platform: process.platform, arch: process.arch },
  find: loginProgramFor,
  run: (program, env) => new Promise((resolve) => {
    // The provider's own program signs in, with the terminal and the person's environment; its output is not read.
    const child = spawn(program.program, [...program.args], { stdio: 'inherit', env: { ...process.env, ...env } })
    child.once('error', () => { resolve(1) })
    child.once('exit', (code) => { resolve(code ?? 1) })
  }),
  running: homeRuns,
  send: sendHomeRequest,
  now: () => Date.now(),
})
