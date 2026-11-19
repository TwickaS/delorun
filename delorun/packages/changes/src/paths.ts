/**
 * Where Changes keeps its files under the Delorun home (contract C1). Everything is below `changes/`, which is under the
 * protected home: a confined command can neither read nor write it, because the sandbox protects the whole home and
 * `changes/` is not one of C1's read exemptions.
 *
 * ```text
 * changes/                          0700
 *   protection.json                 the protection setting; absent means off
 *   migration.json                  the profiles that existed at the first start under Changes
 *   store/objects/<sha256>          approved file contents, by digest, never rewritten
 *   store/versions/<sha256>.json    one content version's file list, by its digest
 *   profiles/<profile>/
 *     active/<slug>/                the directory the profile's link: dependency names
 *     active.json                   what each active directory holds
 *     log.json                      the change log
 *     work-session.json             the work session, while one lasts
 *     scan-cache.json               file digests by inode, size and times, to scan a folder quickly
 *   harness/
 *     log.json                      the change log of the harness's own files, for every profile
 *     <runtime>/
 *       approved.json               the runtime's files whose approved content differs from the signed release's
 *       copy/                       the person's writable copy of the runtime's app/ directory
 *       scan-cache.json             file digests by inode, size and times, to scan the copy quickly
 *       pending.json                the file of each change the last read of the copy found, for one change's action
 *       run/<digest>/               the signed runtime with the approved files in place, which a start runs
 * ```
 *
 * A plugin's name is checked against {@link PACKAGE_NAME_PATTERN}, and a runtime version against C1's runtime version
 * pattern, before any path is built from it.
 *
 * @module @delorun/changes/paths
 */
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, PROFILE_NAME_SYNTAX, RUNTIME_VERSION_MAX_LENGTH, RUNTIME_VERSION_PATTERN } from '@delorun/contract-home-layout'
import { ChangesError } from './errors.ts'

/** What a package name under Changes is: npm's form, with an optional scope. */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/** Files and directories under `changes/`. */
export const CHANGES_ENTRIES = {
  protection: 'protection.json',
  notices: 'notices.json',
  store: 'store',
  objects: 'objects',
  versions: 'versions',
  profiles: 'profiles',
  active: 'active',
  activeRecord: 'active.json',
  log: 'log.json',
  workSession: 'work-session.json',
  scanCache: 'scan-cache.json',
  harnessPending: 'pending.json',
  migration: 'migration.json',
  harness: 'harness',
  harnessRecord: 'approved.json',
  harnessCopy: 'copy',
  harnessRun: 'run',
} as const

/**
 * @param home - the Delorun home.
 * @returns `changes/` under it.
 */
export function changesDirectory(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.changes)
}

/**
 * @param home - the Delorun home.
 * @returns the path of the notices for the person at the computer.
 */
export function noticesPath(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.notices)
}

/**
 * @param home - the Delorun home.
 * @returns the protection record's path.
 */
export function protectionPath(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.protection)
}

/**
 * @param home - the Delorun home.
 * @returns the object directory of the store.
 */
export function objectsDirectory(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.store, CHANGES_ENTRIES.objects)
}

/**
 * @param home - the Delorun home.
 * @returns the version directory of the store.
 */
export function versionsDirectory(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.store, CHANGES_ENTRIES.versions)
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name, which must match {@link PROFILE_NAME_SYNTAX}; reserved names such as `headless` are valid here.
 * @returns the profile's directory under `changes/profiles/`.
 * @throws {ChangesError} `INVALID_REQUEST` when the name does not match {@link PROFILE_NAME_SYNTAX}, so no path is built from it.
 */
export function profileChangesDirectory(home: string, profile: string): string {
  requireProfileName(profile)
  return join(changesDirectory(home), CHANGES_ENTRIES.profiles, profile)
}

/**
 * The approved copies of one profile's plugins, relative to the home, as a sandbox read exemption names them.
 * @param profile - the profile's name, which must match {@link PROFILE_NAME_SYNTAX}; reserved names such as `headless` are valid here.
 * @returns `changes/profiles/<profile>/active`, which holds nothing but approved copies: no pending, unapproved or
 *   stored content, no record and no log.
 * @throws {ChangesError} `INVALID_REQUEST` when the name does not match {@link PROFILE_NAME_SYNTAX}, so no path is built from it.
 */
