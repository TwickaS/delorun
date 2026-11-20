/**
 * The age check every `delorun` invocation runs as it starts (contract C20, "Rotation and retention"): each expired
 * file of every local operational log under the home is deleted, so the logs of a process that is not running are
 * pruned too. A refused log directory or file is reported as a warning and left as it is; the command runs either
 * way.
 *
 * @module @delorun/cli/logs/startup
 */
import { HomeLayoutError, resolveDelorunHome } from '@delorun/home'
import { pruneLocalSurfaces } from '@delorun/logs'
import type { CommandContext } from '../command.ts'
import { isSandboxHomeMode } from '../sandbox-home.ts'

/**
 * Prune the expired operational logs of the home this invocation resolves.
 * @param context - the environment and output.
 * @param now - the time of the check, in milliseconds since the epoch.
 * @returns when the check is done; a home that does not resolve is left to the command, which reports it.
 */
export async function pruneLogsAtStart(context: CommandContext, now: number): Promise<void> {
  let home
  try {
    home = await resolveDelorunHome(context.env)
  } catch (error: unknown) {
    // A home C1 refuses is reported by the command itself, with its own exit code.
    if (error instanceof HomeLayoutError) return
    throw error
  }
  let report
  try {
    report = pruneLocalSurfaces(home.path, now)
  } catch (error: unknown) {
    // Inside a chat sandbox the hidden home shows fake mode bits; there are no logs to prune, so the check stays quiet.
    if (isSandboxHomeMode(error, context.env)) return
    // The home's `logs/` directory could not be listed; the command still runs, and the next start checks again.
    context.stderr(`delorun: warning: the operational logs were not pruned: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }
  for (const failure of report.failures) context.stderr(`delorun: warning: an expired operational log was not pruned: ${failure.message}\n`)
}
