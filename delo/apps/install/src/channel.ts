/**
 * The release channel the launcher installs through: contract C2's client verification steps 1 to 5 over contract
 * C1's download rule, contract C18's bundle and online check before anything installs, and the extraction of the
 * verified archive into the runtime store's staging directory. {@link LauncherChannel.resolve} names and verifies the
 * release and records the root, timestamp and log checkpoint it proved under `trust/`;
 * {@link LauncherChannel.fill} then downloads that release's archive and file list, checks both against the manifest
 * before extracting, and returns the three signed files the store keeps beside the installation. `current` is never
 * touched here: the store switches it, and only an install of a store without one sets it.
 *
 * @module @delo/install/channel
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ARCHIVE_MAX_BYTES, type RuntimeVersion } from '@delo/contract-home-layout'
import {
  RELEASE_FILE_SIZE_LIMITS,
  RELEASE_METADATA_ORIGIN,
  RELEASE_REPOSITORY_URL,
  type ReleaseChannel as ChannelName,
  type RuntimePlatform,
  type SemanticVersion,
} from '@delo/contract-release-manifest'
import type { ReleaseFileBytes } from '@delo/runtime-store'
import type { RuntimeChannel, ChannelRelease } from '@delo/runtime-store'
import { parseRuntimeVersion } from '@delo/runtime-store'
import { archiveFormat } from '@delo/release/archive/entry'
import { Downloader } from './download.ts'
import { InstallError } from './errors.ts'
import { extractArchive } from './extract.ts'
import { requireVerifiedLog, runOnlineCheck, type LogService } from './log.ts'
import { readStoredCheckpoint, readStoredTimestamp, writeStoredCheckpoint, writeStoredRootChain, writeStoredTimestamp, writeTrustedRoot, type StoredCheckpoint } from './state.ts'
import { newestRootVersion, rootVersionOf, verifyChannelRelease, verifyDownloadedFile, verifyPlatformFiles, verifyTimestampUnderRoots, type VerifiedChannelRelease } from './verify.ts'

/**
 * Where a release's files are published: contract C2's metadata host for `root/<n>.root.json` and `timestamp.json`,
 * and the GitHub release of the version's tag for every other file, named by its `FileRef`.
 */
export interface ReleaseSource {
  /** The metadata host's origin, without a trailing slash. */
  readonly metadata: string
  /**
   * The URL of one release file.
   * @param version - the release.
   * @param name - the file's name, which contract C2 makes one path segment.
   * @returns the URL.
   */
  readonly files: (version: SemanticVersion, name: string) => string
}

/** Contract C2's publication: metadata from `releases.delorun.com`, every other file from the version's GitHub release. */
export const RELEASE_SOURCE: ReleaseSource = {
  metadata: RELEASE_METADATA_ORIGIN,
  files: (version, name) => `${RELEASE_REPOSITORY_URL}/releases/download/v${version}/${name}`,
}

/** What a {@link LauncherChannel} needs. */
export interface LauncherChannelOptions {
  /** The resolved Delo home, whose `trust/` records what verified. */
  readonly home: string
  /** The platform whose runtime closure this machine installs. */
  readonly platform: RuntimePlatform
  /** The root files the launcher embeds, oldest first; the install trusts no other root. */
  readonly roots: readonly Uint8Array[]
  /** The person's channel. */
  readonly channel: ChannelName
  /** The log and its checkpoint distributor. */
  readonly log: LogService
  /** Where the files are published; {@link RELEASE_SOURCE} by default. */
  readonly source?: ReleaseSource
  /** The downloader; contract C1's rule over this process's `fetch` by default. */
  readonly downloader?: Downloader
  /** The clock, in milliseconds; `Date.now` by default. */
  readonly now?: () => number
}

/** A release this channel resolved, kept for its install. */
interface Resolved {
  readonly release: ChannelRelease
  readonly verified: VerifiedChannelRelease
  readonly manifestBytes: Buffer
  readonly bundleBytes: Buffer
}

