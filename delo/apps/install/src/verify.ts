/**
 * Contract C2's client verification, steps 1 to 4, and step 5's digest checks, as the install path runs them before
 * anything lands under `~/.delo/runtimes/`: the root chain from the root a launcher embeds, the timestamp's signature,
 * lifetime, expiry and version against the stored one, the channel's manifest by the timestamp's digest and the
 * targets signature, the platform's file list, the archive's digest, and contract C18's release-log bundle. Every
 * refusal is {@link InstallError}: a signature, digest or freshness failure is `INSTALL_VERIFY_FAILED`, and a
 * release-log failure is `RELEASE_LOG_FAILED` with C18's reason code.
 *
 * @module @delo/install/verify
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  RELEASE_FILE_SIZE_LIMITS,
  type FileRef,
  type ReleaseChannel,
  type ReleaseManifest,
  type RootMetadata,
  type RuntimeFileList,
  type RuntimePlatform,
  type SemanticVersion,
  type TimestampMetadata,
} from '@delo/contract-release-manifest'
import { LogVerificationError, readBundle, verifyBundle, type VerifiedBundle } from '@delo/release-formats/log/bundle'
import { canonicalJson, toJsonValue } from '@delo/release-formats/sign/json'
import { channelAccepts, readRoot, trustRootChain, verifyChannelManifest, verifyFileList, verifySignedManifest, verifyTimestamp, walkRootChain, type TrustedRoot } from '@delo/release-formats/sign/verify'
import { InstallError, messageOf } from './errors.ts'
import type { StoredTimestamp } from './state.ts'

/** Why a C2 check refused, as an {@link InstallError}. */
function refused(source: string, error: unknown): InstallError {
  return error instanceof InstallError ? error : new InstallError('INSTALL_VERIFY_FAILED', source, messageOf(error), { cause: error })
}

/**
 * The version of the root a timestamp names, read from the unsigned field that decides which root file to fetch. It
 * is a fetch hint only: nothing installs until {@link verifyTimestampUnderRoots} verifies the signature over it.
 * @param timestamp - the timestamp file's bytes.
 * @returns its `signed.root.version`.
 * @throws {InstallError} `RELEASE_METADATA_INVALID` when the file is not JSON naming a positive integer version.
 */
export function rootVersionOf(timestamp: Uint8Array): number {
  let version: unknown
  try {
    const envelope: unknown = JSON.parse(Buffer.from(timestamp).toString('utf8'))
    version = typeof envelope === 'object' && envelope !== null
      ? (envelope as { readonly signed?: { readonly root?: { readonly version?: unknown } } }).signed?.root?.version
      : undefined
  } catch (error) {
    throw new InstallError('RELEASE_METADATA_INVALID', 'timestamp', `timestamp.json is not JSON: ${messageOf(error)}`, { cause: error })
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new InstallError('RELEASE_METADATA_INVALID', 'timestamp', 'timestamp.json names no root version')
  }
  return version
}

/**
 * The version of the newest root in a chain, which is how far a launcher's trust has come and the version every walk
 * starts from.
 * @param roots - the root files, oldest first.
 * @returns the newest root's version.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when the chain is empty; `INSTALL_VERIFY_FAILED` when its newest file does
 *   not verify with its own root threshold.
 */
export function newestRootVersion(roots: readonly Uint8Array[]): number {
  if (roots.length === 0) throw new InstallError('NO_TRUSTED_ROOT', 'root', 'the launcher embeds no root, so no release can be verified')
  try {
    return readRoot(roots.at(-1)!).metadata.version
  } catch (error) {
    throw refused('root', error)
  }
}

/** What verifying a timestamp needs. */
export interface TimestampRequest {
  /** The root files, oldest first: the root the launcher embeds and each root it walked to, which must be contiguous. */
  readonly roots: readonly Uint8Array[]
  /** `timestamp.json`'s bytes. */
  readonly timestamp: Uint8Array
  /** The client's clock in Unix seconds. */
  readonly now: number
  /** The newest timestamp verified before, when the client stored one. */
  readonly stored?: StoredTimestamp
  /** Accept a timestamp whose expiry has passed; its signature, lifetime, issue time, version and root still hold. */
  readonly allowExpired?: boolean
}

/** A verified root chain and timestamp. */
export interface RootAndTimestamp {
  /** The chain, oldest first; the last entry is the trusted root. */
  readonly chain: readonly TrustedRoot[]
  /** The trusted root: the newest of the chain. */
  readonly root: TrustedRoot
  /** The verified timestamp. */
  readonly timestamp: TimestampMetadata
}

