/**
 * Packs across releases: an update installs, before `current` moves, the new release's version of every pack the home
 * has added, so plugin and runtime versions always match; a rollback needs nothing, because `packs/<previous>/` stays
 * with the kept `previous` runtime; a repair hashes the installed packs again and fetches a damaged one anew.
 *
 * @module @delorun/runtime-store/packs-carry
 */
import { access, readFile } from 'node:fs/promises'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import { verifyPacks } from '@delorun/release-formats/sign/verify'
import { acquirePacks, fetchPack, installFetchedPack, type InstalledRelease, type PackFiles, type PacksLogCheck, type PackTransfer } from './packs-client.ts'
import { packProblems, removePack } from './packs.ts'
import type { StorePaths } from './paths.ts'

/** What carrying and repairing packs need. */
export interface PackCarry {
  /** The store's paths. */
  readonly paths: StorePaths
  /** The anchored trusted root. */
  readonly root: () => Promise<RootMetadata>
  /** The release channel's files for a release. */
  readonly filesFor: (version: RuntimeVersion) => Promise<PackFiles>
  /** The release-log check of a packs file's bundle. */
  readonly checkLog: PacksLogCheck
}

async function installedRelease(carry: PackCarry, version: RuntimeVersion): Promise<InstalledRelease> {
  return { paths: carry.paths, root: await carry.root(), version, manifestBytes: await readFile(carry.paths.releaseFiles(version).manifest), checkLog: carry.checkLog }
}

async function present(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** The names of the packs installed for a release, read through its stored, verified packs file. */
async function installedNames(carry: PackCarry, version: RuntimeVersion): Promise<string[]> {
  const files = carry.paths.releaseFiles(version)
  if (!await present(files.packs)) return []
  const packs = verifyPacks(await carry.root(), await readFile(files.manifest), await readFile(files.packs))
  const names: string[] = []
  for (const entry of packs.packs) if (await present(carry.paths.pack(version, entry.name))) names.push(entry.name)
  return names
}

/**
 * Install, for the release an update is about to switch to, the new version of each pack the home has added.
 * @param carry - the store, root and channel.
 * @param from - the release that runs now.
 * @param to - the installed release the update switches to.
 * @returns the names carried.
 * @throws PackRefusal `NO_SUCH_PACK` when the new release no longer publishes an added pack, or whatever a fetch or an
 * install refuses; the packs this call installed for `to` are removed first, so the update fails with nothing
 * half-carried and `current` unchanged.
 */
export async function carryPacks(carry: PackCarry, from: RuntimeVersion, to: RuntimeVersion): Promise<string[]> {
  if (from === to) return []
  const names = await installedNames(carry, from)
  if (names.length === 0) return []
  const release = await installedRelease(carry, to)
  const files = await carry.filesFor(to)
  const done: string[] = []
  try {
    const packs = await acquirePacks(release, files)
    if (packs === undefined) throw new PackRefusal(`release ${to} publishes no plugin packs, but this home has added ${names.join(', ')}`, 'NO_SUCH_PACK')
    for (const name of names) {
      if (!packs.packs.some(entry => entry.name === name)) throw new PackRefusal(`release ${to} no longer publishes the plugin pack ${name}`, 'NO_SUCH_PACK')
      await installFetchedPack(release, await fetchPack(release, name, files))
      done.push(name)
    }
  } catch (error) {
    for (const name of done) await removePack(carry.paths, to, name)
    throw error
  }
  return done
}

/**
 * Hash a release's installed packs again and fetch any that are damaged.
 * @param carry - the store, root and channel.
 * @param version - the installed release.
 * @param transfer - the abort signal and byte progress of each download.
 * @returns the packs that were intact and the packs that were removed and installed again.
 * @throws PackRefusal when a damaged pack cannot be fetched and installed again; it is left removed rather than trusted.
 */
export async function repairPacks(carry: PackCarry, version: RuntimeVersion, transfer?: PackTransfer): Promise<{ readonly intact: string[], readonly repaired: string[] }> {
  const release = await installedRelease(carry, version)
  const files = await carry.filesFor(version)
  const packs = await acquirePacks(release, files)
  const result = { intact: [] as string[], repaired: [] as string[] }
  if (packs === undefined) return result
  for (const entry of packs.packs) {
    if (!await present(carry.paths.pack(version, entry.name))) continue
    if ((await packProblems(carry.paths, version, entry, carry.paths.platform)).length === 0) {
      result.intact.push(entry.name)
      continue
    }
    await removePack(carry.paths, version, entry.name)
    await installFetchedPack(release, await fetchPack(release, entry.name, files, transfer))
    result.repaired.push(entry.name)
  }
  return result
}
