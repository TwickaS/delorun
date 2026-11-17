/**
 * Installing a plugin pack (contract C2's packs file, contract C1's `packs/`): under `store.lock`, checks the downloaded
 * archive against the signed variant, fetches the signed external npm packages and checks each against its pinned
 * SHA-512, links the packages the runtime provides into the pack, seals the tree like a runtime installation, records
 * the external files' digests outside the pack, and publishes the pack's directory only when every check passed.
 * Verification of the packs file itself (`verifyPacks`) happens before this runs; this function trusts only the
 * entry it is given. {@link checkInstalledPack} hashes every installed file again against the signed list and the
 * record.
 *
 * @module @delorun/runtime-store/packs
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PRIVATE_DIR_MODE, STORE_LOCK_WAIT_MS, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { PackEntry, PackExternal, PackVariant, RuntimePlatform } from '@delorun/contract-release-manifest'
import { extractExternal, extractPack, joinInside, PackRefusal } from '@delorun/release-formats/packs/archive'
import { createStagingDirectory, installedFileMode, moveOutAndRemove, removeTree, sealInstallation, setInstalledModes, writeStoreFile } from './files.ts'
import { withStoreLock } from './lock.ts'
import type { StorePaths } from './paths.ts'
import { readPointerFile, syncDirectory } from './pointer.ts'
import { pointPacks } from './packs-current.ts'

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
}

/** The files an external package put into a pack, recorded at install because the signed list does not name them. */
interface PackRecord {
  readonly v: 1
  readonly release: string
  readonly name: string
  readonly version: string
  readonly externals: readonly { readonly path: string, readonly length: number, readonly sha256: string, readonly mode: '0644' | '0755' }[]
}

/**
 * The variant of a pack for a platform.
 * @param entry - the pack.
 * @param platform - the platform.
 * @returns the platform's variant, or the platform-independent one.
 * @throws PackRefusal `NOT_PUBLISHED` when the release publishes the pack for neither.
 */
export function packVariantFor(entry: PackEntry, platform: RuntimePlatform): PackVariant {
  const variant = entry.variants[platform] ?? entry.variants.any
  if (variant === undefined) throw new PackRefusal(`${entry.name} is not published for ${platform}`, 'NOT_PUBLISHED')
  return variant
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Every regular file below `directory`, `/`-separated and relative to `root`; symbolic links are returned apart. */
async function walk(root: string, directory: string, files: string[], links: string[]): Promise<void> {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name)
    const relative = path.slice(root.length + 1).split('\\').join('/')
    if (child.isSymbolicLink()) links.push(relative)
    else if (child.isDirectory()) await walk(root, path, files, links)
    else files.push(relative)
  }
}

/**
 * Give every file of a pack the installed mode of C1 (0444, or 0555 when executable) and every directory 0555. Listed
 * files go through {@link setInstalledModes}; files an external package brought are sealed by their executable bit.
 */
async function seal(packageDirectory: string, variant: PackVariant): Promise<void> {
  await setInstalledModes(packageDirectory, variant)
  const files: string[] = []
  await walk(packageDirectory, packageDirectory, files, [])
  const listed = new Set(variant.files.map(file => file.path))
  for (const path of files) {
    if (listed.has(path)) continue
    const absolute = join(packageDirectory, ...path.split('/'))
    await chmod(absolute, installedFileMode(((await lstat(absolute)).mode & 0o111) === 0 ? '0644' : '0755'))
  }
  await sealInstallation(packageDirectory)
}

async function recordExternals(packageDirectory: string, variant: PackVariant): Promise<PackRecord['externals']> {
  const externals: { path: string, length: number, sha256: string, mode: '0644' | '0755' }[] = []
  for (const pin of variant.external) {
    const root = joinInside(packageDirectory, 'node_modules', ...pin.name.split('/'))
    const files: string[] = []
    await walk(packageDirectory, root, files, [])
    for (const path of files.sort()) {
      const absolute = join(packageDirectory, ...path.split('/'))
      const bytes = await readFile(absolute)
      externals.push({ path, length: bytes.byteLength, sha256: sha256Of(bytes), mode: ((await lstat(absolute)).mode & 0o111) === 0 ? '0644' : '0755' })
    }
  }
  return externals
}

