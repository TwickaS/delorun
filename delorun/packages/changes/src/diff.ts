/**
 * How two content versions differ: the changed files, a unified diff of their text bounded in size, and the input the
 * risk checks read. Both sides are read from the store, so what a person is shown is what an apply approves.
 *
 * @module @delorun/changes/diff
 */
import { isUtf8 } from 'node:buffer'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import { readObject } from './store.ts'
import { compareCodeUnits } from './tree.ts'
import type { BoundedDiff, FileChange, NotShownReason, ObjectDigest, ReviewedFile, ReviewInput, VersionEntry, VersionManifest } from './types.ts'

/** The largest file, in bytes on either side, whose text the diff and the risk checks read. */
export const DIFF_FILE_LIMIT = 1024 * 1024

/** The largest diff text, in UTF-8 bytes. */
export const DIFF_TOTAL_LIMIT = 256 * 1024

/** How many leading bytes are searched for a NUL byte, which makes a file binary. */
const BINARY_PROBE_BYTES = 8000

/** The bounds of a diff. */
export interface DiffBounds {
  /** The largest file whose text is read, in bytes; {@link DIFF_FILE_LIMIT} by default. */
  readonly file?: number
  /** The largest diff text, in UTF-8 bytes; {@link DIFF_TOTAL_LIMIT} by default. */
  readonly total?: number
}

/** Objects read once per call, by digest. */
type ObjectCache = Map<ObjectDigest, Buffer>

/**
 * Read an object through a per-call cache.
 * @param home - the Delorun home.
 * @param cache - the objects already read.
 * @param digest - the object's digest.
 * @returns its bytes.
 */
async function cachedObject(home: string, cache: ObjectCache, digest: ObjectDigest): Promise<Buffer> {
  const cached = cache.get(digest)
  if (cached !== undefined) return cached
  const bytes = await readObject(home, digest)
  cache.set(digest, bytes)
  return bytes
}

/**
 * Whether bytes are not text: a NUL byte in the first 8000 bytes, or not valid UTF-8.
 * @param bytes - the bytes.
 * @returns whether they are binary.
 */
export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) || !isUtf8(bytes)
}

/**
 * Whether a path is a dependency's file.
 * @param path - the relative path.
 * @returns whether a segment is `node_modules`.
 */
function isDependency(path: string): boolean {
  return path.split('/').includes('node_modules')
}

/**
 * The size of an entry's content: a file's bytes, or a link's target in UTF-8.
 * @param entry - the entry.
 * @returns the size in bytes.
 */
function entrySize(entry: VersionEntry): number {
  return entry.type === 'file' ? entry.size : Buffer.byteLength(entry.target)
}

/**
 * Whether one side is binary. A link is text: its content is its target.
 * @param home - the Delorun home.
 * @param cache - the objects already read.
 * @param entry - the side, when it exists.
 * @returns whether it is a binary file.
 */
async function sideBinary(home: string, cache: ObjectCache, entry: VersionEntry | undefined): Promise<boolean> {
  return entry?.type === 'file' && isBinary(await cachedObject(home, cache, entry.digest))
}

/**
 * Whether two entries of one path differ.
 * @param a - one side.
 * @param b - the other.
 * @returns whether type, bytes, execute bit or target differ.
 */
function differs(a: VersionEntry, b: VersionEntry): boolean {
  if (a.type === 'file') return b.type !== 'file' || a.digest !== b.digest || a.executable !== b.executable
  return b.type !== 'link' || a.target !== b.target
}

/**
 * The entries of a manifest by path.
 * @param manifest - the manifest, or undefined for no content.
 * @returns the entries by path.
 */
function byPath(manifest: VersionManifest | undefined): Map<string, VersionEntry> {
  return new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]))
}

/**
 * The files that differ between two content versions.
 * @param home - the Delorun home, whose store holds both versions' objects.
 * @param before - the content before; undefined for none.
 * @param after - the content after.
 * @returns one change per differing path, in path order; a link counts as a file whose content is its target.
 * @throws {ChangesError} `STORE_CORRUPT` when an object is missing or altered.
 */
