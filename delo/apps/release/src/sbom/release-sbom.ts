/**
 * Reads a build output's runtime archives into the SBOM's inputs and writes `delorun-<version>.spdx.json`. The
 * document derives only from the archives and the pinned toolchain, so the rebuild comparison checks a copy by
 * deriving it again from the archives beside it.
 *
 * @module @delo/release/sbom/release-sbom
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import { archiveEntries } from '@delo/release-formats/archive/inspect'
import { fileDigest } from '@delo/release-formats/archive/sink'
import type { Toolchain } from '../closure/config.ts'
import { closureFileNames } from '../closure/tree.ts'
import { imagesName, type ImagesFile } from '../images/build.ts'
import { isPackageManifest, spdxDocument, type ArchiveContents, type ImageContents, type NpmPackageEntry } from './spdx.ts'

/** The closure lockfile's path inside a runtime archive. */
export const CLOSURE_LOCKFILE = 'app/pnpm-lock.yaml'

/**
 * The release SBOM's file name.
 * @param version - the release.
 * @returns `delorun-<version>.spdx.json`.
 */
export function sbomName(version: string): string {
  return `delorun-${version}.spdx.json`
}

/**
 * Read one runtime archive's packages and lockfile.
 * @param path - the archive.
 * @param format - its format.
 * @returns the installed npm packages, the closure lockfile's text and the entries' mtime.
 * @throws Error when the archive holds no closure lockfile or a package manifest that does not parse.
 */
export async function readArchiveContents(path: string, format: 'tar.gz' | 'zip'): Promise<{ packages: NpmPackageEntry[], lockfile: string, mtime: number }> {
  const packages = new Map<string, NpmPackageEntry>()
  let lockfile: string | undefined
  let mtime = 0
  for await (const entry of archiveEntries(path, format)) {
    mtime = entry.mtime
    if (entry.path === CLOSURE_LOCKFILE) lockfile = entry.data.toString('utf8')
    if (!isPackageManifest(entry.path)) continue
    let manifest: { name?: unknown, version?: unknown, license?: unknown }
    try {
      manifest = JSON.parse(entry.data.toString('utf8')) as typeof manifest
    } catch (error) {
      throw new Error(`${entry.path} in ${path} is not JSON`, { cause: error })
    }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    packages.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version, ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}) })
  }
  if (lockfile === undefined) throw new Error(`${path} holds no ${CLOSURE_LOCKFILE}`)
  return { packages: [...packages.values()].sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1)), lockfile, mtime }
}

/**
 * The SBOM text of a build output that holds every release platform's archive.
 * @param directory - the output directory.
 * @param version - the release.
 * @param platforms - the release platforms, `closure.json`'s `platforms`.
 * @param toolchain - the pinned toolchain.
 * @param base - the images' base by digest, from the `images.json` that built them.
 * @returns the document's text, or `undefined` when an archive is missing. When the output holds
 * `delorun-<version>.images.json`, the document describes both images too.
 */
export async function deriveSbomText(directory: string, version: string, platforms: readonly RuntimePlatform[], toolchain: Toolchain, base: string): Promise<string | undefined> {
  const present = new Set(await readdir(directory))
  const archives: ArchiveContents[] = []
  let epoch = 0
  for (const platform of platforms) {
    const name = closureFileNames(version, platform).archive
    if (!present.has(name)) return undefined
    const contents = await readArchiveContents(join(directory, name), platform === 'win32-x64' ? 'zip' : 'tar.gz')
    epoch = contents.mtime
    archives.push({ platform, name, sha256: (await fileDigest(join(directory, name))).sha256, packages: contents.packages, lockfile: contents.lockfile })
  }
  const images = present.has(imagesName(version)) ? imageContents(JSON.parse(await readFile(join(directory, imagesName(version)), 'utf8')) as ImagesFile, base) : undefined
  const document = spdxDocument(version, epoch, { node: { version: toolchain.node.version, origin: toolchain.node.origin }, pnpm: { version: toolchain.pnpm.version, integrity: toolchain.pnpm.integrity }, builder: { packages: toolchain.native.builder.packages, platforms: platforms.filter(platform => toolchain.native.platforms[platform] === 'source') } }, archives, images)
  return `${JSON.stringify(document, undefined, 2)}\n`
}

/**
 * Write a build output's SBOM.
 * @param directory - the output directory, holding every release platform's archive.
 * @param version - the release.
 * @param platforms - the release platforms, `closure.json`'s `platforms`.
 * @param toolchain - the pinned toolchain.
 * @param base - the images' base by digest, from `images.json`.
 * @returns the file's name.
 * @throws Error when an archive is missing. An existing SBOM is replaced, so the image build can extend it.
 */
export async function writeReleaseSbom(directory: string, version: string, platforms: readonly RuntimePlatform[], toolchain: Toolchain, base: string): Promise<string> {
  const text = await deriveSbomText(directory, version, platforms, toolchain, base)
  if (text === undefined) throw new Error(`the SBOM covers every release platform, and ${directory} lacks an archive`)
  await writeFile(join(directory, sbomName(version)), text, { mode: 0o644 })
  return sbomName(version)
}

function imageContents(images: ImagesFile, base: string): ImageContents {
  if (images.debian === undefined) throw new Error('the images file lists no Debian packages; build-images.ts writes them')
  return { base, images: { s2: { repository: images.s2.repository, index: images.s2.index }, s3: { repository: images.s3.repository, index: images.s3.index } }, debian: images.debian }
}
