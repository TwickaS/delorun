/**
 * The reader of the bundles a target release loads, for contract C3's report: for each bundle of the bundle list the
 * target would load, whether upstream's profile load (`loadProfileDirectory` in `@deepseek-ai/dsh-app-boot`) would skip
 * it, and the rows of its patch layer when it loads. Every fact is read from a file — the bundle's `package.json` and
 * the patch files its `dsh.bundle.patch` names — and no module is imported.
 *
 * Upstream's rules, in upstream's order: the bundle resolves from the target's install anchor first and the profile
 * second; its `package.json` declares `dsh.bundle`; `dsh.bundle.platforms`, when present, lists this machine's
 * platform; its DSH requirement (`engines.dsh`, else its `@deepseek-ai/dsh*` peers) is met by the target's DSH or
 * exempted for this exact version, and its `engines.delo` is met by the target's Delo; and every patch file parses as
 * a list of patch entries. A rule that decides from metadata Delo read makes a `verified` skip. Metadata Delo cannot
 * read as upstream's format raises {@link BundleReadError}, and the bundle is reported as an `unverified` skip: upstream
 * skips such a bundle too, but the report cannot know that its own reading matches upstream's.
 *
 * @module @delo/cli/update/bundle-layers
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExemptionRecord } from '@delo/contract-plugin-versions'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { exempted, exemptionKey, satisfiesRange, type LayerFact, type RowFact, type SkippedBundleFact } from '@delo/update'
import { parse } from 'yaml'
import { z } from 'zod'

/**
 * The install anchor upstream resolves a target's bundles from first: `@deepseek-ai/dsh`'s `package.json` in the
 * runtime closure's `app/node_modules`, the anchor `delo/apps/release/closure.json` names.
 */
const TARGET_INSTALL_ANCHOR = ['app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'] as const

/** Node's platform names, which upstream's `assertBundlePlatform` accepts in `dsh.bundle.platforms`. */
const NODE_PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'] as const

/** The peer ranges upstream reads as the running DSH itself. */
const WORKSPACE_RANGES: readonly string[] = ['workspace:^', 'workspace:~', 'workspace:*']

/** Why Delo could not read a bundle's metadata as upstream's format. */
export type BundleReadErrorCode =
  /** The bundle's `package.json` cannot be read or is not a JSON object. */
  | 'BUNDLE_MANIFEST_UNREADABLE'
  /** A field upstream reads — `dsh.bundle`, its `patch` or `platforms`, `engines`, `peerDependencies`, or the identity a mismatch needs — has a form upstream refuses. */
  | 'BUNDLE_DECLARATION_MALFORMED'
  /** A patch file the bundle declares cannot be read, is not YAML, or is not a list of patch entries with named rows. */
  | 'BUNDLE_PATCH_UNREADABLE'

/** A bundle whose metadata Delo could not read; the report names the bundle as an unverified skip. */
export class BundleReadError extends Error {
  readonly code: BundleReadErrorCode
  readonly bundle: string
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
  /** The target's DSH and Delo versions. */
  readonly versions: { readonly dsh: SemanticVersion, readonly delo: SemanticVersion }
  /** The profile's DSH exemption file (`compatibility.json`). */
  readonly exemptions: ExemptionRecord
  /** The platform the target runs on, as Node names it. */
  readonly platform: string
}

