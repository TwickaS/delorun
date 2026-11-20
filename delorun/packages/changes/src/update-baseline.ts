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
import type { ApprovedRecord, VersionEntry, VersionManifest } from './types.ts'

export type { SignedPackFiles }

/** What an update's successor verified: the two releases and the files their packs files list. */
export interface UpdateBaseline {
  /** The release the update left; older than `to`. */
  readonly from: string
  /** The release this process runs. */
  readonly to: string
  /**
   * Whether either release's verified packs file lists a pack; reads no installed file.
   * @param name - the pack's package name.
   * @returns true when `from` or `to` lists a pack of that name.
   */
  lists(name: string): boolean
  /**
   * The signed files of one pack in `from` and in `to`, from their verified packs files; each release that lists the pack
   * gives one entry. Reading a pack hashes its installed files, so a pack is asked for only when a waiting change touches
   * it, and the provider answers the same pack once.
   * @param name - the pack's package name.
   * @returns the pack's signed files; none for a release that lists no such pack or whose pack cannot be read.
   */
  packsFor(name: string): Promise<readonly SignedPackFiles[]>
}

/**
 * A baseline over packs that are already read.
 * @param from - the release the update left.
 * @param to - the release this process runs.
 * @param packs - the signed files of each pack of both releases.
 * @returns the baseline, which answers each pack from `packs`.
 */
export function baselineOfPacks(from: string, to: string, packs: readonly SignedPackFiles[]): UpdateBaseline {
  return { from, to, lists: name => packs.some(pack => pack.name === name), packsFor: name => Promise.resolve(packs.filter(pack => pack.name === name)) }
}

/**
 * Whether an update's baseline can replace anything: some plugin the profile has approved is linked from the pack
 * store and is a pack one of the two releases lists. Without one, no waiting change is about a release's own files,
 * and the successor has nothing to read.
 * @param home - the Delorun home.
 * @param approved - the profile's approved plugins.
 * @param baseline - what the successor verified.
 * @returns true when {@link supersededByUpdate} may be asked about some approved plugin.
 */
export function baselineMayApply(home: string, approved: ApprovedRecord, baseline: Pick<UpdateBaseline, 'lists'>): boolean {
  return Object.entries(approved.plugins).some(([plugin, { source }]) => inPackStore(home, source) && baseline.lists(plugin))
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
 * @param entry - an entry of a folder's content.
 * @param pack - a pack's signed files.
 * @returns whether the entry is a regular file whose digest and execute bit are the pack's signed ones.
 */
function signedFile(entry: VersionEntry, pack: SignedPackFiles | undefined): boolean {
  const signed = entry.type === 'file' ? pack?.files.get(entry.path) : undefined
  return entry.type === 'file' && signed !== undefined && signed.sha256 === entry.digest && signed.executable === entry.executable
}

/**
 * @param left - an entry of the approved content, or none.
 * @param right - an entry of the folder's content, or none.
 * @returns whether both are absent or both are the same file or link.
 */
function sameEntry(left: VersionEntry | undefined, right: VersionEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.type === 'file'
    ? right.type === 'file' && right.digest === left.digest && right.executable === left.executable
    : right.type === 'link' && right.target === left.target && right.runtime === left.runtime
}

/**
 * @param home - the Delorun home, whose store holds the approved content's objects.
 * @param entry - an approved entry that the folder no longer holds as it is.
 * @param origin - the pack of the release the update left.
 * @param buildPaths - whether that release may carry the build's folder names ({@link leftReleaseWithBuildPaths}).
 * @returns whether the entry is a file the release the update left signed; a `package.json` or `pnpm-lock.yaml` also
 *   counts when it equals the text of that release's installed, signed one apart from the build folder names ({@link withoutBuildFolder}).
 */
async function signedBefore(home: string, entry: VersionEntry, origin: SignedPackFiles | undefined, buildPaths: boolean): Promise<boolean> {
  if (entry.type !== 'file' || origin === undefined) return false
  if (signedFile(entry, origin)) return true
  // The signed file must be the same kind of file the approved one is, as the digest rule requires.
  if (!buildPaths || !BUILD_PATH_FILES.has(entry.path) || origin.files.get(entry.path)?.executable !== entry.executable) return false
  const signed = await origin.text(entry.path)
  return signed !== undefined && withoutBuildFolder(signed) === withoutBuildFolder((await readObject(home, entry.digest)).toString('utf8'))
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
 * Whether the difference between a plugin's approved content and its folder is only the release's own files. Only
 * the entries that differ are judged, by what the signed data vouches for: an entry the folder holds now must be a file
 * with the digest and execute bit the verified packs file of the release this process runs lists for it, and an
 * approved entry the folder no longer holds as it is must be a file the packs file of the release the update left
 * lists; an entry the approved content lacks must not be listed by that release either. A `package.json` or `pnpm-lock.yaml` approved from a release up to {@link LAST_RELEASE_WITH_BUILD_PATHS} also
 * counts when it equals that release's installed, signed one apart from the build's temporary folder names. A link, an entry the
 * signed lists do not vouch for, a signed file the folder lacks, or a person's edit among the differing entries
 * means the change is not superseded and waits for review. The digests are the ones the scans of the approved
 * content and the folder already hold; no installed pack is hashed.
 * @param home - the Delorun home.
 * @param baseline - what the update's successor verified.
 * @param request - the plugin, its approved content and its folder's content.
 * @returns true when the update replaces the approved content with the folder's.
 * @throws {ChangesError} `STORE_CORRUPT` when an object of the approved content is missing or altered.
 */
export async function supersededByUpdate(home: string, baseline: UpdateBaseline, request: SupersedeRequest): Promise<boolean> {
  const { plugin, before, after } = request
  const pools = (await baseline.packsFor(plugin)).filter(pack => pack.name === plugin && (pack.release === baseline.from || pack.release === baseline.to))
  const target = pools.find(pack => pack.release === baseline.to)
  if (target === undefined) return false
  const origin = pools.find(pack => pack.release === baseline.from)
  const buildPaths = leftReleaseWithBuildPaths(baseline.from)
  const was = new Map(before.entries.map(entry => [entry.path, entry]))
  const now = new Map(after.entries.map(entry => [entry.path, entry]))
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    const approved = was.get(path)
    const folder = now.get(path)
    if (sameEntry(approved, folder)) continue
    // The folder holds a file the release signs, or lacks a file it does not sign.
    if (folder === undefined ? target.files.has(path) : !signedFile(folder, target)) return false
    // An added entry must be absent from the release the update left too: a file it signs that the person deleted is the person's decision.
    if (approved === undefined ? origin === undefined || origin.files.has(path) : !await signedBefore(home, approved, origin, buildPaths)) return false
  }
  return true
}