/** A release the channel resolved but has not filled, for its own error messages. */
const NO_RELEASE = 'this channel has not resolved a release to install'

/**
 * Contract C1's release channel over contract C2's publication and contract C18's log.
 */
export class LauncherChannel implements RuntimeChannel {
  private readonly source: ReleaseSource
  private readonly downloader: Downloader
  private readonly now: () => number
  private readonly resolved = new Map<string, Resolved>()

  /**
   * @param options - the home, the platform, the embedded roots, the channel, the log, the source, the downloader and
   *   the clock.
   */
  constructor(private readonly options: LauncherChannelOptions) {
    this.source = options.source ?? RELEASE_SOURCE
    this.downloader = options.downloader ?? new Downloader()
    this.now = options.now ?? Date.now
  }

  /**
   * Name, verify and log-check a release: walk the root chain from the embedded root to the one the timestamp names,
   * verify the timestamp's signature, lifetime, expiry and version, verify the channel's manifest and contract C18's
   * bundle, run the online log check, and record what verified under `trust/`. Nothing downloads a runtime until all
   * of it passes.
   * @param target - the version a person asked for, or `undefined` for the channel's current release.
   * @returns the release's version and the root it verified with.
   * @throws {InstallError} `DOWNLOAD_REFUSED`, `DOWNLOAD_FAILED`, `INSTALL_VERIFY_FAILED`, `RELEASE_NOT_OFFERED`,
   *   `RELEASE_LOG_FAILED` or `RELEASE_LOG_UNCHECKED`; no file appears under `runtimes/` on any of them.
   */
  async resolve(target?: RuntimeVersion): Promise<ChannelRelease> {
    const now = Math.floor(this.now() / 1000)
    const stamp = await this.downloader.bytes(`${this.source.metadata}/timestamp.json`, RELEASE_FILE_SIZE_LIMITS.timestamp)
    const roots = await this.rootChain(rootVersionOf(stamp.bytes))
    const stored = await readStoredTimestamp(this.options.home)
    const { root, timestamp } = verifyTimestampUnderRoots({ roots, timestamp: stamp.bytes, now, ...stored === undefined ? {} : { stored } })
    await writeTrustedRoot(this.options.home, roots.at(-1)!)
    await writeStoredRootChain(this.options.home, roots)
    await writeStoredTimestamp(this.options.home, stamp.bytes)
    const pointer = timestamp.channels[this.options.channel]
    const version = asVersion(pointer.release)
    const manifest = await this.downloader.bytes(this.source.files(pointer.release, pointer.manifest.name), RELEASE_FILE_SIZE_LIMITS.manifest)
    const bundleName = bundleFileName(pointer.release)
    const bundle = await this.downloader.bytes(this.source.files(pointer.release, bundleName), RELEASE_FILE_SIZE_LIMITS.manifest)
    const verified = verifyChannelRelease({
      root: root.metadata,
      timestamp,
      channel: this.options.channel,
      manifest: manifest.bytes,
      bundle: bundle.bytes,
      ...target === undefined ? {} : { target: brandString<SemanticVersion>(String(target)) },
    })
    const online = await runOnlineCheck({ root: root.metadata, release: pointer.release, log: verified.log, service: this.options.log, now, ...await this.storedCheckpoint() })
    requireVerifiedLog(online, `release ${pointer.release}`)
    if (online.checkpoint !== undefined) await writeStoredCheckpoint(this.options.home, online.checkpoint)
    const release: ChannelRelease = { version, root: root.metadata }
    this.resolved.set(version, { release, verified, manifestBytes: manifest.bytes, bundleBytes: bundle.bytes })
    return release
  }

