/**
 * The update channel's reach operations (contracts C7 and C19): `reach.status` reads the live state of each reach
 * option in the running Host, and `reach.apply` makes the Host's reach service restart its options from the row
 * `delorun reach on|off` wrote, so a running home applies the change without a restart.
 *
 * Both are accepted only with the person's token: the Host's channel token, which acts for studio sessions on every
 * listener, reach sessions included, is refused with `LOOPBACK_REQUIRED` before the Host is asked anything.
 *
 * @module @delorun/home-process/reach
 */
import type { ReachApplyRequest, ReachOptionStatus, ReachStatusRequest } from '@delorun/contract-home-process'
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'

/** The Host's half of the reach operations: the reach service of `@delorun/reach`. */
export interface LocalReach {
  /**
   * Each option's state now.
   * @returns the states, or undefined when the Host's reach service does not run.
   */
  status(): readonly ReachOptionStatus[] | undefined
  /**
   * Restart every option from the profile's `delorun-reach` row as the profile holds it now.
   * @returns each option's state once its start settled, or undefined when the Host's reach service does not run,
   *   so only the next start applies the row.
   */
  apply(): Promise<readonly ReachOptionStatus[] | undefined>
}

/**
 * Refuse a reach operation the person's own command did not send, or one that reaches a Host without remote access.
 * @param caller - the credential the request carried.
 * @param reach - the Host's reach operations, or undefined while no Host runs.
 * @returns the Host's reach operations.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `REACH_UNAVAILABLE` without a Host.
 */
function personReach(caller: ChannelCaller, reach: LocalReach | undefined): LocalReach {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'remote access is managed at your computer: run delorun reach there')
  }
  if (reach === undefined) throw new HomeProcessError('REACH_UNAVAILABLE', 'no Host is running')
  return reach
}

/** The detail of a Host whose reach service does not run. */
const NOT_LOADED = 'the running profile did not load the reach service, so only the next start applies remote access'

/**
 * Run `reach.status`.
 * @param _request - the request, which has no arguments.
 * @param caller - the credential it carried.
 * @param reach - the Host's reach operations, or undefined while no Host runs.
 * @returns the final line's fields: `options`.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `REACH_UNAVAILABLE` when no Host or no reach
 *   service runs.
 */
export function reachStatus(_request: ReachStatusRequest, caller: ChannelCaller, reach: LocalReach | undefined): Readonly<Record<string, unknown>> {
  const options = personReach(caller, reach).status()
  if (options === undefined) throw new HomeProcessError('REACH_UNAVAILABLE', NOT_LOADED)
  return { options }
}

/**
 * Run `reach.apply`.
 * @param _request - the request, which has no arguments.
 * @param caller - the credential it carried.
 * @param reach - the Host's reach operations, or undefined while no Host runs.
 * @returns the final line's fields: `options`, each option's state once its start settled.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `REACH_UNAVAILABLE` when no Host or no reach
 *   service runs.
 */
export async function reachApply(_request: ReachApplyRequest, caller: ChannelCaller, reach: LocalReach | undefined): Promise<Readonly<Record<string, unknown>>> {
  const options = await personReach(caller, reach).apply()
  if (options === undefined) throw new HomeProcessError('REACH_UNAVAILABLE', NOT_LOADED)
  return { options }
}
