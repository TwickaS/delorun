/**
 * The two version axes of one installed plugin, predicted against the release the update would install (contract C17,
 * `delo/docs/contracts/c17-plugin-versions.md#exemptions`): whether the target meets the declared range, whether the
 * person's exact-version exemption covers the target, and whether the plugin only runs today because an exemption
 * covers the version it runs on now.
 *
 * The semantics are upstream's (`plugin-compatibility.ts`): a range is met when the version satisfies it with
 * prereleases taking part, and an empty or invalid range is unmet. An exemption is the profile's file for the axis
 * mapping an exact `package@version` key to exact versions of that axis, so it admits one version and not a range.
 *
 * @module @delo/update/versions
 */
import semver from 'semver'
import type { ExemptionRecord, VersionAxis } from '@delo/contract-plugin-versions'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import type { DeclaredRequirement } from './manifest.ts'

/** The version the installation runs on one axis, and the one the update would install. */
export interface AxisVersions {
  /** The running release's version on this axis. */
  readonly from: SemanticVersion
  /** The target release's version on this axis. */
  readonly to: SemanticVersion
}

/** What one axis decides for one installed plugin. */
export type AxisDecision =
  /** The target satisfies the declared range, so the axis changes nothing. */
  | { readonly kind: 'compatible' }
  /** The target does not satisfy the range and no exemption covers it: the plugin is disabled. */
  | { readonly kind: 'unmet', readonly requirement: string }
  /** The axis is declared in a form Delo cannot read: the plugin is disabled and the item is unverified. */
  | { readonly kind: 'unreadable' }
  /** The target does not satisfy the range, and the person's exemption covers the target version: the plugin is kept. */
  | { readonly kind: 'exempted', readonly requirement: string, readonly version: SemanticVersion }
  /** The plugin runs today under an exemption that does not cover the target: it is disabled. */
  | { readonly kind: 'not-carried', readonly requirement: string, readonly from: SemanticVersion, readonly to: SemanticVersion }
  /** Nothing is declared, so the plugin's compatibility with the target is not stated. */
  | { readonly kind: 'undeclared' }
  /** The axis is not declared, and C3 has no reason for it: nothing changes and nothing is shown. */
  | { readonly kind: 'none' }

/**
 * The key an exemption file maps to the versions it admits.
 * @param name - the plugin's package name.
 * @param version - the installed exact version.
 * @returns the key, such as `dsh-tools@1.4.0`.
 */
export function exemptionKey(name: string, version: SemanticVersion): string {
  return `${name}@${version}`
}

/**
 * Whether an exemption for this exact plugin version admits the given axis version.
 * @param exemptions - the axis's exemption file.
 * @param key - the plugin version's key, from {@link exemptionKey}.
 * @param version - the exact axis version to admit.
 * @returns true when the record names that version under the key.
 */
export function exempted(exemptions: ExemptionRecord, key: string, version: SemanticVersion): boolean {
  return (exemptions[key] ?? []).includes(version)
}

/**
 * Whether a version satisfies a declared range, as upstream reads one: an empty, `workspace:` or invalid range is
 * unmet, and prereleases take part.
 * @param version - the axis version to check.
 * @param range - the declared range.
 * @returns true when it is satisfied.
 */
export function satisfiesRange(version: SemanticVersion, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(version, range, { includePrerelease: true })
}

/**
 * Decide one axis of one installed plugin against the target.
 * @param axis - the axis this declaration belongs to.
 * @param declaration - the axis's declaration in the plugin's `package.json`.
 * @param versions - the running and target versions of this axis.
 * @param exemptions - the axis's exemption file, as the profile holds it now.
 * @param key - the plugin version's exemption key, from {@link exemptionKey}.
 * @returns the decision; `undeclared` only on the DSH axis, the one C3 has a reason for.
 */
export function evaluateRequirement(axis: VersionAxis, declaration: DeclaredRequirement, versions: AxisVersions, exemptions: ExemptionRecord, key: string): AxisDecision {
  if (declaration.kind === 'unreadable') return { kind: 'unreadable' }
  if (declaration.kind === 'none') return axis === 'dsh' ? { kind: 'undeclared' } : { kind: 'none' }
  const { range } = declaration
  if (satisfiesRange(versions.to, range)) return { kind: 'compatible' }
  if (exempted(exemptions, key, versions.to)) return { kind: 'exempted', requirement: range, version: versions.to }
  // The exemption that lets the plugin run today is the one that covers the version it runs on now.
  if (exempted(exemptions, key, versions.from)) return { kind: 'not-carried', requirement: range, from: versions.from, to: versions.to }
  return { kind: 'unmet', requirement: range }
}
