/**
 * Evaluate plugin version requirements without importing plugin code: `engines.delorun` alone when the plugin declares it and
 * Delorun's version is known, otherwise `engines.dsh`, else the dsh peers.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/** Unmet dsh requirements and the exact plugin/runtime exemption decision. */
export interface PluginCompatibility {
  name: string
  version: string
  runtimeVersion: string
  /**
   * Only requirements the running dsh version does not satisfy: `engines.dsh`, or dsh peer package names. Empty for a plugin
   * decided on `engines.delorun` (see `delorun`), whose dsh ranges are not read.
   */
  requirements: Record<string, string>
  exempted: boolean
  /**
   * The plugin's `engines.delorun` requirement, present only when Delorun's version is known and the plugin declares one;
   * it then decides alone.
   */
  delorun?: DelorunRequirement
}

/**
 * Delorun's version, which its own processes export before any module runs
 * (`delorun/apps/cli/src/version.ts`, contract C17). Unset when stock DSH runs, where the
 * `engines.delorun` axis is not checked.
 */
export const DELORUN_VERSION_ENV = 'DELORUN_VERSION'

/** One plugin's `engines.delorun` requirement, checked against Delorun's version. */
export interface DelorunRequirement {
  /** The Delorun version the requirement was checked against. */
  delorunVersion: string
  /** `met` or `unmet` for a range, `unreadable` for a declaration that is not a string, which is refused as unmet. */
  status: 'met' | 'unmet' | 'unreadable'
  /** The declared range, for `met` and `unmet`. */
  requirement?: string
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function runtimeVersionOf(value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`)
  }
  return value
}

function identityField(manifest: Record<string, unknown>, field: 'name' | 'version'): string {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh requirements are unmet`)
  }
  return value
}

/**
 * Read this app-boot package's version in both source and bundled installations.
 * @returns the validated runtime semantic version, preserving its exact spelling.
 * @throws if package.json cannot be read or its version is missing or invalid.
 */
export function getDshRuntimeVersion(): string {
  // The executable's virtual filesystem intercepts string paths, not URL arguments.
  const filename = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = objectOf(JSON.parse(fs.readFileSync(filename, 'utf8')), 'app-boot package.json')
  return runtimeVersionOf(Object.hasOwn(manifest, 'version') ? manifest.version : undefined)
}

/**
 * Read the Delorun version this process was given, from {@link DELORUN_VERSION_ENV}.
 * @param env - the environment to read; this process's by default.
 * @returns the validated Delorun version, or undefined when the variable is unset or blank (the `engines.delorun` axis is then not
 * checked).
 * @throws Error when the variable is set to something that is not a semantic version.
 */
export function getDelorunRuntimeVersion(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const value = env[DELORUN_VERSION_ENV]
  if (value === undefined || value.trim() === '') return undefined
  if (semver.valid(value) === null) {
    throw new Error(`Invalid Delorun version: ${JSON.stringify(value)}; expected a semantic version such as 1.0.0`)
  }
  return value
}

function satisfies(runtimeVersion: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}

/**
 * Check a plugin's `engines.delorun` range against Delorun's version, without importing plugin code.
 * An absent declaration has no Delorun requirement; a non-string one is unreadable and is refused as unmet;
 * an empty, `workspace:` or invalid range is unmet. Prereleases participate in ranges.
 * @param manifest - parsed plugin package.json; inherited fields are ignored.
 * @param delorunVersion - the Delorun version to check against, read from {@link DELORUN_VERSION_ENV} by default.
 * @returns the requirement's result, or undefined when Delorun's version is unknown or the plugin declares none.
 * @throws Error for a manifest that is not an object or a Delorun version that is not a semantic version.
 */
export function evaluateDelorunRequirement(
  manifest: object,
  delorunVersion: string | undefined = getDelorunRuntimeVersion(),
): DelorunRequirement | undefined {
  if (delorunVersion === undefined) return undefined
  if (semver.valid(delorunVersion) === null) {
    throw new Error(`Invalid Delorun version: ${JSON.stringify(delorunVersion)}; expected a semantic version such as 1.0.0`)
  }
  const fields = objectOf(manifest, 'Plugin manifest')
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (!Object.hasOwn(engines, 'delorun')) return undefined
  const range = engines.delorun
  if (typeof range !== 'string') return { delorunVersion, status: 'unreadable' }
  return { delorunVersion, status: satisfies(delorunVersion, range) ? 'met' : 'unmet', requirement: range }
}

function unmetRequirements(fields: Record<string, unknown>, runtimeVersion: string): Record<string, string> {
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {}
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')
  const unmet: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (!satisfies(runtimeVersion, requirement)) unmet[name] = range
  }
  return unmet
}

