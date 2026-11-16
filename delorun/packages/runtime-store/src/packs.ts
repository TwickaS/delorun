/**
 * Installing a plugin pack (contract C2's packs file, contract C1's `packs/`): checks the downloaded archive against the
 * signed variant, fetches the signed external npm packages and checks each against its pinned SHA-512, links the
 * packages the runtime provides into the pack, and publishes the pack's directory only when every check passed.
 * Verification of the packs file itself (`verifyPacks`) happens before this runs; this function trusts only the
 * entry it is given.
 *
 * @module @delorun/runtime-store/packs
 */
import { chmod, lstat, mkdir, readdir, rename, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PackEntry, PackExternal, RuntimePlatform } from '@delorun/contract-release-manifest'
import { extractExternal, extractPack, PackRefusal } from '@delorun/release-formats/packs/archive'
import { createStagingDirectory, removeTree } from './files.ts'
import type { StorePaths } from './paths.ts'
import type { RuntimeVersion } from '@delorun/contract-home-layout'

/** What installing one pack needs. */
export interface PackInstallRequest {
  /** The home's store paths. */
  readonly paths: StorePaths
  /** The installed release the pack belongs to; the pack lives and dies with it. */
  readonly release: RuntimeVersion
  /** The verified entry of the release's packs file. */
  readonly entry: PackEntry
  /** This computer's platform. */
  readonly platform: RuntimePlatform
  /** The pack archive's downloaded bytes. */
  readonly archive: Uint8Array
  /** Fetch an external package's tarball from the registry URL its pin names. */
  readonly fetchExternal: (pin: PackExternal) => Promise<Uint8Array>
  /** The release's `app/node_modules`, which provides the pack's peers. */
  readonly runtimeNodeModules: string
}

/**
 * The variant of a pack for a platform.
 * @param entry - the pack.
 * @param platform - the platform.
 * @returns the platform's variant, or the platform-independent one.
 * @throws PackRefusal when the release publishes the pack for neither.
 */
export function packVariantFor(entry: PackEntry, platform: RuntimePlatform): NonNullable<PackEntry['variants'][RuntimePlatform]> {
  const variant = entry.variants[platform] ?? entry.variants.any
  if (variant === undefined) throw new PackRefusal(`${entry.name} is not published for ${platform}`)
  return variant
}

async function makeReadOnly(directory: string): Promise<void> {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name)
    if (child.isSymbolicLink()) continue
    if (child.isDirectory()) await makeReadOnly(path)
    else if (child.isFile()) await chmod(path, (await lstat(path)).mode & 0o111 ? 0o555 : 0o444)
  }
}

/**
 * Install one pack for a release.
 * @param request - the verified entry, the archive and the places to fetch from and link to.
 * @returns the pack's package directory, `packs/<release>/<name>/package`.
 * @throws PackRefusal when the archive or an external package does not match what the targets key signed, or a peer
 * is missing from the runtime; nothing is left under `packs/`.
 * @throws Error when the pack is already installed for the release, or a file operation fails.
 */
export async function installPack(request: PackInstallRequest): Promise<string> {
  const { paths, release, entry, platform } = request
  const variant = packVariantFor(entry, platform)
  const target = paths.pack(release, entry.name)
  const stage = await createStagingDirectory(paths.staging)
  try {
    const packageDirectory = join(stage, 'package')
    await mkdir(packageDirectory, { mode: 0o700 })
    await extractPack(request.archive, variant, packageDirectory)
    for (const pin of variant.external) {
      await extractExternal(await request.fetchExternal(pin), pin, join(packageDirectory, 'node_modules', ...pin.name.split('/')))
    }
    for (const peer of entry.peers) {
      const provided = join(request.runtimeNodeModules, ...peer.split('/'))
      if (!(await stat(provided).then(() => true, () => false))) throw new PackRefusal(`${entry.name} needs ${peer}, which this runtime does not provide`)
      const link = join(packageDirectory, 'node_modules', ...peer.split('/'))
      await mkdir(dirname(link), { recursive: true })
      await symlink(provided, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await makeReadOnly(packageDirectory)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(stage, target)
    return join(target, 'package')
  } catch (error) {
    await removeTree(stage)
    throw error
  }
}
