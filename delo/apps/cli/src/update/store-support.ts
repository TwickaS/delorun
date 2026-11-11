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
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import type { UpdateSupport } from '@delo/home-process'
import type { DeloLogger } from '@delo/logs'
import { FULL_CHECK_DAYS_ENV, resolveFullCheckDays, RuntimeStore, type OpenUpdateChannel, type TrustedRootSource } from '@delo/runtime-store'
import { homeReleaseChannel, runtimePlatformOf } from './channel.ts'
import { storeReportSources } from './sources.ts'
import { homeUpdateSupport } from './support.ts'
import { releaseLogStartCheck } from './release-check.ts'
import { launcherAnchor, type LauncherAnchor } from './trusted-root.ts'

/**
 * The interval of the start check's full hash a home process uses: the launcher's variable, which the launcher already
 * refused to start with when it is invalid.
 * @param env - the environment `delorun` was started with.
 * @returns the interval in days.
 * @throws {Error} when the variable is not a whole number of days from 0 to 30.
 */
export function fullCheckDaysOf(env: Readonly<Record<string, string | undefined>>): number {
  return resolveFullCheckDays(env[FULL_CHECK_DAYS_ENV])
}

/**
 * The opener of this home's release channel: it checks the running release with C2's start check under the anchored
 * root, as the launcher checked it before this process started, and opens the channel that release's manifest names,
 * walking from the launcher's roots.
 * @param home - the resolved Delo home.
 * @param store - C1's runtime store.
 * @param running - the version this process runs.
 * @param anchor - the launcher's roots and the stored root anchored on them.
 * @param fullCheckDays - the interval of the start check's full hash in days.
 * @returns the opener.
 */
export function storeChannelOpener(home: string, store: RuntimeStore, running: RuntimeVersion, anchor: LauncherAnchor, fullCheckDays: number): OpenUpdateChannel {
  return async (line) => {
    const release = await store.startCheckRuntime(running, await anchor.root(), fullCheckDays)
    return homeReleaseChannel(home, store.paths.platform, release.manifest.channel, await anchor.shipped(), line)
  }
}

/**
 * The update support of a home process running from the store.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param running - the version this process runs.
 * @param logger - the home process's logger.
 * @param env - the environment `delorun` was started with, read for the launcher's roots and the interval of the start
 *   check's full hash.
 * @param admitVersion - decides whether an update's snapshot may be saved; every snapshot is saved without one.
 * @returns the support.
 * @throws {Error} when Delo publishes no runtime for this machine's platform, or the interval is invalid.
 */
export function storeUpdateSupport(home: string, profile: string, running: RuntimeVersion, logger: DeloLogger, env: Readonly<Record<string, string | undefined>>, admitVersion?: VersionAdmission): UpdateSupport {
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger })
  const anchor = launcherAnchor(home, env)
  const fullCheckDays = fullCheckDaysOf(env)
  return homeUpdateSupport({
    home, profile, store, root: anchor.root, fullCheckDays, preLaunch: (version, root) => releaseLogStartCheck(home, store.paths.platform, version, root), openChannel: storeChannelOpener(home, store, running, anchor, fullCheckDays), sources: storeReportSources({ home, profile, store, running, root: anchor.root, fullCheckDays }), now: () => new Date(),
    ...admitVersion === undefined ? {} : { admitVersion },
  })
}

/**
 * C2's start check of an installed version, as C3's health check H1 runs it on the version a home process runs: the
 * check the launcher runs before a start, by each file's recorded identity or its hash. For an update's target, every
 * file was hashed at install from the bytes it was written from, and the identity record captured then vouches for
 * each file the switch has not touched since; a file whose identity changed is hashed again.
 * @param home - the resolved Delo home.
 * @param version - the installed version.
 * @param logger - the home process's logger.
 * @param root - the stored root, anchored on the launcher's roots.
 * @param fullCheckDays - the interval of the start check's full hash in days.
 * @throws {RuntimeStoreError} when the version is not installed, its files do not match its manifest, or the root
 *   does not verify it; `ROOT_NOT_ANCHORED` when the root cannot be anchored.
 */
export async function checkStoredRuntime(home: string, version: RuntimeVersion, logger: DeloLogger, root: TrustedRootSource, fullCheckDays: number): Promise<void> {
  await new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger }).startCheckRuntime(version, await root(), fullCheckDays)
}
