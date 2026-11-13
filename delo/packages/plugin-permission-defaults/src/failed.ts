/**
 * What the row mounts when one of its services failed to activate while the `permission_defaults` switch is on: the
 * seams that the row's services would have decided answer their most restrictive value, so a crashed row never reads
 * as a composition without one. Commands get no network, and a switch to `danger-full-access` is refused.
 *
 * @module @delo/plugin-permission-defaults/failed
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxModeGuard, SandboxNetworkResolver } from '@deepseek-ai/dsh-sandbox-policy'

/** The row that mounts this plugin in Delo's composition, named in a refusal. */
export const PERMISSION_DEFAULTS_ROW = 'delo-permission-defaults'

/**
 * Why a failed row refuses, and how to recover.
 * @param reason - why the service failed.
 * @returns the sentence the person and the model read.
 */
export function failedRowNote(reason: string): string {
  return `the permission-defaults row ${PERMISSION_DEFAULTS_ROW} is on but a service of it failed to start (${reason}). `
    + 'To recover, restart Delorun; if it fails again, read the Delo logs for the row\'s failure, or start in safe mode with `delorun recover safe-mode`.'
}

/** The disposers of the restrictive answers mounted on a root context, until the row starts again or the root ends. */
const mounted = new WeakMap<Context, (() => void)[]>()

/**
 * Mount the restrictive answers of the seams the row's services did not provide. They are provided on the root
 * context, not the row's, because a row whose start failed loses its own registrations, which would leave the seams
 * empty and the commands on the host's network. {@link clearFailedRow} removes them when the row starts again.
 * @param ctx - the row's context.
 * @param reason - why the service failed.
 */
export function mountFailedRow(ctx: Context, reason: string): void {
  const root = ctx.root
  const note = failedRowNote(reason)
  const disposers = mounted.get(root) ?? []
  mounted.set(root, disposers)
  if (root.get('sandboxNetwork') === undefined) {
    // No network at all, never the host's; a runner that cannot express it refuses the command with its own reason.
    const resolver: SandboxNetworkResolver = () => ({ mode: 'off' })
    disposers.push(root.provide('sandboxNetwork', resolver))
  }
  if (root.get('sandboxModeGuard') === undefined) {
    const guard: SandboxModeGuard = (_session, mode) => mode === 'danger-full-access' ? `full access is refused: ${note}` : undefined
    disposers.push(root.provide('sandboxModeGuard', guard))
  }
}

/**
 * Remove the answers a failed start of the row mounted, before the row starts again.
 * @param ctx - the row's context.
 */
export function clearFailedRow(ctx: Context): void {
  for (const dispose of mounted.get(ctx.root)?.splice(0) ?? []) dispose()
}