/**
 * Verify contract C2's steps 1 and 2: the root chain from the embedded root, its expiry against the clock, then the
 * timestamp's signature, its three-day lifetime, its expiry and its version against the stored one.
 * @param request - the chain, the timestamp, the clock and the stored timestamp.
 * @returns the trusted root and the timestamp.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` naming the failed rule, which includes an expired root, an expired or
 *   replayed timestamp, and a chain that skips a version.
 */
export function verifyTimestampUnderRoots(request: TimestampRequest): RootAndTimestamp {
  let chain: TrustedRoot[]
  try {
    chain = trustRootChain(request.roots, request.now)
  } catch (error) {
    throw refused('root', error)
  }
  const root = chain.at(-1)!
  let timestamp: TimestampMetadata
  try {
    timestamp = verifyTimestamp(root, request.timestamp, request.now, request.stored, { allowExpired: request.allowExpired === true })
  } catch (error) {
    throw refused('timestamp.json', error)
  }
  return { chain, root, timestamp }
}

/** What verifying a channel's release needs. */
export interface ReleaseRequest {
  /** The trusted root. */
  readonly root: RootMetadata
  /** The verified timestamp. */
  readonly timestamp: TimestampMetadata
  /** The channel whose current release is installed. */
  readonly channel: ReleaseChannel
  /** The manifest file's bytes. */
  readonly manifest: Uint8Array
  /** The release-log bundle's bytes. */
  readonly bundle: Uint8Array
  /** The version a person asked for, when one was named. */
  readonly target?: SemanticVersion
}

/** A verified release, with the log facts its online check starts from. */
export interface VerifiedChannelRelease {
  /** The manifest. */
  readonly manifest: ReleaseManifest
  /** The log checkpoint the verified bundle carries. */
  readonly log: VerifiedBundle
}

/**
 * Verify contract C2's step 3 and contract C18's bundle: the manifest is the file the fresh timestamp names for the
 * channel, its targets threshold signs it, the version a person asked for is that release, and the bundle's entry,
 * inclusion proof and witness cosignature verify with the trusted root.
 * @param request - the root, the timestamp, the channel, the manifest, the bundle and the requested version.
 * @returns the manifest and the bundle's checkpoint facts.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the manifest is not the channel's or does not verify;
 *   `RELEASE_NOT_OFFERED` when a requested version is not the release the timestamp names; `RELEASE_LOG_FAILED` when
 *   the bundle fails C18's checks.
 */
export function verifyChannelRelease(request: ReleaseRequest): VerifiedChannelRelease {
  let manifest: ReleaseManifest
  try {
    manifest = verifyChannelManifest(request.root, request.timestamp, request.channel, request.manifest)
  } catch (error) {
    throw refused(`${request.channel} manifest`, error)
  }
  if (request.target !== undefined && manifest.version !== request.target) {
    throw new InstallError('RELEASE_NOT_OFFERED', `${request.channel} manifest`, `the ${request.channel} channel names release ${manifest.version}, not ${request.target}; a release the fresh timestamp does not name is not installed`)
  }
  return { manifest, log: verifyReleaseBundle(request.root, request.manifest, manifest, request.bundle) }
}

/**
 * Verify contract C18's bundle of a manifest: its entry, inclusion proof and witness cosignature.
 * @param root - the trusted root.
 * @param manifestBytes - the manifest file.
 * @param manifest - the verified manifest.
 * @param bundleBytes - the bundle file.
 * @returns the bundle's checkpoint facts.
 * @throws {InstallError} `RELEASE_LOG_FAILED` when the bundle does not read or fails C18's checks.
 */
function verifyReleaseBundle(root: RootMetadata, manifestBytes: Uint8Array, manifest: ReleaseManifest, bundleBytes: Uint8Array): VerifiedBundle {
  let bundle
  try {
    bundle = readBundle(bundleBytes)
  } catch (error) {
    throw new InstallError('RELEASE_LOG_FAILED', 'release-log bundle', `the release-log bundle does not read: ${messageOf(error)}`, { cause: error })
  }
  try {
    return verifyBundle(root, manifestBytes, manifest.version, bundle)
  } catch (error) {
    if (error instanceof LogVerificationError) {
      throw new InstallError('RELEASE_LOG_FAILED', 'release-log bundle', `${error.failure}: ${error.message}`, { cause: error })
    }
    throw new InstallError('RELEASE_LOG_FAILED', 'release-log bundle', messageOf(error), { cause: error })
  }
}

/** What verifying a release a person supplied, without a timestamp, needs. */
export interface UnconfirmedReleaseRequest {
  /** The trusted root. */
  readonly root: RootMetadata
  /** The channel whose releases are accepted. */
  readonly channel: ReleaseChannel
  /** The manifest file's bytes. */
  readonly manifest: Uint8Array
  /** The release-log bundle's bytes. */
  readonly bundle: Uint8Array
  /** The release the person asked for. */
  readonly version: SemanticVersion
}

