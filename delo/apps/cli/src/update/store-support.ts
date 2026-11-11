/**
 * The update support of a home process that runs from C1's runtime store: the store of this machine's platform, a
 * release channel opened for each prepare on the channel the running release names and walking from the roots the
 * launcher ships, the report's readers over the store and the profile, the profile history and the session-data copies
 * ([support](./support.ts)). Every root they verify with is anchored on the launcher's roots
 * ([trusted root](./trusted-root.ts)); a home process the launcher did not start refuses every update and rollback
 * with `ROOT_NOT_ANCHORED`. A home process that never prepares an update never reads the stored root.
 *
 * @module @delo/cli/update/store-support
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateSupport } from '@delo/home-process'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStore, type OpenUpdateChannel, type TrustedRootSource, type VerifiedRuntime } from '@delo/runtime-store'
import { homeReleaseChannel, runtimePlatformOf } from './channel.ts'
import { storeReportSources } from './sources.ts'
import { homeUpdateSupport } from './support.ts'
import { releaseLogStartCheck } from './release-check.ts'
import { launcherAnchor, type LauncherAnchor } from './trusted-root.ts'

/**
 * The opener of this home's release channel: it checks the running release with C1's start check under the anchored
 * root and opens the channel that release's manifest names, walking from the launcher's roots.
 * @param home - the resolved Delo home.
 * @param store - C1's runtime store.
 * @param running - the version this process runs.
 * @param anchor - the launcher's roots and the stored root anchored on them.
 * @returns the opener.
 */
export function storeChannelOpener(home: string, store: RuntimeStore, running: RuntimeVersion, anchor: LauncherAnchor): OpenUpdateChannel {
  return async (line) => {
    const release = await store.checkRuntime(running, await anchor.root())
    return homeReleaseChannel(home, store.paths.platform, release.manifest.channel, await anchor.shipped(), line)
  }
}

/**
 * The update support of a home process running from the store.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param running - the version this process runs.
 * @param logger - the home process's logger.
 * @param env - the environment `delorun` was started with, read for the launcher's roots.
 * @returns the support.
 * @throws {Error} when Delo publishes no runtime for this machine's platform.
 */
export function storeUpdateSupport(home: string, profile: string, running: RuntimeVersion, logger: DeloLogger, env: Readonly<Record<string, string | undefined>>): UpdateSupport {
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger })
  const anchor = launcherAnchor(home, env)
  return homeUpdateSupport({
    home, profile, store, root: anchor.root, preLaunch: (version, root) => releaseLogStartCheck(home, store.paths.platform, version, root), openChannel: storeChannelOpener(home, store, running, anchor), sources: storeReportSources({ home, profile, store, running, root: anchor.root }), now: () => new Date(),
  })
}

/**
 * C1's start check of an installed version, as C3's health check H1 runs it on the version a home process runs.
 * @param home - the resolved Delo home.
 * @param version - the installed version.
 * @param logger - the home process's logger.
 * @param root - the stored root, anchored on the launcher's roots.
 * @returns the verified runtime with its signed file list.
 * @throws {RuntimeStoreError} when the version is not installed, its files do not match its manifest, or the root
 *   does not verify it; `ROOT_NOT_ANCHORED` when the root cannot be anchored.
 */
export async function checkStoredRuntime(home: string, version: RuntimeVersion, logger: DeloLogger, root: TrustedRootSource): Promise<VerifiedRuntime> {
  return new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger }).checkRuntime(version, await root())
}
