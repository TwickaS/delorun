/**
 * The profile sections of a trust bill ([bill](./bill.ts)), read from files without loading a plugin:
 *
 * - plugins: each dependency the profile's `package.json` declares, with its source kind classified from the spec and
 *   its installed version from the installed package's `package.json`. Both files are read as regular files of at most
 *   {@link PLUGIN_MANIFEST_LIMIT} bytes, without following a link at the file itself. Integrity and commit are `null`,
 *   every match is `unknown` and no advisory is listed, because only the install check knows them.
 * - patches: the rows the person's own patch layers insert, the profile's `cordis.patch.yml` and the home's
 *   `cordis.patch.yml` that applies over every profile, read with upstream's loader ({@link loadOptionalPatches}), which
 *   keeps each `!!js` value as an unevaluated `{ __jsExpr }` object, and the count of those values.
 * - skills: the roots the filesystem skill provider reads with no workspace, as it names them: `custom` roots from the
 *   `skill-filesystem` row's config in the person's layers, `user-dsh` under the Delorun home, `user-agents` under
 *   `$DSH_AGENTS_HOME` or `~/.agents`, and `bundled` from `$DSH_BUNDLED_SKILL_DIR`.
 * - MCP servers: each `@deepseek-ai/dsh-mcp-client` row the person's layers insert, with the config the last of those
 *   layers gives it.
 *
 * Every reader turns its own failure into an `unknown` section with the reason.
 *
 * @module @delorun/cli/verify/bill-profile
 */
import { join, resolve } from 'node:path'
import { loadOptionalPatches, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { resolveAgentsHome } from '@deepseek-ai/dsh-home-paths'
import type { TrustMcp, TrustPatches, TrustPlugin, TrustPluginSource, TrustPlugins, TrustSkills } from '@delorun/bundle-local/trust-bill'
import semver from 'semver'
import { homePatchFile, isRecord, rowPatches } from '../patch-layers.ts'
import { PLUGIN_MANIFEST_LIMIT, readRegularFile } from '../plugin-check.ts'
import { profileDirectory } from '../profile.ts'
import { reasonOf } from './bill-release.ts'

/** The reason a plugins section is `unknown` while no install check is wired in. */
export const NO_INSTALL_CHECK = 'the plugin install check is not available in this release'

/** The upstream package that connects one MCP server. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** The row id of upstream's filesystem skill provider in the shipped bundles. */
export const SKILL_FILESYSTEM_ROW = 'skill-filesystem'

/** An npm package name, which keeps a dependency's name from leaving the profile's `node_modules`. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u

/** A tarball file name. */
const TARBALL = /\.(?:tgz|tar\.gz)$/u

/**
 * Where a dependency's code comes from, by its spec in the profile's `package.json`.
 * @param spec - the spec, such as `^1.2.0`, `github:owner/repo`, `link:../plugin` or `file:plugin-1.0.0.tgz`.
 * @returns the source kind; `unknown` for a spec of no kind named here, such as `workspace:*`.
 */
export function pluginSourceOf(spec: string): TrustPluginSource {
  const value = spec.trim()
  if (value.startsWith('link:')) return 'link'
  if (value.startsWith('file:')) return TARBALL.test(value) ? 'tarball' : 'file'
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/u.test(value)) return 'git'
  if (/^https?:\/\//u.test(value)) return TARBALL.test(value) ? 'tarball' : value.endsWith('.git') ? 'git' : 'unknown'
  if (/^(?:\.{1,2}\/|\/|~\/)/u.test(value)) return TARBALL.test(value) ? 'tarball' : 'file'
  if (value.startsWith('npm:')) return 'registry'
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/u.test(value)) return 'git'
  if (value === '' || value === 'latest' || semver.validRange(value) !== null) return 'registry'
  if (/^[a-z][\w.-]*$/iu.test(value)) return 'registry'
  return 'unknown'
}

