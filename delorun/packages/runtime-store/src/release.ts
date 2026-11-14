/**
 * The signed release files an installation keeps beside it (contract C1), verified with `@delorun/release`'s C2
 * verifier: the manifest's targets signature, and the platform's file list against the manifest's digest and its own
 * targets signature. The trusted root is the caller's: the launcher, and every update and rollback through a
 * {@link TrustedRootSource}, anchor `trust/root.json` on the roots the launcher ships before it reaches the store.
 *
 * @module @delorun/runtime-store/release
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_FILE_SIZE_LIMITS, type ReleaseManifest, type RootMetadata, type RuntimeFileList } from '@delorun/contract-release-manifest'
import { verifyFileList, verifySignedManifest } from '@delorun/release-formats/sign/verify'
import type { StorePaths } from './paths.ts'

/** A version's manifest and file list, each verified with the trusted root. */
export interface VerifiedRelease {
  /** The release manifest. */
  readonly manifest: ReleaseManifest
  /** This platform's runtime file list. */
  readonly files: RuntimeFileList
  /** The SHA-256 of the manifest's bytes, which binds an installation's identity record. */
  readonly manifestSha256: string
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
  return { manifest, files: verifyFileList(root, manifest, paths.platform, bytes.files), manifestSha256: createHash('sha256').update(bytes.manifest).digest('hex') }
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
 * Reads the root a start check, an install or a rollback verifies with: `trust/root.json`, read under C1's refusal
 * rule and trusted only through the release roots the launcher that started this process ships, by the chain an
 * install walked to it. The store never reads `trust/root.json` itself, because a root checked against its own
 * signatures only is one any process running as the person could have written.
 * @returns the anchored root.
 * @throws {RuntimeStoreError} `ROOT_NOT_ANCHORED` when the root cannot be anchored; the error names the remedy.
 */
export type TrustedRootSource = () => Promise<RootMetadata>
