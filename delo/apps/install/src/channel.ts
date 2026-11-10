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
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ARCHIVE_MAX_BYTES, DELO_HOME_ENTRIES, type RuntimeVersion } from '@delo/contract-home-layout'
import { RELEASE_LOG_BUNDLE_SIZE_LIMIT } from '@delo/contract-release-log'
import {
  RELEASE_FILE_SIZE_LIMITS,
  RELEASE_METADATA_ORIGIN,
  RELEASE_REPOSITORY_URL,
  type ReleaseChannel as ChannelName,
  type RootMetadata,
  type RuntimePlatform,
  type SemanticVersion,
} from '@delo/contract-release-manifest'
import type { ReleaseFileBytes } from '@delo/runtime-store'
import type { RuntimeChannel, ChannelRelease } from '@delo/runtime-store'
import { parseRuntimeVersion } from '@delo/runtime-store'
import { archiveFormat } from '@delo/release-formats/archive/entry'
import { walkRootChain } from '@delo/release-formats/sign/verify'
import { HomeLayoutError } from '@delo/home'
import { ReleaseLogInternalError, type ReleaseLogTransport } from '@delo/release-verify/online'
import { checkAndStore, recordResult } from '@delo/release-verify/record'
import type { StartCheckResult } from '@delo/release-verify/start'
import { Downloader } from './download.ts'
import { InstallError, isInstallError, messageOf } from './errors.ts'
import { extractArchive } from './extract.ts'
import type { InstallProgress } from './progress.ts'
import { readStoredRootBytes, readStoredRootChain, readStoredTimestamp, writeStoredRootChain, writeStoredTimestamp, writeTrustedRoot } from './state.ts'
import { newestRootVersion, rootVersionOf, verifyChannelRelease, verifyDownloadedFile, verifyPlatformFiles, verifyStoredRoot, verifyTimestampUnderRoots, type VerifiedChannelRelease } from './verify.ts'

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

/** The most root versions one install walks past the root this home trusts; a timestamp that names more is refused unread. */
export const MAX_ROOT_ROTATIONS = 32

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
  /**
   * The transport to the release log, or the function that makes it from the root being trusted: the log's address
   * derives from the root's `log.origin`, which a root rotation can change, so a launcher passes the function.
   */
  readonly log: ReleaseLogTransport | ((root: RootMetadata) => ReleaseLogTransport)
  /** Where the files are published; {@link RELEASE_SOURCE} by default. */
  readonly source?: ReleaseSource
  /** The downloader; contract C1's rule over this process's `fetch` by default. */
  readonly downloader?: Downloader
  /** The clock, in milliseconds; `Date.now` by default. */
  readonly now?: () => number
  /** Told of each step that finishes; nothing by default. */
  readonly progress?: (event: InstallProgress) => void
}

/** A release this channel resolved, kept for its install. */
interface Resolved {
  readonly release: ChannelRelease
  readonly verified: VerifiedChannelRelease
  readonly manifestBytes: Buffer
  readonly bundleBytes: Buffer
  /** What contract C18's check found, for the record the install keeps once the store installed the release. */
  readonly log: StartCheckResult
  /** Unix seconds of the check. */
  readonly checkedAt: number
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
   * Name, verify and log-check a release: walk the root chain from the newest root this home trusts (the stored root
   * when the launcher's shipped roots lead to it, the newest shipped root otherwise) to the one the timestamp names,
   * verify the timestamp's signature, lifetime, expiry and version, verify the channel's manifest and contract C18's
   * bundle, run the online log check, and record what verified under `trust/`: the roots and the timestamp once they
   * verify, and the checkpoint once the log check verifies, because a later install holds the root, the timestamp and
   * the log to what they proved even when this install ends before the runtime lands. The check state of the release
   * is recorded only by {@link LauncherChannel.recordInstalled}. The release-log check is `@delo/release-verify`'s.
   * Nothing downloads a runtime until all of it passes. A log check that could not run does not stop the install: it
   * continues on the release's signature, and the home records that the check did not run (contract C18, "Behaviour
   * per client"). A log whose signed checkpoint contradicts the release refuses.
   * @param target - the version a person asked for, or `undefined` for the channel's current release.
   * @returns the release's version and the root it verified with.
   * @throws {InstallError} `DOWNLOAD_REFUSED`, `DOWNLOAD_FAILED`, `INSTALL_VERIFY_FAILED`, `RELEASE_NOT_OFFERED`,
   *   `RELEASE_LOG_FAILED` or `TRUST_STATE_INVALID`; no file appears under `runtimes/` on any of them. A log that does
   *   not answer, answers with no checkpoint its key signed, or whose checkpoint the witnesses have not cosigned is
   *   `unchecked`, which never refuses.
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
    this.options.progress?.({ step: 'resolved', channel: this.options.channel, version: pointer.release })
    const manifest = await this.downloader.bytes(this.source.files(pointer.release, pointer.manifest.name), pointer.manifest.length)
    const bundleName = bundleFileName(pointer.release)
    const bundle = await this.downloader.bytes(this.source.files(pointer.release, bundleName), RELEASE_LOG_BUNDLE_SIZE_LIMIT)
    const verified = verifyChannelRelease({
      root: root.metadata,
      timestamp,
      channel: this.options.channel,
      manifest: manifest.bytes,
      bundle: bundle.bytes,
      ...target === undefined ? {} : { target: brandString<SemanticVersion>(String(target)) },
    })
    this.options.progress?.({ step: 'signature-checked', version: pointer.release, rootVersion: root.metadata.version })
    const log = await this.checkLog({ root: root.metadata, version: pointer.release, manifest: manifest.bytes, bundle: bundle.bytes, now, transport: this.logFor(root.metadata), mode: 'enforce' })
    if (log.state === 'failed') {
      throw new InstallError('RELEASE_LOG_FAILED', `release ${pointer.release}`, `the release log failed its check (${String(log.refusal)}: ${String(log.detail)}); nothing was installed`)
    }
    this.options.progress?.({ step: 'log-checked', version: pointer.release, state: log.state, ...log.detail === undefined ? {} : { detail: log.detail } })
    const release: ChannelRelease = { version, root: root.metadata }
    this.resolved.set(version, { release, verified, manifestBytes: manifest.bytes, bundleBytes: bundle.bytes, log, checkedAt: now })
    return release
  }

