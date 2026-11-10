/**
 * The typed failure of every profile-safety operation. Each refusal names one closed code, the path it concerns, the
 * detail the person reads, and the remedies they are offered; contract C3's security requirement R1 is what most of
 * them enforce, because a change that would lose a profile row, a local plugin or a configuration the person added is
 * refused before anything changes rather than applied and reported afterwards.
 *
 * @module @delo/profile-safety/errors
 */

/**
 * Every code a {@link ProfileSafetyError} carries.
 *
 * - `PROFILE_UNREADABLE`: the profile's manifest or one of its patch layers cannot be read or parsed, so no carry
 *   check can be made.
 * - `ROW_NOT_CARRIED`: a row the person added would leave the profile silently, named by no update-report item.
 * - `CONFIGURATION_NOT_CARRIED`: a setting the person wrote for a row would be dropped or changed silently.
 * - `LOCAL_PLUGIN_NOT_CARRIED`: a plugin the person added from this machine (`file:`, `link:` or a path) would leave
 *   the profile silently.
 * - `BUNDLE_LIST_NOT_CARRIED`: the profile's bundle list would be reordered, or lose or gain a bundle, in a way no
 *   update-report item names.
 * - `UNNAMED_CHANGE`: the target would write something into the person's profile that no report item names.
 * - `EJECTED_PLUGIN_REINSTATED`: the target would put back a plugin the person ejected.
 * - `SNAPSHOT_FAILED`: the history version that has to exist before anything changes could not be written.
 * - `RESTORE_REFUSED`: an undo, restore or rollback cannot bring a version back the way the person asked.
 * - `SAFE_MODE_UNREADABLE`: the safe-mode marker exists but cannot be read, so the next start cannot tell which mode
 *   the person is in.
 * - `EJECT_REFUSED`: the plugin named for ejection is not one the profile holds, or is Delo's own bundle.
 * - `RECOVER_REFUSED`: `delorun recover` cannot do what it was asked, such as rolling back when no snapshot exists.
 */
export type ProfileSafetyCode =
  | 'PROFILE_UNREADABLE'
  | 'ROW_NOT_CARRIED'
  | 'CONFIGURATION_NOT_CARRIED'
  | 'LOCAL_PLUGIN_NOT_CARRIED'
  | 'BUNDLE_LIST_NOT_CARRIED'
  | 'UNNAMED_CHANGE'
  | 'EJECTED_PLUGIN_REINSTATED'
  | 'SNAPSHOT_FAILED'
  | 'RESTORE_REFUSED'
  | 'SAFE_MODE_UNREADABLE'
  | 'EJECT_REFUSED'
  | 'RECOVER_REFUSED'

/** What the person is offered after a refusal, in the words of C3's item actions and the screens that show them. */
export type ProfileSafetyRemedy =
  /** Do not take this update. */
  | 'skip-update'
  /** Keep the subject in place and stop the update until a release carries it. */
  | 'keep'
  /** Update the plugin to a version the target runs. */
  | 'update-plugin'
  /** Keep the plugin disabled, with the reason shown. */
  | 'keep-disabled'
  /** Eject the plugin, keeping its rows and configuration in the profile. */
  | 'eject'
  /** Restore a profile history version. */
  | 'restore'
  /** Switch back to the previous release. */
  | 'rollback'
  /** Start in safe mode. */
  | 'safe-mode'
  /** Repair the profile file the message names, then run the command again. */
  | 'repair-profile'

/** One subject a refusal is about: a row, a configuration, a plugin, a bundle or the bundle list. */
export interface RefusedSubject {
  /** What the subject is. */
  readonly kind: 'row' | 'configuration' | 'local-plugin' | 'bundle' | 'bundle-list'
  /** The subject's name: a row id or plugin name, a bundle's package name, or the profile's bundle list. */
  readonly name: string
  /** Where it lives, when it lives in a patch layer or a profile file. */
  readonly layer?: string
}

/** A refusal or failure of profile safety. */
export class ProfileSafetyError extends Error {
  override readonly name = 'ProfileSafetyError'

  readonly code: ProfileSafetyCode
  readonly path: string
  readonly detail: string
  readonly remedies: readonly ProfileSafetyRemedy[]
  readonly subjects: readonly RefusedSubject[]

  /**
   * @param code - the failure's code.
   * @param path - the absolute path the failure concerns.
   * @param detail - what is wrong, naming the subjects; the message is the code and this.
   * @param remedies - what the person is offered, in order; empty when nothing is offered.
   * @param subjects - the rows, configurations, plugins or bundles the refusal is about.
   * @param options - the underlying error.
   */
  constructor(
    code: ProfileSafetyCode,
    path: string,
    detail: string,
    remedies: readonly ProfileSafetyRemedy[] = [],
    subjects: readonly RefusedSubject[] = [],
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options)
    this.code = code
    this.path = path
    this.detail = detail
    this.remedies = remedies
    this.subjects = subjects
  }

  /**
   * Whether this failure is a refusal: the profile was left as it was, and nothing the person added was lost.
   * @returns true for every code but {@link ProfileSafetyCode} `SNAPSHOT_FAILED`, which may have written a file.
   */
  get refused(): boolean {
    return this.code !== 'SNAPSHOT_FAILED'
  }
}

/**
 * Whether a value is a {@link ProfileSafetyError} with one of the given codes.
 * @param error - the value.
 * @param codes - the codes; none matches any code.
 * @returns true when it is one.
 */
export function isProfileSafetyError(error: unknown, ...codes: readonly ProfileSafetyCode[]): error is ProfileSafetyError {
  return error instanceof ProfileSafetyError && (codes.length === 0 || codes.includes(error.code))
}
