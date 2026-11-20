/**
 * What the pack plugin needs from the home: the installed release verified under the anchored trusted root, and the
 * transport that fetches from that release's channel. Production reads them from the environment the launcher set;
 * a specification or another composition provides the `packsEnvironment` service instead.
 *
 * @module @delorun/plugin-packs/environment
 */
import { readFile } from 'node:fs/promises'
import { getDelorunRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { DELORUN_HOME_ENV, DELORUN_LAUNCHER_ROOTS_ENV } from '@delorun/contract-home-layout'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { RELEASE_SOURCE, readAnchoredRoot, readChannelRecord, readShippedRoots } from '@delorun/install'
import { checkPacksBundle } from '@delorun/release-verify'
import { semanticVersion } from '@delorun/release-formats/brands'
import { verifySignedManifest } from '@delorun/release-formats/sign/verify'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { createPackFiles, parseRuntimeVersion, StorePaths, type InstalledRelease, type PackFiles } from '@delorun/runtime-store'

/** The installed release and the channel its packs come from. */
export interface PacksEnvironment {
  /**
   * An installed release, verified now.
   * @param other - another installed release of the store, such as the one an update left; the running release when omitted.
   * @returns the release with the anchored root.
   * @throws Error when the release is not an installation of the store, or its root does not anchor.
   */
  release(other?: RuntimeVersion): Promise<InstalledRelease>
  /** Where the release's files and external packages come from. */
  readonly files: PackFiles
}

/** How long a pack download may receive nothing before it fails; the plugin's `stallSeconds` default, which callers without a plugin configuration use. */
export const DEFAULT_STALL_SECONDS = 60

/** What the pack transport is asked for. */
export interface PackTransportSettings {
  /** The fetch the downloads go through; the global one by default. */
  readonly fetch?: typeof globalThis.fetch
  /** Seconds a download may go without receiving a byte; {@link DEFAULT_STALL_SECONDS} by default. */
  readonly stallSeconds?: number
}

/**
 * The files of one release's channel: the channel the installing launcher recorded, or the production one.
 * @param home - the resolved Delorun home.
 * @param version - the release.
 * @param settings - the fetch and the stall limit.
 * @returns the transport for that release's directory.
 */
export async function packFilesFor(home: string, version: RuntimeVersion, settings: PackTransportSettings = {}): Promise<PackFiles> {
  const record = await readChannelRecord(home)
  const sample = record?.channelOrigin === undefined ? RELEASE_SOURCE.files(semanticVersion(version), 'x') : `${record.channelOrigin.replace(/\/$/u, '')}/releases/download/v${version}/x`
  return createPackFiles({ channel: sample.slice(0, -1), stallSeconds: settings.stallSeconds ?? DEFAULT_STALL_SECONDS, ...settings.fetch === undefined ? {} : { fetch: settings.fetch } })
}

/**
 * The environment of the running installation.
 * @param env - the process environment: `DELORUN_HOME`, `DELORUN_VERSION` and the launcher's roots.
 * @param settings - the fetch and the stall limit of the downloads.
 * @returns the environment, or the reason this process has no installation to take packs from.
 */
export async function hostPacksEnvironment(env: Readonly<Record<string, string | undefined>>, settings: PackTransportSettings = {}): Promise<PacksEnvironment | { readonly unsupported: string }> {
  const home = env[DELORUN_HOME_ENV]
  const text = getDelorunRuntimeVersion(env)
  const version = text === undefined ? undefined : parseRuntimeVersion(text)
  const roots = env[DELORUN_LAUNCHER_ROOTS_ENV]
  if (home === undefined || version === undefined) return { unsupported: 'Delorun is not running from an installed release, so it has no plugin packs to download.' }
  if (roots === undefined) return { unsupported: 'The launcher that started Delorun did not name its release roots, so a pack cannot be verified.' }
  const platform = RUNTIME_PLATFORMS.find((each): each is RuntimePlatform => each === `${process.platform}-${process.arch}`)
  if (platform === undefined) return { unsupported: `Delorun publishes no plugin packs for ${process.platform}-${process.arch}.` }
  const paths = new StorePaths(home, platform)
  const files = await packFilesFor(home, version, settings)
  return {
    release: async (other = version) => {
      const root = (await readAnchoredRoot(home, await readShippedRoots(roots))).metadata
      const manifestBytes = await readFile(paths.releaseFiles(other).manifest)
      verifySignedManifest(root, manifestBytes)
      return { paths, root, version: other, manifestBytes, checkLog: checkPacksBundle }
    },
    files,
  }
}
