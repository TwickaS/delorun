/**
 * `delorun workspace full-access [<folder> on | off]`: a workspace's full access, turned on or off at the home's own
 * computer, in the per-workspace permission store of `@delorun/plugin-permission-defaults` (contract C1's protected
 * state).
 *
 * - Without a folder, it lists the workspaces the store holds, with their preset and since when full access is on.
 * - `on` shows what full access means for that folder ({@link fullAccessNote}) and records the grant only after the
 *   person confirms at a terminal; without a terminal, or without a yes, nothing is recorded. The store is read again
 *   before the write, and a workspace whose full access changed meanwhile is refused as a stale review.
 * - `off` withdraws the grant without asking, because it only takes access away.
 *
 * The command writes the store itself, whether Delorun runs or not, holding the store's lock file so a concurrent change
 * by a running studio is never overwritten. Every Host that uses the store, of any profile, watches the store file and
 * reads it again within a second of the write, setting the open chats of a workspace that lost its grant back to the
 * safer preset, and reads it again at its next decision in any case; a running `delorun headless` task reads it at
 * its next decision. The command sends no request to a running profile: after turning full access off it names the
 * profiles whose home process runs, from their home locks alone. A folder Delorun never adds as a workspace — a
 * filesystem root, the home folder, the Delorun home and the stock home, or a folder containing one — is refused.
 *
 * `delorun workspace external-agents` lists, allows and revokes the external agents that start in a workspace without
 * asking ([external-agents](./external-agents.ts)).
 *
 * @module @delorun/cli/workspace/command
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { resolveDelorunHome, shellQuote, workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem } from '@delorun/home'
import {
  FULL_ACCESS_PRESET, permissionStorePath, readPermissionStore, SAFER_PRESET, withPermissionStoreLock, writePermissionStore,
  type PermissionPresetName, type WorkspacePermission,
} from '@delorun/plugin-permission-defaults/store'
import { fullAccessNote, workspaceAccessOf } from '@delorun/plugin-permission-defaults/review'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { printable } from '../terminal-text.ts'
import { externalAgents } from './external-agents.ts'

/** What the command runs against. */
export interface WorkspaceDependencies {
  /**
   * The profiles whose home process runs.
   * @param home - the Delorun home.
   * @returns each profile a live process holds the home lock of, sorted.
   */
  readonly runningProfiles: (home: string) => readonly string[]
  /**
   * Ask the person a yes-or-no question, defaulting to no.
   * @param message - the question.
   * @returns the answer, or undefined when the person cancelled.
   */
  readonly confirm: (message: string) => Promise<boolean | undefined>
  /** Whether standard input and output are a terminal, where the person can answer. */
  readonly terminal: boolean
  /**
   * The directory a relative folder is resolved against.
   * @returns the command's working directory.
   */
  readonly cwd: () => string
  /**
   * The time a grant records.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
}

/** The usage line. */
const USAGE = 'Usage: delorun workspace full-access [<folder> on|off] [--profile <name>]\n       delorun workspace external-agents [<folder> <agent> on|off]'

/** One invocation's home, profile, output and dependencies. */
interface Where {
  readonly home: string
  readonly profile: string
  readonly context: CommandContext
  readonly dependencies: WorkspaceDependencies
}

/**
 * Build the command over its dependencies.
 * @param dependencies - the running check, the home socket, the prompt, the terminal check, the directory and the clock.
 * @returns the command.
 */
export function createWorkspaceCommand(dependencies: WorkspaceDependencies): CliCommand {
  return {
    name: 'workspace',
    summary: 'A workspace\'s full access and the external agents that start there without asking, changed at this computer: full-access [<folder> on|off], external-agents [<folder> <agent> on|off]',
    async run(args, context) {
      const { values, positionals } = parseCommandLine('workspace', args, { profile: { type: 'string' } })
      const [action, folder, state, extra] = positionals
      if (action === 'external-agents') {
        const home = (await resolveDelorunHome(context.env)).path
        return externalAgents({
          home, context, terminal: dependencies.terminal, confirm: dependencies.confirm, cwd: dependencies.cwd(), now: dependencies.now(),
        }, positionals.slice(1))
      }
      if (action !== 'full-access') {
        throw new CliError(EXIT.usage, `delorun workspace: ${action === undefined ? 'choose what to change, full-access or external-agents' : `unknown action ${JSON.stringify(action)}, use full-access or external-agents`}.\n${USAGE}`)
      }
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDelorunHome(context.env)).path
      const where = { home, profile, context, dependencies }
      if (folder === undefined) return list(where)
      if (extra !== undefined || (state !== 'on' && state !== 'off')) {
        throw new CliError(EXIT.usage, `delorun workspace full-access: name one folder and on or off\n${USAGE}`)
      }
      return change(where, folder, state === 'on')
    },
  }
}

