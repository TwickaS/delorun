/**
 * Where Changes keeps its files under the Delo home (contract C1). Everything is below `changes/`, which is under the
 * protected home: a confined command can neither read nor write it, because the sandbox protects the whole home and
 * `changes/` is not one of C1's read exemptions.
 *
 * ```text
 * changes/                          0700
 *   protection.json                 the protection setting; absent means block
 *   store/objects/<sha256>          approved file contents, by digest, never rewritten
 *   store/versions/<sha256>.json    one content version's file list, by its digest
 *   profiles/<profile>/
 *     active/<slug>/                the directory the profile's link: dependency names
 *     active.json                   what each active directory holds
 *     log.json                      the change log
 *     work-session.json             the work session, while one lasts
 *     scan-cache.json               file digests by inode, size and times, to scan a folder quickly
 * ```
 *
 * @module @delo/changes/paths
 */
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'

/** Files and directories under `changes/`. */
export const CHANGES_ENTRIES = {
  protection: 'protection.json',
  store: 'store',
  objects: 'objects',
  versions: 'versions',
  profiles: 'profiles',
  active: 'active',
  activeRecord: 'active.json',
  log: 'log.json',
  workSession: 'work-session.json',
  scanCache: 'scan-cache.json',
} as const

/**
 * @param home - the Delo home.
 * @returns `changes/` under it.
 */
export function changesDirectory(home: string): string {
  return join(home, DELO_HOME_ENTRIES.changes)
}

/**
 * @param home - the Delo home.
 * @returns the protection record's path.
 */
export function protectionPath(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.protection)
}

/**
 * @param home - the Delo home.
 * @returns the object directory of the store.
 */
export function objectsDirectory(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.store, CHANGES_ENTRIES.objects)
}

/**
 * @param home - the Delo home.
 * @returns the version directory of the store.
 */
export function versionsDirectory(home: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.store, CHANGES_ENTRIES.versions)
}

/**
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the profile's directory under `changes/profiles/`.
 */
export function profileChangesDirectory(home: string, profile: string): string {
  return join(changesDirectory(home), CHANGES_ENTRIES.profiles, profile)
}

/**
 * The directory name of one plugin's active content: the package name with `/` written as `+`, as pnpm writes it.
 * @param name - the package name, such as `@scope/plugin`.
 * @returns the name as one path segment.
 */
export function pluginSlug(name: string): string {
  return name.replace('/', '+')
}

/**
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param plugin - the package name.
 * @returns the directory the profile's `link:` dependency on the plugin names.
 */
export function activeDirectory(home: string, profile: string, plugin: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.active, pluginSlug(plugin))
}
