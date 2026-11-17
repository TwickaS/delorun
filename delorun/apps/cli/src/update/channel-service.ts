/**
 * Hands the home process's update channel to `@delorun/plugin-update`, which the studio's update routes use for the
 * update, rollback and stop requests. The channel carries the Host's channel token inside its `send` method and nothing
 * else; a Host outside the runtime store hands over none. No Cordis service holds it.
 *
 * @module @delorun/cli/update/channel-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { UpdateChannelAccess } from '@delorun/home-process'
import { handUpdateChannel } from '@delorun/plugin-update'

/**
 * Hand over the update channel for as long as the Host runs.
 * @param root - the Host's root context, before the Loader mounts its first row.
 * @param access - the home process's way to its update channel, or undefined outside the runtime store.
 */
export function provideUpdateChannel(root: Context, access: UpdateChannelAccess | undefined): void {
  if (access === undefined) return
  root.effect(() => handUpdateChannel(access), 'delorun update channel')
}
