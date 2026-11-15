/** Pure helpers that tidy the version list before it is drawn. */
import type { VersionEntry } from './versions-api.ts'

/** The history's summary of a plugin-settings edit, which names the row's id. */
const SETTINGS_SUMMARY = /^Changed the settings of (.+)$/

/** A run of consecutive identical versions, shown as one row. */
export interface VersionGroup {
  /** The newest version of the run, the one the row switches to. */
  readonly version: VersionEntry
  /** How many identical versions the run holds. */
  readonly count: number
}

/**
 * Collapse runs of consecutive versions that have the same summary and origin and are not saved by name.
 * @param versions - the versions, newest first.
 * @returns the runs in the same order.
 */
export function groupVersions(versions: readonly VersionEntry[]): VersionGroup[] {
  const groups: { version: VersionEntry; count: number }[] = []
  for (const version of versions) {
    const last = groups.at(-1)
    if (last !== undefined && version.origin !== 'saved' && last.version.origin === version.origin && last.version.summary === version.summary) last.count += 1
    else groups.push({ version, count: 1 })
  }
  return groups
}

/**
 * The plugin name to show for a settings-edit summary: the row id without Delorun's prefix, in words.
 * @param summary - a version's summary.
 * @returns the name, or undefined when the summary is not a settings edit.
 */
export function settingsEditName(summary: string): string | undefined {
  const id = SETTINGS_SUMMARY.exec(summary)?.[1]
  if (id === undefined) return undefined
  const words = id.replace(/^(delorun|dsh)-/, '').replace(/^(plugin|tool|ui)-/, '').replaceAll(/[-_]+/g, ' ').trim()
  return words === '' ? id : words.charAt(0).toUpperCase() + words.slice(1)
}
