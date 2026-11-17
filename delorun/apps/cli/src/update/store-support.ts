/**
 * The update support of a home process that runs from C1's runtime store: the store of this machine's platform, a
 * release channel opened for each prepare on the channel the running release names and walking from the roots the
 * launcher ships, the report's readers over the store and the profile, the profile history and the session-data copies
 * ([support](./support.ts)). Every root they verify with is anchored on the launcher's roots
 * ([trusted root](./trusted-root.ts)); a home process the launcher did not start refuses every update and rollback
 * with `ROOT_NOT_ANCHORED`. A home process that never prepares an update never reads the stored root.
 *
 * @module @delorun/cli/update/store-support
 */
import { DELORUN_LAUNCHER_ROOTS_ENV, type RuntimeVersion } from '@delorun/contract-home-layout'
import { dirname } from 'node:path'
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import type { UpdateSupport } from '@delorun/home-process'
import type { DelorunLogger } from '@delorun/logs'
import { packFilesFor } from '@delorun/plugin-packs/environment'
import { checkPacksBundle } from '@delorun/release-verify'
import { carryPacks, FULL_CHECK_DAYS_ENV, resolveFullCheckDays, RuntimeStore, RuntimeStoreError, START_CHECK_SCHEMA, startCheckHandoffText, type OpenUpdateChannel, type TrustedRootSource, type CheckedRuntime } from '@delorun/runtime-store'
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
 * @param home - the resolved Delorun home.
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
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param running - the version this process runs.
 * @param logger - the home process's logger.
 * @param env - the environment `delorun` was started with, read for the launcher's roots and the interval of the start
 *   check's full hash.
 * @param admitVersion - decides whether an update's snapshot may be saved; every snapshot is saved without one.
 * @returns the support.
 * @throws {Error} when Delorun publishes no runtime for this machine's platform, or the interval is invalid.
 */
export function storeUpdateSupport(home: string, profile: string, running: RuntimeVersion, logger: DelorunLogger, env: Readonly<Record<string, string | undefined>>, admitVersion?: VersionAdmission): UpdateSupport {
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger })
  const anchor = launcherAnchor(home, env)
  const fullCheckDays = fullCheckDaysOf(env)
  return homeUpdateSupport({
    home, profile, store, root: anchor.root, fullCheckDays,
    carryPacks: (from, to) => carryPacks({ paths: store.paths, root: anchor.root, filesFor: version => packFilesFor(home, version), checkLog: checkPacksBundle }, from, to),
    preLaunch: (version, root) => releaseLogStartCheck(home, store.paths.platform, version, root), openChannel: storeChannelOpener(home, store, running, anchor, fullCheckDays), sources: storeReportSources({ home, profile, store, running, root: anchor.root, fullCheckDays }), now: () => new Date(),
    ...admitVersion === undefined ? {} : { admitVersion },
  })
}

/**
 * C2's start check of an installed version, as C3's health check H1 runs it on the version a home process runs: the
 * check the launcher runs before a start, by each file's recorded identity or its hash. For an update's target, every
 * file was hashed at install from the bytes it was written from, and the identity record captured then vouches for
 * each file the switch has not touched since; a file whose identity changed is hashed again.
 * @param home - the resolved Delorun home.
 * @param version - the installed version.
 * @param logger - the home process's logger.
 * @param root - the stored root, anchored on the launcher's roots.
 * @param fullCheckDays - the interval of the start check's full hash in days.
 * @returns the verified runtime with its signed file list.
 * @throws {RuntimeStoreError} when the version is not installed, its files do not match its manifest, or the root
 *   does not verify it; `ROOT_NOT_ANCHORED` when the root cannot be anchored.
 */
export async function checkStoredRuntime(home: string, version: RuntimeVersion, logger: DelorunLogger, root: TrustedRootSource, fullCheckDays: number): Promise<CheckedRuntime> {
  return new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger }).startCheckRuntime(version, await root(), fullCheckDays)
}

/**
 * The start-check record for a successor runtime, whose predecessor starts it without `DELORUN_START_CHECK`: the
 * predecessor may be an older release that cannot hand one over, so the successor runs the store's start check on its own
 * release, as the launcher does, and records what that check did, marked `checkedBy: 'runtime'`. No record is made
 * without a passing check: a failing check throws.
 * @param request - the release, the environment, the clock and the check.
 * @param request.version - the release this process runs.
 * @param request.env - the process's environment, read for `DELORUN_LAUNCHER_ROOTS`.
 * @param request.now - the clock, in milliseconds since the epoch.
 * @param request.check - the start check of the release's files and signed manifest; {@link checkStoredRuntime} in a real start.
 * @returns the record's text for `DELORUN_START_CHECK`.
 * @throws whatever the check throws, and `ROOT_NOT_ANCHORED` when the environment names no launcher roots.
 */
export async function successorRecord(request: { readonly version: RuntimeVersion, readonly env: Readonly<Record<string, string | undefined>>, readonly now: number, readonly check: () => Promise<Pick<CheckedRuntime, 'check'>> }): Promise<string> {
  const verified = await request.check()
  // The launcher names its roots' directory inside its package directory; the Host runs `delorun verify` through that package.
  const roots = request.env[DELORUN_LAUNCHER_ROOTS_ENV]
  if (roots === undefined || roots === '') throw new RuntimeStoreError('ROOT_NOT_ANCHORED', DELORUN_LAUNCHER_ROOTS_ENV, `${DELORUN_LAUNCHER_ROOTS_ENV} is not set, so the launcher that started this Delorun is not known`)
  return startCheckHandoffText({ schema: START_CHECK_SCHEMA, release: String(request.version), at: request.now, ...verified.check, launcher: { version: null, path: dirname(roots) }, checkedBy: 'runtime' })
}

/**
 * {@link successorRecord} over this home's store, with the root anchored on the launcher's roots.
 * @param home - the resolved Delorun home.
 * @param version - the release this process runs.
 * @param logger - the home process's logger.
 * @param env - the process's environment.
 * @param now - the clock, in milliseconds since the epoch.
 * @returns the record's text.
 * @throws {RuntimeStoreError} when the installation's files or manifest do not verify, or the root cannot be anchored.
 */
export function successorStartCheckRecord(home: string, version: RuntimeVersion, logger: DelorunLogger, env: Readonly<Record<string, string | undefined>>, now: number): Promise<string> {
  return successorRecord({ version, env, now, check: () => checkStoredRuntime(home, version, logger, launcherAnchor(home, env).root, fullCheckDaysOf(env)) })
}