/**
 * Check the plugin's dsh requirements against the runtime. An own `engines.dsh` range decides alone and
 * peerDependencies are ignored; otherwise every @deepseek-ai/dsh or @deepseek-ai/dsh-* peer must match.
 * Prereleases participate in ranges. For peers only, workspace:^, workspace:~, and workspace:* refer to
 * the current runtime; other empty or invalid ranges, including any workspace: `engines.dsh`, are unmet.
 * A plugin that declares `engines.delorun` is checked on that range alone, when the process knows Delorun's
 * version ({@link DELORUN_VERSION_ENV}): its `engines.dsh` and dsh peers are not read, so a malformed one is not an
 * error either. An unmet or unreadable Delorun requirement is a mismatch of its own, and the dsh exact-version
 * exemption does not admit it. A plugin without `engines.delorun`, or any plugin when Delorun's version is unknown
 * (stock DSH), is decided on the dsh requirements as above.
 * @param manifest - parsed plugin package.json; inherited fields are ignored.
 * @param exemptions - exact plugin name@version keys mapped to exact runtime versions.
 * @param runtimeVersion - running dsh version, defaulting to this app-boot package.
 * @param delorunVersion - running Delorun version, read from {@link DELORUN_VERSION_ENV} by default; undefined skips the Delorun axis.
 * @returns unmet requirements and exemption status, or undefined when every requirement is met.
 * @throws for malformed manifest engines or peer fields, invalid runtime or Delorun versions, or missing identity on a mismatch.
 */
export function evaluatePluginCompatibility(
  manifest: object,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
  runtimeVersion = getDshRuntimeVersion(),
  delorunVersion: string | undefined = getDelorunRuntimeVersion(),
): PluginCompatibility | undefined {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  const delorun = evaluateDelorunRequirement(fields, delorunVersion)
  // A plugin that declares `engines.delorun` is decided on that range alone: its dsh ranges are not read on Delorun.
  const requirements = delorun === undefined ? unmetRequirements(fields, runtimeVersion) : {}
  const delorunMismatch = delorun !== undefined && delorun.status !== 'met'
  if (Object.keys(requirements).length === 0 && !delorunMismatch) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  // The exemption covers the dsh axis alone, so a Delorun mismatch keeps the plugin refused.
  const exempted = !delorunMismatch && exemptedVersions?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, requirements, exempted, ...(delorun === undefined ? {} : { delorun }) }
}

/**
 * Describe unmet requirements, their risk, and the exact-version remedy.
 * Surfaces with their own grant mechanism or locale render the structured result themselves.
 * @param issue - incompatible plugin/runtime result, including exempted mismatches.
 * @returns an English diagnostic for logs and stderr, naming both the Delorun and the dsh version when Delorun's axis is checked.
 */
export function pluginCompatibilityWarning(issue: PluginCompatibility): string {
  const key = `${issue.name}@${issue.version}`
  const unmet = Object.keys(issue.requirements).length > 0
  const delorun = issue.delorun !== undefined && issue.delorun.status !== 'met' ? issue.delorun : undefined
  const mismatch = delorun === undefined ? ''
    : delorun.status === 'unreadable'
      ? `${key} declares engines.delorun in a form Delorun cannot read; this is Delorun ${delorun.delorunVersion} on DSH ${issue.runtimeVersion}. `
      : `${key} requires Delorun ${delorun.requirement ?? ''}; this is Delorun ${delorun.delorunVersion} on DSH ${issue.runtimeVersion}. `
  const dshMismatch = unmet
    ? `Plugin ${key} is incompatible with dsh ${issue.runtimeVersion}: requirements ${JSON.stringify(issue.requirements)}. `
    : ''
  const dshRemedy = unmet
    ? 'Update the plugin or install a plugin version compatible with this dsh runtime. '
      + `To accept this risk explicitly, grant the exact-version exemption for ${key} on dsh ${issue.runtimeVersion} with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. `
    : ''
  const delorunRemedy = delorun === undefined ? ''
    : 'Update the plugin or install one whose Delorun requirement this Delorun satisfies. '
      + `To accept this risk explicitly, grant the exact-version exemption for ${key} on Delorun ${delorun.delorunVersion} with \`delorun plugin allow-version ${key} --delorun-version ${delorun.delorunVersion} --accept-risk\`, then retry the installation or restart Delorun. `
  // A dsh-only mismatch keeps upstream's sentence order byte for byte; the Delorun sentences follow its risk sentence.
  const detail = unmet ? `${dshMismatch}Running it may cause crashes or data loss. ${mismatch}${dshRemedy}` : `${mismatch}Running it may cause crashes or data loss. `
  return `${detail}${delorunRemedy}Exact-version exemption: ${issue.exempted ? 'active' : 'not active'}.`
}