/**
 * Read a JSON object from a regular file of at most {@link PLUGIN_MANIFEST_LIMIT} bytes.
 * @param path - the file.
 * @returns the object.
 * @throws {Error} when the file is a link, not a regular file, too large, not JSON or not an object.
 */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readRegularFile(path, PLUGIN_MANIFEST_LIMIT))
  if (!isRecord(value)) throw new Error(`${path} does not hold a JSON object`)
  return value
}

/**
 * The installed version of one dependency.
 * @param profileDir - the profile's directory.
 * @param name - the dependency's name.
 * @returns the version, or `null` when the name is not a package name or its `package.json` does not read.
 */
async function installedVersion(profileDir: string, name: string): Promise<string | null> {
  if (!PACKAGE_NAME.test(name)) return null
  let manifest: Record<string, unknown>
  try {
    manifest = await readJsonObject(join(profileDir, 'node_modules', name, 'package.json'))
  } catch {
    // A missing, linked, oversized or malformed package.json leaves the version unknown; the entry still lists it.
    return null
  }
  return typeof manifest.version === 'string' ? manifest.version : null
}

/**
 * List the profile's plugins from its `package.json` without an install check: every entry is `match: 'unknown'` and
 * the section is `unknown` with `reason`.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param reason - why no install check ran.
 * @returns the section.
 */
export async function listedPlugins(home: string, profile: string, reason: string = NO_INSTALL_CHECK): Promise<TrustPlugins> {
  const directory = profileDirectory(home, profile)
  let manifest: Record<string, unknown>
  try {
    manifest = await readJsonObject(join(directory, 'package.json'))
  } catch (error) {
    return { status: 'unknown', reason: `${reason}; the profile's package.json does not read: ${reasonOf(error)}`, entries: [] }
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  const entries = await Promise.all(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, spec]): Promise<TrustPlugin> => ({
    name,
    source: typeof spec === 'string' ? pluginSourceOf(spec) : 'unknown',
    version: await installedVersion(directory, name),
    integrity: null,
    commit: null,
    match: 'unknown',
    warnings: [],
    criticalAdvisories: [],
  })))
  return { status: 'unknown', reason, entries }
}

/** One of the person's own patch layers, as read. */
export interface OwnLayer {
  /** The layer's file. */
  readonly file: string
  /** Its patches; empty when the file is absent. */
  readonly patches: readonly unknown[]
}

/** The person's own patch layers and what kept any from reading. */
export interface OwnLayers {
  /** The layers that read, profile first, then home. */
  readonly layers: readonly OwnLayer[]
  /** One reason per layer that did not read. */
  readonly problems: readonly string[]
}

/**
 * Read the person's own patch layers: the profile's `cordis.patch.yml`, then the home's.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the layers that read and a reason for each that did not.
 */
export function readOwnLayers(home: string, profile: string): OwnLayers {
  const layers: OwnLayer[] = []
  const problems: string[] = []
  for (const file of [join(profileDirectory(home, profile), PROFILE_PATCH_FILENAME), homePatchFile(home)]) {
    try {
      layers.push({ file, patches: loadOptionalPatches('delorun', file) ?? [] })
    } catch (error) {
      problems.push(reasonOf(error))
    }
  }
  return { layers, problems }
}

/**
 * Whether a value is a `!!js` value as upstream's loader parses it.
 * @param value - the value.
 * @returns true for an object holding a string `__jsExpr`.
 */
function isExpression(value: unknown): boolean {
  return isRecord(value) && typeof value.__jsExpr === 'string'
}

/**
 * Count the `!!js` values anywhere in a parsed value.
 * @param value - the value.
 * @returns the count.
 */
export function countExpressions(value: unknown): number {
  if (isExpression(value)) return 1
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countExpressions(item), 0)
  if (isRecord(value)) return Object.values(value).reduce((sum: number, item) => sum + countExpressions(item), 0)
  return 0
}

/**
 * The entries a patch list inserts, at any depth of `insert` and group `config` lists; a group itself is not a row.
 * @param patches - the patch list.
 * @returns the inserted entries, in order.
 */
