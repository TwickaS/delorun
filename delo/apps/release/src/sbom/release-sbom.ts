/**
 * Reads a build output's runtime archives into the SBOM's inputs and writes `delorun-<version>.spdx.json`. The
 * document derives only from the archives and the pinned toolchain, so the rebuild comparison checks a copy by
 * deriving it again from the archives beside it.
 *
 * @module @delo/release/sbom/release-sbom
 */
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { archiveEntries } from '../archive/inspect.ts'
import { fileDigest } from '../archive/sink.ts'
import type { Toolchain } from '../closure/config.ts'
import { closureFileNames } from '../closure/tree.ts'
import { isPackageManifest, spdxDocument, type ArchiveContents, type NpmPackageEntry } from './spdx.ts'

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
 * The SBOM text of a build output that holds every platform's archive.
 * @param directory - the output directory.
 * @param version - the release.
 * @param toolchain - the pinned toolchain.
 * @returns the document's text, or `undefined` when an archive is missing.
 */
export async function deriveSbomText(directory: string, version: string, toolchain: Toolchain): Promise<string | undefined> {
  const present = new Set(await readdir(directory))
  const archives: ArchiveContents[] = []
  let epoch = 0
  for (const platform of RUNTIME_PLATFORMS) {
    const name = closureFileNames(version, platform).archive
    if (!present.has(name)) return undefined
    const contents = await readArchiveContents(join(directory, name), platform === 'win32-x64' ? 'zip' : 'tar.gz')
    epoch = contents.mtime
    archives.push({ platform, name, sha256: (await fileDigest(join(directory, name))).sha256, packages: contents.packages, lockfile: contents.lockfile })
  }
  const document = spdxDocument(version, epoch, { node: { version: toolchain.node.version, origin: toolchain.node.origin }, pnpm: { version: toolchain.pnpm.version, integrity: toolchain.pnpm.integrity } }, archives)
  return `${JSON.stringify(document, undefined, 2)}\n`
}

/**
 * Write a build output's SBOM.
 * @param directory - the output directory, holding every platform's archive.
 * @param version - the release.
 * @param toolchain - the pinned toolchain.
 * @returns the file's name.
 * @throws Error when an archive is missing or the file exists.
 */
export async function writeReleaseSbom(directory: string, version: string, toolchain: Toolchain): Promise<string> {
  const text = await deriveSbomText(directory, version, toolchain)
  if (text === undefined) throw new Error(`the SBOM covers every platform, and ${directory} lacks an archive`)
  await writeFile(join(directory, sbomName(version)), text, { flag: 'wx', mode: 0o644 })
  return sbomName(version)
}
