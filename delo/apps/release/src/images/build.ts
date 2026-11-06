/**
 * Builds the S2 and S3 images of contract C9 within C2's reproducible-rebuild scope: each from the digest-pinned base
 * `images.json` names, for `linux/amd64` and `linux/arm64`, with BuildKit's `rewrite-timestamp` at the release's
 * `SOURCE_DATE_EPOCH`, no cache, and no provenance or SBOM attestation (they record build times and invocation ids).
 * The S3 image carries each platform's Linux runtime closure, extracted read-only. The OCI index and per-platform
 * manifest digests go into `delorun-<version>.images.json`, which the manifest's `images` copies.
 *
 * @module @delo/release/images/build
 */
import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ImageRef, OciDigest } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { archiveEntries } from '../archive/inspect.ts'
import { RECIPE_DIR, readRecipeFile } from '../closure/config.ts'
import { closureFileNames } from '../closure/tree.ts'

/** `images.json`: the base by digest and each image's repository and build context. */
export const ImagesRecipe = z.strictObject({
  schema: z.literal('delo.release-images/1'),
  base: z.string().regex(/^docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]{64}$/u, 'the Debian base by digest'),
  images: z.strictObject({
    s2: z.strictObject({ repository: z.string().min(1), context: z.string().min(1) }),
    s3: z.strictObject({ repository: z.string().min(1), context: z.string().min(1) }),
  }),
})

/** {@link ImagesRecipe}'s parsed value. */
export type ImagesRecipe = z.output<typeof ImagesRecipe>

/** The two images' references, as `delorun-<version>.images.json` holds them. */
export interface ReleaseImages {
  readonly s2: ImageRef
  readonly s3: ImageRef
}

/** The OCI platforms each image is built for, and the closure platform each carries under S3. */
const PLATFORMS = [
  { oci: 'linux/amd64', arch: 'amd64', closure: 'linux-x64' },
  { oci: 'linux/arm64', arch: 'arm64', closure: 'linux-arm64' },
] as const

/**
 * The images file's name.
 * @param version - the release.
 * @returns `delorun-<version>.images.json`.
 */
export function imagesName(version: string): string {
  return `delorun-${version}.images.json`
}

/**
 * Read the image recipe.
 * @returns the parsed `images.json`.
 */
export function readImagesRecipe(): ImagesRecipe {
  return readRecipeFile(ImagesRecipe, join(RECIPE_DIR, 'images.json'))
}

const OciIndex = z.looseObject({ manifests: z.array(z.looseObject({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u), platform: z.looseObject({ os: z.string(), architecture: z.string() }).optional() })).min(1) })

function digest(value: string): OciDigest {
  return brandString<OciDigest>(value)
}

function readFromTar(tar: string, member: string): string {
  const result = spawnSync('tar', ['-xOf', tar, member], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${tar} holds no ${member}`)
  return result.stdout
}

/**
 * The index and per-platform digests of an OCI layout tar that holds one multi-platform image.
 * @param tar - the OCI layout tar.
 * @param repository - the image's repository.
 * @returns the image reference.
 * @throws Error when the layout does not hold one index with both platforms.
 */
export function ociImageRef(tar: string, repository: string): ImageRef {
  const top = OciIndex.parse(JSON.parse(readFromTar(tar, 'index.json')))
  if (top.manifests.length !== 1) throw new Error(`${tar} holds ${String(top.manifests.length)} images, not 1`)
  const index = top.manifests[0]!.digest
  const nested = OciIndex.parse(JSON.parse(readFromTar(tar, `blobs/sha256/${index.slice('sha256:'.length)}`)))
  const platforms = Object.fromEntries(PLATFORMS.map(({ oci }) => {
    const [os, architecture] = oci.split('/')
    const found = nested.manifests.find(item => item.platform?.os === os && item.platform?.architecture === architecture)
    if (found === undefined) throw new Error(`${tar} has no ${oci} manifest`)
    return [oci, digest(found.digest)]
  }))
  return { repository, index: digest(index), platforms: { 'linux/amd64': platforms['linux/amd64']!, 'linux/arm64': platforms['linux/arm64']! } }
}

/**
 * Extract a runtime archive read-only: files 0444 or 0555, directories 0555.
 * @param archive - the closure archive.
 * @param destination - a directory that does not exist yet.
 */
async function extractReadOnly(archive: string, destination: string): Promise<void> {
  const directories = new Set<string>([destination])
  for await (const entry of archiveEntries(archive, 'tar.gz')) {
    const path = join(destination, entry.path)
    for (let parent = dirname(path); !directories.has(parent); parent = dirname(parent)) directories.add(parent)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, entry.data, { flag: 'wx', mode: entry.mode === 0o755 ? 0o555 : 0o444 })
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o555)
}

function buildx(context: string, base: string, epoch: number, tar: string): void {
  const result = spawnSync('docker', [
    'buildx', 'build', '--builder', 'default', '--no-cache', '--provenance=false', '--sbom=false',
    '--platform', PLATFORMS.map(item => item.oci).join(','),
    '--build-arg', `BASE=${base}`, '--build-arg', `SOURCE_DATE_EPOCH=${String(epoch)}`,
    '--output', `type=oci,dest=${tar},rewrite-timestamp=true`, context,
  ], { encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) }, maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`docker buildx build of ${context} failed:\n${result.stderr.slice(-4000)}`)
}

/** What building the images needs. */
export interface ImageBuildRequest {
  /** The image recipe. */
  readonly recipe: ImagesRecipe
  /** The build output holding the Linux closures; the images file is written there. */
  readonly out: string
  /** Where the OCI layout tars go. */
  readonly oci: string
  /** The release. */
  readonly version: string
  /** The release's `SOURCE_DATE_EPOCH`. */
  readonly epoch: number
}

/**
 * Build both images and write the images file.
 * @param request - the recipe, directories, release and epoch.
 * @returns the two image references.
 * @throws Error when Docker fails, a Linux closure is missing or the images file exists.
 */
export async function buildImages(request: ImageBuildRequest): Promise<ReleaseImages> {
  const work = await mkdtemp(join(tmpdir(), 'delo-images-'))
  try {
    const refs: Partial<Record<'s2' | 's3', ImageRef>> = {}
    for (const name of ['s2', 's3'] as const) {
      const image = request.recipe.images[name]
      const context = join(work, name)
      await cp(join(RECIPE_DIR, image.context), context, { recursive: true })
      if (name === 's3') {
        for (const platform of PLATFORMS) await extractReadOnly(join(request.out, closureFileNames(request.version, platform.closure).archive), join(context, `closure-${platform.arch}`))
      }
      const tar = join(request.oci, `${name}.oci.tar`)
      buildx(context, request.recipe.base, request.epoch, tar)
      refs[name] = ociImageRef(tar, image.repository)
    }
    const images: ReleaseImages = { s2: refs.s2!, s3: refs.s3! }
    await writeFile(join(request.out, imagesName(request.version)), `${JSON.stringify(images, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
    return images
  } finally {
    // The extracted closure is read-only; its owner makes it writable again so it can be removed.
    spawnSync('chmod', ['-R', 'u+w', work])
    await rm(work, { recursive: true, force: true })
  }
}
