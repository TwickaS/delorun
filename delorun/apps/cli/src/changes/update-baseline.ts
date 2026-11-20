/**
 * The files an update's successor verified for Changes ([update baseline](../../../../packages/changes/src/update-baseline.ts)):
 * the signed pack files of the release an update left and of the release this process runs, read from each release's
 * stored packs file, which the runtime store verifies again under the anchored root and the release-log record. Only
 * the pre-start step `changes` of an update's successor asks for it, and only for an update to a newer release; a
 * rollback, a restart and a fresh start never get one.
 *
 * @module @delorun/cli/changes/update-baseline
 */
import type { SignedPackFiles, UpdateBaseline } from '@delorun/changes'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { HandoverLine } from '@delorun/home-process'
import type { PacksEnvironment } from '@delorun/plugin-packs/environment'
import { openSignedPacks } from '@delorun/runtime-store'
import semver from 'semver'

/**
 * The release an update left, from the handover line its successor was started with.
 * @param line - the handover line, or `undefined` for a start that is not a successor.
 * @returns the line's `from` for an update's handover; `undefined` for a rollback's, a restart's and no line, none of
 *   which is an update to the files their release installed.
 */
export function updateSource(line: Pick<HandoverLine, 'type' | 'purpose' | 'from'> | undefined): RuntimeVersion | undefined {
  return line?.type === 'handover' && line.purpose !== 'rollback' ? line.from : undefined
}

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
 * The verified signed packs files of both releases of an update. Each release's packs file verifies here; a pack's files
 * are read, with each installed file hashed, only when Changes asks for that pack, once per pack.
 * @param environment - gives each installed release, verified under the anchored root.
 * @param from - the release the update left.
 * @param unreadable - told once for a pack whose installed files cannot be read; that pack replaces nothing.
 * @returns the baseline, or `undefined` when the update is not to a newer release or the release this process runs
 *   stored no packs file.
 * @throws when a release's manifest, packs file or release-log record does not verify: nothing is replaced then, and the
 *   caller says so.
 */
export async function updateBaselineOf(environment: Pick<PacksEnvironment, 'release'>, from: RuntimeVersion, unreadable: (name: string, error: unknown) => void = () => undefined): Promise<UpdateBaseline | undefined> {
  const running = await environment.release()
  if (!isUpgrade(from, running.version)) return undefined
  const to = await openSignedPacks(running)
  if (to === undefined) return undefined
  const before = await openSignedPacks(await environment.release(from))
  const read = new Map<string, Promise<readonly SignedPackFiles[]>>()
  const readPack = async (name: string): Promise<readonly SignedPackFiles[]> => {
    try {
      return [await before?.files(name), await to.files(name)].filter(pack => pack !== undefined)
    } catch (error) {
      unreadable(name, error)
      return []
    }
  }
  return {
    from,
    to: running.version,
    packsFor: (name) => {
      const known = read.get(name)
      if (known !== undefined) return known
      const started = readPack(name)
      read.set(name, started)
      return started
    },
  }
}
