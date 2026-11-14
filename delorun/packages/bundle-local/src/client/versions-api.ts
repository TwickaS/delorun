/**
 * Requests to the home's profile-version routes (the Setup versions section) and the validation of their JSON answers.
 * The Host serves the list and the differences to every signed-in studio and saving or switching to the loopback listener
 * only. The route names and answer fields are shared with [`../profile-versions.ts`](../profile-versions.ts), which
 * serves them; requests go through [`./host-api.ts`](./host-api.ts).
 * @module @delorun/bundle-local/client/versions-api
 */
import { call, fields, isBoolean, isString, isTime, listOf, optional, type Check, type HostFetch } from './host-api.ts'

/** The routes under `/api`. */
export const PROFILE_VERSION_ROUTES = {
  /** `GET`: the versions, as {@link VersionsAnswer}. */
  list: '/api/delorunVersions.list',
  /** `GET ?version=<id>`: what switching to a version changes, as {@link ChangesAnswer}. */
  changes: '/api/delorunVersions.changes',
  /** `POST` `{ name? }`: save the setup as a version, loopback only. */
  save: '/api/delorunVersions.save',
  /** `POST` `{ version }`: switch to a version, loopback only. */
  switch: '/api/delorunVersions.switch',
} as const

/** What made a version. */
export type VersionOrigin = 'update' | 'saved' | 'switch' | 'other'

/** One version as the list shows it. */
export interface VersionEntry {
  readonly id: string
  /** When it was written, in milliseconds since the epoch. */
  readonly at: number
  readonly summary: string
  readonly origin: VersionOrigin
  /** The name the person gave a saved version. */
  readonly name?: string
  /** Whether the profile holds exactly this version's setup now. */
  readonly current: boolean
}

/** What `GET /api/delorunVersions.list` answers. */
export interface VersionsAnswer {
  /** The versions, newest first. */
  readonly versions: readonly VersionEntry[]
  /** True when no version holds the setup as it is now. */
  readonly unsaved: boolean
  /** Why the history cannot be read; the list is empty meanwhile. */
  readonly problem?: string
}

/** What switching to a version changes, from the history's own comparison. */
export interface VersionChanges {
  readonly plugins: readonly { readonly name: string; readonly from?: string; readonly to?: string }[]
  readonly bundles: readonly { readonly name: string; readonly selected: boolean }[]
  readonly exemptions: readonly { readonly axis: 'dsh' | 'delorun'; readonly key: string; readonly version: string; readonly change: 'added' | 'removed' }[]
  readonly builds: readonly { readonly key: string; readonly from?: boolean | 'pending'; readonly to?: boolean | 'pending' }[]
  /** Whether the profile's settings and rows (its patch file) change. */
  readonly patchChanged: boolean
  /** Whether the home's patch file changes. */
  readonly homePatchChanged: boolean
  /** Whether the plugins' dependencies are installed again. */
  readonly lockfileChanged: boolean
  /** Plugins that come back turned off because a release revoked them, with the reason. */
  readonly disabled: readonly { readonly name: string; readonly message: string }[]
  /** Whether anything changes at all. */
  readonly same: boolean
}

/** What `GET /api/delorunVersions.changes` answers. */
export interface ChangesAnswer {
  readonly changes: VersionChanges
}

/** What `POST /api/delorunVersions.save` answers. */
export interface SaveAnswer {
  readonly id: string
  /** False when the latest version already held this setup. */
  readonly created: boolean
}

/** What `POST /api/delorunVersions.switch` answers. */
export interface SwitchAnswer {
  /** The version that now holds the setup from before the switch; absent when the latest version already held it. */
  readonly saved?: string
  readonly changes: VersionChanges
  /** Whether Delorun must restart to run the switched setup. */
  readonly restartNeeded: boolean
}

const isOrigin: Check = value => value === 'update' || value === 'saved' || value === 'switch' || value === 'other'
const isEntry: Check = fields({ id: isString, at: isTime, summary: isString, origin: isOrigin, name: optional(isString), current: isBoolean })
const isVersionsAnswer: Check = fields({ versions: listOf(isEntry), unsaved: isBoolean, problem: optional(isString) })
const isChanges: Check = fields({
  plugins: listOf(fields({ name: isString, from: optional(isString), to: optional(isString) })),
  bundles: listOf(fields({ name: isString, selected: isBoolean })),
  exemptions: listOf(fields({ axis: isString, key: isString, version: isString, change: isString })),
  builds: listOf(fields({ key: isString })),
  patchChanged: isBoolean,
  homePatchChanged: isBoolean,
  lockfileChanged: isBoolean,
  disabled: listOf(fields({ name: isString, message: isString })),
  same: isBoolean,
})
const isChangesAnswer: Check = fields({ changes: isChanges })
const isSaveAnswer: Check = fields({ id: isString, created: isBoolean })
const isSwitchAnswer: Check = fields({ saved: optional(isString), changes: isChanges, restartNeeded: isBoolean })

/**
 * Read the profile's versions.
 * @param fetch - the request function.
 * @returns the versions, newest first.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function readSetupVersions(fetch: HostFetch): Promise<VersionsAnswer> {
  return call<VersionsAnswer>(fetch, PROFILE_VERSION_ROUTES.list, isVersionsAnswer)
}

/**
 * Read what switching to a version would change.
 * @param fetch - the request function.
 * @param version - the version's id.
 * @returns the comparison with the profile now.
 * @throws {HostRequestError} for a refusal (`UNKNOWN_VERSION`), an unreachable Host or an unreadable answer.
 */
export async function readSetupChanges(fetch: HostFetch, version: string): Promise<VersionChanges> {
  return (await call<ChangesAnswer>(fetch, `${PROFILE_VERSION_ROUTES.changes}?version=${encodeURIComponent(version)}`, isChangesAnswer)).changes
}

/**
 * Save the setup as a version.
 * @param fetch - the request function.
 * @param name - the person's name for it; blank saves it unnamed.
 * @returns the version and whether it is new.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` away from the home's computer, `SAVE_REFUSED`), an
 *   unreachable Host or an unreadable answer.
 */
export function saveSetupVersion(fetch: HostFetch, name: string): Promise<SaveAnswer> {
  return call<SaveAnswer>(fetch, PROFILE_VERSION_ROUTES.save, isSaveAnswer, name.trim() === '' ? {} : { name })
}

/**
 * Switch to a version, saving the setup first.
 * @param fetch - the request function.
 * @param version - the version's id.
 * @returns what changed and whether Delorun must restart.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `UNKNOWN_VERSION`, `SWITCH_REFUSED`), an unreachable
 *   Host or an unreadable answer.
 */
export function switchSetupVersion(fetch: HostFetch, version: string): Promise<SwitchAnswer> {
  return call<SwitchAnswer>(fetch, PROFILE_VERSION_ROUTES.switch, isSwitchAnswer, { version })
}
