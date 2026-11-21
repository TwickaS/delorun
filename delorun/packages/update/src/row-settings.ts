/**
 * The settings two releases' signed bundles give the rows Delorun protects (contract C3, "Rows a release changes"). A
 * release can set a key on a protected row, add the row or drop it, and the health check holds a protected row to its
 * previous settings (H3), so the change is a fact the report names before the update and the target's health check
 * derives again from the same signed data. Everything here is read from the layers of the two releases' bundles
 * ({@link LayerFact.settings}); the profile's and the home's own patches are not an input, because a person or an agent
 * can write them.
 *
 * @module @delorun/update/row-settings
 */
import type { ItemEffect, ReportItem, RowSettingsDetail, SettingChange, SettingValue } from '@delorun/contract-update-report'
import type { LayerFact, RowSettingsFact } from './facts.ts'

/** How a protected row's settings differ between the running and the target release, with the row's identity. */
export interface RowSettingsChange extends RowSettingsDetail {
  /** The row's id. */
  readonly id: string
  /** The plugin the row loads. */
  readonly plugin: string
  /** The target release's bundle that holds the row, or the running release's when the target has none. */
  readonly layer: string
}

/** The `protectedPlugins` row of `@delorun/bundle-local`'s patch names the plugins whose rows Delorun protects. */
const PLUGIN_MANAGER_ROW = 'plugin-manager'

/**
 * JSON with each object's keys in sorted order, so the same value always gives the same text.
 * @param value - the value.
 * @returns the text; `null` for a value JSON cannot write.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** One row's merged settings across the layers of one release. */
interface MergedRow {
  /** The plugin the row loads, when a layer inserts it. */
  plugin?: string
  /** The bundle that holds the row: the last layer that gives it settings. */
  layer: string
  /** The merged keys; a later layer's key replaces an earlier one's. */
  config: Record<string, SettingValue>
}

/**
 * Merge every layer's settings per row id, in layer order.
 * @param layers - one release's bundle layers.
 * @returns the rows by id.
 */
function mergedRows(layers: readonly LayerFact[]): Map<string, MergedRow> {
  const rows = new Map<string, MergedRow>()
  for (const layer of layers) {
    for (const fact of layer.settings ?? []) {
      const existing = rows.get(fact.id) ?? { layer: layer.layer, config: {} }
      rows.set(fact.id, { ...existing, ...fact.plugin === undefined ? {} : { plugin: fact.plugin }, layer: layer.layer, config: { ...existing.config, ...fact.config } })
    }
  }
  return rows
}

/**
 * The plugins whose rows one release protects: the `protectedPlugins` list of its `plugin-manager` row.
 * @param layers - the release's bundle layers.
 * @returns the plugin names; none when no layer sets a list of names.
 */
export function protectedPluginsOfLayers(layers: readonly LayerFact[]): ReadonlySet<string> {
  const list = mergedRows(layers).get(PLUGIN_MANAGER_ROW)?.config['protectedPlugins']
  return new Set(Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [])
}

/**
 * Every setting a bundle gives a row, as changes from nothing or to nothing.
 * @param config - the row's merged keys.
 * @param side - which release holds them.
 * @returns the changes, in key order.
 */
function wholeRow(config: Readonly<Record<string, SettingValue>>, side: 'before' | 'after'): readonly SettingChange[] {
  return Object.keys(config).sort().map(key => ({ key, [side]: config[key] as SettingValue }))
}

/**
 * The keys whose values differ between two merged rows.
 * @param before - the running release's keys.
 * @param after - the target release's keys.
 * @returns the changes, in key order; none when the rows are equal.
 */
function differingKeys(before: Readonly<Record<string, SettingValue>>, after: Readonly<Record<string, SettingValue>>): readonly SettingChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys.flatMap((key): readonly SettingChange[] => {
    const was = Object.hasOwn(before, key) ? before[key] : undefined
    const now = Object.hasOwn(after, key) ? after[key] : undefined
    if (canonicalJson(was) === canonicalJson(now) && (was === undefined) === (now === undefined)) return []
    return [{ key, ...was === undefined ? {} : { before: was }, ...now === undefined ? {} : { after: now } }]
  })
}

