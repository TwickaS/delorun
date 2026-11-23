/**
 * Which patch layer of the running profile adds or changes each Loader row (A631, L201), read from the profile's files
 * at each review. Booting the profile flattens every bundle's patches and the person's own into one row list, so the
 * Loader tree does not say where a row came from. Upstream's hot reload rebuilds that list from the same files when a
 * bundle is installed, switched or configured, and these files are what it reads, so a review after a hot reload sees
 * the new layers.
 *
 * @module @delorun/plugin-mcp-consent/layers
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { loadOptionalPatches, loadProfileDirectory, PROFILE_PATCH_FILENAME, type ProfileContext } from '@deepseek-ai/dsh-app-boot'

/**
 * What a bundle layer is, as the Delorun launcher judges it:
 * - `runtime`: one of the bundles Delorun's runtime ships and its profiles require (Delorun's and upstream's own);
 * - `pack`: one of the running release's plugin packs, loading from the folder the release installs it in (or the
 *   Changes review copy of that folder);
 * - `other`: anything else, a pack's name included when it loads from anywhere else.
 */
export type LayerKind = 'runtime' | 'pack' | 'other'

/** One bundle layer as the launcher's judge reads it. */
export interface LayerSource {
  /** The bundle's package name, as the profile lists it. */
  readonly packageName: string
  /** The folder the bundle resolved to. */
  readonly packageDir: string
}

/**
 * The Delorun launcher's judgement of the profile's bundle layers, provided on the Host's root context as
 * `delorunPackLayers` before the Loader mounts its first row. Without it every bundle layer counts as `other`.
 */
export interface DelorunPackLayers {
  /**
   * Judge one bundle layer now, from the folder it resolves to.
   * @param layer - the layer.
   * @returns what the layer is.
   */
  kindOf(layer: LayerSource): Promise<LayerKind>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The launcher's judgement of bundle layers; present in a Host the Delorun CLI starts. */
    delorunPackLayers: DelorunPackLayers
  }
}

/** One bundle layer's part in a row. */
export interface RowLayer {
  /** The bundle's package name. */
  readonly bundle: string
  /** What the bundle is. */
  readonly kind: LayerKind
  /** Whether the layer inserts the row, rather than only changing it. */
  readonly inserts: boolean
}

/** Where the running profile's rows come from. */
export interface RowSources {
  /** The ids of the rows the person's own patch files insert: the profile's `cordis.patch.yml` and the home's. */
  readonly own: ReadonlySet<string>
  /** For each row a bundle layer inserts or changes, those layers in order. */
  readonly bundles: ReadonlyMap<string, readonly RowLayer[]>
}

/** The parts of a patch that change the row it names; a patch with only `id` and `insert` adds rows to a group. */
const ROW_CHANGING_KEYS = (key: string): boolean => key !== 'id' && key !== 'insert'

/**
 * The rows a patch list inserts, nested group rows included, and the rows it changes.
 * @param patches - the patch list.
 * @returns the inserted and the changed row ids.
 */
export function rowsOfPatches(patches: readonly unknown[]): { readonly inserted: ReadonlySet<string>; readonly changed: ReadonlySet<string> } {
  const inserted = new Set<string>()
  const changed = new Set<string>()
  const visitEntry = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null) return
    if (Array.isArray(entry)) {
      entry.forEach(visitEntry)
      return
    }
    const record: Record<string, unknown> = { ...entry }
    if (typeof record.id === 'string') inserted.add(record.id)
    // A group row's config is its own row list.
    for (const value of Object.values(record)) if (typeof value === 'object') visitEntry(value)
  }
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const record: Record<string, unknown> = { ...patch }
    if (typeof record.id === 'string' && Object.keys(record).some(ROW_CHANGING_KEYS)) changed.add(record.id)
    visitEntry(record.insert)
  }
  return { inserted, changed }
}

/**
 * Read where the running profile's rows come from, from its files as they are now.
 * @param ctx - a context that sees upstream's `profileContext` and, in a Delorun Host, `delorunPackLayers`.
 * @returns the row sources, or `undefined` without a profile context or when the profile's files cannot be read, so
 *   that no row counts as the person's own or a pack's.
 */
export async function readRowSources(ctx: Context): Promise<RowSources | undefined> {
  const profile: ProfileContext | undefined = ctx.get('profileContext')
  if (profile === undefined) return undefined
  const judge = ctx.get('delorunPackLayers')
  let loaded: ReturnType<typeof loadProfileDirectory>
  let home: readonly unknown[]
  try {
    loaded = loadProfileDirectory('delorun', profile.dir, profile.installAnchor)
    home = loadOptionalPatches('delorun', join(profile.home, PROFILE_PATCH_FILENAME)) ?? []
  } catch (error) {
    // A profile file that does not read (`error`) leaves every row's source unknown, so its servers ask.
    void error
    return undefined
  }
  const own = new Set([...rowsOfPatches(loaded.patches).inserted, ...rowsOfPatches(home).inserted])
  const bundles = new Map<string, RowLayer[]>()
  for (const layer of loaded.layers) {
    const kind = judge === undefined ? 'other' : await judge.kindOf({ packageName: layer.packageName, packageDir: layer.packageDir }).catch(() => 'other' as const)
    const { inserted, changed } = rowsOfPatches(layer.patches)
    for (const id of new Set([...inserted, ...changed])) {
      const list = bundles.get(id) ?? []
      list.push({ bundle: layer.packageName, kind, inserts: inserted.has(id) })
      bundles.set(id, list)
    }
  }
  return { own, bundles }
}
