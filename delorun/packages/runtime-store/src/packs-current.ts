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
import { PRIVATE_DIR_MODE, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { StorePaths } from './paths.ts'
import { renameWithRetry, syncDirectory } from './pointer.ts'

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
