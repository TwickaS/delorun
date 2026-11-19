/**
 * The home process's update channel as the Host's `updateChannel` service, which the studio's update routes
 * (`@delorun/plugin-update`) send the update, rollback and stop requests through. The service carries the Host's channel
 * token inside its `send` method and nothing else; a Host outside the runtime store gets none.
 *
 * @module @delorun/cli/update/channel-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@delorun/plugin-update'
import type { UpdateChannelAccess } from '@delorun/home-process'

/**
 * Provide `updateChannel` on the Host's root context for as long as it runs.
 * @param root - the Host's root context, before the Loader mounts its first row.
 * @param access - the home process's way to its update channel, or undefined outside the runtime store.
 */
export function provideUpdateChannel(root: Context, access: UpdateChannelAccess | undefined): void {
  if (access === undefined) return
  root.effect(() => root.provide('updateChannel', access), 'delorun update channel')
}
