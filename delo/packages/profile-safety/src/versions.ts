/**
 * The profile history as a person browses it: the versions with what made each one, the one the profile matches now,
 * a version saved on request, and a switch to another version that saves the current setup first. Every operation runs
 * over the one history `openHistory` opens and the restore path `delorun recover restore` uses; this module adds the
 * naming of versions and nothing that stores anything.
 *
 * @module @delo/profile-safety/versions
 */
import type { ProfileChangedBy, ProfileVersionId, VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { ProfileSafetyError } from './errors.ts'
import { HOME_PATCH_COPY_FILENAME, UPDATE_REPORT_FILENAME } from './files.ts'
import { recover, type RecoverReport } from './recover.ts'
import { openHistory, planRestore, recordSnapshot, withProfileLock, type HistoryOptions, type RevokedPlugin } from './snapshot.ts'

/** What made a version: an update (its snapshot), the person (Save this setup), a switch, or anything else that edits the profile. */
export type VersionOrigin = 'update' | 'saved' | 'switch' | 'other'

/** The summary of a version the person saved without a name. */
export const SAVED_SUMMARY = 'Saved by you'

/** The summary prefix of the version a switch saves before it writes. */
export const SWITCH_SUMMARY_PREFIX = 'Before switching to'

/** The summary prefix of the version an update snapshot takes. */
export const UPDATE_SUMMARY_PREFIX = 'Before update to'

/** The longest name a person can give a saved version, in characters. */
export const MAX_VERSION_NAME = 60

/** The most versions {@link listProfileVersions} reads. */
export const MAX_LISTED_VERSIONS = 50

/** One history version as the studio lists it. */
export interface ProfileVersionView {
  /** The version's id. */
  readonly id: ProfileVersionId
  /** When it was written, in milliseconds since the epoch. */
  readonly at: number
  /** The history's one-line summary. */
  readonly summary: string
  /** What made it. */
  readonly origin: VersionOrigin
  /** The name the person gave a saved version; absent for other versions and for an unnamed save. */
  readonly name?: string
  /** Whether the profile holds exactly this version's setup now. */
  readonly current: boolean
}

/** The versions, newest first. */
export interface ProfileVersionList {
  readonly versions: readonly ProfileVersionView[]
  /** True when no listed version matches the profile now, so the setup has changes no version holds. */
  readonly unsaved: boolean
}

/**
 * The summary of a version saved on request.
 * @param name - the person's name for it; blank or absent saves it unnamed.
 * @returns `Saved by you` with the name, whitespace collapsed, control characters dropped and cut to {@link MAX_VERSION_NAME}.
 */
export function savedSummary(name?: string): string {
  const clean = (name ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_NAME).trim()
  return clean === '' ? SAVED_SUMMARY : `${SAVED_SUMMARY}: ${clean}`
}

/**
 * Name what made a version from its summary.
 * @param summary - the history's summary.
 * @returns the origin, and the person's name for a saved version.
 */
export function originOf(summary: string): { readonly origin: VersionOrigin, readonly name?: string } {
  if (summary === SAVED_SUMMARY) return { origin: 'saved' }
  if (summary.startsWith(`${SAVED_SUMMARY}: `)) return { origin: 'saved', name: summary.slice(SAVED_SUMMARY.length + 2) }
  if (summary.startsWith(SWITCH_SUMMARY_PREFIX)) return { origin: 'switch' }
  if (summary.startsWith(UPDATE_SUMMARY_PREFIX)) return { origin: 'update' }
  return { origin: 'other' }
}

/** What the version-browsing operations need besides the history's options. */
export interface VersionsRequest extends HistoryOptions {
  /** The Harness home, which holds the home patch a version carries a copy of. */
  readonly homeDir: string
}

/**
 * List the profile's versions newest first, marking the one the profile matches now. Reads only.
 * @param request - the profile and home.
 * @returns the versions; empty before the first.
 * @throws {HistoryUnavailableError} when git cannot read the history.
 */
export async function listProfileVersions(request: VersionsRequest): Promise<ProfileVersionList> {
  const history = openHistory(request)
  const listed = await history.list(MAX_LISTED_VERSIONS)
  let currentId: ProfileVersionId | undefined
  for (const version of listed) {
    const plan = await planRestore({ ...request, version: version.id, history })
    const differing = plan.writes.filter(name => name !== HOME_PATCH_COPY_FILENAME && name !== UPDATE_REPORT_FILENAME)
    if (differing.length === 0 && !plan.homePatchWritten) {
      currentId = version.id
      break
    }
  }
  return {
    versions: listed.map(version => ({
      id: version.id,
      at: version.at,
      summary: version.summary,
      ...originOf(version.summary),
      current: version.id === currentId,
    })),
    unsaved: listed.length > 0 && currentId === undefined,
  }
}

/** What {@link saveProfileVersion} needs. */
export interface SaveVersionRequest extends VersionsRequest {
  /** The person's name for the version; optional. */
  readonly name?: string
  /** Who saved it; the person by default. */
  readonly changedBy?: ProfileChangedBy
  /** How long to wait for the profile's writer lock. */
  readonly lockWaitMs?: number
}

/**
 * Save the profile as it stands as a version, through the profile history.
 * @param request - the profile, home and optional name.
 * @returns the version's id, and whether it is new: false when the latest version already holds this setup.
 * @throws {ProfileSafetyError} `SNAPSHOT_FAILED` when the history cannot write it or the admission refuses it.
 */
export async function saveProfileVersion(request: SaveVersionRequest): Promise<{ readonly id: ProfileVersionId, readonly created: boolean }> {
  const history = openHistory(request)
  return withProfileLock(request.profileDir, 'SNAPSHOT_FAILED', async () => {
    const latest = (await history.list(1))[0]?.id
    const id = await recordSnapshot({
      profileDir: request.profileDir, homeDir: request.homeDir, summary: savedSummary(request.name), changedBy: request.changedBy ?? { kind: 'person' }, history,
    })
    return { id, created: id !== latest }
  }, request.lockWaitMs)
}

/** What {@link switchToVersion} needs. */
export interface SwitchVersionRequest extends VersionsRequest {
  /** The profile's name, as its directory is named. */
  readonly profile: string
  /** The version to switch to. */
  readonly version: ProfileVersionId
  /** The admission the saves of the history use, such as the secret-field check. */
  readonly admit?: VersionAdmission
  /** The plugin versions the current revocation list revokes. */
  readonly revoked?: readonly RevokedPlugin[]
  /** How long to wait for the profile's writer lock. */
  readonly lockWaitMs?: number
}

/**
 * Switch the profile to a version through the restore `delorun recover restore` runs, after saving the current setup as
 * a version in the same locked step, so switching back is switching to that version.
 * @param request - the profile, home and target version.
 * @returns the restore's report: its plan, and `saved` when the current setup was saved as a new version.
 * @throws {ProfileSafetyError} `RESTORE_REFUSED` when the version is not in the history or cannot be read, and
 *   `SNAPSHOT_FAILED` when the current setup cannot be saved; nothing has changed when it throws either.
 */
export async function switchToVersion(request: SwitchVersionRequest): Promise<RecoverReport> {
  const target = await openHistory(request).version(request.version).catch((error: unknown) => {
    throw new ProfileSafetyError('RESTORE_REFUSED', request.profileDir, `the history cannot be read: ${String(error)}`, ['repair-profile'], [], { cause: error })
  })
  if (target === undefined) {
    throw new ProfileSafetyError('RESTORE_REFUSED', request.profileDir, `profile version ${request.version} is not in the history.`, ['repair-profile'], [])
  }
  const { name } = originOf(target.summary)
  const label = name ?? target.summary.slice(0, MAX_VERSION_NAME)
  return recover({
    profileDir: request.profileDir,
    homeDir: request.homeDir,
    profile: request.profile,
    action: { kind: 'restore', version: request.version, saveFirst: `${SWITCH_SUMMARY_PREFIX} ${label}` },
    ...request.admit === undefined ? {} : { admit: request.admit },
    ...request.revoked === undefined ? {} : { revoked: request.revoked },
    ...request.lockWaitMs === undefined ? {} : { lockWaitMs: request.lockWaitMs },
    changedBy: { kind: 'person' },
  })
}
