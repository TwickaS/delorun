/**
 * The hand-over of the home process's update channel from `delorun start` to this plugin. The channel is held in this
 * module and read only by {@link heldUpdateChannel}, which the package's exports do not offer, so no Cordis service
 * name lets another plugin send update, rollback or stop requests around the access table.
 *
 * @module @delorun/plugin-update/channel-handover
 */
import type { UpdateChannelAccess } from '@delorun/home-process'

let held: UpdateChannelAccess | undefined

/**
 * Give this plugin the Host's update channel. The first hand-over wins: `delorun start` makes it before any row loads.
 * @param access - the Host's way to the update channel.
 * @returns the call that takes the channel back, for the Host's teardown.
 * @throws {Error} when a channel is already handed over.
 */
export function handUpdateChannel(access: UpdateChannelAccess): () => void {
  if (held !== undefined) throw new Error('the update channel is already handed to plugin-update')
  held = access
  return () => {
    if (held === access) held = undefined
  }
}

/**
 * The channel handed over.
 * @returns it, or undefined outside an installed release's Host.
 */
export function heldUpdateChannel(): UpdateChannelAccess | undefined {
  return held
}
