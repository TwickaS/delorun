/** Loader overlay that keeps the bundled Host's product analytics off until the person turns them on (S20). */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name of the overlay written beside the desktop profile. */
export const ANALYTICS_OFF_OVERLAY_FILE = 'delorun-analytics-off.overlay.yml'

/**
 * The overlay's patches: the `product-analytics` row's `enabled` setting starts `false`. Upstream's desktop profile
 * sets it to `true`; the person's live application setting still changes it afterwards. JSON is valid YAML, so the
 * overlay needs no YAML writer.
 */
export const ANALYTICS_OFF_PATCHES: readonly { readonly id: string; readonly config: { readonly enabled: false } }[] = [
  { id: 'product-analytics', config: { enabled: false } },
]

/**
 * Write the overlay into a directory the Host owns and return its path for the loader's `--patch` layer.
 * @param directory - Existing or creatable directory owned by the desktop profile.
 * @returns Absolute path of the written overlay file.
 */
export function writeAnalyticsOffOverlay(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, ANALYTICS_OFF_OVERLAY_FILE)
  writeFileSync(file, `${JSON.stringify(ANALYTICS_OFF_PATCHES, undefined, 2)}\n`)
  return file
}
