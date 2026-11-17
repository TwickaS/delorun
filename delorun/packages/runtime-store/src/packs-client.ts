/**
 * Getting a release's packs file and turning a pack on (contract C2, "Packs"): the installed release's verified manifest
 * is the anchor. The packs file must verify under the same root, belong to that manifest by digest, and have a
 * release-log record that verifies; only then does a pack's archive download, and its external packages download
 * from the registry, each checked against what the targets key signed. Nothing is fetched for a release
 * the store has not installed, so plugin and runtime versions always match.
 *
 * @module @delorun/runtime-store/packs-client
 */
import { readFile } from 'node:fs/promises'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_FILE_SIZE_LIMITS, type PackEntry, type PackExternal, type ReleasePacks, type RootMetadata } from '@delorun/contract-release-manifest'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import { verifyPacks } from '@delorun/release-formats/sign/verify'
import { STORE_FILE_MODE, writeStoreFile } from './files.ts'
import { installPack, packVariantFor } from './packs.ts'
import type { StorePaths } from './paths.ts'

/**
 * Checks a packs file's release-log bundle. The caller passes `release-verify`'s `checkBundle`, which this package does
 * not depend on.
 */
export type PacksLogCheck = (root: RootMetadata, version: string, packsBytes: Uint8Array, bundleBytes: Uint8Array) => { readonly ok: boolean, readonly detail?: string }

/**
 * How many bytes a download may have: at most `max`, or exactly `exact` when the signed file list names the length, with
 * the standard base64 SHA-512 the transport checks while the bytes arrive when the file list names it.
 */
export type PackSize = { readonly max: number } | { readonly exact: number, readonly sha512?: string }

/** What a caller may ask of one download. */
export interface PackTransfer {
  /** Aborts the download; the fetch then rejects. */
  readonly signal?: AbortSignal
  /** Called with the bytes received so far, after each piece. */
  readonly onBytes?: (received: number) => void
}

/** Where a release's files come from. */
export interface PackFiles {
  /** Fetch a file of the installed release by name from the release channel, within `size`; `undefined` when the channel has no such file. */
  fetchRelease(name: string, size: PackSize, transfer?: PackTransfer): Promise<Uint8Array | undefined>
  /** Fetch an external package's tarball from the registry URL the signed pin names. */
  fetchExternal(pin: PackExternal, transfer?: PackTransfer): Promise<Uint8Array>
}

/** An installed release the packs belong to. */
export interface InstalledRelease {
  /** The store. */
  readonly paths: StorePaths
  /** The trusted root. */
  readonly root: RootMetadata
  /** The installed version. */
  readonly version: RuntimeVersion
  /** The manifest file's bytes; the packs file is verified against them. */
  readonly manifestBytes: Uint8Array
  /** The release log check. */
  readonly checkLog: PacksLogCheck
}

