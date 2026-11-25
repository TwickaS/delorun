/**
 * Stage 8's comparison: the studio's regions with and without the plugin. The browser script reads each region as text
 * and style values rather than pixels, so a comparison is exact and shows what changed: the sidebar's entries, the theme's
 * tokens (CSS custom properties on the page root) and Settings' navigation groups. What the plugin adds is its own;
 * what it removes, reorders or restyles of Delorun's is a clash, and a Settings section of the plugin's under "Other"
 * is the studio-overlap cause the plan names.
 *
 * @module @delorun/tools/compat-bench/clashes
 */

/** What the browser script read from the studio. */
export interface RegionSignature {
  /** The sidebar's entries, in order. */
  readonly sidebar: readonly string[]
  /** The theme tokens: custom property name to value on the page root. */
  readonly theme: Readonly<Record<string, string>>
  /** Settings' navigation: each group's heading and its entries in order. */
  readonly settings: ReadonlyArray<{ readonly group: string, readonly items: readonly string[] }>
}

/** One difference. */
export interface Clash {
  /** The region. */
  readonly region: 'sidebar' | 'theme' | 'settings'
  /** What differs, in words. */
  readonly detail: string
}

/**
 * Whether the items, with the plugin's additions taken out, are the baseline's items in the baseline's order.
 * @param baseline - the entries without the plugin.
 * @param withPlugin - the entries with it.
 * @returns the entries of the baseline that are gone, and whether the rest changed order.
 */
function listChange(baseline: readonly string[], withPlugin: readonly string[]): { readonly removed: string[], readonly reordered: boolean } {
  const removed = baseline.filter(item => !withPlugin.includes(item))
  const kept = withPlugin.filter(item => baseline.includes(item))
  const reordered = removed.length === 0 && kept.join('\u0000') !== baseline.join('\u0000')
  return { removed, reordered }
}

/**
 * Compare the regions with and without the plugin.
 * @param baseline - the regions without the plugin.
 * @param withPlugin - the regions with it.
 * @returns the clashes; empty when Delorun's own sidebar, theme and Settings are unchanged.
 */
export function compareRegions(baseline: RegionSignature, withPlugin: RegionSignature): Clash[] {
  const clashes: Clash[] = []
  const sidebar = listChange(baseline.sidebar, withPlugin.sidebar)
  if (sidebar.removed.length > 0) clashes.push({ region: 'sidebar', detail: `entries gone with the plugin: ${sidebar.removed.join(', ')}` })
  if (sidebar.reordered) clashes.push({ region: 'sidebar', detail: 'the entries changed order' })
  const changedTokens = Object.keys(baseline.theme).filter(name => withPlugin.theme[name] !== baseline.theme[name])
  if (changedTokens.length > 0) clashes.push({ region: 'theme', detail: `theme tokens with another value: ${changedTokens.slice(0, 8).join(', ')}${changedTokens.length > 8 ? `, and ${String(changedTokens.length - 8)} more` : ''}` })
  const baselineSettings = new Map(baseline.settings.map(group => [group.group, group.items]))
  for (const group of baseline.settings) {
    const now = withPlugin.settings.find(each => each.group === group.group)
    if (now === undefined) { clashes.push({ region: 'settings', detail: `the group "${group.group}" is gone` }); continue }
    const change = listChange(group.items, now.items)
    if (change.removed.length > 0) clashes.push({ region: 'settings', detail: `entries gone from "${group.group}": ${change.removed.join(', ')}` })
    if (change.reordered) clashes.push({ region: 'settings', detail: `the entries of "${group.group}" changed order` })
  }
  for (const group of withPlugin.settings) {
    const before = baselineSettings.get(group.group) ?? []
    const added = group.items.filter(item => !before.includes(item))
    if (added.length > 0 && /^other$/i.test(group.group)) clashes.push({ region: 'settings', detail: `the plugin's Settings section is under "Other": ${added.join(', ')}` })
  }
  return clashes
}
