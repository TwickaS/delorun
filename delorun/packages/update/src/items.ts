/**
 * The items the report names, one builder per kind: the plugins the target disables or leaves unreadable, the bundles
 * that leave or cannot load, and the profile rows and Includes that load a plugin the update disables. Each builder
 * returns the items C3's item table describes — kind, subject, reason, effect, verification, detail and the offered
 * actions — and nothing else; sorting and counting is `buildUpdateReport`'s.
 *
 * The offered actions are C3's closed list (`update-plugin`, `keep-disabled`, `allow-version`, `skip-update`). C3
 * fixes which actions an axis mismatch offers — updating the plugin, and an exact-version exemption on the unmet axis
 * — and leaves the rest to the screen that shows them (WP6.3), so this module offers only what the report can already
 * decide: the two an axis mismatch offers, `keep-disabled` where the person can accept the disable, `skip-update`
 * where nothing else can change it, and none beside an item that changes nothing.
 *
 * @module @delorun/update/items
 */
import { VERSION_AXES, type ExemptionRecord, type VersionAxis } from '@delorun/contract-plugin-versions'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import type { ItemAction, ItemDetail, ItemEffect, ItemVerification, PluginSubject, ReportItem, ReportReason, RowSubject } from '@delorun/contract-update-report'
import type { BundleFacts, LayerFact, RevokedPluginVersion, RowFact, SkippedBundleFact } from './facts.ts'
import type { InstalledPluginFact } from './manifest.ts'
import { evaluatePluginAxes, exemptionKey, type AxisDecision, type AxisVersions } from './versions.ts'

/** What one disabled plugin contributes to the report, for the rows and Includes that load it. */
export interface DisabledPlugin {
  /** The plugin's subject. */
  readonly subject: PluginSubject
  /** Whether the disable rests on metadata Delorun read. */
  readonly verification: ItemVerification
}

/** The actions an axis mismatch offers: a version that meets the target, and an exemption on the unmet axis. */
const MISMATCH_ACTIONS: readonly ItemAction[] = ['update-plugin', 'allow-version', 'keep-disabled']

/**
 * One plugin item.
 * @param subject - the plugin.
 * @param reason - the reason code.
 * @param effect - what happens to it.
 * @param verification - whether the prediction rests on metadata Delorun read.
 * @param detail - the reason's facts.
 * @param actions - the offered choices.
 * @returns the item.
 */
function pluginItem(subject: PluginSubject, reason: ReportReason, effect: ItemEffect, verification: ItemVerification, detail: ItemDetail, actions: readonly ItemAction[]): ReportItem {
  return { kind: 'plugin', subject, reason, effect, verification, detail, actions }
}

/**
 * The item a revoked plugin gets, or undefined when the target's list does not revoke this version.
 * @param plugin - the installed plugin.
 * @param revocations - the target's fresh revocation list.
 * @returns the item, or undefined.
 */
function revocationItem(plugin: InstalledPluginFact, revocations: readonly RevokedPluginVersion[]): ReportItem | undefined {
  const revocation = revocations.find(entry => entry.package === plugin.name && entry.versions.includes(plugin.version))
  if (revocation === undefined) return undefined
  const detail: ItemDetail = { revocation: { reason: revocation.reason, message: revocation.message } }
  return pluginItem({ name: plugin.name, version: plugin.version }, 'plugin-revoked', 'disabled', 'verified', detail, ['update-plugin', 'keep-disabled'])
}

/**
 * The item one axis decides.
 * @param plugin - the installed plugin.
 * @param axis - the axis.
 * @param decision - what the axis decides.
 * @returns the item the decision makes, or undefined when the axis changes nothing.
 */
function axisItem(plugin: InstalledPluginFact, axis: VersionAxis, decision: AxisDecision): ReportItem | undefined {
  const subject: PluginSubject = { name: plugin.name, version: plugin.version }
  switch (decision.kind) {
    case 'compatible':
    case 'none':
    case 'not-checked':
      return undefined
    case 'undeclared':
      // C3 states this only for the DSH axis, which is the axis whose absence leaves compatibility unstated.
      return pluginItem(subject, 'requirement-undeclared', 'kept', 'unverified', {}, [])
    case 'unreadable':
      return pluginItem(subject, 'requirement-unreadable', 'disabled', 'unverified', { axis }, ['keep-disabled', 'skip-update'])
    case 'exempted':
      return pluginItem(subject, 'requirement-exempted', 'kept', 'verified', { axis, requirement: decision.requirement }, [])
    case 'not-carried':
      return pluginItem(subject, 'exemption-not-carried', 'disabled', 'verified', { axis, requirement: decision.requirement }, MISMATCH_ACTIONS)
    case 'unmet':
      return pluginItem(subject, axis === 'dsh' ? 'dsh-requirement-unmet' : 'delorun-requirement-unmet', 'disabled', 'verified', { axis, requirement: decision.requirement }, MISMATCH_ACTIONS)
  }
}