/** Wrap a file-system failure; refusals, store codes and other typed failures pass through. */
function wrapped(error: unknown, what: string): unknown {
  if (error instanceof PackRefusal || typeof (error as NodeJS.ErrnoException).code !== 'string' || !/^E[A-Z]+$/u.test((error as NodeJS.ErrnoException).code!)) return error
  return new PackRefusal(`${what}: ${(error as Error).message}`, 'FILE_ERROR', { cause: error })
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function installLocked(request: PackInstallRequest): Promise<string> {
  const { paths, release, entry, platform } = request
  const variant = packVariantFor(entry, platform)
  const target = paths.pack(release, entry.name)
  if (await exists(target)) {
    await checkInstalledPack(paths, release, entry, platform)
    return join(target, 'package')
  }
  const stage = await createStagingDirectory(paths.staging)
  try {
    const packageDirectory = join(stage, 'package')
    await mkdir(packageDirectory, { mode: PRIVATE_DIR_MODE })
    await extractPack(request.archive, variant, packageDirectory)
    for (const pin of variant.external) {
      await extractExternal(await request.fetchExternal(pin), pin, joinInside(packageDirectory, 'node_modules', ...pin.name.split('/')))
    }
    const runtimeModules = paths.runtimeNodeModules(release)
    for (const peer of variant.peers) {
      const provided = joinInside(runtimeModules, ...peer.split('/'))
      if (!(await exists(provided))) throw new PackRefusal(`${entry.name} needs ${peer}, which this runtime does not provide`, 'PEER_MISSING')
      const link = joinInside(packageDirectory, 'node_modules', ...peer.split('/'))
      await mkdir(dirname(link), { recursive: true })
      await symlink(provided, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const externals = await recordExternals(packageDirectory, variant)
    await seal(packageDirectory, variant)
    // The record goes first: a crash between the two steps leaves a record with no pack, which the next install
    // overwrites, and never a pack with no record, which would refuse every start.
    const record: PackRecord = { v: 1, release, name: entry.name, version: entry.version, externals }
    await mkdir(dirname(paths.packRecord(release, entry.name)), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeStoreFile(paths.packRecord(release, entry.name), Buffer.from(`${JSON.stringify(record)}\n`), 0o600)
    await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE })
    await rename(stage, target)
    await sealInstallation(target)
    await syncDirectory(dirname(target))
    return join(target, 'package')
  } catch (error) {
    await removeTree(stage)
    throw wrapped(error, `installing ${entry.name}`)
  }
}

/**
 * Install one pack for a release, under `store.lock`: an install never runs while retention removes staging, and two
 * installs of the same pack run one after the other, the second finding the first's pack and checking it.
 * @param request - the verified entry, the archive and the place to fetch externals from.
 * @returns the pack's package directory, `packs/<release>/<name>/package`.
 * @throws PackRefusal when the archive or an external package does not match what the targets key signed, a peer is
 * missing from the runtime, a file operation fails (`FILE_ERROR`), or a pack already installed no longer matches
 * (`INSTALLED_PACK_CHANGED`); nothing new is left under `packs/`.
 * @throws RuntimeStoreError `STORE_BUSY` when the lock is not free in time.
 */
export async function installPack(request: PackInstallRequest): Promise<string> {
  await mkdir(request.paths.root, { recursive: true, mode: PRIVATE_DIR_MODE })
  return withStoreLock(request.paths.lock, STORE_LOCK_WAIT_MS, async () => {
    const directory = await installLocked(request)
    // A pack of the running release is reached through `packs/current`, so the link must exist before a profile links it.
    if (await readPointerFile(request.paths.pointer('current')) === request.release) await pointPacks(request.paths, request.release)
    return directory
  })
}

async function readRecord(paths: StorePaths, release: RuntimeVersion, name: string): Promise<PackRecord | undefined> {
  let text: string
  try {
    text = await readFile(paths.packRecord(release, name), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(text) as Partial<PackRecord>
  return parsed.v === 1 && parsed.release === release && parsed.name === name && Array.isArray(parsed.externals) ? parsed as PackRecord : undefined
}

/**
 * Hash every installed file of a pack against the signed list and the install's record.
 * @param paths - the store's paths.
 * @param release - the release the pack belongs to.
 * @param entry - the pack's verified entry.
 * @param platform - this computer's platform.
 * @returns what differs: a changed, missing, extra or relinked file, or a mode other than the sealed one; empty when
 * the pack is intact.
 */
export async function packProblems(paths: StorePaths, release: RuntimeVersion, entry: PackEntry, platform: RuntimePlatform): Promise<string[]> {
  const variant = packVariantFor(entry, platform)
  const directory = join(paths.pack(release, entry.name), 'package')
  const record = await readRecord(paths, release, entry.name)
  if (record === undefined) return [`${entry.name} has no install record`]
  const signed = new Set(variant.files.map(file => file.path))
  const roots = variant.external.map(pin => `node_modules/${pin.name}/`)
  const strays = record.externals.filter(file => signed.has(file.path) || !roots.some(root => file.path.startsWith(root)) || file.path.includes('..'))
  if (strays.length > 0) return [`${entry.name}'s install record names ${strays.slice(0, 3).map(file => file.path).join(', ')}, which is not inside a pinned external package`]
  const expected = new Map<string, { length: number, sha256: string, mode: '0644' | '0755' }>([...variant.files, ...record.externals].map(file => [file.path, file]))
  const files: string[] = []
  const links: string[] = []
  try {
    await walk(directory, directory, files, links)
  } catch (error) {
    return [`${entry.name} cannot be read: ${(error as Error).message}`]
  }
  const problems: string[] = []
  const peerLinks = new Map(variant.peers.map(peer => [`node_modules/${peer}`, join(paths.runtimeNodeModules(release), ...peer.split('/'))]))
  for (const link of links) {
    const wanted = peerLinks.get(link)
    if (wanted === undefined || await readlink(join(directory, ...link.split('/'))) !== wanted) problems.push(`${link} is a link the install did not make`)
  }
  for (const peer of peerLinks.keys()) if (!links.includes(peer)) problems.push(`${peer} link is missing`)
  for (const path of files) if (!expected.has(path)) problems.push(`${path} is not in the signed file list`)
  for (const [path, file] of expected) {
    const absolute = join(directory, ...path.split('/'))
    const stats = await lstat(absolute).catch(() => undefined)
    if (stats === undefined) problems.push(`${path} is missing`)
    else if (!stats.isFile()) problems.push(`${path} is not a regular file`)
    else {
      const bytes = await readFile(absolute)
      if (bytes.byteLength !== file.length || sha256Of(bytes) !== file.sha256) problems.push(`${path} differs from its signed digest`)
      else if (process.platform !== 'win32' && (stats.mode & 0o777) !== installedFileMode(file.mode)) problems.push(`${path} has mode ${(stats.mode & 0o777).toString(8)}, not its sealed mode`)
    }
  }
  return problems
}

/**
 * Refuse an installed pack that no longer matches what was installed.
 * @param paths - the store's paths.
 * @param release - the release the pack belongs to.
 * @param entry - the pack's verified entry.
 * @param platform - this computer's platform.
 * @throws PackRefusal `INSTALLED_PACK_CHANGED` naming up to five differing files.
 */
export async function checkInstalledPack(paths: StorePaths, release: RuntimeVersion, entry: PackEntry, platform: RuntimePlatform): Promise<void> {
  const problems = await packProblems(paths, release, entry, platform)
  if (problems.length > 0) throw new PackRefusal(`the installed pack ${entry.name} differs from its signed file list: ${problems.slice(0, 5).join('; ')}`, 'INSTALLED_PACK_CHANGED')
}

/**
 * Remove an installed pack and its record, under `store.lock`, so a repair can install it again.
 * @param paths - the store's paths.
 * @param release - the release.
 * @param name - the pack's package name.
 */
export async function removePack(paths: StorePaths, release: RuntimeVersion, name: string): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: PRIVATE_DIR_MODE })
  await withStoreLock(paths.lock, STORE_LOCK_WAIT_MS, async () => {
    const target = paths.pack(release, name)
    if (await exists(target)) await moveOutAndRemove(target, paths.staging)
    await removeTree(paths.packRecord(release, name))
  })
}

/**
 * Remove a directory of `packs/<release>/` that the signed packs file does not list, under `store.lock`.
 * @param paths - the store's paths.
 * @param directory - the directory.
 */
export async function removeUnlisted(paths: StorePaths, directory: string): Promise<void> {
  await withStoreLock(paths.lock, STORE_LOCK_WAIT_MS, () => moveOutAndRemove(directory, paths.staging))
}