async function readLimited(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function verified(release: InstalledRelease, packsBytes: Uint8Array, bundleBytes: Uint8Array): ReleasePacks {
  if (packsBytes.byteLength > RELEASE_FILE_SIZE_LIMITS.packs) throw new PackRefusal(`the packs file has ${String(packsBytes.byteLength)} bytes, above its limit`, 'PACKS_FILE_REFUSED')
  const packs = verifyPacks(release.root, release.manifestBytes, packsBytes)
  const log = release.checkLog(release.root, release.version, packsBytes, bundleBytes)
  if (!log.ok) throw new PackRefusal(`the packs file has no verified release-log record: ${log.detail ?? 'refused'}`, 'PACKS_FILE_REFUSED')
  return packs
}

/**
 * Fetch the installed release's packs file and its log bundle, verify both, and keep them beside the installation.
 * @param release - the installed release.
 * @param files - where files come from.
 * @returns the packs, or `undefined` when the release publishes none.
 * @throws PackRefusal or VerificationError when the file or its record does not verify; nothing is stored.
 */
export async function acquirePacks(release: InstalledRelease, files: PackFiles): Promise<ReleasePacks | undefined> {
  const stored = release.paths.releaseFiles(release.version)
  const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
  const size = { max: RELEASE_FILE_SIZE_LIMITS.packs }
  const [packsBytes, bundleBytes] = await Promise.all([files.fetchRelease(name(stored.packs), size), files.fetchRelease(name(stored.packsBundle), size)])
  if (packsBytes === undefined) return undefined
  if (bundleBytes === undefined) throw new PackRefusal(`${name(stored.packs)} has no ${name(stored.packsBundle)}`, 'NOT_ON_CHANNEL')
  const packs = verified(release, packsBytes, bundleBytes)
  await writeStoreFile(stored.packs, packsBytes, STORE_FILE_MODE)
  await writeStoreFile(stored.packsBundle, bundleBytes, STORE_FILE_MODE)
  return packs
}

/**
 * Read the stored packs file and verify it again; every use re-verifies, as a start re-verifies the manifest.
 * @param release - the installed release.
 * @returns the packs, or `undefined` when none are stored.
 * @throws PackRefusal or VerificationError when the stored files no longer verify.
 */
export async function readStoredPacks(release: InstalledRelease): Promise<ReleasePacks | undefined> {
  const stored = release.paths.releaseFiles(release.version)
  const [packsBytes, bundleBytes] = await Promise.all([readLimited(stored.packs), readLimited(stored.packsBundle)])
  if (packsBytes === undefined) return undefined
  if (bundleBytes === undefined) throw new PackRefusal('the stored packs file has no release-log bundle', 'PACKS_FILE_REFUSED')
  return verified(release, packsBytes, bundleBytes)
}

/**
 * The size a person is about to download for a pack: its archive plus its external packages on this platform.
 * @param entry - the pack.
 * @param platform - the platform.
 * @returns the bytes.
 */
export function packDownloadSize(entry: PackEntry, platform: StorePaths['platform']): number {
  const variant = packVariantFor(entry, platform)
  return variant.archive.length + variant.external.reduce((sum, pin) => sum + pin.length, 0)
}

/** A pack's verified entry with every download it needs, before anything is installed. */
export interface FetchedPack {
  /** The verified entry. */
  readonly entry: PackEntry
  /** The archive's bytes. */
  readonly archive: Uint8Array
  /** The external packages' tarballs by their signed URL. */
  readonly externals: ReadonlyMap<string, Uint8Array>
}

/**
 * Find a pack in the installed release's packs file and download its archive and external packages, none of them
 * installed yet.
 * @param release - the installed release.
 * @param name - the pack's package name.
 * @param files - where files come from.
 * @param transfer - the abort signal and byte progress; bytes count across the archive and the externals together.
 * @returns the entry and its downloads.
 * @throws PackRefusal when the release has no such pack, it is not published for this platform, a file is missing from
 * the channel, or anything fails a signed check.
 */
export async function fetchPack(release: InstalledRelease, name: string, files: PackFiles, transfer: PackTransfer = {}): Promise<FetchedPack> {
  const packs = await readStoredPacks(release) ?? await acquirePacks(release, files)
  const entry = packs?.packs.find(each => each.name === name)
  if (entry === undefined) throw new PackRefusal(`release ${release.version} has no pack ${name}`, 'NO_SUCH_PACK')
  const variant = packVariantFor(entry, release.paths.platform)
  let done = 0
  const counted = (): PackTransfer => ({ ...transfer.signal === undefined ? {} : { signal: transfer.signal }, onBytes: (received) => { transfer.onBytes?.(done + received) } })
  const archive = await files.fetchRelease(variant.archive.name, { exact: variant.archive.length, sha512: variant.archive.sha512 }, counted())
  if (archive === undefined) throw new PackRefusal(`the release channel has no ${variant.archive.name}`, 'NOT_ON_CHANNEL')
  done += archive.byteLength
  const externals = new Map<string, Uint8Array>()
  for (const pin of variant.external) {
    const bytes = await files.fetchExternal(pin, counted())
    externals.set(pin.url, bytes)
    done += bytes.byteLength
  }
  return { entry, archive, externals }
}

/**
 * Install a downloaded pack beside the installed release.
 * @param release - the installed release.
 * @param fetched - {@link fetchPack}'s result.
 * @returns the package directory for the plugin manager to load.
 * @throws PackRefusal as {@link installPack} does.
 */
export function installFetchedPack(release: InstalledRelease, fetched: FetchedPack): Promise<string> {
  return installPack({ paths: release.paths, release: release.version, entry: fetched.entry, platform: release.paths.platform, archive: fetched.archive, fetchExternal: pin => Promise.resolve(fetched.externals.get(pin.url)!) })
}

/**
 * Turn a pack on for the installed release: download its archive from the release channel, install it with its
 * external packages, and return its package directory for the plugin manager to load.
 * @param release - the installed release.
 * @param name - the pack's package name.
 * @param files - where files come from.
 * @returns the package directory.
 * @throws PackRefusal as {@link fetchPack} and {@link installPack} do.
 */
export async function turnOnPack(release: InstalledRelease, name: string, files: PackFiles): Promise<string> {
  return installFetchedPack(release, await fetchPack(release, name, files))
}