  /**
   * Download a resolved release's platform archive and file list, check both against the manifest before extracting,
   * and extract the archive into the staging directory with contract C1's path checks.
   * @param release - the release {@link LauncherChannel.resolve} returned.
   * @param directory - a new, empty `staging/<16 hex>/` directory.
   * @returns the manifest, the file list and the release-log bundle, to keep beside the installation. Each download
   *   is held to the length the signed manifest gives it.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when a file is not the manifest's or the archive is not the list's;
   *   `ARCHIVE_REFUSED` when the archive holds an entry it may not; `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED`.
   */
  async fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes> {
    const resolved = this.resolved.get(release.version)
    if (resolved === undefined) throw new InstallError('INSTALL_VERIFY_FAILED', String(release.version), `${NO_RELEASE}: ${release.version} was not resolved before it was installed`)
    const { manifest } = resolved.verified
    const artifacts = manifest.runtime[this.options.platform]
    const format = archiveFormat(this.options.platform)
    // The store holds its lock while it fills, so no other install owns a download directory of a past run.
    await sweepDownloads(dirname(directory))
    const scratch = await mkdtemp(join(dirname(directory), DOWNLOAD_PREFIX))
    try {
      const archivePath = join(scratch, artifacts.archive.name)
      this.options.progress?.({ step: 'downloading', name: artifacts.archive.name, bytes: artifacts.archive.length })
      await this.downloader.file(this.source.files(manifest.version, artifacts.archive.name), Math.min(artifacts.archive.length, ARCHIVE_MAX_BYTES), archivePath)
      await verifyDownloadedFile(artifacts.archive, archivePath)
      const list = await this.downloader.bytes(this.source.files(manifest.version, artifacts.files.name), Math.min(artifacts.files.length, RELEASE_FILE_SIZE_LIMITS.files))
      const files = verifyPlatformFiles({ root: release.root, manifest, platform: this.options.platform, bytes: list.bytes })
      await extractArchive({ archive: archivePath, format, files, directory })
      return { manifest: resolved.manifestBytes, files: list.bytes, bundle: resolved.bundleBytes }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Record the release-log check state of a release the store installed: `verified`, or `unchecked` with the reason, in
   * `trust/release-log.json`. A caller runs it after the store's install returned, so a release the store refused
   * leaves no record.
   * @param release - the release {@link LauncherChannel.resolve} returned and the store installed.
   * @throws {InstallError} `TRUST_STATE_INVALID` when the record cannot be written; `INSTALL_VERIFY_FAILED` when the
   *   release was never resolved.
   */
  async recordInstalled(release: ChannelRelease): Promise<void> {
    const resolved = this.resolved.get(release.version)
    if (resolved === undefined) throw new InstallError('INSTALL_VERIFY_FAILED', String(release.version), `${NO_RELEASE}: ${release.version} was not resolved before it was recorded`)
    try {
      await recordResult(this.options.home, release.version, resolved.checkedAt, resolved.log)
    } catch (error) {
      throw new InstallError('TRUST_STATE_INVALID', this.options.home, `the release-log check state cannot be recorded: ${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * Run contract C18's check through `@delo/release-verify`, the one implementation of it, which also stores the
   * checkpoint the online check verified: a later install holds the log to it even when this install ends before the
   * runtime lands.
   * @param input - the check's input.
   * @returns the check's result.
   * @throws {InstallError} `TRUST_STATE_INVALID` when a record under `trust/` is refused or cannot be read or written;
   *   `RELEASE_LOG_FAILED` when this client's own check fails.
   */
  private async checkLog(input: Parameters<typeof checkAndStore>[1]): Promise<StartCheckResult> {
    try {
      return await checkAndStore(this.options.home, input)
    } catch (error) {
      if (error instanceof ReleaseLogInternalError) throw new InstallError('RELEASE_LOG_FAILED', `release ${input.version}`, `the release-log check failed in this client: ${error.message}; nothing was installed`, { cause: error })
      // What else the check throws is a record under `trust/` that is refused or cannot be read or written.
      const path = error instanceof HomeLayoutError ? error.path : join(this.options.home, DELO_HOME_ENTRIES.trust)
      throw new InstallError('TRUST_STATE_INVALID', path, `a release-log record under trust/ cannot be used: ${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * The log transport for the root being trusted.
   * @param root - that root.
   * @returns the transport the options give, or the one they make for the root.
   */
  private logFor(root: RootMetadata): ReleaseLogTransport {
    return typeof this.options.log === 'function' ? this.options.log(root) : this.options.log
  }

  /**
   * The root files this install walks forward from: the stored root once the launcher's shipped roots lead to it, so a
   * home that adopted a newer root never walks back to an older one; otherwise the shipped roots. A stored root that
   * no shipped root leads to is ignored here, as the launcher's remedy for it is to install again from the shipped
   * roots.
   * @returns the root files, oldest first, whose last file is the newest root trusted.
   */
  private async anchor(): Promise<readonly Uint8Array[]> {
    const shipped = this.options.roots
    const stored = await readStoredRootBytes(this.options.home)
    if (stored === undefined) return shipped
    try {
      const trusted = verifyStoredRoot({ stored, shipped, walked: await readStoredRootChain(this.options.home), source: 'trust/root.json' })
      return trusted.metadata.version > newestRootVersion(shipped) ? [stored] : shipped
    } catch (error) {
      if (!isInstallError(error, 'INSTALL_VERIFY_FAILED')) throw error
      return shipped
    }
  }

  /**
   * The root chain from the newest root this home trusts to the version a timestamp names: each later root file, exactly
   * one version above the one before, verified as it arrives and before the next is asked for.
   * @param target - the root version the timestamp names, which no signature has yet vouched for.
   * @returns the root files, oldest first.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the timestamp names a root older than the one this home trusts,
   *   or more than {@link MAX_ROOT_ROTATIONS} past it, or a root file does not verify as the next one;
   *   `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED` for a root file that cannot be fetched.
   */
  private async rootChain(target: number): Promise<readonly Uint8Array[]> {
    const roots = [...await this.anchor()]
    const newest = newestRootVersion(roots)
    if (target < newest) {
      throw new InstallError('INSTALL_VERIFY_FAILED', 'timestamp.json', `the timestamp names root ${String(target)}, older than root ${String(newest)}, which this home trusts; a root never moves backwards`)
    }
    if (target - newest > MAX_ROOT_ROTATIONS) {
      throw new InstallError('INSTALL_VERIFY_FAILED', 'timestamp.json', `the timestamp names root ${String(target)}, ${String(target - newest)} versions past root ${String(newest)}, which this home trusts; an install walks at most ${String(MAX_ROOT_ROTATIONS)}`)
    }
    for (let version = newest + 1; version <= target; version++) {
      const source = `${this.source.metadata}/root/${String(version)}.root.json`
      const root = await this.downloader.bytes(source, RELEASE_FILE_SIZE_LIMITS.root)
      try {
        walkRootChain([...roots.slice(-1), root.bytes])
      } catch (error) {
        throw new InstallError('INSTALL_VERIFY_FAILED', source, `root ${String(version)} does not follow root ${String(version - 1)}: ${messageOf(error)}`, { cause: error })
      }
      roots.push(root.bytes)
    }
    return roots
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

/** The prefix of a download directory under `staging/`. */
const DOWNLOAD_PREFIX = '.download-'

/**
 * Remove the download directories that earlier installs left under `staging/`. The caller holds the store's lock, so
 * none of them belongs to a running install; one survives only when a run ended before it could clean up.
 * @param staging - the store's `staging/` directory.
 */
async function sweepDownloads(staging: string): Promise<void> {
  for (const name of await readdir(staging)) {
    if (name.startsWith(DOWNLOAD_PREFIX)) await rm(join(staging, name), { recursive: true, force: true })
  }
}
