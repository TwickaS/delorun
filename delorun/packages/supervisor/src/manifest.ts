/**
 * The verified release manifest as the supervisor consumes it (contract C9, "Images"; contract C2). Verifying the
 * manifest's signature, timestamp and log entry is the release verifier's job; the home process passes the verified
 * manifest's image entries to the supervisor at launch, and the supervisor takes every image digest from them and
 * from nowhere else. No request names an image.
 *
 * @module @delorun/supervisor/manifest
 */
import { IMAGES, type DockerShape } from '@delorun/contract-runtime-supervisor'
import type { FileRef, ImagePlatform, OciDigest, ReleaseManifest } from '@delorun/contract-release-manifest'
import { z } from 'zod'
import { SupervisorError } from './errors.ts'

/**
 * The part of a verified release manifest the supervisor reads. The caller guarantees the manifest passed C2's
 * verification for the running runtime; the supervisor still refuses an entry that does not name C9's repository.
 */
export interface VerifiedManifest {
  /** The S2 and S3 images, by digest; absent when the release lists none. */
  readonly images?: NonNullable<ReleaseManifest['images']>
}

/** One image the supervisor may run: C9's repository at a digest the verified manifest lists. */
export interface ListedImage {
  /** The shape the image serves. */
  readonly shape: DockerShape
  /** C9's repository name. */
  readonly repository: string
  /** The platform's manifest digest the supervisor pulls and runs. */
  readonly digest: OciDigest
  /** Every digest the manifest lists for the image: its index and its platform manifest. */
  readonly listed: readonly OciDigest[]
  /** `<repository>@<digest>`, the only reference the supervisor passes to the engine. */
  readonly reference: string
  /** The seccomp profile file the manifest lists for the image, if any. */
  readonly seccomp?: FileRef
}

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/
const digest = z.string().regex(OCI_DIGEST)
const fileRef = z.strictObject({ name: z.string().min(1), length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
const imageRef = z.strictObject({ repository: z.string(), index: digest, platforms: z.strictObject({ 'linux/amd64': digest, 'linux/arm64': digest }), seccomp: fileRef.optional() })

/** The JSON validation of the image entries the home process sends at launch. */
export const verifiedManifestSchema = z.strictObject({ images: z.strictObject({ s2: imageRef, s3: imageRef }) })

/**
 * The OCI platform of an engine's architecture.
 * @param architecture - the engine's `Architecture`, such as `x86_64` or `aarch64`.
 * @returns the platform, or `undefined` for one the release does not build.
 */
export function imagePlatform(architecture: string): ImagePlatform | undefined {
  switch (architecture) {
    case 'x86_64':
    case 'amd64':
      return 'linux/amd64'
    case 'aarch64':
    case 'arm64':
      return 'linux/arm64'
    default:
      return undefined
  }
}

/**
 * The image a shape runs on a platform, from the verified manifest.
 * @param manifest - the verified manifest.
 * @param shape - the shape.
 * @param platform - the engine's platform, or `undefined` when the release builds none for it.
 * @returns the listed image.
 * @throws {SupervisorError} `IMAGE_NOT_IN_MANIFEST` when the manifest lists no images, the entry names another repository, the platform has no
 *   listed digest, or a digest is not an OCI SHA-256 digest.
 */
export function listedImage(manifest: VerifiedManifest, shape: DockerShape, platform: ImagePlatform | undefined): ListedImage {
  const entry = manifest.images?.[shape]
  if (entry === undefined) throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the manifest lists no ${shape} image`)
  if (entry.repository !== IMAGES[shape]) throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the manifest's ${shape} image names ${entry.repository}, not ${IMAGES[shape]}`)
  if (platform === undefined) throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the manifest lists no ${shape} image for this engine's architecture`)
  const chosen = entry.platforms[platform]
  for (const value of [entry.index, chosen]) {
    if (!OCI_DIGEST.test(value)) throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the manifest's ${shape} digest ${value} is not a sha256 digest`)
  }
  return { shape, repository: entry.repository, digest: chosen, listed: [entry.index, chosen], reference: `${entry.repository}@${chosen}`, ...entry.seccomp === undefined ? {} : { seccomp: entry.seccomp } }
}