/**
 * Verify a release no fresh timestamp names: the manifest's targets signature and contract C18's bundle (entry,
 * inclusion proof and witness). Only the timestamp's freshness is missing; nothing else is relaxed.
 * @param request - the root, the channel, the manifest, the bundle and the release.
 * @returns the manifest and the bundle's checkpoint facts.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the manifest is not signed by the targets threshold, is not the
 *   asked release or is of a channel this one does not accept; `RELEASE_LOG_FAILED` when the bundle fails.
 */
export function verifyUnconfirmedRelease(request: UnconfirmedReleaseRequest): VerifiedChannelRelease {
  let manifest: ReleaseManifest
  try {
    manifest = verifySignedManifest(request.root, request.manifest)
  } catch (error) {
    throw refused(`${request.channel} manifest`, error)
  }
  if (manifest.version !== request.version || !channelAccepts(request.channel, manifest.channel)) {
    throw new InstallError('INSTALL_VERIFY_FAILED', `${request.channel} manifest`, `the manifest is release ${manifest.version} on ${manifest.channel}, not ${request.version} on ${request.channel}`)
  }
  return { manifest, log: verifyReleaseBundle(request.root, request.manifest, manifest, request.bundle) }
}

/**
 * Trust the newest root of a chain: each root's signature by the one before it, and the newest root's expiry against the
 * clock.
 * @param roots - the root files, oldest first, contiguous.
 * @param now - the clock in Unix seconds.
 * @returns the chain, whose last entry is the trusted root.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` for a broken, skipping or expired chain.
 */
export function trustedChain(roots: readonly Uint8Array[], now: number): TrustedRoot[] {
  try {
    return trustRootChain(roots, now)
  } catch (error) {
    throw refused('root', error)
  }
}

/** What verifying a platform's file list needs. */
export interface FileListRequest {
  /** The trusted root. */
  readonly root: RootMetadata
  /** The verified manifest. */
  readonly manifest: ReleaseManifest
  /** The platform. */
  readonly platform: RuntimePlatform
  /** The file list's bytes. */
  readonly bytes: Uint8Array
}

/**
 * Verify contract C2's step 5 for the file list: its length and SHA-256 against the manifest's reference and its
 * targets signature, which names the same release and platform.
 * @param request - the root, the manifest, the platform and the file list's bytes.
 * @returns the verified file list.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the bytes are not the manifest's or do not verify.
 */
export function verifyPlatformFiles(request: FileListRequest): RuntimeFileList {
  if (request.bytes.byteLength > RELEASE_FILE_SIZE_LIMITS.files) {
    throw new InstallError('INSTALL_VERIFY_FAILED', `${request.platform} file list`, `the file list has ${String(request.bytes.byteLength)} bytes, above its limit of ${String(RELEASE_FILE_SIZE_LIMITS.files)}`)
  }
  try {
    return verifyFileList(request.root, request.manifest, request.platform, request.bytes)
  } catch (error) {
    throw refused(`${request.platform} file list`, error)
  }
}

/**
 * Check a downloaded file against its signed reference, before anything is extracted from it (contract C2, "an
 * archive whose SHA-256 differs from the manifest is refused before extraction"). The digest is computed while the
 * file is read, so a 1 GiB archive is never held in memory.
 * @param ref - the reference the manifest carries.
 * @param path - the downloaded file.
 * @returns the file's length and digest, as checked.
 * @throws {InstallError} `INSTALL_VERIFY_FAILED` when the length or SHA-256 differs from the reference.
 */
export async function verifyDownloadedFile(ref: FileRef, path: string): Promise<{ readonly length: number, readonly sha256: string }> {
  const hash = createHash('sha256')
  let length = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer
    length += bytes.byteLength
    hash.update(bytes)
  }
  const sha256 = hash.digest('hex')
  if (length !== ref.length) {
    throw new InstallError('INSTALL_VERIFY_FAILED', ref.name, `${ref.name} has ${String(length)} bytes; the manifest lists ${String(ref.length)}`)
  }
  if (sha256 !== ref.sha256) {
    throw new InstallError('INSTALL_VERIFY_FAILED', ref.name, `${ref.name} has SHA-256 ${sha256}; the manifest lists ${ref.sha256}`)
  }
  return { length, sha256 }
}

/** What trusting the root a home stored for a start needs. */
export interface StoredRootRequest {
  /** `trust/root.json`'s bytes, the root this home last verified. */
  readonly stored: Uint8Array
  /** The root files the launcher ships, oldest first: the only roots it trusts. */
  readonly shipped: readonly Uint8Array[]
  /** `trust/roots/<n>.root.json`'s bytes, oldest first: the chain an install walked to the stored root. */
  readonly walked: readonly Uint8Array[]
  /** The stored root's path, which a refusal names. */
  readonly source: string
}

