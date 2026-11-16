/**
 * The row ids the profile's bundles already hold, read from the bundles themselves. A setup's inserted row may take
 * none of them, and no plugin's name may stand in front of one, because Cordis's patch layer finds a row by its id:
 * a second row with the same id takes later patches meant for the protection's row, and the loader keeps one of the two.
 *
 * @module @delorun/changes/setup-transfer/composed-ids
 */
import { bundlePatchPaths, loadOverlayPatches, readProfileManifest, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { ChangesError } from '../errors.ts'

/**
 * @param value - a parsed patch list or any part of one.
 * @param into - receives each `id` text found at any depth.
 */
function collectIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'id' && typeof item === 'string') into.add(item)
      else collectIds(item, into)
    }
  }
}

/**
 * Read the ids of every row the profile's bundles insert or patch.
 * @param profileDir - the profile directory.
 * @returns the ids, read now; nothing is written.
 * @throws {ChangesError} `SETUP_REFUSED` when a bundle the profile lists cannot be read, because a setup cannot be checked against rows that are not known.
 */
export function composedRowIds(profileDir: string): ReadonlySet<string> {
  const ids = new Set<string>()
  try {
    const bundles = readProfileManifest('delorun', profileDir).dsh?.profile?.bundles ?? []
    for (const name of bundles) {
      const packageDir = resolveBundleDir('delorun', name, import.meta.filename, profileDir)
      const bundle = readProfileManifest('delorun', packageDir).dsh?.bundle
      if (bundle === undefined) continue
      for (const path of bundlePatchPaths(packageDir, bundle)) collectIds(loadOverlayPatches('delorun', path), ids)
    }
  } catch (error: unknown) {
    throw new ChangesError('SETUP_REFUSED', profileDir, `The profile's bundles could not be read, so a setup cannot be checked against their rows: ${(error as Error).message}`)
  }
  return ids
}
