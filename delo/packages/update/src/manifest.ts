/**
 * What the report reads from a plugin's `package.json`, and how it classifies each version axis. C3 says the report
 * "imports no plugin code" and rests on metadata Delo could read, so a manifest is parsed here as JSON and reduced
 * to the two declarations the axes need; nothing a plugin declares is executed.
 *
 * The classification follows upstream's `plugin-compatibility.ts`, which the report cannot reuse because that module
 * checks a plugin against the DSH that runs, and the report predicts against the DSH the update would install:
 * a declaration is a range when it is a string, unreadable when it is present in another form, and absent otherwise.
 * Whether a range is met, and whether an exemption covers it, is `evaluateRequirement`'s decision, not this module's.
 *
 * @module @delo/update/manifest
 */
import type { SemanticVersion } from '@delo/contract-release-manifest'
import type { VersionAxis } from '@delo/contract-plugin-versions'

/** One axis's declaration in a plugin's `package.json`. */
export type DeclaredRequirement =
  /** `engines.dsh` or `engines.delo` is a string: its text is the range, valid or not. */
  | { readonly kind: 'range', readonly range: string }
  /** The axis is declared in a form that is not a range, so Delo cannot read it. */
  | { readonly kind: 'unreadable' }
  /** The plugin declares nothing on this axis. */
  | { readonly kind: 'none' }

/** Both axes as one manifest declares them. */
export interface PluginRequirements {
  /** `engines.dsh`, or the absence of it. */
  readonly dsh: DeclaredRequirement
  /** `engines.delo`, or the absence of it. */
  readonly delo: DeclaredRequirement
}

/** An installed plugin as the profile holds it, with what its own manifest declares. */
export interface InstalledPluginFact {
  /** The package name, from the profile's dependency listing. */
  readonly name: string
  /** The installed exact version, from the profile's dependency listing. */
  readonly version: SemanticVersion
  /**
   * Both axes' declarations, or absent when the plugin's `package.json` could not be read as one: the installed
   * version still names the plugin, which is why an unreadable manifest leaves a subject and no facts.
   */
  readonly requirements?: PluginRequirements
}

/**
 * Reduce one JSON value to the two declarations the report needs.
 * @param value - the parsed `package.json`.
 * @returns both axes' declarations, or undefined when the value is not a manifest object at all; every axis is
 *   `unreadable` when a manifest's `engines` is present but is not an object.
 */
function requirementsOf(value: unknown): PluginRequirements | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (!Object.hasOwn(fields, 'engines')) return { dsh: { kind: 'none' }, delo: { kind: 'none' } }
  const engines = fields['engines']
  if (typeof engines !== 'object' || engines === null || Array.isArray(engines)) return { dsh: { kind: 'unreadable' }, delo: { kind: 'unreadable' } }
  const declaration = (axis: VersionAxis): DeclaredRequirement => {
    const range = (engines as Record<string, unknown>)[axis]
    if (range === undefined) return { kind: 'none' }
    return typeof range === 'string' ? { kind: 'range', range } : { kind: 'unreadable' }
  }
  return { dsh: declaration('dsh'), delo: declaration('delo') }
}

/**
 * Read one installed plugin: its identity from the profile, its declarations from its own `package.json`.
 * @param name - the package name the profile lists.
 * @param version - the installed exact version the profile lists.
 * @param bytes - the plugin's `package.json` as read from its package directory.
 * @returns the plugin, with no `requirements` when the bytes do not parse as a JSON object, which C3 reports as
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
  const requirements = requirementsOf(parsed)
  return requirements === undefined ? { name, version } : { name, version, requirements }
}