/** What the plugin items decide, and what the rows that load them need. */
export interface PluginItems {
  /** One group of items per installed plugin, in the profile's order. */
  readonly items: readonly ReportItem[]
  /** The plugins the update disables, by package name. */
  readonly disabled: ReadonlyMap<string, DisabledPlugin>
}

/**
 * Every plugin item the update names.
 * @param plugins - the installed plugins.
 * @param versions - both axes' running and target versions.
 * @param exemptions - both exemption files.
 * @param revocations - the target's fresh revocation list.
 * @returns the items and the plugins they disable.
 */
export function pluginItems(plugins: readonly InstalledPluginFact[], versions: Readonly<Record<VersionAxis, AxisVersions>>, exemptions: Readonly<Record<VersionAxis, ExemptionRecord>>, revocations: readonly RevokedPluginVersion[]): PluginItems {
  const items: ReportItem[] = []
  const disabled = new Map<string, DisabledPlugin>()
  for (const plugin of plugins) {
    const subject: PluginSubject = { name: plugin.name, version: plugin.version }
    // A revoked version is refused whatever its ranges say: the target's fresh list holds it, and offering an
    // exemption would offer to keep running a version the list revokes.
    const revoked = revocationItem(plugin, revocations)
    if (revoked !== undefined) {
      items.push(revoked)
      disabled.set(plugin.name, { subject, verification: 'verified' })
      continue
    }
    if (plugin.manifest === undefined) {
      // An unreadable manifest is kept — nothing says the update breaks it — and it is never counted as safe.
      items.push(pluginItem(subject, 'manifest-unreadable', 'kept', 'unverified', {}, ['keep-disabled', 'skip-update']))
      continue
    }
    const decisions = evaluatePluginAxes(plugin.manifest, versions, exemptions, exemptionKey(plugin.name, plugin.version))
    for (const axis of VERSION_AXES) {
      const item = axisItem(plugin, axis, decisions[axis])
      if (item === undefined) continue
      items.push(item)
      if (item.effect === 'disabled') disabled.set(plugin.name, { subject, verification: item.verification })
    }
  }
  return { items, disabled }
}

/**
 * The bundle items the target's own tables and its bundles' metadata make: a bundle the target cannot load is
 * disabled, an installation-owned list is replaced by the target's template, and any other retired bundle leaves the
 * list.
 * @param bundles - the profile's bundle list.
 * @param facts - the target's bundle facts.
 * @returns the items, in the profile's order, then each bundle the template adds that the profile does not list.
 */
export function bundleItems(bundles: readonly string[], facts: BundleFacts): readonly ReportItem[] {
  const items: ReportItem[] = []
  const skipped = new Map(facts.skipped.map(entry => [entry.package, entry]))
  const skippedItem = (entry: SkippedBundleFact): ReportItem => ({ kind: 'bundle', subject: { package: entry.package }, reason: 'bundle-skipped', effect: 'disabled', verification: entry.verification, detail: { failure: entry.reason }, actions: ['keep-disabled', 'skip-update'] })
  const normalisedItem = (bundle: string): ReportItem => ({ kind: 'bundle', subject: { package: bundle }, reason: 'bundle-template-normalised', effect: 'changed', verification: 'verified', detail: {}, actions: [] })
  for (const bundle of bundles) {
    const failure = skipped.get(bundle)
    if (failure !== undefined) {
      items.push(skippedItem(failure))
      continue
    }
    if (facts.template !== undefined) {
      // The whole list is replaced by the target's template, so a bundle stays only when the template keeps it.
      if (!facts.template.includes(bundle)) items.push(normalisedItem(bundle))
      continue
    }
    if (facts.retired.includes(bundle)) items.push({ kind: 'bundle', subject: { package: bundle }, reason: 'bundle-retired', effect: 'removed', verification: 'verified', detail: {}, actions: [] })
  }
  // A template can also add a bundle the profile does not list, which changes the list just as much; one the target
  // cannot load is named for that instead.
  if (facts.template !== undefined) {
    for (const bundle of facts.template) {
      if (bundles.includes(bundle)) continue
      const failure = skipped.get(bundle)
      items.push(failure === undefined ? normalisedItem(bundle) : skippedItem(failure))
    }
  }
  return items
}

