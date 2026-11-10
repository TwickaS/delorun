/**
 * The pinned inputs of a runtime closure that do not come from the repository's lockfile: the Node distribution and
 * pnpm. Each is downloaded once into a cache named by its digest and used only after its bytes match the digest
 * `toolchain.json` pins; a cached file that no longer matches is removed and the build stops.
 *
 * @module @delo/release/closure/sources
 */
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import type { Toolchain } from './config.ts'

/** An npm package pinned by exact version and integrity. */
export interface PinnedPackage {
  readonly name: string
  readonly version: string
  /** `sha512-<base64>`. */
  readonly integrity: string
}

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 600_000

/** A digest a download must match. */
export interface PinnedDigest {
  /** The algorithm. */
  readonly algorithm: 'sha256' | 'sha512'
  /** The digest in lowercase hex. */
  readonly hex: string
}

/**
 * The digest an npm integrity string names.
 * @param integrity - `sha512-<base64>`.
 * @returns the SHA-512 in hex.
 */
export function integrityDigest(integrity: string): PinnedDigest {
  return { algorithm: 'sha512', hex: Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex') }
}

/**
 * Fetch a pinned file through the cache.
 * @param url - where to download it from.
 * @param digest - the digest its bytes must have.
 * @param cache - the cache directory.
 * @returns the cached file's path.
 * @throws Error when the download fails or its bytes, or the cached bytes, do not match the digest.
 */
export async function fetchPinned(url: string, digest: PinnedDigest, cache: string): Promise<string> {
  await mkdir(cache, { recursive: true })
  const path = join(cache, `${digest.algorithm}-${digest.hex}`)
  let bytes: Buffer
  let cached = true
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    cached = false
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${String(response.status)}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash(digest.algorithm).update(bytes).digest('hex') !== digest.hex) {
    if (cached) await rm(path, { force: true })
    throw new Error(`${url}: its ${digest.algorithm} does not match the pinned digest${cached ? ' (the cached copy was removed)' : ''}`)
  }
  if (!cached) {
    const temporary = join(cache, `.${randomUUID()}`)
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  }
  return path
}

/**
 * Place the pinned Node distribution's executable and licence at `<stage>/node/`: `bin/node` on Linux and macOS,
 * `node.exe` on Windows.
 * @param toolchain - the pinned toolchain.
 * @param platform - the closure's platform.
 * @param stage - the staged tree's root.
 * @param cache - the download cache.
 */
export async function stageNode(toolchain: Toolchain, platform: RuntimePlatform, stage: string, cache: string): Promise<void> {
  const distribution = toolchain.node.distributions[platform]
  const archive = await fetchPinned(`${toolchain.node.origin}/${distribution.file}`, { algorithm: 'sha256', hex: distribution.sha256 }, cache)
  const top = distribution.file.replace(/\.(tar\.gz|zip)$/u, '')
  const unpacked = await mkdtemp(join(cache, '.node-'))
  try {
    const target = join(stage, 'node')
    if (distribution.file.endsWith('.zip')) {
      await extractZip(archive, { dir: unpacked })
      await mkdir(target, { recursive: true })
      await cp(join(unpacked, top, 'node.exe'), join(target, 'node.exe'))
    } else {
      await extractTar({ file: archive, cwd: unpacked, filter: path => path === `${top}/bin/node` || path === `${top}/LICENSE` })
      await mkdir(join(target, 'bin'), { recursive: true })
      await cp(join(unpacked, top, 'bin', 'node'), join(target, 'bin', 'node'))
    }
    await cp(join(unpacked, top, 'LICENSE'), join(target, 'LICENSE'))
  } finally {
    await rm(unpacked, { recursive: true, force: true })
  }
}

/**
 * Unpack an npm package tarball pinned by integrity into a directory, checking its name and version.
 * @param tarball - the tarball's URL.
 * @param expected - the package's name, version and integrity.
 * @param destination - a directory that does not exist yet.
 * @param cache - the download cache.
 * @throws Error when the tarball does not match its integrity or names another package or version.
 */
export async function stageNpmPackage(tarball: string, expected: PinnedPackage, destination: string, cache: string): Promise<void> {
  const archive = await fetchPinned(tarball, integrityDigest(expected.integrity), cache)
  await mkdir(destination, { recursive: false })
  await extractTar({ file: archive, cwd: destination, strip: 1 })
  const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')) as { name?: unknown, version?: unknown }
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    throw new Error(`${tarball} holds ${String(manifest.name)}@${String(manifest.version)}, not ${expected.name}@${expected.version}`)
  }
}

/**
 * Place pnpm at `<stage>/pnpm/`.
 * @param toolchain - the pinned toolchain.
 * @param stage - the staged tree's root.
 * @param cache - the download cache.
 */
export async function stagePnpm(toolchain: Toolchain, stage: string, cache: string): Promise<void> {
  await stageNpmPackage(toolchain.pnpm.tarball, { name: 'pnpm', version: toolchain.pnpm.version, integrity: toolchain.pnpm.integrity }, join(stage, 'pnpm'), cache)
}
