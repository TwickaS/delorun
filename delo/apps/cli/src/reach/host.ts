/**
 * The home process's way to `@delo/reach` in the Host it runs: the live state and the restart that the update channel's
 * `reach.status` and `reach.apply` drive (contracts C7 and C19). `delorun start` attaches it to the running Host.
 *
 * @module @delo/cli/reach/host
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import type { ReachOptionStatus } from '@delo/contract-home-process'
import type { ReachConfigRows } from '@delo/contract-reach-providers'
import type { LocalReach } from '@delo/home-process'
import type { ReachStatus } from '@delo/reach'
import type { TailscalePrivateRow } from './row.ts'

/**
 * The reach service's rows of a profile's Tailscale private row.
 * @param row - the row, as `readReachRow` reads it.
 * @returns the rows the service resolves.
 */
export function reachRowsOf(row: TailscalePrivateRow): ReachConfigRows {
  return { tailscalePrivate: { ...row, address: brandString<StudioAddress>(row.address) } }
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
 * @returns the operations, or undefined when the profile does not load `@delo/reach`.
 */
export function localReach(ctx: Pick<Context, 'get'>, rows: () => ReachConfigRows): LocalReach | undefined {
  const reach = ctx.get('reach')
  if (reach === undefined) return undefined
  return {
    status: () => (reach.mounted ? reach.status().map(optionLine) : undefined),
    apply: async () => (await reach.apply(rows()))?.map(optionLine),
  }
}
