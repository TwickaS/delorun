/**
 * The files an update's successor verified for Changes ([update baseline](../../../../packages/changes/src/update-baseline.ts)):
 * the signed pack files of the release an update left and of the release this process runs, read from each release's
 * stored packs file, which the runtime store verifies again under the anchored root and the release-log record. Only
 * the pre-start step `changes` of an update's successor asks for it, and only for an update to a newer release; a
 * rollback, a restart and a fresh start never get one.
 *
 * @module @delorun/cli/changes/update-baseline
 */
import type { UpdateBaseline } from '@delorun/changes'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { PacksEnvironment } from '@delorun/plugin-packs/environment'
import { readSignedPackFiles } from '@delorun/runtime-store'
import semver from 'semver'

/**
 * Whether an update goes to a newer release.
 * @param from - the release the update left.
 * @param to - the release this process runs.
 * @returns true when both are semantic versions and `to` is newer.
 */
export function isUpgrade(from: RuntimeVersion, to: RuntimeVersion): boolean {
  return semver.valid(from) !== null && semver.valid(to) !== null && semver.gt(to, from)
}

/**
 * The verified signed pack files of both releases of an update.
 * @param environment - gives each installed release, verified under the anchored root.
 * @param from - the release the update left.
 * @returns the baseline, or `undefined` when the update is not to a newer release or the release this process runs
 *   stored no packs file.
 * @throws when a release's manifest, packs file or release-log record does not verify, or a stored file cannot be read:
 *   nothing is replaced then, and the caller says so.
 */
export async function updateBaselineOf(environment: Pick<PacksEnvironment, 'release'>, from: RuntimeVersion): Promise<UpdateBaseline | undefined> {
  const running = await environment.release()
  if (!isUpgrade(from, running.version)) return undefined
  const to = await readSignedPackFiles(running)
  if (to.length === 0) return undefined
  const before = await readSignedPackFiles(await environment.release(from))
  return { from, to: running.version, packs: [...before, ...to] }
}
