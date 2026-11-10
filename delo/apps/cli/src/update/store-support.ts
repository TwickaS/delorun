/**
 * The update support of a home process that runs from C1's runtime store: the store of this machine's platform, a
 * release channel opened for each prepare on the channel the running release names and anchored on the root chain the
 * home stores, the report's readers over the store and the profile, the profile history and the session-data copies
 * ([support](./support.ts)). A home process that never prepares an update never reads the stored root chain.
 *
 * @module @delo/cli/update/store-support
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateSupport } from '@delo/home-process'
import type { DeloLogger } from '@delo/logs'
import { readStoredRoot, RuntimeStore, type OpenUpdateChannel } from '@delo/runtime-store'
import { homeReleaseChannel, runtimePlatformOf } from './channel.ts'
import { storeReportSources } from './sources.ts'
import { homeUpdateSupport } from './support.ts'

/**
 * The opener of this home's release channel: it checks the running release with C1's start check and opens the
 * channel that release's manifest names.
 * @param home - the resolved Delo home.
 * @param store - C1's runtime store.
 * @param running - the version this process runs.
 * @returns the opener.
 */
export function storeChannelOpener(home: string, store: RuntimeStore, running: RuntimeVersion): OpenUpdateChannel {
  return async (line) => {
    const release = await store.checkRuntime(running, await readStoredRoot(home))
    return homeReleaseChannel(home, store.paths.platform, release.manifest.channel, line)
  }
}

/**
 * The update support of a home process running from the store.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param running - the version this process runs.
 * @param logger - the home process's logger.
 * @returns the support.
 * @throws {Error} when Delo publishes no runtime for this machine's platform.
 */
export function storeUpdateSupport(home: string, profile: string, running: RuntimeVersion, logger: DeloLogger): UpdateSupport {
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger })
  return homeUpdateSupport({ home, profile, store, openChannel: storeChannelOpener(home, store, running), sources: storeReportSources({ home, profile, store, running }), now: () => new Date() })
}

/**
 * C1's start check of an installed version, as C3's health check H1 runs it on the version a home process runs.
 * @param home - the resolved Delo home.
 * @param version - the installed version.
 * @param logger - the home process's logger.
 * @throws {RuntimeStoreError} when the version is not installed, its files do not match its manifest, or the stored
 *   root does not verify it.
 */
export async function checkStoredRuntime(home: string, version: RuntimeVersion, logger: DeloLogger): Promise<void> {
  await new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger }).checkRuntime(version, await readStoredRoot(home))
}
