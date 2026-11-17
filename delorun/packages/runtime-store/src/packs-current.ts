/**
 * `packs/current`: a symlink (a junction on Windows) to `packs/<release>` for the release `runtimes/current` names. A
 * profile links a pack through it (`packs/current/<pack>/package`), so an update and a rollback re-point one link and
 * never rewrite the profile. The link is swapped by a rename over the old link in the same step as the pointers, and
 * the start check refuses a Host whose link names another release.
 *
 * @module @delorun/runtime-store/packs-current
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { PRIVATE_DIR_MODE, STORE_LOCK_WAIT_MS, type RuntimeVersion } from '@delorun/contract-home-layout'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import type { StorePaths } from './paths.ts'
import { withStoreLock } from './lock.ts'
import { readPointerFile, renameWithRetry, syncDirectory } from './pointer.ts'

/** The name of the link inside `packs/`. */
export const PACKS_CURRENT = 'current'

/** Prefix of the temporary link a swap writes before it renames it over `packs/current`. */
export const PACKS_CURRENT_TEMPORARY = '.current.'

const WINDOWS = process.platform === 'win32'

/** What the link holds for a release: the release's folder name, or its absolute path for a junction. */
function targetOf(paths: StorePaths, version: RuntimeVersion): string {
  return WINDOWS ? resolve(paths.packs, version) : version
}

/**
 * Point `packs/current` at a release, creating `packs/<release>` when it does not exist yet. The old link is replaced
 * by a rename, so a reader sees the old release or the new one and never no link.
 * @param paths - the store's paths.
 * @param version - the release `runtimes/current` names.
 * @returns when the link names the release.
 */
export async function pointPacks(paths: StorePaths, version: RuntimeVersion): Promise<void> {
  await mkdir(join(paths.packs, version), { recursive: true, mode: PRIVATE_DIR_MODE })
  const temporary = join(paths.packs, `${PACKS_CURRENT_TEMPORARY}${randomUUID()}`)
  await symlink(targetOf(paths, version), temporary, WINDOWS ? 'junction' : 'dir')
  await renameWithRetry(temporary, join(paths.packs, PACKS_CURRENT), process.platform)
  await syncDirectory(paths.packs)
}

/**
 * Re-point `packs/current` at a release when the home uses packs, and leave a home that never installed one untouched.
 * @param paths - the store's paths.
 * @param version - the release `runtimes/current` names now.
 * @returns when the link is current, or at once when nothing uses packs.
 */
export async function pointPacksIfUsed(paths: StorePaths, version: RuntimeVersion): Promise<void> {
  const linked = await readlink(join(paths.packs, PACKS_CURRENT)).then(() => true, () => false)
  const installed = (await readdir(join(paths.packs, version)).catch(() => [])).length > 0
  if (linked || installed) await pointPacks(paths, version)
}

/**
 * Make `packs/current` name the release the pointers name, when the home uses packs and the link names another. The link
 * is derived from `runtimes/current`, so a switch that stopped between the pointers and the link is finished here
 * without any network.
 * @param paths - the store's paths.
 * @param version - the release `runtimes/current` names.
 * @returns when the link names the release, or at once when nothing uses packs.
 */
export async function ensurePacksCurrent(paths: StorePaths, version: RuntimeVersion): Promise<void> {
  if (await packsCurrentProblem(paths, version) !== undefined) await pointPacksIfUsed(paths, version)
}

/**
 * Why `packs/current` does not match a release, if it does not.
 * @param paths - the store's paths.
 * @param version - the release that runs.
 * @returns the problem, or `undefined` when the link names the release, or when the home has never installed a pack
 * (no `packs/<release>` content and no link).
 */
export async function packsCurrentProblem(paths: StorePaths, version: RuntimeVersion): Promise<string | undefined> {
  const holds = async (release: string): Promise<boolean> => (await readdir(join(paths.packs, release)).catch(() => [])).length > 0
  const link = await readlink(join(paths.packs, PACKS_CURRENT)).then(target => ({ target }), (error: NodeJS.ErrnoException) => ({ error }))
  if ('target' in link) {
    if (link.target === targetOf(paths, version)) return undefined
    // A link to a release with no packs, while the running release has none either, can lead a profile nowhere.
    const named = WINDOWS ? basename(link.target) : link.target
    if (!await holds(version) && !await holds(named)) return undefined
    return `packs/current names ${named}, not the running release ${version}`
  }
  if (link.error.code !== 'ENOENT') return `packs/current cannot be read: ${link.error.message}`
  return await holds(version) ? `packs/current is missing, but ${version} has plugin packs installed` : undefined
}

/**
 * Whether the release this process runs is still the one `runtimes/current` names.
 * @param paths - the store's paths.
 * @param version - the release this process runs.
 * @returns true until an update switched `current` to another release.
 */
export async function isRunningRelease(paths: StorePaths, version: RuntimeVersion): Promise<boolean> {
  return await readPointerFile(paths.pointer('current')) === version
}

/**
 * Refuse a pack install into a Host that an update has already switched away from: its pack would be linked through
 * `packs/current`, which names the new release now.
 * @param paths - the store's paths.
 * @param version - the release this process runs.
 * @returns when this process still runs the current release; the check holds `store.lock`, so no switch lands during it.
 * @throws PackRefusal `UPDATE_PENDING` when `current` names another release.
 */
export async function requireRunningRelease(paths: StorePaths, version: RuntimeVersion): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: PRIVATE_DIR_MODE })
  await withStoreLock(paths.lock, STORE_LOCK_WAIT_MS, async () => {
    if (!await isRunningRelease(paths, version)) throw new PackRefusal(`Restart Delorun to finish the update: this Host runs ${version}, but an update has switched to another release`, 'UPDATE_PENDING')
  })
}
