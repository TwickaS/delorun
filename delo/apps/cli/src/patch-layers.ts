/**
 * The patch lists that compose a profile's rows, read the way upstream's boot reads them, so a start can check what
 * will mount before any plugin runs and name the file that set a value. The order is upstream's
 * (`readProfilePatches` in `@deepseek-ai/dsh-app-boot`): the bundle layers in `dsh.profile.bundles` order, the
 * profile's own `cordis.patch.yml`, the home's `cordis.patch.yml`, which applies over every profile, and the start's
 * `--patch` overlays in the order it passes them. A patch's `config` replaces the row's whole config and its
 * `disabled` replaces the row's (`applyPatches` in `@deepseek-ai/cordis-plugin-include`), so the composed entry is
 * what the last layer that sets each field gives.
 *
 * @module @delo/cli/patch-layers
 */
import { join, resolve } from 'node:path'
import { composeEntries, loadOptionalPatches, loadOverlayPatches, PROFILE_PATCH_FILENAME, type Profile } from '@deepseek-ai/dsh-app-boot'

/** One patch list that composes onto the profile's rows. */
export interface PatchLayer {
  /** The file, or the bundle with its files, that refusals name. */
  readonly source: string
  /** The bundle's package name, for a bundle layer; absent for the profile's patch, the home's patch and overlays. */
  readonly packageName?: string
  /** The bundle's package directory, for a bundle layer. */
  readonly packageDir?: string
  /** The parsed patches. */
  readonly patches: Profile['patches']
}

/**
 * The home's patch, which upstream applies over every profile's own patch: `cordis.patch.yml` in the harness home,
 * which the CLI sets to the Delo home before upstream runs.
 * @param home - the resolved Delo home.
 * @returns `<home>/cordis.patch.yml`.
 */
export function homePatchFile(home: string): string {
  return join(home, PROFILE_PATCH_FILENAME)
}

/**
 * The patch lists that compose the profile's rows, in upstream's order.
 * @param home - the resolved Delo home.
 * @param profile - the profile as it boots.
 * @param patchFiles - the start's `--patch` overlays, in the order it passes them.
 * @returns the layers; an absent home patch is an empty layer, as upstream reads it.
 * @throws {Error} upstream's loader error when the home patch or an overlay cannot be read or parsed, as the boot
 *   would fail.
 */
export function patchLayers(home: string, profile: Pick<Profile, 'layers' | 'patchPath' | 'patches'>, patchFiles: readonly string[]): PatchLayer[] {
  const homePatch = homePatchFile(home)
  return [
    ...profile.layers.map(layer => ({ source: `the bundle ${layer.packageName} (${layer.patchPaths.join(', ')})`, packageName: layer.packageName, packageDir: layer.packageDir, patches: layer.patches })),
    { source: profile.patchPath, patches: profile.patches },
    { source: homePatch, patches: loadOptionalPatches('delorun', homePatch) ?? [] },
    ...patchFiles.map(file => ({ source: resolve(file), patches: loadOverlayPatches('delorun', resolve(file)) })),
  ]
}

/**
 * Whether a value is an object that is not an array.
 * @param value - the value.
 * @returns the narrowing.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The patches or entries for one row, in order: a patch's or entry's own, then the rows it inserts and the members of
 * a group config.
 * @param entries - the patches or entries.
 * @param id - the row's id.
 * @returns the patches and entries naming the row, which a later one overrides field by field.
 */
export function rowPatches(entries: readonly unknown[], id: string): Record<string, unknown>[] {
  return entries.filter(isRecord).flatMap(entry => [
    ...entry.id === id ? [entry] : [],
    ...rowPatches(Array.isArray(entry.insert) ? entry.insert : [], id),
    ...rowPatches(Array.isArray(entry.config) ? entry.config : [], id),
  ])
}

/**
 * The entries one patch list inserts with a row's id: the members of every `insert`, and the members of an inserted
 * group's `config`, at any depth. A patch without `insert` targets an existing entry and inserts nothing; upstream skips
 * a patch whose `name` differs from its target's, so only an insert can give an id another plugin.
 * @param patches - the patch list.
 * @param id - the row's id.
 * @returns the inserted entries, in order.
 */
export function rowInserts(patches: readonly unknown[], id: string): Record<string, unknown>[] {
  const members = (entries: readonly unknown[]): Record<string, unknown>[] => entries.filter(isRecord).flatMap(entry => [
    ...entry.id === id ? [entry] : [],
    ...members(Array.isArray(entry.config) ? entry.config : []),
  ])
  return patches.filter(isRecord).flatMap(patch => members(Array.isArray(patch.insert) ? patch.insert : []))
}

/**
 * The sources of the layers whose patches for a row pass a test.
 * @param layers - the layers.
 * @param id - the row's id.
 * @param test - the test of one patch or inserted entry.
 * @returns the sources, in layer order.
 */
export function sourcesSetting(layers: readonly PatchLayer[], id: string, test: (patch: Record<string, unknown>) => boolean): string[] {
  return layers.filter(layer => rowPatches(layer.patches, id).some(test)).map(layer => layer.source)
}

/**
 * The entry a row composes to over every layer, as the boot include mounts it.
 * @param layers - the layers.
 * @param id - the row's id.
 * @returns the entry, or `undefined` when no layer inserts the row.
 */
export function composedRow(layers: readonly PatchLayer[], id: string): Record<string, unknown> | undefined {
  return rowPatches(composeEntries(layers.map(layer => layer.patches)), id).at(-1)
}
