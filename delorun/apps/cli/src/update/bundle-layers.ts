/**
 * The reader of the bundles a target release loads, for contract C3's report: for each bundle of the bundle list the
 * target would load, whether upstream's profile load (`loadProfileDirectory` in `@deepseek-ai/dsh-app-boot`) would skip
 * it, and the rows of its patch layer when it loads. Every fact is read from a file — the bundle's `package.json` and
 * the patch files its `dsh.bundle.patch` names — and no module is imported.
 *
 * Upstream's rules, in upstream's order: the bundle resolves from the target's install anchor first and the profile
 * second; its `package.json` declares `dsh.bundle`; `dsh.bundle.platforms`, when present, lists this machine's
 * platform; its `engines.delorun` is met by the target's Delorun and decides alone (A567), or, when it declares none, its DSH
 * requirement (`engines.dsh`, else its `@deepseek-ai/dsh*` peers) is met by the target's DSH or exempted for this exact version; and every patch file parses as
 * a list of patch entries. A rule that decides from metadata Delorun read makes a `verified` skip. Metadata Delorun cannot
 * read as upstream's format raises {@link BundleReadError}, and the bundle is reported as an `unverified` skip: upstream
 * skips such a bundle too, but the report cannot know that its own reading matches upstream's.
 *
 * @module @delorun/cli/update/bundle-layers
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExemptionRecord } from '@delorun/contract-plugin-versions'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import type { SettingValue } from '@delorun/contract-update-report'
import { exempted, exemptionKey, rowSettingsFact, satisfiesRange, type LayerFact, type RowFact, type RowSettingsFact, type SkippedBundleFact } from '@delorun/update'
import { parse } from 'yaml'
import { z } from 'zod'

/**
 * The install anchor upstream resolves a target's bundles from first: `@deepseek-ai/dsh`'s `package.json` in the
 * runtime closure's `app/node_modules`, the anchor `delorun/apps/release/closure.json` names.
 */
const TARGET_INSTALL_ANCHOR = ['app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'] as const

/** Node's platform names, which upstream's `assertBundlePlatform` accepts in `dsh.bundle.platforms`. */
const NODE_PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'] as const

/** The peer ranges upstream reads as the running DSH itself. */
const WORKSPACE_RANGES: readonly string[] = ['workspace:^', 'workspace:~', 'workspace:*']

/** Why Delorun could not read a bundle's metadata as upstream's format. */
export type BundleReadErrorCode =
  /** The bundle's `package.json` cannot be read or is not a JSON object. */
  | 'BUNDLE_MANIFEST_UNREADABLE'
  /** A field upstream reads — `dsh.bundle`, its `patch` or `platforms`, `engines`, `peerDependencies`, or the identity a mismatch needs — has a form upstream refuses. */
  | 'BUNDLE_DECLARATION_MALFORMED'
  /** A patch file the bundle declares cannot be read, is not YAML, or is not a list of patch entries with named rows. */
  | 'BUNDLE_PATCH_UNREADABLE'

/** A bundle whose metadata Delorun could not read; the report names the bundle as an unverified skip. */
export class BundleReadError extends Error {
  /** Why. */
  readonly code: BundleReadErrorCode
  /** The bundle's package name. */
  readonly bundle: string
  /** The failure for a person, which the report's item quotes. */
  readonly detail: string

  /**
   * @param code - why.
   * @param bundle - the bundle's package name.
   * @param detail - the failure for a person, which the report's item quotes.
   * @param options - the cause.
   */
  constructor(code: BundleReadErrorCode, bundle: string, detail: string, options?: ErrorOptions) {
    super(`${code}: ${bundle}: ${detail}`, options)
    this.code = code
    this.bundle = bundle
    this.detail = detail
    this.name = 'BundleReadError'
  }
}

