/**
 * The two version axes of one installed plugin, predicted against the release the update would install (contract C17,
 * `delorun/docs/contracts/c17-plugin-versions.md#exemptions`): whether the target meets the declared range, whether the
 * person's exact-version exemption covers the target, and whether the plugin only runs today because an exemption
 * covers the version it runs on now.
 *
 * Whether a requirement is met, and which declaration decides (`engines.delorun` alone when declared, A567), is upstream's
 * decision (`plugin-compatibility.ts`), made by the same function the plugin installer and the start's preflight call, with the
 * target's versions in place of the running ones. An exemption is the profile's file for the axis
 * mapping an exact `package@version` key to exact versions of that axis, so it admits one version and not a range.
 *
 * @module @delorun/update/versions
 */
import semver from 'semver'
import type { ExemptionRecord, VersionAxis } from '@delorun/contract-plugin-versions'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { evaluatePluginCompatibility, type PluginCompatibility } from '@deepseek-ai/dsh-app-boot'

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
  /** The axis is declared in a form Delorun cannot read: the plugin is disabled and the item is unverified. */
  | { readonly kind: 'unreadable' }
  /** The target does not satisfy the range, and the person's exemption covers the target version: the plugin is kept. */
  | { readonly kind: 'exempted', readonly requirement: string, readonly version: SemanticVersion }
  /** The plugin runs today under an exemption that does not cover the target: it is disabled. */
  | { readonly kind: 'not-carried', readonly requirement: string, readonly from: SemanticVersion, readonly to: SemanticVersion }
  /** Neither `engines.dsh` nor a DSH peer is declared, so the plugin's compatibility with the target is not stated. */
  | { readonly kind: 'undeclared' }
  /** The axis is not declared, and C3 has no reason for it: nothing changes and nothing is shown. */
  | { readonly kind: 'none' }
  /** The DSH axis of a plugin that declares `engines.delorun`: that range decides alone on Delorun, so the DSH ranges are not read. */
  | { readonly kind: 'not-checked' }

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

/** Which declaration decided a plugin's version: `engines.delorun`, `engines.dsh`, the DSH peers, or nothing declared. */
export type DecidedBy = 'delorun' | 'dsh' | 'peer' | 'none'

/**
 * What one plugin's declarations decide on one Delorun and one DSH version (contract C17,
 * `delorun/docs/contracts/c17-plugin-versions.md`), in fields that stay stable for tools to read.
 */
export interface PluginVersionDecision {
  /** The declaration that decided: `engines.delorun` when present, else `engines.dsh`, else the DSH peers, else `none`. */
  readonly decidedBy: DecidedBy
  /** The range that decided: `engines.delorun`'s or `engines.dsh`'s as written; for `peer`, each DSH peer as `name range`, joined by `, `; `null` for `none`, or when `engines.delorun` is not a string. */
  readonly range: string | null
  /** The version the range was checked against: Delorun's for `delorun`, DSH's for `dsh` and `peer`; `null` for `none`. */
  readonly checkedAgainst: string | null
  /** `admitted` when the installer would admit the plugin on these versions, `refused` when it would not. */
  readonly verdict: 'admitted' | 'refused'
  /** `false` when a declaration is in a form Delorun cannot read, which is refused; the range is then not a verdict on its own. */
  readonly readable: boolean
}

/** The decision with the text of each unmet requirement, which the update report names. */
interface DetailedDecision {
  readonly decision: PluginVersionDecision
  /** The unmet DSH requirements, as upstream reports them; empty for a plugin decided on `engines.delorun`. */
  readonly unmet: Readonly<Record<string, string>>
}

/**
 * Own `engines` of a manifest, when it is an object.
 * @param manifest - the plugin's parsed `package.json`.
 * @returns the object, `{}` when there is none, or undefined when `engines` is declared but is not an object.
 */
function enginesOf(manifest: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  if (!Object.hasOwn(manifest, 'engines')) return {}
  const engines = manifest['engines']
  return typeof engines === 'object' && engines !== null && !Array.isArray(engines) ? engines as Readonly<Record<string, unknown>> : undefined
}

/**
 * Each DSH peer a manifest declares, as `name range`.
 * @param manifest - the plugin's parsed `package.json`.
 * @returns the declarations in the manifest's order; empty when there are none or `peerDependencies` is not an object.
 */
function dshPeers(manifest: Readonly<Record<string, unknown>>): readonly string[] {
  const peers = Object.hasOwn(manifest, 'peerDependencies') ? manifest['peerDependencies'] : undefined
  if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) return []
  return Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')).map(([name, range]) => `${name} ${String(range)}`)
}

/**
 * Decide one manifest with the evaluation the installer and the start's preflight run, and say which declaration decided.
 * @param manifest - the plugin's parsed `package.json`.
 * @param delorun - the Delorun version to check against.
 * @param dsh - the DSH version to check against.
 * @returns the decision and the unmet DSH requirements.
 * @throws {RangeError} when either version is not a semantic version.
 */
