/**
 * The plugin operation `delorun changes apply` runs for the agent's plugin requests: upstream's `runProfilePnpm`, the
 * operation `delorun plugin` runs, with the same output and wait bounds. `applyInstallChange` already holds the
 * profile's write lock, so the operation is the one upstream's own command line runs under a lock it took itself.
 *
 * @module @delo/cli/changes/plugin-operation
 */
import type { ChangesContext, PluginOperation } from '@delo/changes'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { CommandContext } from '../command.ts'

/** Output a profile plugin operation keeps for its result, as `dsh plugin` keeps it. */
const OUTPUT_BYTES = 16_384

/** How long an operation waits for pnpm's package lookups, as `dsh plugin` waits. */
const LOOKUP_WAIT_MS = 120_000

/** Upstream's operation and the installation anchor `dsh plugin` passes; loaded once the launch variables are set. */
export interface UpstreamOperation {
  readonly installAnchor: string
  readonly runProfilePnpm: (context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions) => Promise<{ readonly exitCode: number, readonly logPath: string }>
}

/**
 * @returns upstream's operation and installation anchor.
 */
export async function loadUpstream(): Promise<UpstreamOperation> {
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  const { runProfilePnpm } = await import('@deepseek-ai/dsh-plugin-manager/operations')
  return { installAnchor: INSTALL_ANCHOR, runProfilePnpm }
}

/**
 * The operation for one profile, printing pnpm's output as `delorun plugin` does.
 * @param ctx - the profile.
 * @param context - the command's output.
 * @param upstream - loads upstream's operation; the installed one by default.
 * @returns the operation.
 */
export function upstreamPluginOperation(ctx: ChangesContext, context: Pick<CommandContext, 'stdout' | 'stderr'>, upstream: () => Promise<UpstreamOperation> = loadUpstream): PluginOperation {
  return async (args) => {
    const { installAnchor, runProfilePnpm } = await upstream()
    const { exitCode, logPath } = await runProfilePnpm(
      { profile: ctx.profile, dir: ctx.profileDir, installAnchor, cwd: process.cwd(), home: ctx.home },
      args,
      { execution: 'cli', outputBytes: OUTPUT_BYTES, lookupTimeoutMs: LOOKUP_WAIT_MS, onOutput: (text, stream) => context[stream === 'stdout' ? 'stdout' : 'stderr'](text) },
    )
    return { exitCode, logPath }
  }
}