/** What {@link readBundleLayers} checks each bundle against. */
export interface BundleLayerOptions {
  /** The files upstream resolves bundles from, in order: the target's install anchor, then the profile's `package.json`. */
  readonly anchors: readonly string[]
  /** The target's DSH and Delorun versions. */
  readonly versions: { readonly dsh: SemanticVersion, readonly delorun: SemanticVersion }
  /** The profile's DSH exemption file (`compatibility.json`). */
  readonly exemptions: ExemptionRecord
  /** The platform the target runs on, as Node names it. */
  readonly platform: string
  /**
   * A directory a bundle must resolve under, which only the release's own signed files are under. A bundle another
   * directory on Node's lookup path holds, such as a folder the person owns above the home, is treated as not installed.
   */
  readonly within?: string
  /**
   * Read a bundle's `package.json` or patch file as text; the file system by default. A caller that holds the files to a
   * signed file list passes a reader that throws for a file whose bytes do not hash to its signed digest, which makes
   * the bundle an unverified skip.
   * @param path - the absolute path.
   * @returns the file's text.
   */
  readonly readText?: (path: string) => Promise<string>
}

/** What the target does with its bundle list. */
export interface BundleLayerFacts {
  /** The layers of the bundles it loads, in list order, each named by its bundle. */
  readonly layers: readonly LayerFact[]
  /** The bundles it would skip, in list order. */
  readonly skipped: readonly SkippedBundleFact[]
}

/**
 * The one anchor of a release's own signed files.
 * @param runtime - the installed runtime's directory.
 * @returns the release's install anchor alone, so a bundle only the profile installs does not resolve.
 */
export function signedBundleAnchors(runtime: string): readonly string[] {
  return [join(runtime, ...TARGET_INSTALL_ANCHOR)]
}

/**
 * The anchors a target resolves bundles from.
 * @param runtime - the installed target runtime's directory.
 * @param profileDir - the profile directory.
 * @returns the target's install anchor, then the profile's `package.json`.
 */
export function bundleAnchors(runtime: string, profileDir: string): readonly string[] {
  return [join(runtime, ...TARGET_INSTALL_ANCHOR), join(profileDir, 'package.json')]
}

/**
 * The first line of an error's text, so a multi-line parser message stays on one line of the report.
 * @param error - the error.
 * @returns its first line.
 */
function firstLine(error: unknown): string {
  return String(error).split('\n', 1)[0]!
}

/**
 * Whether a value is a plain object.
 * @param value - the value.
 * @returns true for an object that is neither null nor an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a bundle's package directory as upstream's `resolveBundleDir` does: Node's lookup paths from each anchor in
 * turn, taking the first directory that holds a `package.json`.
 * @param bundle - the bundle's package name.
 * @param anchors - the anchors, in order.
 * @param within - the directory a bundle must be under, when the caller holds it to the release's own files.
 * @returns the directory, or undefined when no anchor reaches one.
 */