export async function compareVersions(home: string, before: VersionManifest | undefined, after: VersionManifest): Promise<FileChange[]> {
  const old = byPath(before)
  const updated = byPath(after)
  const paths = [...new Set([...old.keys(), ...updated.keys()])].sort(compareCodeUnits)
  const cache: ObjectCache = new Map()
  const changes: FileChange[] = []
  for (const path of paths) {
    const a = old.get(path)
    const b = updated.get(path)
    if (a !== undefined && b !== undefined && !differs(a, b)) continue
    const status = a === undefined ? 'added' : b === undefined ? 'removed' : 'modified'
    const binary = await sideBinary(home, cache, a) || await sideBinary(home, cache, b)
    changes.push({
      path,
      status,
      binary,
      dependency: isDependency(path),
      ...(a === undefined ? {} : { sizeBefore: entrySize(a) }),
      ...(b === undefined ? {} : { sizeAfter: entrySize(b) }),
    })
  }
  return changes
}

/**
 * The text of one side, when it is read: a text file within the file limit, or a link's target.
 * @param home - the Delorun home.
 * @param cache - the objects already read.
 * @param entry - the side.
 * @returns its text.
 */
async function sideText(home: string, cache: ObjectCache, entry: VersionEntry): Promise<string> {
  return entry.type === 'link' ? entry.target : (await cachedObject(home, cache, entry.digest)).toString('utf8')
}

/**
 * Whether a change's text is read: a text file that is not a dependency's and fits the file limit on both sides.
 * @param change - the change.
 * @param fileLimit - the file limit.
 * @returns whether its text is read.
 */
function textRead(change: FileChange, fileLimit: number): boolean {
  return !change.dependency && !change.binary && (change.sizeBefore ?? 0) <= fileLimit && (change.sizeAfter ?? 0) <= fileLimit
}

/**
 * A file's name on a diff's `Binary file` line: quoted as a JSON string when it holds a control character, a quote or a
 * backslash, as the diff library quotes such a name on its `---` and `+++` lines, so a name never starts a line of the
 * diff of its own.
 * @param path - the file's path.
 * @returns the name.
 */
function binaryName(path: string): string {
  return /[\u0000-\u001f\u007f"\\]/u.test(path) ? JSON.stringify(path) : path
}

/**
 * A unified diff of the changed text files, bounded in size. Dependency files never appear; a binary file is named on
 * one line without its lines; a text file above the file limit, and every text file from the first whose hunks do not
 * fit the total, is left out and listed in `omitted`.
 * @param home - the Delorun home.
 * @param before - the content before; undefined for none.
 * @param after - the content after.
 * @param changes - the changes {@link compareVersions} gave for the two.
 * @param bounds - the file and total limits.
 * @returns the diff text, whether it was cut short, and the files left out.
 * @throws {ChangesError} `STORE_CORRUPT` when an object is missing or altered.
 */
export async function boundedDiff(home: string, before: VersionManifest | undefined, after: VersionManifest, changes: readonly FileChange[], bounds: DiffBounds = {}): Promise<BoundedDiff> {
  const fileLimit = bounds.file ?? DIFF_FILE_LIMIT
  const totalLimit = bounds.total ?? DIFF_TOTAL_LIMIT
  const old = byPath(before)
  const updated = byPath(after)
  const cache: ObjectCache = new Map()
  const parts: string[] = []
  const omitted: string[] = []
  let used = 0
  let full = false
  for (const change of changes) {
    if (change.dependency) continue
    let part: string
    if (change.binary) {
      part = `Binary file ${binaryName(change.path)} ${change.status}\n`
    } else if (full || !textRead(change, fileLimit)) {
      omitted.push(change.path)
      continue
    } else {
      const a = old.get(change.path)
      const b = updated.get(change.path)
      const oldText = a === undefined ? '' : await sideText(home, cache, a)
      const newText = b === undefined ? '' : await sideText(home, cache, b)
      if (oldText === newText) continue
      part = createTwoFilesPatch(`a/${change.path}`, `b/${change.path}`, oldText, newText, undefined, undefined, { headerOptions: FILE_HEADERS_ONLY })
    }
    const size = Buffer.byteLength(part)
    if (full || used + size > totalLimit) {
      full = true
      if (!change.binary) omitted.push(change.path)
      continue
    }
    used += size
    parts.push(part)
  }
  return { text: parts.join(''), truncated: omitted.length > 0, omitted }
}

/**
 * Parse a root `package.json` side.
 * @param home - the Delorun home.
 * @param cache - the objects already read.
 * @param entry - the side's `package.json` entry, when it has one.
 * @returns the parsed manifest, or undefined when it has none, it is a link, or it is not JSON.
 */
async function packageManifest(home: string, cache: ObjectCache, entry: VersionEntry | undefined): Promise<unknown> {
  if (entry?.type !== 'file') return undefined
  const bytes = await cachedObject(home, cache, entry.digest)
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return parsed
  } catch {
    // A SyntaxError: a package.json that is not JSON has no manifest for the checks to read.
    return undefined
  }
}