  /**
   * Download a resolved release's platform archive and file list, check both against the manifest before extracting,
   * and extract the archive into the staging directory with contract C1's path checks.
   * @param release - the release {@link LauncherChannel.resolve} returned.
   * @param directory - a new, empty `staging/<16 hex>/` directory.
   * @returns the manifest, the file list and the release-log bundle, to keep beside the installation.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when a file is not the manifest's or the archive is not the list's;
   *   `ARCHIVE_REFUSED` when the archive holds an entry it may not; `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED`.
   */
  async fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes> {
    const resolved = this.resolved.get(release.version)
    if (resolved === undefined) throw new InstallError('INSTALL_VERIFY_FAILED', String(release.version), `${NO_RELEASE}: ${release.version} was not resolved before it was installed`)
    const { manifest } = resolved.verified
    const artifacts = manifest.runtime[this.options.platform]
    const format = archiveFormat(this.options.platform)
    const scratch = await mkdtemp(join(dirname(directory), '.download-'))
    try {
      const archivePath = join(scratch, artifacts.archive.name)
      await this.downloader.file(this.source.files(manifest.version, artifacts.archive.name), ARCHIVE_MAX_BYTES, archivePath)
      await verifyDownloadedFile(artifacts.archive, archivePath)
      const list = await this.downloader.bytes(this.source.files(manifest.version, artifacts.files.name), RELEASE_FILE_SIZE_LIMITS.files)
      const files = verifyPlatformFiles({ root: release.root, manifest, platform: this.options.platform, bytes: list.bytes })
      await extractArchive({ archive: archivePath, format, files, directory })
      return { manifest: resolved.manifestBytes, files: list.bytes, bundle: resolved.bundleBytes }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /**
   * The root chain from the embedded root to the version a timestamp names: each later root file, exactly one version
   * above the one before, which `@delo/release` then verifies with both thresholds.
   * @param target - the root version the timestamp names.
   * @returns the root files, oldest first.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the timestamp names a root older than the embedded one;
   *   `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED` for a root file that cannot be fetched.
   */
  private async rootChain(target: number): Promise<readonly Uint8Array[]> {
    const newest = newestRootVersion(this.options.roots)
    if (target < newest) {
      throw new InstallError('INSTALL_VERIFY_FAILED', 'timestamp.json', `the timestamp names root ${String(target)}, older than root ${String(newest)}, which this launcher trusts; a root never moves backwards`)
    }
    const roots = [...this.options.roots]
    for (let version = newest + 1; version <= target; version++) {
      const root = await this.downloader.bytes(`${this.source.metadata}/root/${String(version)}.root.json`, RELEASE_FILE_SIZE_LIMITS.root)
      roots.push(root.bytes)
    }
    return roots
  }

  /**
   * The stored log checkpoint, when one reads, for the online check's starting point.
   * @returns the field to pass to {@link runOnlineCheck}, which is absent when nothing was stored.
   * @throws {InstallError} `TRUST_STATE_INVALID` when the stored checkpoint does not read.
   */
  private async storedCheckpoint(): Promise<{ readonly stored?: StoredCheckpoint }> {
    const stored = await readStoredCheckpoint(this.options.home)
    return stored === undefined ? {} : { stored }
  }
}

/**
 * A release version as the store's directory name, refusing one that is not.
 * @param version - the manifest's or timestamp's version.
 * @returns the version.
 * @throws {InstallError} `RELEASE_METADATA_INVALID` when the version cannot name a store directory.
 */
function asVersion(version: SemanticVersion): RuntimeVersion {
  const parsed = parseRuntimeVersion(String(version))
  if (parsed === undefined) throw new InstallError('RELEASE_METADATA_INVALID', String(version), `release ${version} is not a version the runtime store can hold`)
  return parsed
}

/**
 * The release-log bundle's name for a release (contract C2's release files).
 * @param version - the release.
 * @returns `delorun-<version>.manifest.log.json`.
 */
export function bundleFileName(version: SemanticVersion): string {
  return `delorun-${version}.manifest.log.json`
}
