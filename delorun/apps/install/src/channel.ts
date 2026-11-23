/**
 * The release channel the launcher installs through: contract C2's client verification steps 1 to 5 over contract
 * C1's download rule, contract C18's bundle and online check before anything installs, and the extraction of the
 * verified archive into the runtime store's staging directory. {@link LauncherChannel.resolve} names and verifies the
 * release and records the root, timestamp and log checkpoint it proved under `trust/`;
 * {@link LauncherChannel.fill} then downloads that release's archive and file list, checks both against the manifest
 * before extracting, and returns the three signed files the store keeps beside the installation. `current` is never
 * touched here: the store switches it, and only an install of a store without one sets it.
 *
 * @module @delorun/install/channel
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import semver from 'semver'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ARCHIVE_MAX_BYTES, DELORUN_HOME_ENTRIES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_LOG_BUNDLE_SIZE_LIMIT } from '@delorun/contract-release-log'
import {
  RELEASE_FILE_SIZE_LIMITS,
  RELEASE_METADATA_ORIGIN,
  RELEASE_REPOSITORY_URL,
  RELEASE_SPARE_ORIGIN,
  isValidNotes,
  type ChannelPointer,
  type FileRef,
  type ReleaseChannel as ChannelName,
  type ReleaseManifest,
  type RootMetadata,
  type RuntimePlatform,
  type SemanticVersion,
  type TimestampMetadata,
} from '@delorun/contract-release-manifest'
import type { FilledRelease } from '@delorun/runtime-store'
import type { RuntimeChannel, ChannelRelease } from '@delorun/runtime-store'
import { parseRuntimeVersion } from '@delorun/runtime-store'
import { archiveFormat } from '@delorun/release-formats/archive/entry'
import { checkFileRef, walkRootChain, type TrustedRoot } from '@delorun/release-formats/sign/verify'
import { LOCAL_RELEASE_BUILDER } from '@delorun/release-formats/sign/schemas'
import { localBuilderAllowed } from './local-builder.ts'
import { HomeLayoutError } from '@delorun/home'
import { ReleaseLogInternalError, type ReleaseLogTransport } from '@delorun/release-verify/online'
import { checkAndStore, recordResult } from '@delorun/release-verify/record'
import type { StartCheckResult } from '@delorun/release-verify/start'
import { Downloader, type Downloaded } from './download.ts'
import { InstallError, isInstallError, messageOf } from './errors.ts'
import { extractArchive } from './extract.ts'
import type { InstallProgress } from './progress.ts'
import { readStoredRootBytes, readStoredRootChain, readStoredTimestamp, writeStoredRootChain, writeStoredTimestamp, writeTrustedRoot } from './state.ts'
import { newestRootVersion, rootVersionOf, trustedChain, verifyChannelRelease, verifyDownloadedFile, verifyPlatformFiles, verifyStoredRoot, verifyTimestampUnderRoots, verifyUnconfirmedRelease, type VerifiedChannelRelease } from './verify.ts'

/**
 * Where a release's files are published: one origin for all of them, `root/<n>.root.json` and `timestamp.json`
 * included, and the mirrors tried after it.
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
  /**
   * Origins tried, in order, after the primary one fails to serve a file. Absent for a single-origin source, such as a
   * staging channel.
   */
  readonly mirrors?: readonly ReleaseMirror[]
}

/** A mirror of a {@link ReleaseSource}; it serves the kinds of file it has a URL for and is skipped for the rest. */
export interface ReleaseMirror {
  /** The origin's host, as an install report names it. */
  readonly name: string
  /** The origin serving `root/<n>.root.json` and `timestamp.json`, without a trailing slash. */
  readonly metadata?: string
  /** The URL of one release file, as {@link ReleaseSource.files}. */
  readonly files?: (version: SemanticVersion, name: string) => string
}

/**
 * Contract C2's publication: every file from `releases.delorun.com`, then the version's GitHub release for release
 * files, then the spare host `releases.delo.run` for every file. A mirror is tried only when the origin before it
 * fails on the network or by HTTP status, or serves bytes that do not match the signed reference.
 */
