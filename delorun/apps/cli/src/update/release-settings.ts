/**
 * What two installed releases' signed bundles change in the rows Delorun protects, read by the successor's health check
 * (H3). Each release is checked against its signed file list first. Every bundle `package.json` and patch file is then
 * read once and hashed against the signed digest of the bytes that are parsed, whatever the start check recorded, and
 * bundles resolve only from the release's own `app/` directory, so nothing the person, a plugin or an agent can write
 * is an input. When either release does not verify, a file's bytes differ from its signed digest, or a bundle's metadata
 * cannot be read, no change counts as brought by the release.
 *
 * @module @delorun/cli/update/release-settings
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { StorePaths } from '@delorun/runtime-store'
import { releaseSettingChanges, type LayerFact, type RowSettingsChange } from '@delorun/update'
import { signedBundleAnchors, readBundleLayers, type BundleLayerFacts, type BundleLayerOptions } from './bundle-layers.ts'
import { runtimePlatformOf } from './channel.ts'

/** What {@link signedSettingChanges} reads. */
export interface SignedSettingsOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The bundles whose patches are compared: the release's own list, which no home file states. */
  readonly bundles: readonly string[]
  /** The release that runs now. */
  readonly running: RuntimeVersion
  /**
   * C2's start check of an installed release, which returns the release's manifest and verified signed file list.
   * @throws when the release's files differ from its signed file list.
   */
  readonly check: (version: RuntimeVersion) => Promise<{
    readonly manifest: { readonly version: SemanticVersion, readonly dsh: SemanticVersion }
    readonly files: { readonly files: readonly { readonly path: string, readonly sha256: string }[] }
  }>
  /** The platform, as Node names it; this process's by default. */
  readonly platform?: string
  /** Read bundle layers; {@link readBundleLayers} by default. */
  readonly layers?: (bundles: readonly string[], options: BundleLayerOptions) => Promise<BundleLayerFacts>
}

/**
 * A reader of text files of one release that hashes the bytes it returns.
 * @param directory - the installed release.
 * @param files - the release's verified signed file list.
 * @returns a reader that throws for a file the list does not hold, one that is not a regular file, or one whose bytes do not hash to the signed digest.
 */
function signedTextReader(directory: string, files: readonly { readonly path: string, readonly sha256: string }[]): (path: string) => Promise<string> {
  const signed = new Map(files.map(file => [file.path, file.sha256]))
  return async (path) => {
    const name = relative(directory, path).split(sep).join('/')
    const digest = signed.get(name)
    if (digest === undefined) throw new Error(`${name} is not in the release's signed file list`)
    if (!(await lstat(path)).isFile()) throw new Error(`${name} is not a regular file`)
    const bytes = await readFile(path)
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`${name} differs from its signed digest`)
    return bytes.toString('utf8')
  }
}

/**
 * The bundle layers of one verified release, from its own signed files.
 * @param options - the reader's options.
 * @param version - the release.
 * @returns the release's layers.
 * @throws {Error} when the release does not verify, or a bundle's metadata cannot be read as upstream's format or does not hash to its signed digest.
 */
async function signedLayers(options: SignedSettingsOptions, version: RuntimeVersion): Promise<readonly LayerFact[]> {
  const checked = await options.check(version)
  const directory = new StorePaths(options.home, runtimePlatformOf(process.platform, process.arch)).version(version)
  const read = await (options.layers ?? readBundleLayers)(options.bundles, {
    anchors: signedBundleAnchors(directory),
    versions: { dsh: checked.manifest.dsh, delorun: checked.manifest.version },
    exemptions: {},
    platform: options.platform ?? process.platform,
    within: join(directory, 'app'),
    readText: signedTextReader(directory, checked.files.files),
  })
  const unreadable = read.skipped.find(entry => entry.verification === 'unverified')
  if (unreadable !== undefined) throw new Error(`the bundle ${unreadable.package} of release ${version} could not be read: ${unreadable.reason}`)
  return read.layers
}

/**
 * The protected rows whose settings the previous and the running release's signed bundles give differently.
 * @param options - the home, the bundles, the releases and the check.
 * @param previous - the release that ran before.
 * @returns the changes, in row id order.
 * @throws {Error} when either release does not verify or its bundles cannot be read; the caller then derives nothing.
 */
export async function signedSettingChanges(options: SignedSettingsOptions, previous: RuntimeVersion): Promise<readonly RowSettingsChange[]> {
  const before = await signedLayers(options, previous)
  const after = await signedLayers(options, options.running)
  return releaseSettingChanges(before, after)
}
