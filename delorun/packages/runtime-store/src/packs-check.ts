/**
 * The start check and `delorun verify` of installed packs: when `packs/<release>/` exists, the stored packs file must
 * verify under the trusted root against the stored manifest, every directory in it must be a pack that file lists, and
 * every installed file of each must hash to its signed digest ({@link packProblems}).
 *
 * @module @delorun/runtime-store/packs-check
 */
import { readdir, readFile } from 'node:fs/promises'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_FILE_SIZE_LIMITS, type RootMetadata } from '@delorun/contract-release-manifest'
import { verifyPacks } from '@delorun/release-formats/sign/verify'
import { packProblems } from './packs.ts'
import type { StorePaths } from './paths.ts'

/**
 * Find what differs in a release's installed packs.
 * @param paths - the store's paths.
 * @param root - the trusted root.
 * @param version - the installed release.
 * @returns what differs, one line per problem; empty when no pack is installed or all are intact.
 */
export async function installedPacksProblems(paths: StorePaths, root: RootMetadata, version: RuntimeVersion): Promise<string[]> {
  let installed: string[]
  try {
    installed = await readdir(paths.packs.concat('/', version))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (installed.length === 0) return []
  const files = paths.releaseFiles(version)
  let packsBytes: Buffer
  let manifestBytes: Buffer
  try {
    ;[packsBytes, manifestBytes] = await Promise.all([readFile(files.packs), readFile(files.manifest)])
    if (packsBytes.byteLength > RELEASE_FILE_SIZE_LIMITS.packs) return ['the stored packs file is above its size limit']
  } catch (error) {
    return [`the installed packs have no readable signed packs file: ${(error as Error).message}`]
  }
  let packs
  try {
    packs = verifyPacks(root, manifestBytes, packsBytes)
  } catch (error) {
    return [`the stored packs file does not verify: ${(error as Error).message}`]
  }
  const problems: string[] = []
  const known = new Set<string>()
  for (const entry of packs.packs) {
    const directory = paths.pack(version, entry.name).slice(paths.packs.length + version.length + 2)
    if (!installed.includes(directory)) continue
    known.add(directory)
    problems.push(...await packProblems(paths, version, entry, paths.platform))
  }
  for (const directory of installed) if (!known.has(directory)) problems.push(`packs/${version}/${directory} is not a pack the signed packs file lists`)
  return problems
}
