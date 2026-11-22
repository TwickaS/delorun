/**
 * Turning the Browser plugin pack off, for the Browser step's "No browser" choice, and the browser download Browser
 * needs, shown in the downloads panel. Adding the pack goes through the guide's bundle installer, as every other add
 * does; turning it off asks the plugin manager to disable the bundle, which keeps its checks of protected bundles and of
 * a paired device's unlock.
 * @module @delorun/plugin-onboarding/client/browser-pack
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { BROWSER_BUNDLE } from '@delorun/browser-setup'
import type { BrowserInstallAnswer } from '@delorun/bundle-local/browser-check-api'
import { BROWSER_DOWNLOAD_KEY, startPageDownload } from '@delorun/plugin-downloads/row'

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

/**
 * Run the browser download with a row in the downloads panel. The download runs outside the Host's install queue and
 * reports no byte count, so the row's bar moves without a measure until the download ends.
 * @param run - starts the download on the Host and answers how it ended.
 * @returns the answer, unchanged.
 */
export async function downloadBrowserShown(run: () => Promise<BrowserInstallAnswer>): Promise<BrowserInstallAnswer> {
  const shown = startPageDownload(BROWSER_DOWNLOAD_KEY)
  const answer = await run()
  if (answer.ok) shown.done()
  else shown.failed(answer.message)
  return answer
}