function bundleDirectory(bundle: string, anchors: readonly string[], within: string | undefined): string | undefined {
  for (const anchor of anchors) {
    // `resolve.paths` answers null for a Node built-in name, which no anchor resolves to a package.
    for (const searchPath of createRequire(anchor).resolve.paths(bundle) ?? []) {
      const candidate = join(searchPath, bundle)
      if (within !== undefined && !candidate.startsWith(`${within}${sep}`)) continue
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

/**
 * Read a bundle's `package.json`.
 * @param bundle - the bundle's package name.
 * @param directory - its package directory.
 * @param readText - reads a file as text.
 * @returns the manifest.
 * @throws {BundleReadError} `BUNDLE_MANIFEST_UNREADABLE` when it cannot be read or is not a JSON object.
 */
async function readManifest(bundle: string, directory: string, readText: (path: string) => Promise<string>): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(await readText(join(directory, 'package.json')))
  } catch (error) {
    throw new BundleReadError('BUNDLE_MANIFEST_UNREADABLE', bundle, `Delorun could not read its package.json: ${firstLine(error)}`, { cause: error })
  }
  if (!isRecord(value)) throw new BundleReadError('BUNDLE_MANIFEST_UNREADABLE', bundle, 'its package.json is not a JSON object')
  return value
}

const declarationSchema = z.looseObject({
  patch: z.union([z.string(), z.array(z.string())]),
  platforms: z.array(z.enum(NODE_PLATFORMS)).min(1).optional(),
})

/** A bundle's `dsh.bundle`, in the form upstream reads. */
type BundleDeclaration = z.infer<typeof declarationSchema>

/**
 * Read a bundle's `dsh.bundle`.
 * @param bundle - the bundle's package name.
 * @param manifest - its `package.json`.
 * @returns the declaration, or undefined when the manifest declares none.
 * @throws {BundleReadError} `BUNDLE_DECLARATION_MALFORMED` when `dsh.bundle`, its `patch` or its `platforms` has a form
 *   upstream refuses.
 */
function declarationOf(bundle: string, manifest: Record<string, unknown>): BundleDeclaration | undefined {
  const dsh = manifest['dsh']
  const declared = isRecord(dsh) ? dsh['bundle'] : undefined
  if (declared === undefined) return undefined
  const parsed = declarationSchema.safeParse(declared)
  if (!parsed.success) throw new BundleReadError('BUNDLE_DECLARATION_MALFORMED', bundle, 'its dsh.bundle needs patch as a file path or a list of file paths, and platforms, when given, as a nonempty list of Node platform names')
  return parsed.data
}

/** `engines.dsh` is read only when `engines.delorun` is absent (A567), so a malformed one is refused there and not here. */
const enginesSchema = z.looseObject({ dsh: z.unknown().optional(), delorun: z.string().optional() })
const peersSchema = z.record(z.string(), z.string())
/** Upstream's identity rule: a name and a version that are not blank, used as written in the exemption key. */
const identitySchema = z.looseObject({ name: z.string().refine(text => text.trim() !== ''), version: z.string().refine(text => text.trim() !== '') })

/**
 * The bundle's own requirements the target does not meet, as upstream's `evaluatePluginCompatibility` decides them for
 * a bundle: `engines.delorun`, when declared, decides alone against the target's Delorun and the DSH ranges are not read;
 * otherwise `engines.dsh` decides alone, and without it every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must match,
 * with a `workspace:` peer read as the target's DSH. An exact-version DSH exemption admits a DSH mismatch only while the
 * Delorun axis is met, and a bundle decided on `engines.delorun` has no DSH mismatch to admit.
 * @param bundle - the bundle's package name.
 * @param manifest - its `package.json`.
 * @param options - the target's versions and the profile's DSH exemptions.
 * @returns one clause per unmet requirement, empty when the bundle is admitted.
 * @throws {BundleReadError} `BUNDLE_DECLARATION_MALFORMED` when `engines`, a peer range or, on a mismatch, the bundle's
 *   name or version has a form upstream refuses.
 */
function unmetRequirements(bundle: string, manifest: Record<string, unknown>, options: BundleLayerOptions): readonly string[] {
  const { dsh, delorun } = options.versions
  const malformed = (what: string): BundleReadError => new BundleReadError('BUNDLE_DECLARATION_MALFORMED', bundle, `its package.json declares ${what} in a form Delorun cannot read`)
  const engines = enginesSchema.safeParse(Object.hasOwn(manifest, 'engines') ? manifest['engines'] : {})
  if (!engines.success) throw malformed('engines')
  const dshUnmet: string[] = []
  // A bundle that declares `engines.delorun` is decided on that range alone (A567); its DSH ranges are not read.
  if (engines.data.delorun === undefined) {
    if (Object.hasOwn(engines.data, 'dsh')) {
      const range = engines.data.dsh
      if (typeof range !== 'string') throw malformed('engines')
      if (!satisfiesRange(dsh, range)) dshUnmet.push(`it requires DSH ${range} and the target runs DSH ${dsh}`)
    } else if (Object.hasOwn(manifest, 'peerDependencies')) {
      const peers = peersSchema.safeParse(manifest['peerDependencies'])
      if (!peers.success) throw malformed('peerDependencies')
      for (const [name, range] of Object.entries(peers.data)) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
        if (!WORKSPACE_RANGES.includes(range) && !satisfiesRange(dsh, range)) dshUnmet.push(`it requires ${name} ${range} and the target runs DSH ${dsh}`)
      }
    }
  }
  const delorunUnmet = engines.data.delorun !== undefined && !satisfiesRange(delorun, engines.data.delorun) ? [`it requires Delorun ${engines.data.delorun} and the target installs Delorun ${delorun}`] : []
  if (dshUnmet.length === 0 && delorunUnmet.length === 0) return []
  const identity = identitySchema.safeParse(manifest)
  if (!identity.success) throw malformed('its name or version')
  // The exemption covers the DSH axis alone, so a Delorun mismatch keeps the bundle skipped.
  if (delorunUnmet.length === 0 && exempted(options.exemptions, exemptionKey(identity.data.name, brandString<SemanticVersion>(identity.data.version)), dsh)) return []
  return [...dshUnmet, ...delorunUnmet]
}

