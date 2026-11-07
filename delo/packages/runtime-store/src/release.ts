/**
 * The signed release files an installation keeps beside it (contract C1), verified with `@delo/release`'s C2
 * verifier: the manifest's targets signature, and the platform's file list against the manifest's digest and its own
 * targets signature. The trusted root comes from `trust/root.json` under C1's refusal rule.
 *
 * @module @delo/runtime-store/release
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { RELEASE_FILE_SIZE_LIMITS, type ReleaseManifest, type RootMetadata, type RuntimeFileList } from '@delo/contract-release-manifest'
import { readProtectedFile } from '@delo/home'
import { readRoot, verifyFileList, verifySignedManifest } from '@delo/release/sign/verify'
import type { StorePaths } from './paths.ts'

/** A version's manifest and file list, each verified with the trusted root. */
export interface VerifiedRelease {
  /** The release manifest. */
  readonly manifest: ReleaseManifest
  /** This platform's runtime file list. */
  readonly files: RuntimeFileList
}

/** The bytes of a version's release files. */
export interface ReleaseFileBytes {
  /** `delorun-<version>.manifest.json`. */
  readonly manifest: Uint8Array
  /** `delorun-<version>-<platform>.files.json`. */
  readonly files: Uint8Array
  /** `delorun-<version>.manifest.log.json`, kept for C18's checks; the store does not read it. */
  readonly bundle: Uint8Array
}

/**
 * Verify a version's manifest and file list.
 * @param paths - the store's paths, whose platform selects the file list.
 * @param root - the trusted root.
 * @param version - the version the files must describe.
 * @param bytes - the manifest and file list.
 * @returns the verified manifest and list.
 * @throws {Error} when either file does not read or verify, or describes another version or platform.
 */
export function verifyRelease(paths: StorePaths, root: RootMetadata, version: RuntimeVersion, bytes: Pick<ReleaseFileBytes, 'manifest' | 'files'>): VerifiedRelease {
  const manifest = verifySignedManifest(root, bytes.manifest)
  if (manifest.version !== String(version)) throw new Error(`the manifest is release ${manifest.version}, not ${version}`)
  return { manifest, files: verifyFileList(root, manifest, paths.platform, bytes.files) }
}

/**
 * Read a file of at most `limit` bytes.
 * @param path - the file.
 * @param limit - the size limit.
 * @returns its bytes.
 * @throws {Error} when it is larger than the limit, or cannot be read.
 */
async function readLimited(path: string, limit: number): Promise<Buffer> {
  const bytes = await readFile(path)
  if (bytes.byteLength > limit) throw new Error(`${path} has ${String(bytes.byteLength)} bytes, above its limit of ${String(limit)}`)
  return bytes
}

/**
 * Read and verify an installation's stored manifest and file list.
 * @param paths - the store's paths.
 * @param root - the trusted root.
 * @param version - the installed version.
 * @returns the verified manifest and list.
 * @throws {Error} when a file is missing, too large, or does not verify.
 */
export async function readStoredRelease(paths: StorePaths, root: RootMetadata, version: RuntimeVersion): Promise<VerifiedRelease> {
  const files = paths.releaseFiles(version)
  const [manifest, list] = await Promise.all([readLimited(files.manifest, RELEASE_FILE_SIZE_LIMITS.manifest), readLimited(files.files, RELEASE_FILE_SIZE_LIMITS.files)])
  return verifyRelease(paths, root, version, { manifest, files: list })
}

/**
 * Read the stored root `trust/root.json` under C1's refusal rule and check that its own root threshold signs it. The
 * clock is not read: an expired root does not stop a start (C2). Whether the stored root descends from the root the
 * launcher embeds is the launcher's check.
 * @param home - the resolved Delo home.
 * @returns the root metadata.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` for a laxer, linked or foreign file.
 * @throws {Error} when the file is missing or does not verify.
 */
export async function readStoredRoot(home: string): Promise<RootMetadata> {
  return readRoot(await readProtectedFile(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root))).metadata
}