export function activeCopiesEntry(profile: string): string {
  requireProfileName(profile)
  return join(DELORUN_HOME_ENTRIES.changes, CHANGES_ENTRIES.profiles, profile, CHANGES_ENTRIES.active)
}

/**
 * @param profile - a profile's name.
 * @throws {ChangesError} `INVALID_REQUEST` when the name does not match {@link PROFILE_NAME_SYNTAX}.
 */
function requireProfileName(profile: string): void {
  if (!PROFILE_NAME_SYNTAX.test(profile)) {
    throw new ChangesError('INVALID_REQUEST', profile, `${JSON.stringify(profile)} is not a profile name: a profile is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit`)
  }
}

/**
 * The directory name of one plugin's active content: the package name with `/` written as `+`, as pnpm writes it.
 * @param name - the package name, such as `@scope/plugin`.
 * @returns the name as one path segment.
 * @throws {ChangesError} `NOT_LINKED` when the name is not a package name, which no plugin of a profile has; such a name
 *   could name a path outside `active/`.
 */
export function pluginSlug(name: string): string {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new ChangesError('NOT_LINKED', name, `${JSON.stringify(name)} is not a package name, so no plugin of the profile has it.`)
  return name.replace('/', '+')
}

/**
 * @param home - the Delorun home.
 * @returns the record of the first start under Changes.
 */
export function migrationPath(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.migration)
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param plugin - the package name.
 * @returns the directory the profile's `link:` dependency on the plugin names.
 */
export function activeDirectory(home: string, profile: string, plugin: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.active, pluginSlug(plugin))
}

/** What a runtime version is, as contract C1 names the store's directories. */
const RUNTIME_VERSION = new RegExp(RUNTIME_VERSION_PATTERN, 'u')

/**
 * Whether a string is a runtime version a harness path may be built from.
 * @param runtime - the string.
 * @returns whether it matches C1's runtime version pattern and length.
 */
export function isRuntimeVersion(runtime: string): boolean {
  return runtime.length <= RUNTIME_VERSION_MAX_LENGTH && RUNTIME_VERSION.test(runtime)
}

/**
 * @param home - the Delorun home.
 * @returns `changes/harness/`.
 */
export function harnessDirectory(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.harness)
}

/**
 * @param home - the Delorun home.
 * @returns the change log of the harness's own files.
 */
export function harnessLogPath(home: string): string {
  return join(harnessDirectory(home), CHANGES_ENTRIES.log)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the runtime's directory under `changes/harness/`.
 * @throws {ChangesError} `INVALID_REQUEST` when the version is not one C1 names, which could name a path outside it.
 */
export function harnessRuntimeDirectory(home: string, runtime: string): string {
  if (!isRuntimeVersion(runtime)) throw new ChangesError('INVALID_REQUEST', runtime, `${JSON.stringify(runtime)} is not a Delorun runtime version.`)
  return join(harnessDirectory(home), runtime)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the runtime's harness record.
 */
export function harnessRecordPath(home: string, runtime: string): string {
  return join(harnessRuntimeDirectory(home, runtime), CHANGES_ENTRIES.harnessRecord)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the person's writable copy of the runtime, which holds its `app/` directory.
 */
export function harnessCopyDirectory(home: string, runtime: string): string {
  return join(harnessRuntimeDirectory(home, runtime), CHANGES_ENTRIES.harnessCopy)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the directory of the runtime's composed trees, one per set of approved files.
 */
export function harnessRunDirectory(home: string, runtime: string): string {
  return join(harnessRuntimeDirectory(home, runtime), CHANGES_ENTRIES.harnessRun)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the scan cache of the runtime's writable copy.
 */
export function harnessScanCachePath(home: string, runtime: string): string {
  return join(harnessRuntimeDirectory(home, runtime), CHANGES_ENTRIES.scanCache)
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the file naming, by change id, the file of each change the last read of the runtime's copy found.
 */
export function harnessPendingPath(home: string, runtime: string): string {
  return join(harnessRuntimeDirectory(home, runtime), CHANGES_ENTRIES.harnessPending)
}
