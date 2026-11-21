/**
 * What two installed releases' signed bundles change in the rows Delorun protects, read by the successor's health check
 * (H3). Each release is checked against its signed file list first, and its bundles are resolved only from its own
 * `app/` directory, so nothing the person, a plugin or an agent can write is an input; a bundle another directory holds
 * is treated as not installed. When either release does not verify or either release's bundle metadata cannot be read,
 * no change counts as brought by the release.
 *
 * @module @delorun/cli/update/release-settings
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { StorePaths } from '@delorun/runtime-store'
import { bundleListOf } from '@delorun/profile-safety'
import { releaseSettingChanges, type LayerFact, type RowSettingsChange } from '@delorun/update'
import { signedBundleAnchors, readBundleLayers, type BundleLayerFacts, type BundleLayerOptions } from './bundle-layers.ts'
import { runtimePlatformOf } from './channel.ts'

/** What {@link signedSettingChanges} reads. */
export interface SignedSettingsOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile, whose `package.json` lists the bundles. */
  readonly profile: string
  /** The release that runs now. */
  readonly running: RuntimeVersion
  /**
   * C2's start check of an installed release, which returns the release's manifest.
   * @throws when the release's files differ from its signed file list.
   */
  readonly check: (version: RuntimeVersion) => Promise<{ readonly manifest: { readonly version: SemanticVersion, readonly dsh: SemanticVersion } }>
  /** The platform, as Node names it; this process's by default. */
  readonly platform?: string
  /** Read bundle layers; {@link readBundleLayers} by default. */
  readonly layers?: (bundles: readonly string[], options: BundleLayerOptions) => Promise<BundleLayerFacts>
}

/**
 * The bundle layers of one verified release, from its own signed files.
 * @param options - the reader's options.
 * @param version - the release.
 * @param bundles - the profile's bundle list.
 * @returns the release's layers.
 * @throws {Error} when the release does not verify, or a bundle's metadata cannot be read as upstream's format.
 */
async function signedLayers(options: SignedSettingsOptions, version: RuntimeVersion, bundles: readonly string[]): Promise<readonly LayerFact[]> {
  const checked = await options.check(version)
  const directory = new StorePaths(options.home, runtimePlatformOf(process.platform, process.arch)).version(version)
  const read = await (options.layers ?? readBundleLayers)(bundles, {
    anchors: signedBundleAnchors(directory),
    versions: { dsh: checked.manifest.dsh, delorun: checked.manifest.version },
    exemptions: {},
    platform: options.platform ?? process.platform,
    within: join(directory, 'app'),
  })
  const unreadable = read.skipped.find(entry => entry.verification === 'unverified')
  if (unreadable !== undefined) throw new Error(`the bundle ${unreadable.package} of release ${version} could not be read: ${unreadable.reason}`)
  return read.layers
}

/**
 * The protected rows whose settings the previous and the running release's signed bundles give differently.
 * @param options - the home, the releases and the check.
 * @param previous - the release that ran before.
 * @returns the changes, in row id order.
 * @throws {Error} when either release does not verify or its bundles cannot be read; the caller then derives nothing.
 */
export async function signedSettingChanges(options: SignedSettingsOptions, previous: RuntimeVersion): Promise<readonly RowSettingsChange[]> {
  const profilePath = join(options.home, 'profiles', options.profile, 'package.json')
  const manifest: unknown = JSON.parse(await readFile(profilePath, 'utf8'))
  const bundles = bundleListOf(manifest, profilePath)
  const before = await signedLayers(options, previous, bundles)
  const after = await signedLayers(options, options.running, bundles)
  return releaseSettingChanges(before, after)
}