export function insertedEntries(patches: readonly unknown[]): Record<string, unknown>[] {
  const members = (entries: readonly unknown[]): Record<string, unknown>[] => entries.filter(isRecord).flatMap(entry => [
    ...entry.group === true ? [] : [entry],
    ...entry.group === true && Array.isArray(entry.config) ? members(entry.config) : [],
  ])
  return patches.filter(isRecord).flatMap(patch => Array.isArray(patch.insert) ? members(patch.insert) : [])
}

/**
 * A field as text.
 * @param value - the field.
 * @returns the string, or `null` for anything else.
 */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The patches section.
 * @param own - the person's layers.
 * @returns the rows they insert and the `!!js` count; `unknown` when a layer did not read.
 */
export function patchesSection(own: OwnLayers): TrustPatches {
  const rows = own.layers.flatMap(layer => insertedEntries(layer.patches).map(entry => ({ layer: layer.file, id: textOf(entry.id), name: textOf(entry.name) })))
  const jsValues = own.layers.reduce((sum, layer) => sum + countExpressions(layer.patches), 0)
  return own.problems.length === 0 ? { status: 'known', rows, jsValues } : { status: 'unknown', reason: own.problems.join('; '), rows, jsValues }
}

/**
 * The config the person's layers last give a row.
 * @param own - the person's layers.
 * @param id - the row's id.
 * @returns the config, or `undefined` when no layer sets one.
 */
function lastConfig(own: OwnLayers, id: string): unknown {
  return own.layers.flatMap(layer => rowPatches(layer.patches, id)).filter(entry => entry.config !== undefined).at(-1)?.config
}

/**
 * The skill roots the filesystem provider reads with no workspace.
 * @param home - the resolved Delorun home, which is the provider's harness home.
 * @param env - the environment, read for `DSH_AGENTS_HOME` and `DSH_BUNDLED_SKILL_DIR`.
 * @param own - the person's layers, read for the `skill-filesystem` row's config.
 * @returns the section.
 */
export function skillsSection(home: string, env: Readonly<Record<string, string | undefined>>, own: OwnLayers): TrustSkills {
  const config = lastConfig(own, SKILL_FILESYSTEM_ROW)
  const fields = isRecord(config) ? config : {}
  const custom = Array.isArray(fields.customSkillDirs) ? fields.customSkillDirs.filter((root): root is string => typeof root === 'string') : []
  const roots = custom.map(path => ({ path: resolve(path), source: 'custom' }))
  if (fields.includeDefaultRoots !== false) {
    const dshHome = typeof fields.dshHome === 'string' ? resolve(fields.dshHome) : home
    const agentsHome = resolveAgentsHome(typeof fields.agentsHome === 'string' ? fields.agentsHome : undefined, { ...env })
    roots.push({ path: join(dshHome, 'skills'), source: 'user-dsh' }, { path: join(agentsHome, 'skills'), source: 'user-agents' })
  }
  const bundled = typeof fields.bundledSkillDir === 'string' ? fields.bundledSkillDir : fields.includeDefaultRoots === false ? undefined : env.DSH_BUNDLED_SKILL_DIR
  if (bundled !== undefined && bundled !== '') roots.push({ path: resolve(bundled), source: 'bundled' })
  return { roots }
}

/**
 * The MCP servers section.
 * @param own - the person's layers.
 * @returns each inserted MCP client row's server name and transport; `unknown` when a layer did not read.
 */
export function mcpSection(own: OwnLayers): TrustMcp {
  const servers = own.layers.flatMap(layer => insertedEntries(layer.patches))
    .filter(entry => entry.name === MCP_CLIENT_PACKAGE && entry.disabled !== true)
    .map(entry => {
      const config = typeof entry.id === 'string' ? lastConfig(own, entry.id) ?? entry.config : entry.config
      const fields = isRecord(config) ? config : {}
      return { name: textOf(fields.serverName) ?? textOf(entry.id) ?? MCP_CLIENT_PACKAGE, transport: textOf(fields.transport) }
    })
  return own.problems.length === 0 ? { status: 'known', servers } : { status: 'unknown', reason: own.problems.join('; '), servers }
}
