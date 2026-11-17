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
   * The installed release, verified now.
   * @returns the release with the anchored root.
   * @throws Error when the release is not an installation of the store, or its root does not anchor.
   */
  release(): Promise<InstalledRelease>
  /** Where the release's files and external packages come from. */
  readonly files: PackFiles
}

/**
 * The files of one release's channel: the channel the installing launcher recorded, or the production one.
 * @param home - the resolved Delorun home.
 * @param version - the release.
 * @param fetchImpl - the fetch the downloads go through.
 * @returns the transport for that release's directory.
 */
export async function packFilesFor(home: string, version: RuntimeVersion, fetchImpl?: typeof globalThis.fetch): Promise<PackFiles> {
  const record = await readChannelRecord(home)
  const sample = record?.channelOrigin === undefined ? RELEASE_SOURCE.files(semanticVersion(version), 'x') : `${record.channelOrigin.replace(/\/$/u, '')}/releases/download/v${version}/x`
  return createPackFiles({ channel: sample.slice(0, -1), ...fetchImpl === undefined ? {} : { fetch: fetchImpl } })
}

/**
 * The environment of the running installation.
 * @param env - the process environment: `DELORUN_HOME`, `DELORUN_VERSION` and the launcher's roots.
 * @param fetchImpl - the fetch the downloads go through.
 * @returns the environment, or the reason this process has no installation to take packs from.
 */
export async function hostPacksEnvironment(env: Readonly<Record<string, string | undefined>>, fetchImpl?: typeof globalThis.fetch): Promise<PacksEnvironment | { readonly unsupported: string }> {
  const home = env[DELORUN_HOME_ENV]
  const text = getDelorunRuntimeVersion(env)
  const version = text === undefined ? undefined : parseRuntimeVersion(text)
  const roots = env[DELORUN_LAUNCHER_ROOTS_ENV]
  if (home === undefined || version === undefined) return { unsupported: 'Delorun is not running from an installed release, so it has no plugin packs to download.' }
  if (roots === undefined) return { unsupported: 'The launcher that started Delorun did not name its release roots, so a pack cannot be verified.' }
  const platform = RUNTIME_PLATFORMS.find((each): each is RuntimePlatform => each === `${process.platform}-${process.arch}`)
  if (platform === undefined) return { unsupported: `Delorun publishes no plugin packs for ${process.platform}-${process.arch}.` }
  const paths = new StorePaths(home, platform)
  const files = await packFilesFor(home, version, fetchImpl)
  return {
    release: async () => {
      const root = (await readAnchoredRoot(home, await readShippedRoots(roots))).metadata
      const manifestBytes = await readFile(paths.releaseFiles(version).manifest)
      verifySignedManifest(root, manifestBytes)
      return { paths, root, version, manifestBytes, checkLog: checkPacksBundle }
    },
    files,
  }
}