export const RELEASE_SOURCE: ReleaseSource = {
  metadata: RELEASE_METADATA_ORIGIN,
  files: (version, name) => `${RELEASE_METADATA_ORIGIN}/releases/download/v${version}/${name}`,
  mirrors: [
    { name: 'github.com', files: (version, name) => `${RELEASE_REPOSITORY_URL}/releases/download/v${version}/${name}` },
    { name: new URL(RELEASE_SPARE_ORIGIN).hostname, metadata: RELEASE_SPARE_ORIGIN, files: (version, name) => `${RELEASE_SPARE_ORIGIN}/releases/download/v${version}/${name}` },
  ],
}

/** One origin that can serve a file, with the URL it would serve it at. */
interface Candidate {
  readonly origin: string
  readonly url: string
}

/** The shortest time between two byte or file counts the channel reports. */
const PROGRESS_INTERVAL_MS = 100

/** The most root versions one install walks past the root this home trusts; a timestamp that names more is refused unread. */
export const MAX_ROOT_ROTATIONS = 32

/** What a {@link LauncherChannel} needs. */
export interface LauncherChannelOptions {
  /** The resolved Delorun home, whose `trust/` records what verified. */
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
  /**
   * Whether the launcher's roots are a production build's, so a release signed by a local release build is refused
   * whatever the source. A source on the production publication is always refused.
   */
  readonly productionRoot?: boolean
  /**
   * The file digests {@link localBuilderAllowed} accepts as the preview root, for a spec whose throwaway root is not
   * the published one. The launcher never sets it: {@link PREVIEW_ROOT_SHA256} is the default.
   */
  readonly previewRoots?: readonly string[]
  /** Where the files are published; {@link RELEASE_SOURCE} by default. */
  readonly source?: ReleaseSource
  /** The downloader; contract C1's rule over this process's `fetch` by default. */
  readonly downloader?: Downloader
  /** The clock, in milliseconds; `Date.now` by default. */
  readonly now?: () => number
  /** Told of each step that finishes; nothing by default. */
  readonly progress?: (event: InstallProgress) => void
  /**
   * Install a release the channel's fresh timestamp does not confirm, after the person agrees. Absent by default: a
   * timestamp that cannot be read, has expired, or names another release then refuses the install.
   */
  readonly unconfirmed?: UnconfirmedInstall
}

/** What a person-supplied release (`--from`) may relax, and who asks. Only timestamp freshness is relaxed. */
export interface UnconfirmedInstall {
  /** The release to install when the timestamp cannot name it, such as the newest one a folder holds. */
  readonly version?: SemanticVersion
  /**
   * The lowest release this install may name, such as the version the home runs. The release the home's stored
   * timestamp names is a floor too. Without `belowFloor`, a lower release is refused.
   */
  readonly floor?: string
  /** Ask the person about a release below the floor too, as `repair --release` does; refused otherwise. */
  readonly belowFloor?: boolean
  /**
   * Ask the person whether to install on the release's signature and release-log entry alone.
   * @param question - the facts to show.
   * @returns true to install; false when the person declined or no terminal could ask.
   */
  readonly allow: (question: UnconfirmedQuestion) => Promise<boolean>
}

/** The facts a person is shown before an unconfirmed install. */
export interface UnconfirmedQuestion {
  /** The release. */
  readonly version: SemanticVersion
  /** Why the channel cannot confirm it. */
  readonly reason: string
  /** The floor the release is below, when it is. */
  readonly belowFloor?: string
}

/** A reason the fresh timestamp cannot confirm a release; the caller may ask the person about it. */
class Unconfirmable extends Error {
  /** The release the stale timestamp names, when it read. */
  readonly release: SemanticVersion | undefined
  /** The refusal to raise when nothing may be relaxed. */
  readonly refusal: unknown

  /** @param reason - why the channel cannot confirm the release. @param refusal - the original failure. @param release - the stale timestamp's release. */
  constructor(reason: string, refusal: unknown, release?: SemanticVersion) {
    super(reason)
    this.name = 'Unconfirmable'
    this.refusal = refusal
    this.release = release
  }
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

/** The channel's current release as the update check reads it. */
export interface NewestRelease {
  /** The verified manifest. */
  readonly manifest: ReleaseManifest
  /** The `version` of the verified timestamp that names it. */
  readonly timestamp: number
}

/** The channel's current release as {@link LauncherChannel} verified it, before any log check. */
interface Current {
  readonly root: TrustedRoot
  readonly timestamp: TimestampMetadata
  readonly pointer: ChannelPointer
  readonly verified: VerifiedChannelRelease
  readonly manifestBytes: Buffer
  readonly bundleBytes: Buffer
}

/** The release {@link LauncherChannel.resolve} proved, by the fresh timestamp or by the person's agreement. */
interface Proven {
  readonly root: TrustedRoot
  readonly release: SemanticVersion
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