/** What the target does with its bundle list. */
export interface BundleLayerFacts {
  /** The layers of the bundles it loads, in list order, each named by its bundle. */
  readonly layers: readonly LayerFact[]
  /** The bundles it would skip, in list order. */
  readonly skipped: readonly SkippedBundleFact[]
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
 * @returns the directory, or undefined when no anchor reaches one.
 */
function bundleDirectory(bundle: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    // `resolve.paths` answers null for a Node built-in name, which no anchor resolves to a package.
    for (const searchPath of createRequire(anchor).resolve.paths(bundle) ?? []) {
      const candidate = join(searchPath, bundle)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

/**
 * Read a bundle's `package.json`.
 * @param bundle - the bundle's package name.
 * @param directory - its package directory.
 * @returns the manifest.
 * @throws {BundleReadError} `BUNDLE_MANIFEST_UNREADABLE` when it cannot be read or is not a JSON object.
 */
async function readManifest(bundle: string, directory: string): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    throw new BundleReadError('BUNDLE_MANIFEST_UNREADABLE', bundle, `Delo could not read its package.json: ${firstLine(error)}`, { cause: error })
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

const enginesSchema = z.looseObject({ dsh: z.string().optional(), delo: z.string().optional() })
const peersSchema = z.record(z.string(), z.string())
/** Upstream's identity rule: a name and a version that are not blank, used as written in the exemption key. */
const identitySchema = z.looseObject({ name: z.string().refine(text => text.trim() !== ''), version: z.string().refine(text => text.trim() !== '') })

/**
 * The bundle's own requirements the target does not meet, as upstream's `evaluatePluginCompatibility` decides them for
 * a bundle: `engines.dsh` decides the DSH axis alone, otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer
 * must match, with a `workspace:` peer read as the target's DSH; `engines.delo` is checked against the target's Delo;
 * and an exact-version DSH exemption admits a DSH mismatch only while the Delo axis is met.
 * @param bundle - the bundle's package name.
 * @param manifest - its `package.json`.
 * @param options - the target's versions and the profile's DSH exemptions.
 * @returns one clause per unmet requirement, empty when the bundle is admitted.
 * @throws {BundleReadError} `BUNDLE_DECLARATION_MALFORMED` when `engines`, a peer range or, on a mismatch, the bundle's
 *   name or version has a form upstream refuses.
 */
function unmetRequirements(bundle: string, manifest: Record<string, unknown>, options: BundleLayerOptions): readonly string[] {
  const { dsh, delo } = options.versions
  const malformed = (what: string): BundleReadError => new BundleReadError('BUNDLE_DECLARATION_MALFORMED', bundle, `its package.json declares ${what} in a form Delo cannot read`)
  const engines = enginesSchema.safeParse(Object.hasOwn(manifest, 'engines') ? manifest['engines'] : {})
  if (!engines.success) throw malformed('engines')
  const dshUnmet: string[] = []
  if (engines.data.dsh !== undefined) {
    if (!satisfiesRange(dsh, engines.data.dsh)) dshUnmet.push(`it requires DSH ${engines.data.dsh} and the target runs DSH ${dsh}`)
  } else if (Object.hasOwn(manifest, 'peerDependencies')) {
    const peers = peersSchema.safeParse(manifest['peerDependencies'])
    if (!peers.success) throw malformed('peerDependencies')
    for (const [name, range] of Object.entries(peers.data)) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      if (!WORKSPACE_RANGES.includes(range) && !satisfiesRange(dsh, range)) dshUnmet.push(`it requires ${name} ${range} and the target runs DSH ${dsh}`)
    }
  }
  const deloUnmet = engines.data.delo !== undefined && !satisfiesRange(delo, engines.data.delo) ? [`it requires Delo ${engines.data.delo} and the target installs Delo ${delo}`] : []
  if (dshUnmet.length === 0 && deloUnmet.length === 0) return []
  const identity = identitySchema.safeParse(manifest)
  if (!identity.success) throw malformed('its name or version')
  // The exemption covers the DSH axis alone, so a Delo mismatch keeps the bundle skipped.
  if (deloUnmet.length === 0 && exempted(options.exemptions, exemptionKey(identity.data.name, brandString<SemanticVersion>(identity.data.version)), dsh)) return []
  return [...dshUnmet, ...deloUnmet]
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
 * @returns the rows, in order.
 * @throws {BundleReadError} `BUNDLE_PATCH_UNREADABLE` when the file cannot be read, is not YAML, or is not a list of
 *   patch entries with named rows.
 */
async function readPatch(bundle: string, directory: string, file: string): Promise<readonly RowFact[]> {
  let parsed: unknown
  try {
    // `!!js` values stay unevaluated text: a row disabled by an expression counts as loading.
    parsed = parse(await readFile(join(directory, file), 'utf8'), { logLevel: 'error' })
  } catch (error) {
    throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `Delo could not read its patch ${file}: ${firstLine(error)}`, { cause: error })
  }
  if (!Array.isArray(parsed)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} is not a list of patch entries`)
  return parsed.flatMap((entry): readonly RowFact[] => {
    if (!isRecord(entry)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} holds an entry that is not a mapping`)
    const inserted = entry['insert']
    if (inserted === undefined) return []
    if (!Array.isArray(inserted)) throw new BundleReadError('BUNDLE_PATCH_UNREADABLE', bundle, `its patch ${file} holds an insert that is not a list`)
    return insertedRows(bundle, file, inserted)
  })
}

/**
 * Read one bundle as the target would load it.
 * @param bundle - the bundle's package name.
 * @param options - the anchors, the target's versions, the exemptions and the platform.
 * @returns its layer, or the reason the target skips it.
 * @throws {BundleReadError} when its metadata cannot be read as upstream's format.
 */
async function readBundle(bundle: string, options: BundleLayerOptions): Promise<LayerFact | string> {
  const directory = bundleDirectory(bundle, options.anchors)
  if (directory === undefined) return 'neither the target release nor the profile installs it'
  const manifest = await readManifest(bundle, directory)
  const declaration = declarationOf(bundle, manifest)
  if (declaration === undefined) return 'its package.json declares no dsh.bundle'
  if (declaration.platforms !== undefined && !declaration.platforms.some(platform => platform === options.platform)) {
    return `it supports the platforms ${declaration.platforms.join(', ')}, not ${options.platform}`
  }
  const unmet = unmetRequirements(bundle, manifest, options)
  if (unmet.length > 0) return unmet.join('; ')
  const files = typeof declaration.patch === 'string' ? [declaration.patch] : declaration.patch
  const rows: RowFact[] = []
  for (const file of files) rows.push(...await readPatch(bundle, directory, file))
  return { layer: bundle, rows }
}

/**
 * Read the bundles a target loads: which it would skip and why, and the patch layer of each one it loads.
 * @param bundles - the bundle list the target loads, in order.
 * @param options - the anchors, the target's versions, the profile's DSH exemptions and the platform.
 * @returns the layers and the skipped bundles; a bundle whose metadata Delo cannot read is an `unverified` skip.
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
