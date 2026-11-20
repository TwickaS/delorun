/**
 * Plugin pack content an update installed from the signed release is the new baseline, never a person's change
 * (contract C21, "Plugin packs across an update"). A pack's folder under `packs/` holds the release's own files, so
 * when an update replaces it, the approved content (the previous release's files) and the folder differ only by what
 * the release replaced. The successor of an update hands `enforceApprovedContent` the files its verified packs files
 * list ({@link UpdateBaseline}); this module decides, for one plugin, whether the difference is nothing but release
 * files ({@link supersededByUpdate}).
 *
 * Nothing here writes. Only the start of an update's successor builds an {@link UpdateBaseline}, after it verified
 * the stored packs files itself, and only the start's pass over the profile acts on the answer
 * ([enforce](./enforce.ts)); no route, page or plugin reaches either.
 *
 * @module @delorun/changes/update-baseline
 */
import { resolve, sep } from 'node:path'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import type { SignedPackFiles } from '@delorun/runtime-store'
import { readObject } from './store.ts'
import type { VersionEntry, VersionManifest } from './types.ts'

export type { SignedPackFiles }

/** What an update's successor verified: the two releases and the files their packs files list. */
export interface UpdateBaseline {
  /** The release the update left; older than `to`. */
  readonly from: string
  /** The release this process runs. */
  readonly to: string
  /** The signed files of each pack of `from` and of `to`, from their verified packs files. */
  readonly packs: readonly SignedPackFiles[]
}

/**
 * Whether a folder is an unpacked plugin pack of the home: a folder under `packs/`, which holds a release's own files.
 * No one edits them live, and watching them would scan each pack and queue it for the profile write lock, which a pack
 * install holds for minutes; a start or a reload decides a linked pack's content under that lock.
 * @param home - the Delorun home.
 * @param folder - a plugin's folder.
 * @returns true for a folder under `packs/`.
 */
export function inPackStore(home: string, folder: string): boolean {
  return resolve(folder).startsWith(`${resolve(home, DELORUN_HOME_ENTRIES.packs)}${sep}`)
}

/**
 * Security invariant: the last release whose packs carry the build's temporary folder name in their dependency
 * specifiers. Only the approved content of an update that leaves this release or an earlier one may match a signed file
 * apart from that name ({@link leftReleaseWithBuildPaths}); a later release's packs are matched byte for byte. Raising
 * it widens what an update folds into the baseline, so it changes only with a release that was built with those paths.
 */
export const LAST_RELEASE_WITH_BUILD_PATHS = '0.1.0-preview.2.1'

/** A release of the 0.1.0 preview line: the preview number and an optional patch number. */
const PREVIEW_RELEASE = /^0\.1\.0-preview\.(\d+)(?:\.(\d+))?$/u

/**
 * @param release - a release name.
 * @returns its preview and patch numbers, or `undefined` when it is not a release of the 0.1.0 preview line.
 */
function previewNumbers(release: string): readonly [number, number] | undefined {
  const match = PREVIEW_RELEASE.exec(release)
  return match === null ? undefined : [Number(match[1]), Number(match[2] ?? 0)]
}

/**
 * @param release - the release an update left.
 * @returns whether it is {@link LAST_RELEASE_WITH_BUILD_PATHS} or an earlier release of the 0.1.0 preview line; any
 *   other name is not.
 */
export function leftReleaseWithBuildPaths(release: string): boolean {
  const left = previewNumbers(release)
  const last = previewNumbers(LAST_RELEASE_WITH_BUILD_PATHS)!
  return left !== undefined && (left[0] < last[0] || (left[0] === last[0] && left[1] <= last[1]))
}

/** The files of a pack whose text may carry the build's temporary folder name. */
const BUILD_PATH_FILES: ReadonlySet<string> = new Set(['package.json', 'pnpm-lock.yaml'])

/** One `delorun-release-build-<random>` folder segment, which is the only text {@link withoutBuildFolder} replaces. */
const BUILD_FOLDER = /(?<=\/)delorun-release-build-[A-Za-z0-9]+(?=\/)/gu

/**
 * @param text - a file's text.
 * @returns the text with each build folder segment replaced by a fixed token.
 */
export function withoutBuildFolder(text: string): string {
  return text.replaceAll(BUILD_FOLDER, 'delorun-release-build-TOKEN')
}

