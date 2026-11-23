/**
 * The plugin lines of `delorun doctor` for the CLI profile, read from the profile's files without importing or running
 * any plugin code:
 *
 * - `plugins`: one summary line with the number of packages installed in the profile and its `dsh.profile.bundles`
 *   list in load order; a profile with none installed passes with a line that says so. A profile manifest that cannot
 *   be read is one `fail` line instead, and a profile that does not exist yet warns.
 * - `plugin <name>`, for each package in the profile's `dependencies` (the packages pnpm installed there): its
 *   name@version, where it comes from as the manifest records it, with the user information of a URL left out, and
 *   whether it is enabled. Enabled means its name is in `dsh.profile.bundles`; otherwise it is installed but not
 *   enabled, which is a library or a bundle that is switched off. An enabled package that declares no `dsh.bundle`
 *   fails, because upstream's profile loader skips it; a package whose `node_modules/<name>/package.json` is missing
 *   fails when enabled and warns otherwise; a manifest that is a link, larger than {@link PLUGIN_MANIFEST_LIMIT} or not
 *   a JSON object fails.
 * - `plugin <name>` for its version ranges: upstream's `evaluatePluginCompatibility`, with the profile's exemptions and
 *   the running DSH and Delorun versions, as the installer and the start's preflight run it. A range the running
 *   versions do not meet fails with the remedy; a DSH mismatch the profile exempts warns.
 * - `plugin <name>` for a dependency whose name resolves from the dsh installation (`installAnchor`): upstream
 *   resolves every bundle from the installation first, so the shipped package loads and the profile's install does
 *   not; it warns.
 * - `plugin <name>` for a name in `dsh.profile.bundles` that is neither a dependency nor resolvable from the
 *   installation or the profile: it fails, because upstream's loader skips it.
 *
 * Packages the installation ships stay silent unless something is wrong with them. A package ships with the
 * installation when upstream's bundle resolution finds it from the installation's `package.json`
 * (`resolveBundleDir` in `@deepseek-ai/dsh-app-boot`), and every package in Delorun's `@delorun/` scope counts as shipped,
 * because a source checkout links Delorun's bundles into the profile ([delorun-bundles](../delorun-bundles.ts)).
 *
 * @module @delorun/cli/doctor/plugins
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluatePluginCompatibility, PROFILE_COMPATIBILITY_FILENAME, readProfileCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { VersionOutput } from '@delorun/contract-plugin-versions'
import { messageOf } from '@delorun/install'
import { readSafeMode } from '@delorun/profile-safety'
import { isDelorunPackage } from '../delorun-bundles.ts'
import { PLUGIN_MANIFEST_LIMIT, readRegularFile } from '../plugin-check.ts'
import { resolvesFrom } from '@delorun/plugin-scaffold'
import { profileDirectory } from '../profile.ts'
import type { CheckResult, CheckStatus } from './checks.ts'

/** What the plugin lines read besides the profile's files. */
export interface PluginInputs {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /**
   * The dsh installation's `package.json`, from which upstream resolves the bundles the installation ships; read only
   * when the profile has a dependency or a bundle to place.
   * @returns the absolute path.
   */
  readonly installAnchor: () => string
  /**
   * The running Delorun and DSH versions; read only when the profile has a dependency to check.
   * @returns both versions.
   */
  readonly versions: () => VersionOutput
}

