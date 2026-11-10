/**
 * The profile's files that Delo's history holds, and Delo's own file names inside the profile. The list is an
 * extension of upstream's `PROFILE_FILES`: upstream tracks the five files plugin management writes, and Delo adds the
 * second exemption file, its own safety record, the copy of the home patch and the update report, so that an undo, a
 * restore or a rollback brings back everything the person had rather than the subset upstream knew about.
 *
 * @module @delo/profile-safety/files
 */
import { PROFILE_FILES } from '@deepseek-ai/dsh-plugin-manager/history'

/** The profile's manifest, which holds its bundle list and its plugin dependencies. */
export const PROFILE_MANIFEST_FILENAME = 'package.json'

/** The profile's own patch layer: the rows and settings the person added for this profile. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The patch layer at the Harness home, applied over every profile's own layer. */
export const HOME_PATCH_FILENAME = 'cordis.patch.yml'

/** The profile's pnpm settings, which hold its `allowBuilds` decisions. */
export const PROFILE_WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** Delo's own record inside the profile: ejected plugins, plugins kept disabled, and the last update it saw. */
export const SAFETY_RECORD_FILENAME = 'delo-safety.json'

/** The profile's copy of the home patch, so a history version holds the home layer too. */
export const HOME_PATCH_COPY_FILENAME = 'home-cordis.patch.yml'

/** The update report of the last update, held in the snapshot's history version as contract C3 requires. */
export const UPDATE_REPORT_FILENAME = 'delo-update-report.json'

/** The schema value of {@link SAFETY_RECORD_FILENAME}. */
export const SAFETY_RECORD_SCHEMA = 'delo.profile-safety/1'

/** The second exemption file, for contract C17's Delo axis; upstream's history knows only the DSH one. */
export const DELO_COMPATIBILITY_FILENAME = 'delo-compatibility.json'

/**
 * Delo's own state files in the profile history. A history version that does not hold one, when no version up to it
 * held it either, comes from before the history tracked it, as when upstream's plugin manager created the history with
 * its own five files, or before the file existed; a restore keeps the profile's current copy of such a file instead of
 * removing it. A version written after the file was removed restores its absence. The copy of the home patch is not
 * among them: a version without one restores no home patch.
 */
export const DELO_STATE_FILES: readonly string[] = [DELO_COMPATIBILITY_FILENAME, SAFETY_RECORD_FILENAME, UPDATE_REPORT_FILENAME]

/**
 * Every file Delo's profile history tracks, relative to the profile directory: upstream's five, then the four Delo
 * adds. Order is upstream's first, so a version written before Delo's extension reads the same way, with the Delo files
 * absent.
 */
export const PROFILE_SAFETY_FILES: readonly string[] = [
  ...PROFILE_FILES,
  DELO_COMPATIBILITY_FILENAME,
  SAFETY_RECORD_FILENAME,
  HOME_PATCH_COPY_FILENAME,
  UPDATE_REPORT_FILENAME,
]

/**
 * Whether a name is one of the files the history tracks.
 * @param name - a file name relative to the profile directory.
 * @returns true when a history version holds it.
 */
export function isTrackedFile(name: string): boolean {
  return PROFILE_SAFETY_FILES.includes(name)
}