/**
 * Ask a yes-or-no question in the terminal, defaulting to no.
 * @param message - the question.
 * @returns the answer, or undefined when the person cancels.
 */
export async function confirmInTerminal(message: string): Promise<boolean | undefined> {
  const answer = await clack.confirm({ message, initialValue: false })
  return clack.isCancel(answer) ? undefined : answer
}

/**
 * The profiles whose home process runs: each directory under the home's `run/` whose home lock a live process holds.
 * Only the home locks are read, never a profile's token.
 * @param home - the Delorun home.
 * @returns the profiles, sorted; none while `run/` cannot be listed.
 */
export function runningProfiles(home: string): readonly string[] {
  let names: string[]
  try {
    names = readdirSync(join(home, DELORUN_HOME_ENTRIES.run), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (_missing) {
    // A home whose run directory is missing or unreadable has no running profile to name.
    return []
  }
  return names.filter(profile => runs(home, profile)).sort()
}

/**
 * Whether a profile's home process runs.
 * @param home - the Delorun home.
 * @param profile - the profile.
 * @returns {@link homeRuns}, or false when the home lock is not a lock record, which names no live holder.
 */
function runs(home: string, profile: string): boolean {
  try {
    return homeRuns(home, profile)
  } catch (_damaged) {
    // A damaged home lock names no process; the command only names running profiles, so it leaves this one out.
    return false
  }
}

/** `delorun workspace`, over the permission store and a terminal prompt. */
export const workspaceCommand: CliCommand = createWorkspaceCommand({
  runningProfiles,
  confirm: confirmInTerminal,
  terminal: [process.stdin, process.stdout].every(stream => stream.isTTY === true),
  cwd: () => process.cwd(),
  now: () => Date.now(),
})

/**
 * The store's entries.
 * @param home - the Delorun home.
 * @returns the entries; none while no store exists.
 * @throws {CliError} naming the file and its problem when the store is refused.
 */
async function entriesOf(home: string): Promise<ReadonlyMap<string, WorkspacePermission>> {
  const path = permissionStorePath(home)
  const read = await readPermissionStore(path)
  if (read.kind === 'refused') {
    throw new CliError(EXIT.failed, `delorun workspace: Delorun's record of full-access grants, ${path}, cannot be read (${read.problem}), so no grant counts and nothing was changed. Repair or remove that file, then run the command again.`)
  }
  return read.kind === 'readable' ? read.entries : new Map()
}

/**
 * `delorun workspace full-access` without a folder.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function list(where: Where): Promise<ExitCode> {
  const entries = await entriesOf(where.home)
  if (entries.size === 0) {
    where.context.stdout('No workspace has full access. Every workspace starts on the safer preset.\n')
    return EXIT.ok
  }
  const lines = [...entries.keys()].sort().map((workspace) => {
    const access = workspaceAccessOf(entries, workspace)
    const state = access.grantedAt === null ? 'safer preset' : `full access since ${new Date(access.grantedAt).toISOString()}`
    return `${printable(workspace)}  ${state}`
  })
  where.context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}

/**
 * The workspace key of a folder the person named, refusing a folder that does not exist and a folder Delorun never adds.
 * @param where - the invocation.
 * @param folder - the folder as typed, absolute or relative to the working directory.
 * @returns the canonical key.
 * @throws {CliError} for a missing folder, a file, or a location Delorun never adds as a workspace.
 */
async function keyOf(where: Where, folder: string): Promise<string> {
  const path = resolve(where.dependencies.cwd(), folder)
  let directory: boolean
  try {
    directory = statSync(path).isDirectory()
  } catch {
    // A folder that cannot be read is no folder this command can name; the refusal says which path it tried.
    directory = false
  }
  if (!directory) throw new CliError(EXIT.failed, `delorun workspace full-access: ${JSON.stringify(path)} is not a folder; name the workspace's folder`)
  const workspace = workspaceKey(path)
  const problem = await workspaceLocationProblem(workspace, workspaceLocationHomes(where.home))
  if (problem !== undefined) throw new CliError(EXIT.failed, `delorun workspace full-access: ${workspaceLocationMessage(problem)} Nothing was changed.`)
  return workspace
}

/**
 * `delorun workspace full-access <folder> on|off`.
 * @param where - the invocation.
 * @param folder - the folder as typed.
 * @param on - turn full access on, or off.
 * @returns the exit code.
 */
async function change(where: Where, folder: string, on: boolean): Promise<ExitCode> {
  const { home, context, dependencies } = where
  const workspace = await keyOf(where, folder)
  const shown = workspaceAccessOf(await entriesOf(home), workspace)
  const named = printable(workspace)
  const again = `delorun workspace full-access ${printable(shellQuote(workspace))} ${on ? 'on' : 'off'}`
  if ((shown.grantedAt !== null) === on) {
    context.stdout(`Full access is already ${on ? 'on' : 'off'} for ${named}.\n`)
    return EXIT.ok
  }
  if (on) {
    if (!dependencies.terminal) {
      return failed(context, `turning on full access asks you to confirm at a terminal, so nothing was changed. Run ${again} in a terminal on this computer`)
    }
    context.stdout(`${fullAccessNote(workspace)}\n`)
    if (await dependencies.confirm('Turn on full access for this workspace?') !== true) {
      return failed(context, `nothing was changed; full access stays off for ${named}`)
    }
  }
  const path = permissionStorePath(home)
  let next: ReadonlyMap<string, WorkspacePermission> | undefined
  try {
    next = await withPermissionStoreLock(path, async () => {
      const current = await entriesOf(home)
      if (workspaceAccessOf(current, workspace).reviewId !== shown.reviewId) return undefined
      const written = recorded(current, workspace, on ? FULL_ACCESS_PRESET : SAFER_PRESET, dependencies.now())
      await writePermissionStore(path, written)
      return written
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(EXIT.failed, `delorun workspace: nothing was recorded, because Delorun's record of full-access grants, ${path}, could not be changed (${reasonOf(error)}). Check that its folder belongs to you and that no other delorun command is changing it, then run ${again} again.`)
  }
  if (next === undefined) {
    return failed(context, `the full access of ${named} changed while you answered, so nothing was changed. Run ${again} again`)
  }
  if (on) {
    context.stdout(`Full access is on for ${named}. Chats in this workspace may switch to it, and delorun headless there may run with it. Turn it off with: delorun workspace full-access ${printable(shellQuote(workspace))} off\n`)
    return EXIT.ok
  }
  context.stdout(`Full access is off for ${named}; its chats start on the safer preset.\n`)
  const running = dependencies.runningProfiles(home)
  if (running.length > 0) {
    context.stdout(`Delorun runs in profile ${running.map(printable).join(', ')}: running chats there switch to the safer preset within a second.\n`)
  }
  return EXIT.ok
}

/**
 * The words a failure gives.
 * @param error - the failure.
 * @returns its message, or plain words when it has none.
 */
function reasonOf(error: unknown): string {
  /* v8 ignore next -- the lock and the file system throw only Error instances; the words cover any other value. */
  return error instanceof Error ? error.message : 'no reason was given'
}

/**
 * The store's entries with one workspace's preset recorded: full access keeps an earlier grant's time or records now,
 * the safer preset records no grant.
 * @param entries - the entries the file holds now.
 * @param workspace - the workspace key.
 * @param preset - the preset.
 * @param now - the time a new grant records.
 * @returns the entries to write.
 */
function recorded(entries: ReadonlyMap<string, WorkspacePermission>, workspace: string, preset: PermissionPresetName, now: number): ReadonlyMap<string, WorkspacePermission> {
  const next = new Map(entries)
  next.set(workspace, { preset, fullAccessGrantedAt: preset === FULL_ACCESS_PRESET ? entries.get(workspace)?.fullAccessGrantedAt ?? now : null })
  return next
}

/**
 * Report a failure.
 * @param context - the output.
 * @param message - the sentence.
 * @returns {@link EXIT.failed}.
 */
function failed(context: CommandContext, message: string): ExitCode {
  context.stderr(`delorun workspace: ${message}\n`)
  return EXIT.failed
}
