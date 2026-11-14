/**
 * What the report reads from a plugin's `package.json`. C3 says the report "imports no plugin code" and rests on
 * metadata Delorun could read, so a manifest is parsed here as JSON and kept as the object upstream's compatibility
 * evaluation reads; nothing a plugin declares is executed. Whether either axis is met is `evaluatePluginAxes`'s
 * decision (`./versions.ts`), which is upstream's own.
 *
 * @module @delorun/update/manifest
 */
import type { SemanticVersion } from '@delorun/contract-release-manifest'

/** An installed plugin as the profile holds it, with its own manifest. */
export interface InstalledPluginFact {
  /** The package name, from the profile's dependency listing. */
  readonly name: string
  /** The installed exact version, from the profile's dependency listing. */
  readonly version: SemanticVersion
  /**
   * The plugin's parsed `package.json`, or absent when it could not be read as a JSON object: the installed version
   * still names the plugin, which is why an unreadable manifest leaves a subject and no facts.
   */
  readonly manifest?: Readonly<Record<string, unknown>>
}

/**
 * Read one installed plugin: its identity from the profile, its declarations from its own `package.json`.
 * @param name - the package name the profile lists.
 * @param version - the installed exact version the profile lists.
 * @param bytes - the plugin's `package.json` as read from its package directory.
 * @returns the plugin, with no `manifest` when the bytes do not parse as a JSON object, which C3 reports as
 *   `manifest-unreadable` and never as safe.
 */
export function readInstalledPlugin(name: string, version: SemanticVersion, bytes: string | Uint8Array): InstalledPluginFact {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A package.json that does not parse is the fact `manifest-unreadable` states; why it did not is not the report's subject.
    return { name, version }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { name, version }
  return { name, version, manifest: parsed as Readonly<Record<string, unknown>> }
}