/**
 * @param entry - an entry of the folder's content.
 * @param pack - a pack's signed files.
 * @returns whether the entry is exactly one of the pack's signed files or runtime links.
 */
function listed(entry: VersionEntry, pack: SignedPackFiles): boolean {
  if (entry.type === 'link') return entry.runtime === true && entry.outside && pack.peers.some(peer => entry.path === `node_modules/${peer}` && entry.target === peer)
  const signed = pack.files.get(entry.path)
  return signed !== undefined && signed.sha256 === entry.digest && signed.executable === entry.executable
}

/**
 * @param after - the folder's content now.
 * @param pack - the pack's signed files in the release this process runs.
 * @returns whether the folder holds exactly those files and links: each entry is listed, and each listed file and link is present.
 */
function isExactly(after: VersionManifest, pack: SignedPackFiles): boolean {
  const present = new Set(after.entries.map(entry => entry.path))
  return after.entries.every(entry => listed(entry, pack))
    && [...pack.files.keys()].every(path => present.has(path))
    && pack.peers.every(peer => present.has(`node_modules/${peer}`))
}

/**
 * @param home - the Delorun home, whose store holds the approved content's objects.
 * @param entry - an entry of the approved content.
 * @param pools - the packs of the two releases.
 * @returns whether the entry is a file or link some pack lists; a `package.json` or `pnpm-lock.yaml` also counts when it
 *   equals a listed one apart from the build folder names ({@link withoutBuildFolder}).
 */
async function isReleaseEntry(home: string, entry: VersionEntry, pools: readonly SignedPackFiles[], buildPaths: boolean): Promise<boolean> {
  if (pools.some(pack => listed(entry, pack))) return true
  if (!buildPaths || entry.type !== 'file' || !BUILD_PATH_FILES.has(entry.path) || entry.executable) return false
  const text = withoutBuildFolder((await readObject(home, entry.digest)).toString('utf8'))
  return pools.some(pack => {
    const signed = pack.texts.get(entry.path)
    return signed !== undefined && withoutBuildFolder(signed) === text
  })
}

/** What {@link supersededByUpdate} compares. */
export interface SupersedeRequest {
  /** The package name. */
  readonly plugin: string
  /** The approved content. */
  readonly before: VersionManifest
  /** The folder's content now. */
  readonly after: VersionManifest
}

/**
 * Whether the difference between a plugin's approved content and its folder is only the release's own files: the
 * folder holds exactly what the verified packs file of the release this process runs lists for the pack (no other
 * file, link or byte), and every approved file or link that differs from the folder's is one a pack of either
 * release lists. A `package.json` or `pnpm-lock.yaml` approved from a release up to {@link LAST_RELEASE_WITH_BUILD_PATHS} also counts
 * when it equals a listed one apart from the build's temporary folder names. A difference that holds any other
 * edit, or a folder that is not the signed pack, is a person's change and is not superseded.
 * @param home - the Delorun home.
 * @param baseline - what the update's successor verified.
 * @param request - the plugin, its approved content and its folder's content.
 * @returns true when the update replaces the approved content with the release's own.
 * @throws {ChangesError} `STORE_CORRUPT` when an object of the approved content is missing or altered.
 */
export async function supersededByUpdate(home: string, baseline: UpdateBaseline, request: SupersedeRequest): Promise<boolean> {
  const { plugin, before, after } = request
  const target = baseline.packs.find(pack => pack.release === baseline.to && pack.name === plugin)
  if (target === undefined || !isExactly(after, target)) return false
  const pools = baseline.packs.filter(pack => pack.name === plugin && (pack.release === baseline.from || pack.release === baseline.to))
  const buildPaths = leftReleaseWithBuildPaths(baseline.from)
  const now = new Map(after.entries.map(entry => [entry.path, entry]))
  for (const entry of before.entries) {
    const kept = now.get(entry.path)
    const same = kept !== undefined && (entry.type === 'file'
      ? kept.type === 'file' && kept.digest === entry.digest && kept.executable === entry.executable
      : kept.type === 'link' && kept.target === entry.target && kept.runtime === entry.runtime)
    if (!same && !await isReleaseEntry(home, entry, pools, buildPaths)) return false
  }
  return true
}
