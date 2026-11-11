/**
 * What an update does with the harness changes a person approved: a three-way merge per file of the running release's
 * signed file (the base), the person's approved content (mine) and the target release's signed file (theirs). A
 * change carries when the target left the file as it was or when the person's edit applies to the target's file as it
 * is; anything else is a conflict, and a conflict never keeps either side silently: the target's file runs and the
 * person's is kept beside it. {@link planHarnessCarry} reads one runtime's record and plans every file, writing nothing,
 * and the plan holds all three sides so the update can write the target's record and the kept files from it.
 *
 * @module @delo/changes/harness-merge
 */
import { applyPatch, structuredPatch } from 'diff'
import { DIFF_FILE_LIMIT, isBinary } from './diff.ts'
import { ChangesError } from './errors.ts'
import { readObject, readVersion } from './store.ts'
import { compareCodeUnits } from './tree.ts'
import type { ApprovedHarnessFile, ContentVersion, HarnessRecord } from './types.ts'

/** One side of a harness file: its bytes and whether the owner execute bit is set. */
export interface HarnessFileSide {
  /** The file's bytes. */
  readonly bytes: Buffer
  /** Whether the owner execute bit is set. */
  readonly executable: boolean
}

/** The three sides of one file; `undefined` for a side that has no such file. */
export interface HarnessMergeInput {
  /** The running release's signed file. */
  readonly base: HarnessFileSide | undefined
  /** The person's approved content. */
  readonly mine: HarnessFileSide | undefined
  /** The target release's signed file. */
  readonly theirs: HarnessFileSide | undefined
  /** The largest file, in bytes, whose text is merged when both sides changed it; {@link DIFF_FILE_LIMIT} by default. */
  readonly fileLimit?: number
}

/**
 * Why a file conflicts.
 *
 * - `edits-overlap`: the patch from the base to the person's content does not apply to the target's file as it is.
 * - `binary`: both sides changed a file that is not UTF-8 text or holds a NUL byte.
 * - `too-large`: both sides changed a file one side of which is larger than the file limit.
 * - `release-removed`: the target has no such file, and the person changed it.
 * - `release-changed-removed`: the person removed the file, and the target changed it.
 * - `both-added`: the base has no such file, and the target adds one with other content than the person's.
 */
export type HarnessConflict = 'edits-overlap' | 'binary' | 'too-large' | 'release-removed' | 'release-changed-removed' | 'both-added'

/** How a change carries: `release-unchanged` when the target left the file as the base, `merged` otherwise. */
export type HarnessCarry = 'release-unchanged' | 'merged'

/**
 * The outcome of one file's merge.
 *
 * - `carried`: the target runs `result`, the person's change applied to the target's file; `undefined` carries the
 *   person's removal of the file.
 * - `same`: the target's file equals the person's content, so the target runs its signed file and needs no record entry.
 * - `conflict`: the target's file runs, and the person's content is kept beside it.
 */
export type HarnessMergeResult =
  | { readonly outcome: 'carried', readonly carry: HarnessCarry, readonly result: HarnessFileSide | undefined }
  | { readonly outcome: 'same' }
  | { readonly outcome: 'conflict', readonly conflict: HarnessConflict }

/**
 * Whether two sides hold the same file.
 * @param a - one side, or `undefined` for none.
 * @param b - the other.
 * @returns whether both are absent, or both hold equal bytes and the same execute bit.
 */
function sameSide(a: HarnessFileSide | undefined, b: HarnessFileSide | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.executable === b.executable && a.bytes.equals(b.bytes)
}

/**
 * A conflict.
 * @param conflict - why.
 * @returns the result.
 */
function conflictOf(conflict: HarnessConflict): HarnessMergeResult {
  return { outcome: 'conflict', conflict }
}

/**
 * A change that carries by merging.
 * @param bytes - the merged bytes.
 * @param executable - the merged execute bit.
 * @returns the result.
 */
function merged(bytes: Buffer, executable: boolean): HarnessMergeResult {
  return { outcome: 'carried', carry: 'merged', result: { bytes, executable } }
}

/**
 * Merge the text of a file both sides changed: the patch from the base to the person's text applied to the target's
 * text with no fuzz and no line-ending conversion.
 * @param base - the base's bytes.
 * @param mine - the person's bytes.
 * @param theirs - the target's bytes.
 * @param fileLimit - the largest side, in bytes, that is read as text.
 * @returns the merged bytes, or why they conflict.
 */
function mergeText(base: Buffer, mine: Buffer, theirs: Buffer, fileLimit: number): Buffer | HarnessConflict {
  const sides = [base, mine, theirs]
  if (sides.some(bytes => bytes.length > fileLimit)) return 'too-large'
  if (sides.some(isBinary)) return 'binary'
  const patch = structuredPatch('base', 'mine', base.toString('utf8'), mine.toString('utf8'))
  const text = applyPatch(theirs.toString('utf8'), patch, { fuzzFactor: 0, autoConvertLineEndings: false })
  return text === false ? 'edits-overlap' : Buffer.from(text, 'utf8')
}