/** A dependency value pnpm resolves through a git host: a host shorthand, a git URL, or a hosted repository URL, as upstream's `install-spec.ts` reads them. */
const GIT_SPEC = /^(?:github|gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:|^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i
/** A tarball, on disk or over HTTP, as upstream's `install-spec.ts` reads it. */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
/**
 * The user information of a URL, which holds a password or access token when present. It covers upstream's
 * `HTTP_USER_INFO` (`packages/boot/plugin-manager/src/install-spec.ts`), which the package does not export, and every
 * other scheme with an authority.
 */
const URL_USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i
/** A recorded value with a protocol, such as `workspace:` or `portal:`. */
const PROTOCOL = /^[a-z][a-z0-9+.-]*:/i
/** The protocols that name a package registry. */
const REGISTRY_PROTOCOL = /^(?:npm|jsr):/i

/**
 * Whether a value is a plain JSON object.
 * @param value - the value.
 * @returns true for an object that is not an array.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The code a Node.js error carries, such as `ENOENT`.
 * @param error - the caught value.
 * @returns the code, or `undefined` when the value has none.
 */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * One plugin line.
 * @param subject - the package name.
 * @param status - its verdict.
 * @param message - one line.
 * @returns the result.
 */
function pluginLine(subject: string, status: CheckStatus, message: string): CheckResult {
  return { name: 'plugin', subject, status, message }
}

/**
 * One summary line.
 * @param status - its verdict.
 * @param message - one line.
 * @returns the result.
 */
function pluginsLine(status: CheckStatus, message: string): CheckResult {
  return { name: 'plugins', status, message }
}

/**
 * Where a profile dependency comes from, from the value its manifest records. A `file:` or `link:` path is resolved
 * against the profile with `~` for the home directory, as upstream's `dependencySpec` resolves it; a URL is shown
 * without its user information.
 * @param spec - the recorded value.
 * @param profileDir - the profile directory.
 * @returns a phrase that follows "from".
 */
export function pluginSource(spec: string, profileDir: string): string {
  const local = /^(file|link):(.*)$/s.exec(spec)
  if (local !== null) {
    const path = resolve(profileDir, local[2]!.replace(/^~(?=$|[\\/])/, () => homedir()))
    return TARBALL_SPEC.test(path) ? `the tarball ${path}` : `the folder ${path} (${local[1]!}:)`
  }
  const shown = spec.replace(URL_USER_INFO, '$1')
  if (/^https?:\/\//i.test(spec) && TARBALL_SPEC.test(spec)) return `the tarball ${shown}`
  if (GIT_SPEC.test(spec)) return `git ${shown}`
  if (REGISTRY_PROTOCOL.test(spec) || !PROTOCOL.test(spec)) return `the registry (${shown})`
  return `${shown}, as recorded`
}

/** A JSON manifest as read, or why it could not be read. */
type ManifestRead =
  /** The file holds a JSON object. */
  | { readonly kind: 'read', readonly manifest: Record<string, unknown> }
  /** The file does not exist. */
  | { readonly kind: 'missing' }
  /** The file exists and was refused; the message names it. */
  | { readonly kind: 'refused', readonly message: string }

/**
 * Read a package manifest safely: no symbolic link, nothing but a regular file, at most {@link PLUGIN_MANIFEST_LIMIT}
 * bytes, a JSON object.
 * @param path - the `package.json`.
 * @returns the manifest, or why not.
 */
async function readManifest(path: string): Promise<ManifestRead> {
  let text: string
  try {
    text = await readRegularFile(path, PLUGIN_MANIFEST_LIMIT)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', message: `${path} cannot be read: ${messageOf(error)}` }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { kind: 'refused', message: `${path} is not JSON: ${messageOf(error)}` }
  }
  return isObject(value) ? { kind: 'read', manifest: value } : { kind: 'refused', message: `${path} is not a package manifest object` }
}

/** The plugin fields of a profile manifest, or why they cannot be read. */
type ProfileFields =
  | { readonly kind: 'read', readonly dependencies: ReadonlyMap<string, string>, readonly bundles: readonly string[] }
  | { readonly kind: 'refused', readonly message: string }

/**
 * The profile's `dependencies` and `dsh.profile.bundles`.
 * @param manifest - the profile's manifest.
 * @param path - its path, for a refusal.
 * @returns the fields, or why they cannot be read.
 */
function profileFields(manifest: Record<string, unknown>, path: string): ProfileFields {
  const dependencies = manifest['dependencies'] ?? {}
  if (!isObject(dependencies) || !Object.values(dependencies).every(spec => typeof spec === 'string')) {
    return { kind: 'refused', message: `${path}: dependencies is not a map of package names to strings` }
  }
  const dsh = manifest['dsh']
  const profile = isObject(dsh) ? dsh['profile'] : undefined
  const bundles = isObject(profile) ? profile['bundles'] ?? [] : []
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    return { kind: 'refused', message: `${path}: dsh.profile.bundles is not a list of package names` }
  }
  return { kind: 'read', dependencies: new Map(Object.entries(dependencies).flatMap(([name, spec]) => typeof spec === 'string' ? [[name, spec] as const] : [])), bundles }
}

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @returns such as `1 package` or `3 packages`.
 */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The summary line.
 * @param profile - the CLI profile.
 * @param installed - how many packages, outside Delorun's scope, the profile's dependencies name.
 * @param bundles - the bundle list.
 * @returns the line.
 */
function summary(profile: string, installed: number, bundles: readonly string[]): CheckResult {
  const enabled = bundles.length === 0 ? 'it enables no bundle' : `it enables ${counted(bundles.length, 'bundle')}, loaded in this order: ${bundles.join(', ')}`
  return pluginsLine('pass', installed === 0
    ? `no plugin is installed in the profile ${profile}; ${enabled}.`
    : `the profile ${profile} has ${counted(installed, 'installed package')}; ${enabled}.`)
}

/**
 * The version line of one installed package, as the installer and the start's preflight decide it.
 * @param subject - the dependency name.
 * @param manifest - the installed manifest.
 * @param key - its name@version, for the message.
 * @param exemptions - the profile's exact-version exemptions.
 * @param running - the running versions.
 * @param profile - the CLI profile, for the remedy.
 * @returns the line, or `undefined` when every declared range is met.
 */
function versionLine(
  subject: string, manifest: Record<string, unknown>, key: string, exemptions: Readonly<Record<string, readonly string[]>>,
  running: VersionOutput, profile: string,
): CheckResult | undefined {
  let issue
  try {
    issue = evaluatePluginCompatibility(manifest, exemptions, running.dsh, running.delorun)
  } catch (error) {
    return pluginLine(subject, 'fail', `${key} declares its version ranges in a form the installer refuses (${messageOf(error)}); update or remove the plugin.`)
  }
  if (issue === undefined) return undefined
  const dshRanges = Object.entries(issue.requirements).map(([field, range]) => `${JSON.stringify(range)} (${field === 'engines.dsh' ? field : `peer ${field}`})`)
  const reasons: string[] = []
  if (dshRanges.length > 0) reasons.push(`${key} requires DSH ${dshRanges.join(', ')}, and this is DSH ${issue.runtimeVersion}`)
  // A plugin with engines.delorun is decided on that range alone (A567), so no DSH reason is given beside it.
  if (issue.delorun?.status === 'unmet') reasons.push(`${key} requires Delorun ${JSON.stringify(issue.delorun.requirement ?? '')} (engines.delorun), and this is Delorun ${issue.delorun.delorunVersion}; its DSH ranges are not checked on Delorun`)
  if (issue.delorun?.status === 'unreadable') reasons.push(`${key} declares engines.delorun in a form Delorun cannot read; its DSH ranges are not checked on Delorun`)
  if (issue.exempted) {
    return pluginLine(subject, 'warn', `${reasons.join('; ')}; it loads under the exact-version exemption in ${PROFILE_COMPATIBILITY_FILENAME}, which accepts the risk of crashes or data loss.`)
  }
  // The exemption covers the DSH range alone, so it is a remedy only when the Delorun range is met.
  const exemptable = dshRanges.length > 0 && (issue.delorun === undefined || issue.delorun.status === 'met')
  const remedy = exemptable
    ? `update or remove the plugin, or accept the risk with: delorun plugin --profile ${profile} allow-version ${key} --dsh-version ${issue.runtimeVersion} --accept-risk`
    : 'update or remove the plugin.'
  return pluginLine(subject, 'fail', `${reasons.join('; ')}, so the installer and the start's version check refuse it; ${remedy}`)
}

/**
 * The lines of one profile dependency.
 * @param name - the dependency name.
 * @param spec - its recorded value.
 * @param context - the profile, its bundle list, its exemptions, and readers of the installation's anchor and the
 *   running versions.
 * @returns its lines: none for a Delorun package with nothing wrong.
 */
async function dependencyLines(name: string, spec: string, context: {
  readonly profile: string
  readonly profileDir: string
  readonly bundles: readonly string[]
  readonly exemptions: Readonly<Record<string, readonly string[]>>
  readonly anchor: () => string
  readonly running: () => VersionOutput
}): Promise<CheckResult[]> {
  const source = pluginSource(spec, context.profileDir)
  const delorun = isDelorunPackage(name)
  if (!delorun && resolvesFrom(context.anchor(), name)) {
    return [pluginLine(name, 'warn', `${name} is also a package this Delorun ships, so a start loads the shipped one and not this install from ${source}; a fork of a shipped package needs a new package name.`)]
  }
  const enabled = context.bundles.includes(name)
  const path = join(context.profileDir, 'node_modules', name, 'package.json')
  const read = await readManifest(path)
  switch (read.kind) {
    case 'missing':
      return [pluginLine(name, enabled ? 'fail' : 'warn', `${name} from ${source} is not installed: ${path} does not exist; run delorun plugin --profile ${context.profile} install.`)]
    case 'refused':
      return [pluginLine(name, 'fail', read.message)]
    case 'read':
      break
  }
  const { manifest } = read
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '(no version)'
  const key = `${typeof manifest['name'] === 'string' ? manifest['name'] : name}@${version}`
  const dsh = manifest['dsh']
  const declaresBundle = isObject(dsh) && dsh['bundle'] !== undefined
  const lines: CheckResult[] = []
  const installed = `${name}@${version} from ${source}`
  if (enabled && !declaresBundle) {
    lines.push(pluginLine(name, 'fail', `${installed} is enabled in dsh.profile.bundles but declares no dsh.bundle, so a start skips it; install a version that declares one, or take it off the bundle list.`))
  } else if (!delorun) {
    lines.push(pluginLine(name, 'pass', enabled
      ? `${installed}: enabled, and it declares dsh.bundle.`
      : `${installed}: installed but not enabled; ${declaresBundle ? 'it declares dsh.bundle, so it is a bundle that is switched off' : 'it declares no dsh.bundle, so it is a library other plugins import'}.`))
  }
  const versions = versionLine(name, manifest, key, context.exemptions, context.running(), context.profile)
  if (versions !== undefined) lines.push(versions)
  return lines
}

/**
 * The plugin lines of the CLI profile: the summary, then each dependency's lines in manifest order, then each enabled
 * bundle that resolves from nowhere, then each problem of the profile's exemption file.
 * @param inputs - the home, the profile, the installation's anchor and the running versions.
 * @returns the lines.
 * @throws {Error} when the installation's anchor or the running versions cannot be read.
 */
export async function checkPlugins(inputs: PluginInputs): Promise<CheckResult[]> {
  const { home, profile } = inputs
  const profileDir = profileDirectory(home, profile)
  const manifestPath = join(profileDir, 'package.json')
  const read = await readManifest(manifestPath)
  switch (read.kind) {
    case 'missing':
      return [pluginsLine('warn', `the CLI profile ${profile} is not set up in ${home}, so it has no plugin; delorun setup creates it.`)]
    case 'refused':
      return [pluginsLine('fail', `${read.message}; the profile's plugins are not checked.`)]
    case 'read':
      break
  }
  const fields = profileFields(read.manifest, manifestPath)
  if (fields.kind === 'refused') return [pluginsLine('fail', `${fields.message}; the profile's plugins are not checked.`)]
  const { dependencies, bundles } = fields
  const compatibility = readProfileCompatibility(profileDir)
  let anchor: string | undefined
  let running: VersionOutput | undefined
  const context = {
    profile,
    profileDir,
    bundles,
    exemptions: compatibility.exemptions,
    anchor: () => (anchor ??= inputs.installAnchor()),
    running: () => (running ??= inputs.versions()),
  }
  const lines = [summary(profile, [...dependencies.keys()].filter(name => !isDelorunPackage(name)).length, bundles)]
  for (const [name, spec] of dependencies) lines.push(...await dependencyLines(name, spec, context))
  for (const bundle of new Set(bundles)) {
    if (dependencies.has(bundle) || resolvesFrom(context.anchor(), bundle) || resolvesFrom(manifestPath, bundle)) continue
    lines.push(pluginLine(bundle, 'fail', `the profile enables ${bundle} in dsh.profile.bundles, but it is neither installed in the profile nor shipped with this Delorun, so a start skips it; install it with delorun plugin --profile ${profile} add, or take it off the bundle list.`))
  }
  for (const warning of compatibility.warnings) lines.push(pluginsLine('warn', warning))
  return lines
}

/**
 * The safe-mode line: a warning while `delorun recover safe-mode`'s marker is set for the profile.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the line, or `undefined` when the profile is not in safe mode.
 * @throws {ProfileSafetyError} `SAFE_MODE_UNREADABLE` when the marker exists but is not one Delorun wrote.
 */
export function checkSafeMode(home: string, profile: string): CheckResult | undefined {
  const marker = readSafeMode(home, profile)
  if (marker === undefined) return undefined
  return pluginsLine('warn', `the profile ${profile} is in safe mode since ${marker.since} (${marker.reason}): third-party plugins are left out until delorun recover exit-safe-mode.`)
}