/**
 * The root a start, an update and `delorun verify` anchor on, from the root a home stored and the roots the launcher
 * ships (contract C1: trust comes only through the launcher's own roots). The stored root must be signed by its own
 * root threshold, and at a version the launcher ships it must be that very root: a root of the same version whose keys
 * or roles differ is an unrelated root that signs unrelated releases, so it is refused rather than handed to the start
 * check.
 *
 * A stored root older than the newest shipped root, including one older than every shipped root, is not the anchor: the
 * newest shipped root is, so a targets key a later root revoked stops verifying at the first start of a launcher that
 * ships that root, and no stored file can hold a home on the older root. The stored file is left as it is; the next install or update stores the root it walks to.
 *
 * A stored root newer than every shipped root is trusted only with the chain an install walked to it: every version
 * from the newest shipped root to the stored one, each signed by the root before it and by its own root threshold. A
 * root a restore or a sync placed under `trust/` descends from no shipped root, so it is refused rather than accepted
 * as an anchor for whatever runtime sits beside it.
 * @param request - the stored root, the shipped roots, the walked chain and the stored root's path.
 * @returns the root to anchor on: the stored root when it is the newest shipped root or newer than every shipped
 *   root, the newest shipped root when the stored root is older than it.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when the launcher ships no root; `INSTALL_VERIFY_FAILED` when the stored
 *   root does not verify, differs from the shipped root of its version, or is newer than every shipped root without a
 *   chain that walks from one.
 */
export function verifyStoredRoot(request: StoredRootRequest): TrustedRoot {
  const shipped = request.shipped.map((bytes) => {
    try {
      return readRoot(bytes)
    } catch (error) {
      throw refused(request.source, error)
    }
  })
  if (shipped.length === 0) throw new InstallError('NO_TRUSTED_ROOT', request.source, 'the launcher ships no root, so no stored root can be checked against one')
  let stored: TrustedRoot
  try {
    stored = readRoot(request.stored)
  } catch (error) {
    throw refused(request.source, error)
  }
  const version = stored.metadata.version
  const newestShipped = shipped.reduce((newest, root) => (root.metadata.version > newest.metadata.version ? root : newest))
  const newest = newestShipped.metadata.version
  const same = shipped.find(root => root.metadata.version === version)
  if (same !== undefined) {
    if (canonicalJson(toJsonValue(same.metadata)) !== canonicalJson(toJsonValue(stored.metadata))) {
      throw new InstallError('INSTALL_VERIFY_FAILED', request.source, `the stored root names version ${String(version)}, and it is not the root this launcher ships for version ${String(version)}: its keys or roles differ, so the releases it signs are not this launcher's`)
    }
    // An older stored root is never the anchor: the newest shipped root can revoke a key the stored one lists.
    return version < newest ? newestShipped : stored
  }
  const oldest = Math.min(...shipped.map(root => root.metadata.version))
  // A root older than every shipped root anchors nothing; the newest shipped root supersedes it, as for an older shipped one.
  if (version < oldest) return newestShipped
  const walked = request.walked.map((bytes) => {
    try {
      return { root: readRoot(bytes), bytes }
    } catch (error) {
      throw refused(request.source, error)
    }
  })
  // The walk starts at the newest shipped root, so roots the chain holds at or below it are the launcher's own files
  // and roots past the stored one are a chain written after this root, which says nothing about it.
  const forward = walked.filter(entry => entry.root.metadata.version > newest && entry.root.metadata.version <= version)
  if (!forward.some(entry => entry.root.metadata.version === version)) {
    throw new InstallError('INSTALL_VERIFY_FAILED', request.source, `the stored root names version ${String(version)}, newer than root ${String(newest)}, the newest this launcher ships, and the chain an install walked holds no root of that version: nothing proves it descends from the root this launcher ships, so it is not trusted`)
  }
  let chain: TrustedRoot[]
  try {
    chain = walkRootChain([...request.shipped, ...forward.map(entry => entry.bytes)])
  } catch (error) {
    throw new InstallError('INSTALL_VERIFY_FAILED', request.source, `the stored root names version ${String(version)}, newer than root ${String(newest)}, the newest this launcher ships, and the chain an install walked does not walk from a shipped root to it: ${messageOf(error)}`, { cause: error })
  }
  const last = chain.at(-1)!
  if (last.metadata.version !== version || last.sha256 !== stored.sha256) {
    throw new InstallError('INSTALL_VERIFY_FAILED', request.source, `the stored root names version ${String(version)}, and the chain an install walked ends at root ${String(last.metadata.version)}; the chain proves a different root, so the stored one is not trusted`)
  }
  return stored
}
