/**
 * The plugin operation `delorun changes apply` runs for the agent's plugin requests: `@delo/changes`' shared
 * operation (upstream's `runProfilePnpm` with the checks the plugin manager's `installBundle` runs around it), from the
 * command's directory and with pnpm's output on the command's streams, with this installation's anchor.
 *
 * @module @delo/cli/changes/plugin-operation
 */
import type { ChangesContext, PluginOperation } from '@delo/changes'
import { loadUpstreamChecks, upstreamPluginOperation as sharedOperation, type UpstreamOperation } from '@delo/changes/plugin-operation'
import type { CommandContext } from '../command.ts'

export type { UpstreamOperation } from '@delo/changes/plugin-operation'

/**
 * Load upstream's pnpm operation, checks and installation anchor, imported after the launch variables are set so
 * upstream resolves the Delo home and Delo's version.
 * @returns upstream's operation, checks and installation anchor.
 */
export async function loadUpstream(): Promise<UpstreamOperation> {
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  return { installAnchor: INSTALL_ANCHOR, ...await loadUpstreamChecks() }
}

/**
 * The operation for one profile, printing pnpm's output on the command's streams.
 * @param ctx - the profile.
 * @param context - the command's output.
 * @param upstream - loads upstream's operation and checks; the installed ones by default.
 * @returns the operation.
 */
export function upstreamPluginOperation(ctx: ChangesContext, context: Pick<CommandContext, 'stdout' | 'stderr'>, upstream: () => Promise<UpstreamOperation> = loadUpstream): PluginOperation {
  return sharedOperation(ctx, { cwd: process.cwd(), output: (text, stream) => context[stream](text), upstream })
}