/**
 * How the two releases' bundles set the rows Delorun protects: a protected row both give with different settings, one
 * only the target gives, and one only the running release gives. A row is protected when either release's
 * `protectedPlugins` names the plugin it loads; a row whose plugin no layer states is left out.
 * @param running - the running release's bundle layers.
 * @param target - the target release's bundle layers.
 * @returns one change per protected row that differs, in row id order.
 */
export function releaseSettingChanges(running: readonly LayerFact[], target: readonly LayerFact[]): readonly RowSettingsChange[] {
  const protectedPlugins = new Set([...protectedPluginsOfLayers(running), ...protectedPluginsOfLayers(target)])
  const before = mergedRows(running)
  const after = mergedRows(target)
  const changes: RowSettingsChange[] = []
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(id)
    const now = after.get(id)
    const plugin = now?.plugin ?? was?.plugin
    if (plugin === undefined || !protectedPlugins.has(plugin)) continue
    const layer = now?.layer ?? was?.layer ?? ''
    if (was === undefined && now !== undefined) changes.push({ id, plugin, layer, change: 'added', keys: wholeRow(now.config, 'after') })
    else if (was !== undefined && now === undefined) changes.push({ id, plugin, layer, change: 'removed', keys: wholeRow(was.config, 'before') })
    else if (was !== undefined && now !== undefined) {
      const keys = differingKeys(was.config, now.config)
      if (keys.length > 0) changes.push({ id, plugin, layer, change: 'changed', keys })
    }
  }
  return changes
}

/**
 * The configs a protected row would have booted with on the running release, if the target's booted config differs
 * from it in exactly the keys the release's bundles change and holds the target's values there.
 * @param booted - the config the Loader mounted the row with on the target.
 * @param change - the row's change between the two releases' bundles.
 * @returns the candidate previous configs: the booted config with each changed key set back to the running release's
 *   value, or removed where that release sets none; both an empty config and no config when nothing is left. Empty when
 *   the row was not changed in place, or a changed key does not hold the target's value.
 */
export function previousConfigsOf(booted: unknown, change: RowSettingsChange): readonly unknown[] {
  if (change.change !== 'changed') return []
  if (booted !== undefined && (typeof booted !== 'object' || booted === null || Array.isArray(booted))) return []
  const now: Readonly<Record<string, unknown>> = booted === undefined ? {} : booted as Record<string, unknown>
  const previous: Record<string, unknown> = { ...now }
  for (const { key, before, after } of change.keys) {
    const present = Object.hasOwn(now, key)
    if (after === undefined ? present : !present || canonicalJson(now[key]) !== canonicalJson(after)) return []
    if (before === undefined) delete previous[key]
    else previous[key] = before
  }
  return Object.keys(previous).length === 0 ? [previous, undefined] : [previous]
}

/**
 * The report items for the protected-row changes between the two releases.
 * @param changes - {@link releaseSettingChanges}.
 * @returns one `row-settings-changed` item per change: `changed` for a row with new settings or a new row, `removed` for a row the target drops.
 */
export function settingsItems(changes: readonly RowSettingsChange[]): readonly ReportItem[] {
  return changes.map((change): ReportItem => {
    const effect: ItemEffect = change.change === 'removed' ? 'removed' : 'changed'
    return {
      kind: 'row',
      // The name is the row's id, so no other row of the plugin is named with it.
      subject: { id: change.id, name: change.id, layer: change.layer },
      reason: 'row-settings-changed',
      effect,
      verification: 'verified',
      detail: { settings: { change: change.change, keys: change.keys } },
      actions: [],
    }
  })
}

/**
 * The facts of one patch entry that give a row settings, for a reader of patch files.
 * @param id - the row's id.
 * @param plugin - the plugin the entry inserts the row with, when it does.
 * @param config - the entry's `config` keys.
 * @returns the fact.
 */
export function rowSettingsFact(id: string, plugin: string | undefined, config: Readonly<Record<string, SettingValue>>): RowSettingsFact {
  return { id, ...plugin === undefined ? {} : { plugin }, config }
}
