/**
 * What the setup strip shows, kept as Delorun keeps it: each change of look is the settings change the studio would make,
 * written into the `delorun-theme` entry of the profile's `cordis.patch.yml` and listed as a setup version. The keys come
 * from the Theme plugin's own `writesFor`; the entry follows the settings service's write rules; the version list follows
 * the studio's Setup versions section. Nothing here is stored: the strip starts again from a fresh studio on each visit.
 *
 * @module website/strip/model
 */
import type { ContrastId, Look } from '@design/looks.ts'
import { DEFAULT_LOOK } from '@design/looks.ts'
import { groupVersions, settingsEditName, type VersionGroup } from '../../../../packages/bundle-local/src/client/version-rows.ts'
import type { VersionEntry } from '../../../../packages/bundle-local/src/client/versions-api.ts'
import { SETTING_KEYS, THEME_ROW_ID, writesFor, type Density, type LookValues, type SettingWrite, type ThemeChange } from '../../../../packages/plugin-theme/src/settings.ts'
import { BRAND_COLOURS } from '../../../../packages/brand/src/tokens.ts'

/** The Theme plugin's package name, which the entry carries beside its id. */
export const THEME_PLUGIN = '@delorun/plugin-theme'

/** The studio bundle's own row config, the layer a profile's entry is written over. */
export const BUNDLE_CONFIG: Readonly<Record<string, string | number | boolean>> = { studioAdditions: true }

/** The studio's contrast value for each of the site's contrast stops: quiet text moves 60% of the way at 200, as the site's stops move it. */
export const STOP_CONTRAST: Readonly<Record<ContrastId, number>> = { default: 100, high: 125, highest: 150 }

/** The settings a fresh studio holds that the strip can change. */
export interface StoredLook extends LookValues {
  /** The density. */
  readonly density: Density
}

/** The settings of a fresh studio: Soft, Peach, the designed contrast and the comfortable density. */
export const FRESH_STUDIO: StoredLook = { palette: 'soft', accent: 'peach', customAccent: BRAND_COLOURS.peach, contrast: STOP_CONTRAST.default, density: 'comfortable' }

/** The summary the profile history gives a settings change of the Theme entry. */
export const THEME_SUMMARY = `Changed the settings of ${THEME_ROW_ID}`

/** One entry config key and its value, in the order the file holds them. */
export type EntryConfig = readonly (readonly [string, string | number | boolean])[]

/** Everything the strip shows. */
export interface StripState {
  /** The settings the studio would hold now. */
  readonly stored: StoredLook
  /** The entry's config, or undefined while the profile has no entry of its own. */
  readonly entry: EntryConfig | undefined
  /** The versions, oldest first; the list only grows. */
  readonly versions: readonly VersionEntry[]
  /** The look after each version, in the same order. */
  readonly looks: readonly Look[]
  /** The look the strip last saw on the page. */
  readonly seen: Look
}

/** The strip before the visitor changes anything. */
export const START: StripState = { stored: FRESH_STUDIO, entry: undefined, versions: [], looks: [], seen: DEFAULT_LOOK }

/**
 * The changes a control would make to go from one look to another, one per press in the studio: the theme (or the custom
 * theme's accent and contrast), then the density. Light or dark is not a setting of the Theme entry, so it makes none.
 * @param from - the look before.
 * @param to - the look after.
 * @returns the changes, in the order the studio would make them; empty when only the scheme differs.
 */
export function changesBetween(from: Look, to: Look): ThemeChange[] {
  const changes: ThemeChange[] = []
  const custom = to.look === 'custom'
  if (from.look !== to.look || (custom && (from.accent !== to.accent || from.contrast !== to.contrast))) {
    changes.push(custom ? { kind: 'custom', values: { accent: to.accent, contrast: STOP_CONTRAST[to.contrast] } } : { kind: 'palette', palette: to.look })
  }
  if (from.density !== to.density) changes.push({ kind: 'density', density: to.density })
  return changes
}

/**
 * Applies writes to an entry config as the settings service does: the keys already held are put in the schema's order,
 * each write replaces its key in place or adds it at the end, and a config equal to the bundle's own row removes the entry.
 * @param entry - the entry's config, or undefined for no entry.
 * @param writes - the writes of one change.
 * @returns the next config, or undefined when the entry is removed.
 */
export function applyWrites(entry: EntryConfig | undefined, writes: readonly SettingWrite[]): EntryConfig | undefined {
  const held = new Map(entry ?? Object.entries(BUNDLE_CONFIG))
  const next = new Map<string, string | number | boolean>(SETTING_KEYS.flatMap(key => held.has(key) ? [[key, held.get(key) as string | number | boolean] as const] : []))
  for (const write of writes) next.set(write.path[0], write.value)
  const config = [...next]
  const bundle = Object.entries(BUNDLE_CONFIG)
  const same = config.length === bundle.length && bundle.every(([key, value]) => next.get(key) === value)
  return same ? undefined : config
}

/**
 * Records one look the page now shows: each change it takes writes the entry and adds a version.
 * @param state - the strip.
 * @param look - the page's look.
 * @param at - the time of the change, in milliseconds since the epoch.
 * @returns the next strip; the same object when the look makes no change.
 */
export function record(state: StripState, look: Look, at: number): StripState {
  const changes = changesBetween(state.seen, look)
  if (changes.length === 0) return state.seen === look ? state : { ...state, seen: look }
  let { stored, entry, versions, looks } = state
  for (const change of changes) {
    const writes = writesFor(change, stored)
    entry = applyWrites(entry, writes)
    stored = { ...stored, ...Object.fromEntries(writes.map(write => [write.path[0], write.value])) }
    versions = [...versions, { id: String(versions.length + 1), at, summary: THEME_SUMMARY, origin: 'other', current: false }]
    looks = [...looks, look]
  }
  return { stored, entry, versions, looks, seen: look }
}

/**
 * The version list as the studio draws it: newest first, the newest one current, repeats collapsed into one row.
 * @param versions - the versions, oldest first.
 * @returns the rows.
 */
export function versionRows(versions: readonly VersionEntry[]): VersionGroup[] {
  return groupVersions(versions.map((version, index) => ({ ...version, current: index === versions.length - 1 })).reverse())
}

/**
 * The name the studio's version title gives the edited entry.
 * @returns the name, "Theme".
 */
export function editedName(): string {
  return settingsEditName(THEME_SUMMARY) ?? THEME_ROW_ID
}

/**
 * The look the way back returns to: the one before the latest change.
 * @param state - the strip.
 * @returns the earlier look, or undefined before the first change.
 */
export function earlierLook(state: StripState): Look | undefined {
  if (state.looks.length === 0) return undefined
  return state.looks.at(-2) ?? DEFAULT_LOOK
}

/**
 * A YAML scalar as the `yaml` package writes it in a block: a plain word, or a double-quoted string when the text starts
 * with an indicator such as `@` or `#`.
 * @param value - the value.
 * @returns the scalar's text.
 */
function scalar(value: string | number | boolean): string {
  if (typeof value !== 'string' || /^[A-Za-z][\w-]*$/.test(value)) return String(value)
  return JSON.stringify(value)
}

/**
 * The entry as `cordis.patch.yml` holds it.
 * @param entry - the entry's config.
 * @returns the YAML text of the entry, one list item.
 */
export function entryYaml(entry: EntryConfig): string {
  const lines = [`- id: ${THEME_ROW_ID}`, `  name: ${scalar(THEME_PLUGIN)}`, '  config:', ...entry.map(([key, value]) => `    ${key}: ${scalar(value)}`)]
  return `${lines.join('\n')}\n`
}
