/**
 * Turning the Browser plugin pack off, for the Browser step's "No browser" choice. Adding it goes through the guide's
 * bundle installer, as every other add does; turning it off asks the plugin manager to disable the bundle, which keeps
 * its checks of protected bundles and of a paired device's unlock.
 * @module @delorun/plugin-onboarding/client/browser-pack
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { BROWSER_BUNDLE } from '@delorun/browser-setup'

/** How turning Browser off ended: it is off, it is off after a restart, or it could not be turned off. */
export type TurnOffOutcome = 'off' | 'restart' | 'failed'

/**
 * Disable the Browser bundle through the plugin manager.
 * @param ctx - the studio context; `remote.pluginManager` is read when called, so a profile without one answers `failed`.
 * @returns how it ended; it never rejects.
 */
export async function turnBrowserOff(ctx: Pick<Context, 'get'>): Promise<TurnOffOutcome> {
  const remote: ClientRemote['pluginManager'] | undefined = ctx.get('remote.pluginManager')
  if (remote === undefined) return 'failed'
  try {
    const result = await remote.setBundleEnabled(BROWSER_BUNDLE, false)
    if (!result.ok) return 'failed'
    return result.value.application === 'applied' ? 'off' : result.value.application === 'restart-required' ? 'restart' : 'failed'
  } catch (error) {
    // The outcome is unknown here; Plugins shows what the profile holds.
    console.warn('delorun onboarding: Browser was not turned off', error)
    return 'failed'
  }
}