  /** The home, the platform, the embedded roots, the channel, the log, the source, the downloader and the clock. */
  private readonly options: LauncherChannelOptions

  /**
   * @param options - the home, the platform, the embedded roots, the channel, the log, the source, the downloader and
   *   the clock.
   */
  constructor(options: LauncherChannelOptions) {
    this.options = options
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
   * is recorded only by {@link LauncherChannel.recordInstalled}. The release-log check is `@delorun/release-verify`'s.
   * Nothing downloads a runtime until all of it passes. A log check that could not run does not stop the install: it
   * continues on the release's signature, and the home records that the check did not run (contract C18, "Behaviour
   * per client"). A log whose signed checkpoint contradicts the release refuses.
   * @param target - the version a person asked for, or `undefined` for the channel's current release.
   * @returns the release's version and the root it verified with.
   * @throws {InstallError} `DOWNLOAD_REFUSED`, `DOWNLOAD_FAILED`, `INSTALL_VERIFY_FAILED`, `RELEASE_NOT_OFFERED`,
   *   `PLATFORM_NOT_RELEASED` when the verified manifest lists no runtime for this computer's platform,
   *   `RELEASE_LOG_FAILED`, also for a release that publishes no bundle, or `TRUST_STATE_INVALID`; no file appears
   *   under `runtimes/` on any of them. A log that does not answer, answers with no checkpoint its key signed, or whose
   *   checkpoint the witnesses have not cosigned is `unchecked`, which never refuses.
   */
  async resolve(target?: RuntimeVersion): Promise<ChannelRelease> {
    const now = Math.floor(this.now() / 1000)
    const current = await this.currentOrUnconfirmed(now, target)
    const { release: named, root } = current
    const released = Object.keys(current.verified.manifest.runtime)
    if (!released.includes(this.options.platform)) {
      throw new InstallError('PLATFORM_NOT_RELEASED', String(named), `${this.options.platform} is not in this release, which publishes a runtime for ${released.join(', ')} only`)
    }
    const log = await this.checkLog({ root: root.metadata, version: named, manifest: current.manifestBytes, bundle: current.bundleBytes, missingBundle: 'failed', now, transport: this.logFor(root.metadata), mode: 'enforce' })
    if (log.state === 'failed') {
      throw new InstallError('RELEASE_LOG_FAILED', `release ${named}`, `the release log failed its check (${String(log.refusal)}: ${String(log.detail)}); nothing was installed`)
    }
    this.options.progress?.({ step: 'log-checked', version: named, state: log.state, ...log.detail === undefined ? {} : { detail: log.detail } })
    const version = asVersion(named)
    const release: ChannelRelease = { version, root: root.metadata }
    this.resolved.set(version, { release, verified: current.verified, manifestBytes: current.manifestBytes, bundleBytes: current.bundleBytes, log, checkedAt: now })
    return release
  }

  /**
   * Name and verify the channel's current release without installing it or recording anything: the same root chain,
   * timestamp, manifest and release-log bundle checks as {@link LauncherChannel.resolve}, with the timestamp held to the
   * stored one, and no online log check. Nothing under `trust/` changes, so a check running beside an install or an
   * update never moves what they rely on.
   * @returns the verified manifest of the channel's current release, and the version of the timestamp that names it.
   * @throws {InstallError} `DOWNLOAD_REFUSED`, `DOWNLOAD_FAILED`, `INSTALL_VERIFY_FAILED`, `RELEASE_METADATA_INVALID`,
   *   `RELEASE_LOG_FAILED` or `TRUST_STATE_INVALID`, as {@link LauncherChannel.resolve} does before its log check.
   */
  async newest(): Promise<NewestRelease> {
    const current = await this.current(Math.floor(this.now() / 1000), undefined, 'read-only')
    return { manifest: current.verified.manifest, timestamp: current.timestamp.version }
  }

  /**
   * Download the release notes a verified manifest names, checked against the signed length and SHA-256 and against
   * {@link isValidNotes}. The check never trusts a notes file by its name or its origin alone.
   * @param manifest - a manifest {@link LauncherChannel.newest} verified.
   * @returns the notes' bytes, or `undefined` when the manifest names none.
   * @throws {InstallError} `DOWNLOAD_REFUSED`, `DOWNLOAD_FAILED`, or `INSTALL_VERIFY_FAILED` when the length or digest
   *   differs or the bytes are not valid notes.
   */
  async notesOf(manifest: ReleaseManifest): Promise<Uint8Array | undefined> {
    const ref = manifest.notes
    if (ref === undefined) return undefined
    const downloaded = await this.fetchFrom(this.fileCandidates(manifest.version, ref.name), ref.name, url => this.downloader.bytes(url, ref.length), value => {
      checkBytes(ref, value.bytes)
      if (!isValidNotes(value.bytes)) throw new InstallError('INSTALL_VERIFY_FAILED', ref.name, `${ref.name} is not valid release notes`)
    })
    return downloaded.bytes
  }

  /** The origins that serve a metadata file, primary first. */
  private metadataCandidates(path: string): Candidate[] {
    const primary = { origin: new URL(this.source.metadata).hostname, url: `${this.source.metadata}/${path}` }
    const mirrors = (this.source.mirrors ?? []).flatMap(mirror => mirror.metadata === undefined ? [] : [{ origin: mirror.name, url: `${mirror.metadata}/${path}` }])
    return [primary, ...mirrors]
  }

  /** The origins that serve a release file, primary first. */
  private fileCandidates(version: SemanticVersion, name: string): Candidate[] {
    const primary = { origin: new URL(this.source.files(version, name)).hostname, url: this.source.files(version, name) }
    const mirrors = (this.source.mirrors ?? []).flatMap(mirror => mirror.files === undefined ? [] : [{ origin: mirror.name, url: mirror.files(version, name) }])
    return [primary, ...mirrors]
  }

  /**
   * Fetch one file from the first origin that serves bytes passing `check`. The next origin is tried only after a
   * `DOWNLOAD_FAILED` (network or HTTP status) or a failed `check`; a refused download (`DOWNLOAD_REFUSED`) and the
   * last origin's failure are thrown as they are. Bytes from a later origin pass the same `check`, and the skipped
   * origins are reported as `origin-skipped`.
   * @param candidates - the origins in order.
   * @param name - the file's name for reports.
   * @param get - fetches one URL.
   * @param check - verifies what `get` returned against its signed reference; nothing to check when absent.
   * @returns what `get` returned for the origin that served verified bytes.
   */
  private async fetchFrom<T>(candidates: readonly Candidate[], name: string, get: (url: string) => Promise<T>, check?: (value: T) => unknown): Promise<T> {
    const skipped: Array<{ readonly origin: string, readonly reason: string }> = []
    for (const [index, candidate] of candidates.entries()) {
      const last = index === candidates.length - 1
      let value: T
      try {
        value = await get(candidate.url)
      } catch (error) {
        if (last || !isInstallError(error, 'DOWNLOAD_FAILED')) throw error
        skipped.push({ origin: candidate.origin, reason: messageOf(error) })
        continue
      }
      try {
        await check?.(value)
      } catch (error) {
        if (last) throw error
        skipped.push({ origin: candidate.origin, reason: messageOf(error) })
        continue
      }
      for (const failure of skipped) this.options.progress?.({ step: 'origin-skipped', name, failed: failure.origin, reason: failure.reason, served: candidate.origin })
      return value
    }
    throw new InstallError('DOWNLOAD_FAILED', name, `no origin serves ${name}`)
  }

  /**
   * Contract C2's client verification steps 1 to 3 and contract C18's bundle check over the channel's current release.
   * @param now - the clock, in Unix seconds.
   * @param target - the version a person asked for, if any.
   * @param trust - `record` writes the verified roots and timestamp under `trust/` and reports progress, as an install
   *   does; `read-only` writes and reports nothing.
   * @returns what verified, with the bytes an install keeps.
   */
  private async current(now: number, target: RuntimeVersion | undefined, trust: 'record' | 'read-only'): Promise<Current> {
    const unconfirmed = this.options.unconfirmed !== undefined
    if (trust === 'record') this.options.progress?.({ step: 'resolving', channel: this.options.channel })
    // fetchFrom throws a DOWNLOAD_FAILED only for the last origin, so only then is the channel unreachable.
    const stamp = await this.fetchFrom(this.metadataCandidates('timestamp.json'), 'timestamp.json', url => this.downloader.bytes(url, RELEASE_FILE_SIZE_LIMITS.timestamp)).catch((error: unknown) => {
      if (unconfirmed && isInstallError(error, 'DOWNLOAD_FAILED')) throw new Unconfirmable(`the release channel cannot be reached for timestamp.json (${messageOf(error)})`, error)
      throw error
    })
    const roots = await this.rootChain(rootVersionOf(stamp.bytes))
    const stored = await readStoredTimestamp(this.options.home)
    const request = { roots, timestamp: stamp.bytes, now, ...stored === undefined ? {} : { stored } }
    let verifiedStamp: ReturnType<typeof verifyTimestampUnderRoots>
    try {
      verifiedStamp = verifyTimestampUnderRoots(request)
    } catch (error) {
      if (!unconfirmed) throw error
      // Only an expired timestamp may be waived: it must still verify in every other way.
      let stale: ReturnType<typeof verifyTimestampUnderRoots>
      try {
        stale = verifyTimestampUnderRoots({ ...request, allowExpired: true })
      } catch (_notOnlyExpired) {
        // A signature, version or root failure beyond expiry: the original refusal stands.
        throw error
      }
      throw new Unconfirmable(`its timestamp is out of date (${messageOf(error)})`, error, stale.timestamp.channels[this.options.channel].release)
    }
    const { root, timestamp } = verifiedStamp
    const record = trust === 'record'
    if (record) {
      await writeTrustedRoot(this.options.home, roots.at(-1)!)
      await writeStoredRootChain(this.options.home, roots)
      await writeStoredTimestamp(this.options.home, stamp.bytes)
    }
    const pointer = timestamp.channels[this.options.channel]
    if (pointer.manifest.length > RELEASE_FILE_SIZE_LIMITS.manifest) {
      throw new InstallError('INSTALL_VERIFY_FAILED', 'timestamp.json', `the timestamp names a ${this.options.channel} manifest of ${String(pointer.manifest.length)} bytes, above the limit of ${String(RELEASE_FILE_SIZE_LIMITS.manifest)}; it was not fetched`)
    }
    if (record) {
      // An install refuses a version the store cannot name before it downloads anything more.
      asVersion(pointer.release)
      this.options.progress?.({ step: 'resolved', channel: this.options.channel, version: pointer.release })
    }
    const manifest = await this.fetchFrom(this.fileCandidates(pointer.release, pointer.manifest.name), pointer.manifest.name, url => this.downloader.bytes(url, pointer.manifest.length), downloaded => checkBytes(pointer.manifest, downloaded.bytes))
    const bundle = await this.bundleOf(pointer.release)
    let verified: VerifiedChannelRelease
    try {
      verified = verifyChannelRelease({
        root: root.metadata,
        timestamp,
        channel: this.options.channel,
        manifest: manifest.bytes,
        bundle: bundle.bytes,
        ...target === undefined ? {} : { target: brandString<SemanticVersion>(String(target)) },
      })
    } catch (error) {
      if (unconfirmed && isInstallError(error, 'RELEASE_NOT_OFFERED')) throw new Unconfirmable(`release ${String(target)} is not the one the ${this.options.channel} channel currently names`, error, pointer.release)
      throw error
    }
    this.refuseLocalRelease(verified.manifest, pointer.release, root)
    if (record) this.options.progress?.({ step: 'signature-checked', version: pointer.release, rootVersion: root.metadata.version })
    return { root, timestamp, pointer, verified, manifestBytes: manifest.bytes, bundleBytes: bundle.bytes }
  }

  /**
   * Download a release's release-log bundle.
   * @param version - the release.
   * @returns the bundle file.
   * @throws {InstallError} `RELEASE_LOG_FAILED` naming the file when the release publishes no bundle (the host answered
   *   404), which is the log check's failure, not the network's; `DOWNLOAD_FAILED` otherwise.
   */
  private async bundleOf(version: SemanticVersion): Promise<Downloaded> {
    return this.fetchFrom(this.fileCandidates(version, bundleFileName(version)), bundleFileName(version), url => this.downloader.bytes(url, RELEASE_LOG_BUNDLE_SIZE_LIMIT)).catch((error: unknown) => {
      if (isInstallError(error, 'DOWNLOAD_FAILED') && error.status === 404) {
        throw new InstallError('RELEASE_LOG_FAILED', bundleFileName(version), `release ${version} publishes no release-log bundle (the host answered 404), so its log entry cannot be verified; nothing was installed`, { cause: error })
      }
      throw error
    })
  }

  /**
   * {@link LauncherChannel.current} with the person's agreement: when the fresh timestamp cannot confirm the release
   * and the channel was given an {@link UnconfirmedInstall}, install the release named by the person on its targets
   * signature and release-log bundle alone, if the person agrees. The root chain, the signature, the bundle, a failed
   * online log check and the floor are never relaxed, and the stored timestamp is not replaced.
   * @param now - the clock, in Unix seconds.
   * @param target - the version a person asked for, if any.
   * @returns what verified.
   * @throws {InstallError} `RELEASE_NOT_OFFERED` when the release is below the floor or the person declined; the
   *   failures of {@link LauncherChannel.current} otherwise.
   */
  private async currentOrUnconfirmed(now: number, target: RuntimeVersion | undefined): Promise<Proven> {
    try {
      const current = await this.current(now, target, 'record')
      return { root: current.root, release: current.pointer.release, verified: current.verified, manifestBytes: current.manifestBytes, bundleBytes: current.bundleBytes }
    } catch (error) {
      const unconfirmed = this.options.unconfirmed
      if (!(error instanceof Unconfirmable) || unconfirmed === undefined) throw error
      const named = target === undefined ? unconfirmed.version ?? error.release : brandString<SemanticVersion>(String(target))
      if (named === undefined) throw error.refusal
      return this.unconfirmedRelease(now, named, error.message, unconfirmed)
    }
  }

  /**
   * Verify a release on its signature and release-log bundle alone, after the floor and the person's agreement.
   * @param now - the clock, in Unix seconds.
   * @param version - the release.
   * @param reason - why the timestamp cannot confirm it.
   * @param unconfirmed - the floor and the question.
   * @returns what verified.
   * @throws {InstallError} `RELEASE_NOT_OFFERED` below the floor (when not asked about) or when the person declined;
   *   the verification failures otherwise.
   */
  private async unconfirmedRelease(now: number, version: SemanticVersion, reason: string, unconfirmed: UnconfirmedInstall): Promise<Proven> {
    const floors = [unconfirmed.floor, await storedChannelRelease(this.options.home, this.options.channel)].filter((value): value is string => value !== undefined && semver.valid(value) !== null)
    const floor = floors.sort(semver.compare).at(-1)
    const below = floor !== undefined && semver.valid(version) !== null && semver.lt(version, floor) ? floor : undefined
    if (below !== undefined && unconfirmed.belowFloor !== true) {
      throw new InstallError('RELEASE_NOT_OFFERED', `release ${version}`, `TARGET_LOWER: release ${version} is older than release ${below}, which this home runs or has seen the channel offer; the release below it is reached only with delorun recover rollback`)
    }
    const roots = await this.availableRoots()
    const chain = trustedChain(roots, now)
    const root = chain.at(-1)!
    const manifest = await this.fetchFrom(this.fileCandidates(version, manifestFileName(version)), manifestFileName(version), url => this.downloader.bytes(url, RELEASE_FILE_SIZE_LIMITS.manifest))
    const bundle = await this.bundleOf(version)
    const verified = verifyUnconfirmedRelease({ root: root.metadata, channel: this.options.channel, manifest: manifest.bytes, bundle: bundle.bytes, version })
    this.refuseLocalRelease(verified.manifest, version, root)
    const agreed = await unconfirmed.allow({ version, reason, ...below === undefined ? {} : { belowFloor: below } })
    if (!agreed) throw new InstallError('RELEASE_NOT_OFFERED', `release ${version}`, `you did not agree to install release ${version} without the channel confirming it, so nothing was installed`)
    // The roots verified; the stale timestamp is never stored, so the stored one never goes back.
    await writeTrustedRoot(this.options.home, roots.at(-1)!)
    await writeStoredRootChain(this.options.home, roots)
    return { root, release: version, verified, manifestBytes: manifest.bytes, bundleBytes: bundle.bytes }
  }

  /**
   * Refuse a release the local release build signed when the verifying root is a production root: the channel fetches
   * from the production publication, or the options say the launcher's roots are production roots, as they do for a
   * `--from` folder. {@link localBuilderAllowed} is the one exception: a 0.x release under the preview root (A369,
   * A506).
   * @param manifest - the verified manifest.
   * @param version - the release, for the message.
   * @param root - the root that verified the release.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the manifest names {@link LOCAL_RELEASE_BUILDER} and
   *   {@link localBuilderAllowed} does not allow it.
   */
  private refuseLocalRelease(manifest: ReleaseManifest, version: string, root: TrustedRoot): void {
    const production = this.options.productionRoot === true || this.source.metadata === RELEASE_METADATA_ORIGIN
    if (!production || !manifest.rebuild.builders.some(builder => builder.name === LOCAL_RELEASE_BUILDER)) return
    if (localBuilderAllowed(manifest.version, root, this.options.previewRoots)) return
    throw new InstallError('INSTALL_VERIFY_FAILED', `${this.options.channel} manifest`, `release ${version} names the builder "${LOCAL_RELEASE_BUILDER}": it was built by local-release.ts, which no second builder rebuilt and no allowed signer tagged, and the production channel installs such a release only while it is a 0.x release under the preview root`)
  }

  /**
   * The root chain from the root this home trusts through every later root the source holds, without a timestamp to
   * say how far it goes: each file verifies as the next root before the one after it is asked for. A root the source
   * lacks ends the walk.
   * @returns the root files, oldest first.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when a root file does not follow the one before it.
   */
  private async availableRoots(): Promise<readonly Uint8Array[]> {
    const roots = [...await this.anchor()]
    const last = newestRootVersion(roots) + MAX_ROOT_ROTATIONS
    for (let version = newestRootVersion(roots) + 1; version <= last; version++) {
      const source = `${this.source.metadata}/root/${String(version)}.root.json`
      const root = await this.fetchFrom(this.metadataCandidates(`root/${String(version)}.root.json`), source, url => this.downloader.bytes(url, RELEASE_FILE_SIZE_LIMITS.root)).catch((error: unknown) => {
        if (isInstallError(error, 'DOWNLOAD_FAILED')) return undefined
        throw error
      })
      if (root === undefined) break
      try {
        walkRootChain([...roots.slice(-1), root.bytes])
      } catch (error) {
        throw new InstallError('INSTALL_VERIFY_FAILED', source, `root ${String(version)} does not follow root ${String(version - 1)}: ${messageOf(error)}`, { cause: error })
      }
      roots.push(root.bytes)
    }
    return roots
  }

  /**
   * A progress callback that reports at most ten times a second and always reports the last count, so a display redraws
   * without a flood of events.
   * @param event - makes the event from the counts.
   * @param last - the count that ends the work.
   * @returns the callback.
   */
  private throttled<Args extends readonly number[]>(event: (...counts: Args) => InstallProgress, last: number): (...counts: Args) => void {
    let sent = Number.NEGATIVE_INFINITY
    return (...counts) => {
      const at = this.now()
      if (at - sent < PROGRESS_INTERVAL_MS && counts[0] !== last) return
      sent = at
      this.options.progress?.(event(...counts))
    }
  }

  /**
   * Download a resolved release's platform archive and file list, check both against the manifest before extracting,
   * and extract the archive into the staging directory with contract C1's path checks.
   * @param release - the release {@link LauncherChannel.resolve} returned.
   * @param directory - a new, empty `staging/<16 hex>/` directory.
   * @returns the manifest, the file list and the release-log bundle, to keep beside the installation, and each
   *   extracted file's identity against the verified file list. Each download is held to the length the signed
   *   manifest gives it.
   * @throws {InstallError} `INSTALL_VERIFY_FAILED` when a file is not the manifest's or the archive is not the list's;
   *   `ARCHIVE_REFUSED` when the archive holds an entry it may not; `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED`.
   */
  async fill(release: ChannelRelease, directory: string): Promise<FilledRelease> {
    const resolved = this.resolved.get(release.version)
    if (resolved === undefined) throw new InstallError('INSTALL_VERIFY_FAILED', String(release.version), `${NO_RELEASE}: ${release.version} was not resolved before it was installed`)
    const { manifest } = resolved.verified
    // resolve() refused a platform the manifest does not list.
    const artifacts = manifest.runtime[this.options.platform]!
    const format = archiveFormat(this.options.platform)
    // The store holds its lock while it fills, so no other install owns a download directory of a past run.
    await sweepDownloads(dirname(directory))
    const scratch = await mkdtemp(join(dirname(directory), DOWNLOAD_PREFIX))
    try {
      const archivePath = join(scratch, artifacts.archive.name)
      const { name, length } = artifacts.archive
      this.options.progress?.({ step: 'downloading', name, bytes: length })
      await this.fetchFrom(this.fileCandidates(manifest.version, name), name, async (url) => {
        await rm(archivePath, { force: true })
        const onBytes = this.throttled((received: number) => ({ step: 'download-bytes', name, received, total: length }), length)
        const written = await this.downloader.file(url, Math.min(length, ARCHIVE_MAX_BYTES), archivePath, onBytes)
        this.options.progress?.({ step: 'downloaded', name, bytes: written.length })
      }, async () => {
        await verifyDownloadedFile(artifacts.archive, archivePath)
        this.options.progress?.({ step: 'download-verified', name })
      })
      const list = await this.fetchFrom(this.fileCandidates(manifest.version, artifacts.files.name), artifacts.files.name, url => this.downloader.bytes(url, Math.min(artifacts.files.length, RELEASE_FILE_SIZE_LIMITS.files)), downloaded => checkBytes(artifacts.files, downloaded.bytes))
      const files = verifyPlatformFiles({ root: release.root, manifest, platform: this.options.platform, bytes: list.bytes })
      this.options.progress?.({ step: 'unpacking', files: files.files.length })
      const onFile = this.throttled((written: number, total: number) => ({ step: 'unpack-files', written, total }), files.files.length)
      const extracted = await extractArchive({ archive: archivePath, format, files, directory, onFile })
      return { manifest: resolved.manifestBytes, files: list.bytes, bundle: resolved.bundleBytes, staged: { fileList: artifacts.files.sha256, identities: extracted.identities } }
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
   * Run contract C18's check through `@delorun/release-verify`, the one implementation of it, which also stores the
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
      const path = error instanceof HomeLayoutError ? error.path : join(this.options.home, DELORUN_HOME_ENTRIES.trust)
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
      const root = await this.fetchFrom(this.metadataCandidates(`root/${String(version)}.root.json`), source, url => this.downloader.bytes(url, RELEASE_FILE_SIZE_LIMITS.root))
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
 * Check downloaded bytes against their signed reference.
 * @param ref - the reference.
 * @param bytes - the downloaded bytes.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the length or SHA-256 differs.
 */
function checkBytes(ref: FileRef, bytes: Uint8Array): void {
  try {
    checkFileRef(ref, bytes)
  } catch (error) {
    throw new InstallError('INSTALL_VERIFY_FAILED', ref.name, messageOf(error), { cause: error })
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

/**
 * The manifest's name for a release (contract C2's release files).
 * @param version - the release.
 * @returns `delorun-<version>.manifest.json`.
 */
export function manifestFileName(version: SemanticVersion): string {
  return `delorun-${version}.manifest.json`
}

/**
 * The release the home's stored timestamp names for a channel, which is the lowest a release installs without a
 * person's explicit downgrade.
 * @param home - the resolved Delorun home.
 * @param channel - the person's channel.
 * @returns the version, or `undefined` when the home stores no timestamp.
 */
export async function storedChannelRelease(home: string, channel: ChannelName): Promise<string | undefined> {
  const stored = await readStoredTimestamp(home)
  if (stored === undefined) return undefined
  const envelope = JSON.parse(Buffer.from(stored.bytes).toString('utf8')) as { signed?: { channels?: Partial<Record<ChannelName, { release?: unknown }>> } }
  const release = envelope.signed?.channels?.[channel]?.release
  return typeof release === 'string' ? release : undefined
}
