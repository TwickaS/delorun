/**
 * The two version axes of one installed plugin, predicted against the release the update would install (contract C17,
 * `delo/docs/contracts/c17-plugin-versions.md#exemptions`): whether the target meets the declared range, whether the
 * person's exact-version exemption covers the target, and whether the plugin only runs today because an exemption
 * covers the version it runs on now.
 *
 * Whether a requirement is met is upstream's decision (`plugin-compatibility.ts`), made by the same functions the
 * plugin installer and the start's preflight call, with the target's versions in place of the running ones. An exemption is the profile's file for the axis
 * mapping an exact `package@version` key to exact versions of that axis, so it admits one version and not a range.
 *
 * @module @delo/update/versions
 */
import semver from 'semver'
import type { ExemptionRecord, VersionAxis } from '@delo/contract-plugin-versions'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { evaluateDeloRequirement, evaluatePluginCompatibility, type DeloRequirement, type PluginCompatibility } from '@deepseek-ai/dsh-app-boot'

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
  /** Neither `engines.dsh` nor a DSH peer is declared, so the plugin's compatibility with the target is not stated. */
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
 * Whether a manifest states a DSH requirement at all: `engines.dsh`, or a `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
 * peer dependency. Only whether one is stated is read here; whether it is met is upstream's decision.
 * @param manifest - the plugin's parsed `package.json`.
 * @returns true when either is present.
 */
function statesDsh(manifest: Readonly<Record<string, unknown>>): boolean {
  const engines = manifest['engines']
  if (typeof engines === 'object' && engines !== null && Object.hasOwn(engines, 'dsh')) return true
  const peers = manifest['peerDependencies']
  return typeof peers === 'object' && peers !== null && Object.keys(peers).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
}

/**
 * The text of the DSH requirements upstream reports unmet: `engines.dsh`'s range, or each unmet peer with its range.
 * @param requirements - upstream's `requirements`: `engines.dsh` or peer names, mapped to the declared ranges.
 * @returns the requirement as the report names it, such as `^0.2.0` or `^0.2.0 (peer @deepseek-ai/dsh-agent)`.
 */
export function requirementText(requirements: Readonly<Record<string, string>>): string {
  return Object.entries(requirements).map(([field, range]) => field === 'engines.dsh' ? range : `${range} (peer ${field})`).join(', ')
}

/**
 * The decision for an axis whose requirement the target does not meet: kept by an exemption for the target, not
 * carried when only an exemption for the running version lets the plugin run today, unmet otherwise.
 * @param requirement - the unmet requirement's text.
 * @param versions - the axis's running and target versions.
 * @param exemptions - the axis's exemption file.
 * @param key - the plugin version's exemption key.
 * @returns the decision.
 */
function mismatch(requirement: string, versions: AxisVersions, exemptions: ExemptionRecord, key: string): AxisDecision {
  if (exempted(exemptions, key, versions.to)) return { kind: 'exempted', requirement, version: versions.to }
  // The exemption that lets the plugin run today is the one that covers the version it runs on now.
  if (exempted(exemptions, key, versions.from)) return { kind: 'not-carried', requirement, from: versions.from, to: versions.to }
  return { kind: 'unmet', requirement }
}

/**
 * Decide both axes of one installed plugin against the target with upstream's own evaluation, the one the plugin
 * installer and the start's preflight run (`evaluatePluginCompatibility` for the DSH axis, its `engines.dsh` and its
 * peer rule, and `evaluateDeloRequirement` for the Delo axis), so the report never keeps a plugin the next start
 * disables. Exemptions are decided here per axis, against the target and the running version.
 * @param manifest - the plugin's parsed `package.json`.
 * @param versions - both axes' running and target versions.
 * @param exemptions - both exemption files, as the profile holds them now.
 * @param key - the plugin version's exemption key, from {@link exemptionKey}.
 * @returns each axis's decision; a declaration upstream refuses to read is `unreadable`, and a DSH axis that states
 *   nothing is `undeclared`.
 */
export function evaluatePluginAxes(manifest: Readonly<Record<string, unknown>>, versions: Readonly<Record<VersionAxis, AxisVersions>>, exemptions: Readonly<Record<VersionAxis, ExemptionRecord>>, key: string): Readonly<Record<VersionAxis, AxisDecision>> {
  return { dsh: dshDecision(manifest, versions.dsh, exemptions.dsh, key), delo: deloDecision(manifest, versions.delo, exemptions.delo, key) }
}

/**
 * The DSH axis, by upstream's `evaluatePluginCompatibility` with no exemption and no Delo version.
 * @param manifest - the plugin's parsed `package.json`.
 * @param versions - the DSH axis's versions.
 * @param exemptions - the DSH exemption file.
 * @param key - the exemption key.
 * @returns the decision.
 */
function dshDecision(manifest: Readonly<Record<string, unknown>>, versions: AxisVersions, exemptions: ExemptionRecord, key: string): AxisDecision {
  let issue: PluginCompatibility | undefined
  try {
    issue = evaluatePluginCompatibility(manifest, {}, versions.to, undefined)
  } catch (_refused) {
    // Upstream refuses requirement metadata it cannot validate, and so does the report: the axis is unreadable.
    return { kind: 'unreadable' }
  }
  if (issue === undefined) return statesDsh(manifest) ? { kind: 'compatible' } : { kind: 'undeclared' }
  return mismatch(requirementText(issue.requirements), versions, exemptions, key)
}

/**
 * The Delo axis, by upstream's `evaluateDeloRequirement`.
 * @param manifest - the plugin's parsed `package.json`.
 * @param versions - the Delo axis's versions.
 * @param exemptions - the Delo exemption file.
 * @param key - the exemption key.
 * @returns the decision.
 */
function deloDecision(manifest: Readonly<Record<string, unknown>>, versions: AxisVersions, exemptions: ExemptionRecord, key: string): AxisDecision {
  let result: DeloRequirement | undefined
  try {
    result = evaluateDeloRequirement(manifest, versions.to)
  } catch (_refused) {
    // An `engines` that is not an object: upstream refuses it, so the axis is unreadable.
    return { kind: 'unreadable' }
  }
  if (result === undefined) return { kind: 'none' }
  if (result.status === 'unreadable') return { kind: 'unreadable' }
  if (result.status === 'met') return { kind: 'compatible' }
  // Upstream names the range of every unmet Delo requirement.
  return mismatch(String(result.requirement), versions, exemptions, key)
}