/** What one patch file contributes to a layer. */
interface PatchRows {
  /** The rows it inserts that load. */
  readonly rows: readonly RowFact[]
  /** The ids of the rows it disables. */
  readonly disabled: readonly string[]
  /** The settings it gives rows that have an id. */
  readonly settings: readonly RowSettingsFact[]
}

/**
 * The ids of the rows one patch entry's inserted rows disable, a group's children included.
 * @param rows - the entry's `insert` list, or a group's children.
 * @returns the ids of disabled rows that have one.
 */
function disabledInserted(rows: readonly unknown[]): readonly string[] {
  return rows.flatMap((row): readonly string[] => {
    if (!isRecord(row)) return []
    if (row['group'] === true && Array.isArray(row['config'])) return disabledInserted(row['config'])
    return row['disabled'] === true && typeof row['id'] === 'string' ? [row['id']] : []
  })
}

/**
 * The top-level `config` keys of a patch row or entry as JSON values.
 * @param config - the row's `config` value.
 * @returns the keys; none when the config is not a mapping.
 */
function configKeys(config: unknown): Readonly<Record<string, SettingValue>> {
  if (!isRecord(config)) return {}
  return Object.fromEntries(Object.entries(config).map(([key, value]): [string, SettingValue] => [key, JSON.parse(JSON.stringify(value ?? null)) as SettingValue]))
}

/**
 * The settings of the rows one patch entry inserts, a group's children included; a disabled row loads nothing.
 * @param rows - the entry's `insert` list, or a group's children.
 * @returns one fact per inserted row that has an id and a plugin name.
 */
function insertedSettings(rows: readonly unknown[]): readonly RowSettingsFact[] {
  return rows.flatMap((row): readonly RowSettingsFact[] => {
    if (!isRecord(row) || row['disabled'] === true) return []
    if (row['group'] === true && Array.isArray(row['config'])) return insertedSettings(row['config'])
    return typeof row['id'] === 'string' && typeof row['name'] === 'string' ? [rowSettingsFact(row['id'], row['name'], configKeys(row['config']))] : []
  })
}

/**
 * The rows one patch entry inserts, a group's children included; a row the patch disables loads nothing.
 * @param bundle - the bundle's package name.
 * @param file - the patch file, for the failure.
 * @param rows - the entry's `insert` list, or a group's children.
 * @returns the rows, in order.
 * @throws {BundleReadError} `BUNDLE_PATCH_UNREADABLE` when a row is not a mapping or names no plugin.
 */
function insertedRows(bundle: string, file: string, rows: readonly unknown[]): readonly RowFact[] {
  return rows.flatMap((row): readonly RowFact[] => {
    if (!isRecord(row)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} inserts a row that is not a mapping`)
    if (row['disabled'] === true) return []
    if (row['group'] === true && Array.isArray(row['config'])) return insertedRows(bundle, file, row['config'])
    const name = row['name']
    if (typeof name !== 'string') throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} inserts a row that names no plugin`)
    return [{ ...typeof row['id'] === 'string' ? { id: row['id'] } : {}, name, plugins: [name] }]
  })
}

/**
 * Read one patch file of a bundle into the rows it inserts.
 * @param bundle - the bundle's package name.
 * @param directory - its package directory.
 * @param file - the package-relative file, as `dsh.bundle.patch` writes it.
 * @param readText - reads a file as text.
 * @returns the rows it inserts, in order, and the ids of the rows it disables: an entry `{ id, disabled: true }` or a disabled inserted row.
 * @throws {BundleReadError} `BUNDLE_PATCH_UNREADABLE` when the file cannot be read, is not YAML, or is not a list of
 *   patch entries with named rows.
 */
