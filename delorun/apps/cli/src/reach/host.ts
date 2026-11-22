/**
 * The home process's way to `@delorun/reach` in the Host it runs: the live state and the restart that the update channel's
 * `reach.status` and `reach.apply` drive (contracts C7 and C19). `delorun start` attaches it to the running Host.
 *
 * @module @delorun/cli/reach/host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReachOptionStatus } from '@delorun/contract-home-process'
import type { ReachConfigRows } from '@delorun/contract-reach-providers'
import type { LocalReach } from '@delorun/home-process'
import type { ReachStatus } from '@delorun/reach'
import type { TailscalePrivateRow } from '@delorun/setup-apply'
import { isRecord } from '../patch-layers.ts'

/**
 * The `delorun-reach` row's config as a running Host holds it after a `reach.apply`: its boot config with
 * `tailscalePrivate` replaced by the option the service restarted from. An apply changes nothing else: the switch
 * `reach` (`enabled`) and every other key take effect only at the next start.
 * @param bootConfig - the row's config at boot.
 * @param option - the option the service restarted from, as `readReachRow` read it.
 * @returns the config.
 */
export function appliedReachConfig(bootConfig: unknown, option: TailscalePrivateRow): Record<string, unknown> {
  return { ...isRecord(bootConfig) ? bootConfig : {}, tailscalePrivate: { ...option } }
}

/**
 * One option's state as the channel answers it.
 * @param status - the service's state.
 * @returns the line's entry.
 */
function optionLine(status: ReachStatus): ReachOptionStatus {
  return {
    option: status.option,
    state: status.state,
    ...status.address === undefined ? {} : { address: status.address },
    ...status.cause === undefined ? {} : { cause: status.cause },
    ...status.detail === undefined ? {} : { detail: status.detail },
  }
}

/**
 * The reach operations of a booted Host.
 * @param ctx - the Host's root context.
 * @param rows - reads the profile's rows when `reach.apply` arrives.
 * @returns the operations, or undefined when the profile does not load `@delorun/reach`.
 */
export function localReach(ctx: Pick<Context, 'get'>, rows: () => ReachConfigRows): LocalReach | undefined {
  const reach = ctx.get('reach')
  if (reach === undefined) return undefined
  return {
    status: () => (reach.mounted ? reach.status().map(optionLine) : undefined),
    apply: async () => (await reach.apply(rows()))?.map(optionLine),
  }
}
