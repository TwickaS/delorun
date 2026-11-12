/**
 * `delorun workspace external-agents [<folder> <agent> on | off]`: the external agents, such as Claude Code (`claude-code`)
 * or Codex (`codex`), that may start in a workspace without asking, in the grants file of
 * `@delo/plugin-delegation-consent` (contract C1's protected state).
 *
 * - Without a folder, it lists every grant with its workspace, agent and time.
 * - `on` shows what an external agent can do ({@link askText}) and records the grant only after the person confirms at
 *   a terminal; without a terminal, or without a yes, nothing is recorded.
 * - `off` revokes the grant without asking, because it only takes access away.
 *
 * The command writes the grants file itself, under its lock, whether Delo runs or not. Every studio reads the file at
 * each external start, so a change counts from the next start, with no restart. A folder Delo never adds as a
 * workspace is refused.
 *
 * @module @delo/cli/workspace/external-agents
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { shellQuote, workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem } from '@delo/home'
import { agentName, askText, CLI_COMMAND } from '@delo/plugin-delegation-consent/copy'
import { changeGrantStore, grantOf, grantStorePath, problemOf, readGrantStore, withGrant, withoutGrant } from '@delo/plugin-delegation-consent/store'
import { workspaceKey } from '@delo/plugin-permission-defaults/workspace'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import type { CommandContext } from '../command.ts'
import { printable } from '../terminal-text.ts'

/** The usage line. */
export const EXTERNAL_AGENTS_USAGE = `Usage: ${CLI_COMMAND} [<folder> <agent> on|off]`

/** A provider name as a profile registers it. */
const AGENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** What the subcommand needs. */
export interface ExternalAgentsWhere {
  /** The Delo home. */
  readonly home: string
  /** The output. */
  readonly context: CommandContext
  /** Whether the person can answer at a terminal. */
  readonly terminal: boolean
  /**
   * Ask a yes-or-no question, defaulting to no.
   * @param message - the question.
   * @returns the answer, or undefined when cancelled.
   */
  readonly confirm: (message: string) => Promise<boolean | undefined>
  /** The directory a relative folder resolves against. */
  readonly cwd: string
  /** The time a new grant records. */
  readonly now: number
}

/**
 * Run the subcommand.
 * @param where - the home, output, terminal and clock.
 * @param args - the folder, the agent and on or off; none to list.
 * @returns the exit code.
 * @throws {CliError} for a usage error, a folder that is not a workspace, or a grants file that cannot be read or changed.
 */
export async function externalAgents(where: ExternalAgentsWhere, args: readonly (string | undefined)[]): Promise<ExitCode> {
  const [folder, agent, state, extra] = args
  const path = grantStorePath(where.home)
  if (folder === undefined) return list(where, path)
  if (extra !== undefined || agent === undefined || !AGENT_PATTERN.test(agent) || (state !== 'on' && state !== 'off')) {
    throw new CliError(EXIT.usage, `${CLI_COMMAND}: name one folder, one agent such as claude-code or codex, and on or off\n${EXTERNAL_AGENTS_USAGE}`)
  }
  const workspace = await keyOf(where, folder)
  const name = agentName(agent)
  const named = printable(workspace)
  if (state === 'on') {
    if (!where.terminal) {
      where.context.stderr(`${CLI_COMMAND}: allowing ${name} asks you to confirm at a terminal, so nothing was changed. Run ${CLI_COMMAND} ${printable(shellQuote(workspace))} ${agent} on in a terminal on this computer\n`)
      return EXIT.failed
    }
    where.context.stdout(`${askText({ provider: agent, workspace, label: undefined })}\n`)
    if (await where.confirm(`Let ${name} start in this workspace without asking?`) !== true) {
      where.context.stderr(`${CLI_COMMAND}: nothing was changed; ${name} still asks before it starts in ${named}\n`)
      return EXIT.failed
    }
  }
  let before = false
  await changed(path, (grants) => {
    before = grantOf(grants, workspace, agent) !== undefined
    return state === 'on' ? withGrant(grants, workspace, agent, where.now) : withoutGrant(grants, workspace, agent)
  })
  where.context.stdout(state === 'on'
    ? `${name} may start in ${named} without asking${before ? ' (it already could)' : ''}. Revoke it with: ${CLI_COMMAND} ${printable(shellQuote(workspace))} ${agent} off\n`
    : `${name} ${before ? 'now asks again' : 'already asked'} before it starts in ${named}.\n`)
  return EXIT.ok
}

/**
 * List every grant.
 * @param where - the output.
 * @param path - the grants file.
 * @returns the exit code.
 */
async function list(where: ExternalAgentsWhere, path: string): Promise<ExitCode> {
  const read = await readGrantStore(path)
  if (read.kind === 'refused') {
    throw new CliError(EXIT.failed, `${CLI_COMMAND}: Delo's record of external-agent approvals, ${path}, cannot be read (${read.problem}), so no approval counts. Repair or remove that file.`)
  }
  if (read.grants.length === 0) {
    where.context.stdout('No external agent may start without asking. Each one asks before its first run in a workspace.\n')
    return EXIT.ok
  }
  const lines = read.grants.map(grant => `${printable(grant.workspace)}  ${agentName(grant.provider)} (${grant.provider})  since ${new Date(grant.grantedAt).toISOString()}`)
  where.context.stdout(`${lines.sort().join('\n')}\n`)
  return EXIT.ok
}

/**
 * The workspace key of a folder the person named.
 * @param where - the home and the directory.
 * @param folder - the folder as typed.
 * @returns the key.
 * @throws {CliError} for a missing folder or a location Delo never adds as a workspace.
 */
async function keyOf(where: ExternalAgentsWhere, folder: string): Promise<string> {
  const path = resolve(where.cwd, folder)
  let directory = false
  try {
    directory = statSync(path).isDirectory()
  } catch (_unreadable) {
    // A folder that cannot be read is no folder this command can name; the refusal names the path it tried.
  }
  if (!directory) throw new CliError(EXIT.failed, `${CLI_COMMAND}: ${JSON.stringify(path)} is not a folder; name the workspace's folder`)
  const workspace = workspaceKey(path)
  const problem = await workspaceLocationProblem(workspace, workspaceLocationHomes(where.home))
  if (problem !== undefined) throw new CliError(EXIT.failed, `${CLI_COMMAND}: ${workspaceLocationMessage(problem)} Nothing was changed.`)
  return workspace
}

/**
 * Change the grants file, reporting a failure as a {@link CliError}.
 * @param path - the grants file.
 * @param change - the grants to write.
 */
async function changed(path: string, change: Parameters<typeof changeGrantStore>[1]): Promise<void> {
  try {
    await changeGrantStore(path, change)
  } catch (error) {
    throw new CliError(EXIT.failed, `${CLI_COMMAND}: nothing was recorded (${problemOf(error)}). Check that the file belongs to you and that no other delorun command is changing it, then try again.`)
  }
}