/**
 * The bundle list the report predicts for the target, which health criterion H5 compares the profile against.
 * @param bundles - the profile's bundle list.
 * @param facts - the target's retired bundles and template.
 * @returns the template when the list is installation-owned, otherwise the list without the retired bundles.
 */
export function predictBundleList(bundles: readonly string[], facts: Pick<BundleFacts, 'retired' | 'template'>): readonly string[] {
  if (facts.template !== undefined) return [...facts.template]
  return bundles.filter(bundle => !facts.retired.includes(bundle))
}

/**
 * Every plugin a row reaches, the rows of an Include included.
 * @param row - the row.
 * @returns the package names it reaches, in the order the patch writes them.
 */
function reachedPlugins(row: RowFact): readonly string[] {
  const own = row.plugins ?? []
  if (row.include === undefined) return own
  return [...own, ...row.include.rows.flatMap(reachedPlugins)]
}

/**
 * The row and Include items: a row that loads a plugin the update disables is disabled, and an Include that reaches
 * one is disabled whole, as C3's `row-disabled` and `row-include-blocked` state.
 * @param layers - the profile's layers, each with its rows.
 * @param disabled - the plugins the update disables, from {@link pluginItems}.
 * @returns the items, in layer and row order.
 */
export function rowItems(layers: readonly LayerFact[], disabled: ReadonlyMap<string, DisabledPlugin>): readonly ReportItem[] {
  const items: ReportItem[] = []
  /**
   * The subject one row is named by.
   * @param name - the row's name or Include file.
   * @param row - the row.
   * @param layer - the layer that holds it.
   * @returns the subject.
   */
  const subjectOf = (name: string, row: RowFact, layer: string): RowSubject => row.id === undefined ? { name, layer } : { id: row.id, name, layer }
  const visit = (layer: string, row: RowFact): void => {
    if (row.include !== undefined) {
      // The Include is the item: C3 disables the whole Include rather than each row inside it.
      const blocked = row.include.rows.flatMap(reachedPlugins).map(name => disabled.get(name)).find(entry => entry !== undefined)
      if (blocked !== undefined) {
        items.push({ kind: 'row', subject: subjectOf(row.include.file, row, layer), reason: 'row-include-blocked', effect: 'disabled', verification: blocked.verification, detail: { plugin: blocked.subject }, actions: [] })
      }
      return
    }
    const found = (row.plugins ?? []).map(name => disabled.get(name)).find(entry => entry !== undefined)
    if (found === undefined) return
    items.push({ kind: 'row', subject: subjectOf(row.name, row, layer), reason: 'row-disabled', effect: 'disabled', verification: found.verification, detail: { plugin: found.subject }, actions: [] })
  }
  for (const layer of layers) for (const row of layer.rows) visit(layer.layer, row)
  return items
}

/**
 * The rows the target's bundle patches disable that the running release's bundle patches did not: a release that
 * switches a row off in its own composition changes the profile as a plugin it disables does, and H3 holds the report
 * to name it. A row both releases disable is not new, and a row the target stops disabling is not reported.
 * @param target - the target's bundle layers.
 * @param running - the running release's bundle layers.
 * @param released - the target Delorun version, which the row's plugin subject carries.
 * @returns one `row-disabled` item with `detail.bundlePatch` per newly disabled row id, in layer and patch order. The
 *   item's `detail.plugin` names the plugin the row loads, or the row id when the layer's rows do not list it, because
 *   readers before rc.4 print that name in their "loads …, which the update disables" sentence.
 */
export function bundleRowItems(target: readonly LayerFact[], running: readonly LayerFact[], released: SemanticVersion): readonly ReportItem[] {
  const before = new Set(running.flatMap(layer => layer.disabledRows ?? []))
  const seen = new Set<string>()
  const items: ReportItem[] = []
  for (const layer of target) {
    for (const id of layer.disabledRows ?? []) {
      if (before.has(id) || seen.has(id)) continue
      seen.add(id)
      items.push({ kind: 'row', subject: { id, name: id, layer: layer.layer }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: { bundlePatch: true, plugin: { name: layer.rows.find(row => row.id === id)?.plugins?.[0] ?? id, version: released } }, actions: [] })
    }
  }
  return items
}

/**
 * The version one axis carries in one release, for the callers that build {@link AxisVersions}.
 * @param versions - the release's versions.
 * @param axis - the axis.
 * @returns that axis's version.
 */
export function versionOf(versions: { readonly delorun: SemanticVersion, readonly dsh: SemanticVersion }, axis: VersionAxis): SemanticVersion {
  return axis === 'dsh' ? versions.dsh : versions.delorun
}
