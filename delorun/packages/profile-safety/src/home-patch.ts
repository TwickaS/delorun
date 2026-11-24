/**
 * The home patch (`~/.delorun/cordis.patch.yml`) as a profile history version holds it: the copy inside the profile,
 * the mirror that writes that copy before a version is saved, and the write that puts it back when a version is
 * restored.
 *
 * The history's work tree is the profile directory, so a version cannot hold a file outside it. A version therefore
 * holds the home patch as {@link HOME_PATCH_COPY_FILENAME} inside the profile. `delorun recover` and Setup versions
 * mirror and write it through `recordSnapshot` and `applyRestore`; the plugin manager does the same two steps through
 * {@link ProfileHomePatch}, so a harness point covers both patch layers and a restore writes both.
 *
 * @module @delorun/profile-safety/home-patch
 */
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ProfileHistory, ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { HOME_PATCH_COPY_FILENAME, HOME_PATCH_FILENAME } from './files.ts'

/**
 * @param homeDir - the Harness home.
 * @returns the home patch's text, or undefined when the home has none.
 */
export function readHomePatch(homeDir: string): string | undefined {
  const path = join(homeDir, HOME_PATCH_FILENAME)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * @param profileDir - the profile directory.
 * @returns the profile's copy of the home patch, or undefined when it holds none.
 */
export function readHomePatchCopy(profileDir: string): string | undefined {
  const path = join(profileDir, HOME_PATCH_COPY_FILENAME)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Write the home patch's text into the profile's copy, or remove the copy when the home has no patch, so the next
 * version holds the home layer as it is now rather than as an earlier snapshot left it.
 * @param profileDir - the profile directory.
 * @param homeDir - the Harness home.
 * @returns the copy's text before the mirror, or undefined when the profile held none, so a refused version can put it
 *   back.
 */
export async function mirrorHomePatch(profileDir: string, homeDir: string): Promise<string | undefined> {
  const previous = readHomePatchCopy(profileDir)
  const homePatch = readHomePatch(homeDir)
  const copy = join(profileDir, HOME_PATCH_COPY_FILENAME)
  if (homePatch === undefined) await rm(copy, { force: true })
  else await writeFileAtomic(copy, homePatch, { mode: 0o600, dirMode: 0o700 })
  return previous
}

/**
 * Put the profile's copy back as it was, for a version the admission refused: a refused copy must not wait in the
 * profile for the next version another history saves.
 * @param profileDir - the profile directory.
 * @param text - the copy's text before the mirror, or undefined when the profile held none.
 */
export async function restoreHomePatchCopy(profileDir: string, text: string | undefined): Promise<void> {
  const copy = join(profileDir, HOME_PATCH_COPY_FILENAME)
  if (text === undefined) {
    await rm(copy, { force: true })
    return
  }
  await writeFileAtomic(copy, text, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Write a version's home patch to the home, at mode 0600 under a directory at 0700.
 * @param homeDir - the Harness home.
 * @param text - the home patch's text.
 */
export async function writeHomePatch(homeDir: string, text: string): Promise<void> {
  await writeFileAtomic(join(homeDir, HOME_PATCH_FILENAME), text, { mode: 0o600, dirMode: 0o700 })
}

/** Where the home patch and the history that holds its copy are. */
export interface HomePatchWhere {
  /** The profile directory, which holds the copy. */
  readonly profileDir: string
  /** The Harness home, which holds the patch. */
  readonly homeDir: string
  /** The history to read a version's copy from. */
  readonly history: () => ProfileHistory
}

/**
 * The home patch's half of a profile version, for a caller that records and restores through a history of its own: the
 * plugin manager, whose history tracks the profile's files. `delorun recover` and Setup versions do the same two steps
 * through `recordSnapshot` and `applyRestore`; this class is those steps over the history the manager records.
 */
export class ProfileHomePatch {
  /** The profile file a version holds the home patch in. */
  readonly copyFilename = HOME_PATCH_COPY_FILENAME
  private readonly where: () => HomePatchWhere | undefined

  /**
   * @param where - reads the profile, the home and the history when a call needs them; undefined while the Host has no
   *   profile, and then every call does nothing.
   */
  constructor(where: () => HomePatchWhere | undefined) {
    this.where = where
  }

  /**
   * Write the home patch's current text into the profile's copy, so the version recorded next holds the home layer.
   * @returns the copy's text before the mirror, or undefined when the profile held none.
   */
  async mirror(): Promise<string | undefined> {
    const where = this.where()
    return where === undefined ? undefined : await mirrorHomePatch(where.profileDir, where.homeDir)
  }

  /**
   * Put the profile's copy back as it was, after a version the admission refused.
   * @param text - what {@link mirror} returned.
   */
  async restoreCopy(text: string | undefined): Promise<void> {
    const where = this.where()
    if (where !== undefined) await restoreHomePatchCopy(where.profileDir, text)
  }

  /**
   * Whether a version's home patch differs from the home's now, so a restore of it would change the home layer.
   * @param version - the version.
   * @returns true when the version holds a copy that differs from the home patch; false when it holds none, because
   *   such a version restores no home patch.
   */
  async differs(version: ProfileVersionId): Promise<boolean> {
    const where = this.where()
    if (where === undefined) return false
    const held = await heldCopy(where, version)
    return held !== undefined && held !== readHomePatch(where.homeDir)
  }

  /**
   * Write a version's home patch to the home.
   * @param version - the version.
   * @returns whether the home patch changed; a version that holds no copy restores no home patch, so the home keeps
   *   what it holds.
   */
  async restore(version: ProfileVersionId): Promise<boolean> {
    const where = this.where()
    if (where === undefined) return false
    const held = await heldCopy(where, version)
    if (held === undefined || held === readHomePatch(where.homeDir)) return false
    await writeHomePatch(where.homeDir, held)
    return true
  }
}

/**
 * @param where - the profile, the home and the history.
 * @param version - the version.
 * @returns the version's copy of the home patch, or undefined when it holds none.
 */
async function heldCopy(where: HomePatchWhere, version: ProfileVersionId): Promise<string | undefined> {
  return (await where.history().filesAt(version)).get(HOME_PATCH_COPY_FILENAME)
}
