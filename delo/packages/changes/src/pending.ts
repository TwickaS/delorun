/**
 * The pending change of a plugin linked from a folder: the folder's content, stored, compared with the approved
 * version. The change's id names both versions, so an apply by id applies the content that was shown.
 *
 * @module @delo/changes/pending
 */
import { boundedDiff, compareVersions, reviewInputOf } from './diff.ts'
import { changeId } from './ids.ts'
import { reviewChange } from './review.ts'
import { readVersion, storeFolder } from './store.ts'
import type { ContentVersion, PluginChange } from './types.ts'

/** The plugin whose folder is compared. */
export interface PluginChangeRequest {
  /** The package name. */
  readonly plugin: string
  /** The folder it is linked from, absolute. */
  readonly source: string
  /** The approved content; undefined for a plugin with none yet. */
  readonly approved?: ContentVersion
  /** The scan cache file, such as `changes/profiles/<profile>/scan-cache.json`. */
  readonly scanCache?: string
}

/**
 * The pending change of a plugin linked from a folder.
 * @param home - the Delo home.
 * @param request - the plugin, its folder, its approved content and the scan cache.
 * @returns the change, or undefined when the folder holds the approved content.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the folder changed while it was read, `STORE_CORRUPT` when the
 * store does not hold the approved version or an object.
 */
export async function pluginChange(home: string, request: PluginChangeRequest): Promise<PluginChange | undefined> {
  const stored = await storeFolder(home, request.source, request.scanCache === undefined ? {} : { scanCache: request.scanCache })
  const { approved } = request
  if (stored.version === approved) return undefined
  const before = approved === undefined ? undefined : await readVersion(home, approved)
  const files = await compareVersions(home, before, stored.manifest)
  const diff = await boundedDiff(home, before, stored.manifest, files)
  const risk = reviewChange(await reviewInputOf(home, before, stored.manifest, files, {}, diff.omitted))
  const kind = approved === undefined ? 'plugin-install' : 'plugin-edit'
  return {
    id: changeId(kind, { plugin: request.plugin, source: request.source }, approved, stored.version),
    kind,
    plugin: request.plugin,
    source: request.source,
    ...(approved === undefined ? {} : { from: approved }),
    to: stored.version,
    files,
    diff,
    risk,
    skipped: stored.skipped,
  }
}
