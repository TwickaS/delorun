/**
 * `delorun agents login <claude-code | codex>`: signs an added agent in by running its own program's sign-in
 * (`claude auth login`, `codex login`) from the copy the agent's package brings, so no separately installed `claude` or
 * `codex` command is needed. The sign-in is interactive and stays with the provider: Delorun starts the program with the
 * terminal and your environment and reads nothing it prints.
 *
 * @module @delorun/cli/agents/command
 */
import { spawn } from 'node:child_process'
import { resolveDelorunHome } from '@delorun/home'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, type CliCommand } from '../command.ts'
import { requireTerminal } from '../needs-terminal.ts'
import { profileDirectory, selectProfile } from '../profile.ts'
import { AGENT_LOGIN, LOGIN_AGENTS, loginProgramFor, type LoginAgent, type LoginProgram, type Machine } from './resolve.ts'

/** The usage line. */
export const AGENTS_USAGE = `Usage: delorun agents login <${LOGIN_AGENTS.join(' | ')}> [--profile <name>]`

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
  readonly find: (agent: LoginAgent, profileDirectory: string, machine: Machine) => LoginProgram | undefined
  /**
   * Run the program with the terminal and wait for it.
   * @param program - the program and its arguments.
   * @param env - the environment it runs with.
   * @returns its exit code; 1 when it could not start.
   */
  readonly run: (program: LoginProgram, env: Readonly<Record<string, string | undefined>>) => Promise<number>
}

/**
 * Build the command.
 * @param dependencies - what it runs against.
 * @returns the command.
 */
export function createAgentsCommand(dependencies: AgentsDependencies): CliCommand {
  return {
    name: 'agents',
    summary: 'Sign an added agent in without a separately installed command: login <claude-code|codex>',
    async run(args, context): Promise<ExitCode> {
      const { values, positionals } = parseCommandLine('agents', args, { profile: { type: 'string' } })
      const [action, agent, extra] = positionals
      if (action === 'login' && agent !== undefined && extra === undefined && !LOGIN_AGENTS.includes(agent as LoginAgent)) {
        throw new CliError(EXIT.usage, `✗ Unknown agent ${JSON.stringify(agent)}. Choose ${LOGIN_AGENTS.join(' or ')}.`)
      }
      if (action !== 'login' || agent === undefined || extra !== undefined) {
        throw new CliError(EXIT.usage, `delorun agents: ${action === 'login' ? 'name one agent' : 'the only action is login'}\n${AGENTS_USAGE}`)
      }
      const id = agent as LoginAgent
      requireTerminal('delorun agents login', undefined, { isTTY: dependencies.terminal })
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDelorunHome(context.env)).path
      const program = dependencies.find(id, profileDirectory(home, profile), dependencies.machine)
      if (program === undefined) {
        throw new CliError(EXIT.failed, `delorun agents login: ${AGENT_LOGIN[id].title} is not added. Add it first, in the Agents step of setup or in Plugins, then run this again.`)
      }
      context.stdout(`Signing in to ${AGENT_LOGIN[id].title} with its own sign-in. Follow what it asks.\n`)
      const code = await dependencies.run(program, context.env)
      if (code !== 0) throw new CliError(EXIT.failed, `delorun agents login: the ${AGENT_LOGIN[id].title} sign-in ended with exit code ${code}.`)
      return EXIT.ok
    },
  }
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
})