function decideDetailed(manifest: Readonly<Record<string, unknown>>, delorun: string, dsh: string): DetailedDecision {
  for (const version of [delorun, dsh]) if (semver.valid(version) === null) throw new RangeError(`Invalid version ${JSON.stringify(version)}; expected a semantic version such as 1.0.0`)
  const engines = enginesOf(manifest)
  // The identity upstream asks for on a mismatch is not part of the verdict, and nothing here is exempted.
  const subject = { ...manifest, name: 'plugin', version: '0.0.0' }
  let issue: PluginCompatibility | undefined
  let readable = true
  try {
    issue = evaluatePluginCompatibility(subject, {}, dsh, delorun)
  } catch (_refused) {
    // Upstream refuses requirement metadata it cannot validate, and so does this.
    readable = false
  }
  const verdict = readable && issue === undefined ? 'admitted' : 'refused'
  if (engines === undefined) return { decision: { decidedBy: 'none', range: null, checkedAgainst: null, verdict, readable }, unmet: {} }
  if (Object.hasOwn(engines, 'delorun')) {
    const range = engines['delorun']
    // Upstream reads a non-string `engines.delorun` as unreadable without throwing, and refuses it.
    const text = typeof range === 'string' ? range : null
    return { decision: { decidedBy: 'delorun', range: text, checkedAgainst: delorun, verdict, readable: readable && text !== null }, unmet: {} }
  }
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines['dsh']
    return { decision: { decidedBy: 'dsh', range: typeof range === 'string' ? range : null, checkedAgainst: dsh, verdict, readable }, unmet: issue?.requirements ?? {} }
  }
  const peers = dshPeers(manifest)
  if (peers.length === 0) return { decision: { decidedBy: 'none', range: null, checkedAgainst: null, verdict, readable }, unmet: {} }
  return { decision: { decidedBy: 'peer', range: peers.join(', '), checkedAgainst: dsh, verdict, readable }, unmet: issue?.requirements ?? {} }
}

/**
 * Decide what one plugin's declarations say about one Delorun version and one DSH version (A567): `engines.delorun` decides
 * alone when it is declared and its DSH ranges are not read; otherwise `engines.dsh` decides alone, and without it every DSH
 * peer must admit the DSH version. It is upstream's own evaluation, `evaluatePluginCompatibility`, which the installer, the
 * start's preflight and the plugin market run, so the answer is the installer's. It is pure: prereleases take part in
 * ranges, no exemption is applied, nothing reads a file or the environment, and the plugin's name and version play no part.
 * @param manifest - the plugin's parsed `package.json`; inherited fields are ignored.
 * @param delorun - the Delorun version to check `engines.delorun` against.
 * @param dsh - the DSH version to check `engines.dsh` and the DSH peers against.
 * @returns which declaration decided, its range, the version checked, and whether the plugin is admitted. A declaration in a
 *   form Delorun cannot read (an `engines` that is not an object, a non-string `engines.dsh`, `engines.delorun` or peer
 *   range, a `peerDependencies` that is not an object) is refused with `readable` false, except a DSH declaration beside
 *   `engines.delorun`, which is never read.
 * @throws {RangeError} when `delorun` or `dsh` is not a semantic version.
 */
export function decidePluginVersion(manifest: Readonly<Record<string, unknown>>, delorun: string, dsh: string): PluginVersionDecision {
  return decideDetailed(manifest, delorun, dsh).decision
}

/**
 * Decide both axes of one installed plugin against the target with {@link decidePluginVersion}, which is upstream's own
 * evaluation, so the report never keeps a plugin the next start disables. A plugin that declares `engines.delorun` is
 * decided on the Delorun axis alone (A567): its DSH axis is `not-checked`. Exemptions are decided here per axis, against
 * the target and the running version; one on the DSH axis has no effect for such a plugin.
 * @param manifest - the plugin's parsed `package.json`.
 * @param versions - both axes' running and target versions.
 * @param exemptions - both exemption files, as the profile holds them now.
 * @param key - the plugin version's exemption key, from {@link exemptionKey}.
 * @returns each axis's decision; a declaration upstream refuses to read is `unreadable`, and a DSH axis that states
 *   nothing is `undeclared`.
 */
export function evaluatePluginAxes(manifest: Readonly<Record<string, unknown>>, versions: Readonly<Record<VersionAxis, AxisVersions>>, exemptions: Readonly<Record<VersionAxis, ExemptionRecord>>, key: string): Readonly<Record<VersionAxis, AxisDecision>> {
  const { decision, unmet } = decideDetailed(manifest, versions.delorun.to, versions.dsh.to)
  if (decision.decidedBy === 'delorun') {
    if (!decision.readable || decision.range === null) return { dsh: { kind: 'not-checked' }, delorun: { kind: 'unreadable' } }
    return { dsh: { kind: 'not-checked' }, delorun: decision.verdict === 'admitted' ? { kind: 'compatible' } : mismatch(decision.range, versions.delorun, exemptions.delorun, key) }
  }
  if (!decision.readable) return { dsh: { kind: 'unreadable' }, delorun: enginesOf(manifest) === undefined ? { kind: 'unreadable' } : { kind: 'none' } }
  if (decision.verdict === 'refused') return { dsh: mismatch(requirementText(unmet), versions.dsh, exemptions.dsh, key), delorun: { kind: 'none' } }
  return { dsh: decision.decidedBy === 'none' ? { kind: 'undeclared' } : { kind: 'compatible' }, delorun: { kind: 'none' } }
}