async function readPatch(bundle: string, directory: string, file: string, readText: (path: string) => Promise<string>): Promise<PatchRows> {
  let parsed: unknown
  try {
    // `!!js` values stay unevaluated text: a row disabled by an expression counts as loading.
    parsed = parse(await readText(join(directory, file)), { logLevel: 'error' })
  } catch (error) {
    throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `Delorun could not read its patch ${file}: ${firstLine(error)}`, { cause: error })
  }
  if (!Array.isArray(parsed)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} is not a list of patch entries`)
  const rows: RowFact[] = []
  const disabled: string[] = []
  const settings: RowSettingsFact[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} holds an entry that is not a mapping`)
    // A literal `disabled: true` only; a `!!js` expression stays text and counts as not disabled, as it does for inserted rows.
    if (entry['disabled'] === true && typeof entry['id'] === 'string') disabled.push(entry['id'])
    // An entry with an id and a config changes the keys of a row another layer inserted.
    if (typeof entry['id'] === 'string' && isRecord(entry['config'])) settings.push(rowSettingsFact(entry['id'], undefined, configKeys(entry['config'])))
    const inserted = entry['insert']
    if (inserted === undefined) continue
    if (!Array.isArray(inserted)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} holds an insert that is not a list`)
    rows.push(...insertedRows(bundle, file, inserted))
    disabled.push(...disabledInserted(inserted))
    settings.push(...insertedSettings(inserted))
  }
  return { rows, disabled, settings }
}

/**
 * Read one bundle as the target would load it.
 * @param bundle - the bundle's package name.
 * @param options - the anchors, the target's versions, the exemptions and the platform.
 * @returns its layer, or the reason the target skips it.
 * @throws {BundleReadError} when its metadata cannot be read as upstream's format.
 */
async function readBundle(bundle: string, options: BundleLayerOptions): Promise<LayerFact | string> {
  const directory = bundleDirectory(bundle, options.anchors, options.within)
  if (directory === undefined) return 'neither the target release nor the profile installs it'
  const readText = options.readText ?? (async path => readFile(path, 'utf8'))
  const manifest = await readManifest(bundle, directory, readText)
  const declaration = declarationOf(bundle, manifest)
  if (declaration === undefined) return 'its package.json declares no dsh.bundle'
  if (declaration.platforms !== undefined && !declaration.platforms.some(platform => platform === options.platform)) {
    return `it supports the platforms ${declaration.platforms.join(', ')}, not ${options.platform}`
  }
  const unmet = unmetRequirements(bundle, manifest, options)
  if (unmet.length > 0) return unmet.join('; ')
  const files = typeof declaration.patch === 'string' ? [declaration.patch] : declaration.patch
  const rows: RowFact[] = []
  const disabledRows: string[] = []
  const settings: RowSettingsFact[] = []
  for (const file of files) {
    const patch = await readPatch(bundle, directory, file, readText)
    rows.push(...patch.rows)
    disabledRows.push(...patch.disabled)
    settings.push(...patch.settings)
  }
  return { layer: bundle, rows, disabledRows, settings }
}

/**
 * Read the bundles a target loads: which it would skip and why, and the patch layer of each one it loads.
 * @param bundles - the bundle list the target loads, in order.
 * @param options - the anchors, the target's versions, the profile's DSH exemptions and the platform.
 * @returns the layers and the skipped bundles; a bundle whose metadata Delorun cannot read is an `unverified` skip.
 */
export async function readBundleLayers(bundles: readonly string[], options: BundleLayerOptions): Promise<BundleLayerFacts> {
  const layers: LayerFact[] = []
  const skipped: SkippedBundleFact[] = []
  for (const bundle of bundles) {
    let read: LayerFact | string
    try {
      read = await readBundle(bundle, options)
    } catch (error) {
      if (!(error instanceof BundleReadError)) throw error
      skipped.push({ package: bundle, reason: error.detail, verification: 'unverified' })
      continue
    }
    if (typeof read === 'string') skipped.push({ package: bundle, reason: read, verification: 'verified' })
    else layers.push(read)
  }
  return { layers, skipped }
}