/**
 * Merge one harness file across an update.
 * @param input - the base, the person's content and the target's file, and the file limit.
 * @returns whether the change carries, with the content the target runs, is already the target's, or conflicts.
 */
export function mergeHarnessFile(input: HarnessMergeInput): HarnessMergeResult {
  const { base, mine, theirs } = input
  if (sameSide(mine, theirs)) return { outcome: 'same' }
  if (sameSide(base, theirs)) return { outcome: 'carried', carry: 'release-unchanged', result: mine }
  // From here the target changed the file and differs from the person's content.
  if (sameSide(base, mine)) return { outcome: 'carried', carry: 'merged', result: theirs }
  if (theirs === undefined) return conflictOf('release-removed')
  if (base === undefined) return conflictOf('both-added')
  if (mine === undefined) return conflictOf('release-changed-removed')
  // Each side's execute bit merges on its own: the person's when they changed it, otherwise the target's.
  const executable = mine.executable !== base.executable ? mine.executable : theirs.executable
  if (mine.bytes.equals(base.bytes) || mine.bytes.equals(theirs.bytes)) return merged(theirs.bytes, executable)
  if (theirs.bytes.equals(base.bytes)) return merged(mine.bytes, executable)
  const text = mergeText(base.bytes, mine.bytes, theirs.bytes, input.fileLimit ?? DIFF_FILE_LIMIT)
  return typeof text === 'string' ? conflictOf(text) : merged(text, executable)
}

/**
 * Read the target release's signed file at a path, after its file list is verified.
 * @param path - the file's path relative to the runtime's root.
 * @returns the file, or `undefined` when the target's signed file list has no such file.
 */
export type ReadSignedHarnessFile = (path: string) => Promise<HarnessFileSide | undefined>

/** One file of a {@link HarnessCarryPlan}. */
export interface HarnessCarryEntry {
  /** The file's path relative to the runtime's root, under `app/`. */
  readonly file: string
  /** The running runtime's record of the file. */
  readonly approved: ApprovedHarnessFile
  /** The running release's signed file. */
  readonly base: HarnessFileSide | undefined
  /** The person's approved content. */
  readonly mine: HarnessFileSide | undefined
  /** The target release's signed file. */
  readonly theirs: HarnessFileSide | undefined
  /** The merge's outcome. */
  readonly merge: HarnessMergeResult
}

/**
 * What an update does with every approved harness file of the running runtime: one entry per file of its record, in
 * path order. A conflicted entry's `theirs` is what the target runs and its `mine` what is kept beside it.
 */
export interface HarnessCarryPlan {
  /** The running runtime, whose record the plan read. */
  readonly from: string
  /** One entry per file of the record, sorted by path in code-unit order. */
  readonly entries: readonly HarnessCarryEntry[]
}

/**
 * Read one side of a harness file from the store: a content version whose one file entry is at the file's path, or
 * the empty version for no file.
 * @param home - the Delo home.
 * @param file - the file's path.
 * @param version - the content version.
 * @returns the side, or `undefined` for the empty version.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the version holds anything else; `STORE_CORRUPT` when the store
 *   does not hold the version or its object.
 */
async function storedSide(home: string, file: string, version: ContentVersion): Promise<HarnessFileSide | undefined> {
  const [entry, ...rest] = (await readVersion(home, version)).entries
  if (entry === undefined) return undefined
  if (rest.length > 0 || entry.type !== 'file' || entry.path !== file) {
    throw new ChangesError('RECORD_UNREADABLE', file, `The harness record names version ${version} for ${file}, which does not hold that one file.`)
  }
  return { bytes: await readObject(home, entry.digest), executable: entry.executable }
}

/**
 * Plan what an update does with one runtime's approved harness files, writing nothing.
 * @param home - the Delo home, whose store holds the record's versions.
 * @param from - the running runtime's harness record.
 * @param readSigned - reads the target release's verified signed file at a path.
 * @returns one entry per file of the record, in path order.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a version of the record is not a one-file version of its path;
 *   `STORE_CORRUPT` when the store does not hold one. Whatever `readSigned` throws reaches the caller.
 */
export async function planHarnessCarry(home: string, from: HarnessRecord, readSigned: ReadSignedHarnessFile): Promise<HarnessCarryPlan> {
  const entries: HarnessCarryEntry[] = []
  for (const [file, approved] of Object.entries(from.files).sort(([a], [b]) => compareCodeUnits(a, b))) {
    const base = approved.signed === undefined ? undefined : await storedSide(home, file, approved.signed)
    const mine = await storedSide(home, file, approved.version)
    const theirs = await readSigned(file)
    entries.push({ file, approved, base, mine, theirs, merge: mergeHarnessFile({ base, mine, theirs }) })
  }
  return { from: from.runtime, entries }
}