/** The name of the plugin manifest at the folder's root. */
const PACKAGE_MANIFEST = 'package.json'

/**
 * Why the diff does not show a change's lines, when it does not.
 * @param change - the change.
 * @param read - whether its text is read.
 * @param omitted - the files the diff left out.
 * @returns the reason, or undefined when the diff shows the change.
 */
function notShownReason(change: FileChange, read: boolean, omitted: readonly string[]): NotShownReason | undefined {
  if (change.dependency) return 'dependency'
  if (change.binary) return 'binary'
  if (!read) return 'too-large'
  return omitted.includes(change.path) ? 'cut-short' : undefined
}

/**
 * What the risk checks read for a change: each changed file with the text of each side it has, when that side is text
 * within the file limit and not a dependency's file, why the diff does not show it when it does not, and the root
 * `package.json` parsed on each side.
 * @param home - the Delorun home.
 * @param before - the content before; undefined for none.
 * @param after - the content after.
 * @param changes - the changes {@link compareVersions} gave for the two.
 * @param bounds - the file limit.
 * @param omitted - the files the diff of the two left out ({@link BoundedDiff.omitted}); none by default.
 * @returns the review input.
 * @throws {ChangesError} `STORE_CORRUPT` when an object is missing or altered.
 */
export async function reviewInputOf(home: string, before: VersionManifest | undefined, after: VersionManifest, changes: readonly FileChange[], bounds: DiffBounds = {}, omitted: readonly string[] = []): Promise<ReviewInput> {
  const fileLimit = bounds.file ?? DIFF_FILE_LIMIT
  const old = byPath(before)
  const updated = byPath(after)
  const cache: ObjectCache = new Map()
  const files: ReviewedFile[] = []
  for (const change of changes) {
    const a = old.get(change.path)
    const b = updated.get(change.path)
    const read = textRead(change, fileLimit)
    const notShown = notShownReason(change, read, omitted)
    files.push({
      path: change.path,
      status: change.status,
      dependency: change.dependency,
      ...(read && a !== undefined ? { before: await sideText(home, cache, a) } : {}),
      ...(read && b !== undefined ? { after: await sideText(home, cache, b) } : {}),
      ...(notShown === undefined ? {} : { notShown }),
    })
  }
  const manifestBefore = await packageManifest(home, cache, old.get(PACKAGE_MANIFEST))
  const manifestAfter = await packageManifest(home, cache, updated.get(PACKAGE_MANIFEST))
  return {
    files,
    ...(manifestBefore === undefined ? {} : { manifestBefore }),
    ...(manifestAfter === undefined ? {} : { manifestAfter }),
  }
}
