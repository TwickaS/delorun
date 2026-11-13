/**
 * Contract C2's runtime file check: a directory's regular files must be exactly the signed file list's, each with the
 * listed length and SHA-256. Any other entry (a symbolic link, device, FIFO or socket) is refused, because an archive
 * holds only regular files. The same check runs on a staged install before it is published and on the installation
 * at every start. Given identities the store recorded, a file on the root's device whose identity is unchanged and
 * settled is not read again ([identity](./identity.ts)); every other file is hashed.
 *
 * @module @delo/runtime-store/tree
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync, readdirSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeFile, RuntimeFileList } from '@delo/contract-release-manifest'
import { identityOf, RACY_WINDOW_NS } from './identity.ts'

/** The most bytes one read of a hashed file takes. */
const READ_CHUNK_BYTES = 1_048_576

/** Files hashed at once. */
const HASH_CONCURRENCY = 8

/** Problems quoted in a refusal; the rest are counted. */
const QUOTED_PROBLEMS = 10

/** One difference between a directory and its file list. */
export interface TreeProblem {
  /** The `/`-separated path relative to the directory. */
  readonly path: string
  /** What differs. */
  readonly kind: 'missing' | 'extra' | 'not-regular' | 'length' | 'sha256'
}

/**
 * Every entry under a directory, with `/`-separated relative paths: the regular files, and the entries that are
 * neither a regular file nor a directory. It reads synchronously, because a start lists tens of thousands of entries
 * and the asynchronous calls cost several times more.
 * @param root - the directory.
 * @returns the regular files and the other entries.
 */
function listTree(root: string): { readonly files: Set<string>, readonly irregular: string[] } {
  const files = new Set<string>()
  const irregular: string[] = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else if (entry.isFile()) files.add(relative)
      else irregular.push(relative)
    }
  }
  walk(root, '')
  return { files, irregular }
}

/** What hashing one file found. */
interface FileResult {
  /** The difference, when the file does not match. */
  readonly problem?: TreeProblem
  /**
   * The identity the matching bytes were read under: `fstat` of the descriptor before and after the hash, equal both
   * times and on the root's device; `null` when they differ.
   */
  readonly identity?: string | null
}

/**
 * Hash one file without following a symbolic link, comparing its length first.
 * @param path - the file.
 * @param expected - its list entry.
 * @param device - the device of the tree's root.
 * @returns the problem, or the identity the matching bytes were read under.
 */
async function checkFile(path: string, expected: RuntimeFile, device: bigint): Promise<FileResult> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) return { problem: { path: expected.path, kind: 'not-regular' } }
    if (before.size !== BigInt(expected.length)) return { problem: { path: expected.path, kind: 'length' } }
    const hash = createHash('sha256')
    let length = 0
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(expected.length, 1), READ_CHUNK_BYTES) + 1)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, length)
      if (bytesRead === 0) break
      length += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (length !== expected.length) return { problem: { path: expected.path, kind: 'length' } }
    if (hash.digest('hex') !== expected.sha256) return { problem: { path: expected.path, kind: 'sha256' } }
    const after = await handle.stat({ bigint: true })
    const seen = `${String(device)}:${identityOf(before)}`
    return { identity: seen === `${String(after.dev)}:${identityOf(after)}` ? identityOf(before) : null }
  } finally {
    await handle.close()
  }
}

/**
 * Whether a file list path is relative, `/`-separated and normalised: no empty, `.` or `..` segment, no backslash and
 * no NUL, so joining it to the directory cannot leave it.
 * @param path - the listed path.
 * @returns true when it is.
 */
function isListPath(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Identities the store recorded for a tree, and when it captured them. */
export interface RecordedIdentities {
  /** Per list entry, the identity, or `null` where none was recorded. */
  readonly identities: readonly (string | null)[]
  /** The capture time in nanoseconds; an identity whose change time is not settled against it is hashed. */
  readonly capturedAt: bigint
}

/** What {@link examineTree} found. */
export interface TreeExamination {
  /** Every difference, sorted by path; empty when the directory matches the list. */
  readonly problems: readonly TreeProblem[]
  /** Per list entry, the identity its matching bytes were seen with, or `null` when none can be recorded. */
  readonly identities: readonly (string | null)[]
  /** How many files were hashed. */
  readonly hashed: number
}

/**
 * Compare a directory with a file list. Without `recorded`, every listed file is hashed. With it, a file on the
 * root's device whose `lstat` identity equals its recorded identity, settled against the capture time, is taken as
 * matching unread, and every other file is hashed.
 * @param root - the directory; it must be a directory, not a symbolic link.
 * @param list - the verified file list.
 * @param recorded - the identities the store recorded, and their capture time.
 * @returns the problems, the identities to record and how many files were hashed.
 * @throws {Error} when `root` is not a directory, or the list names a path twice or a path that is not normalised.
 */
export async function examineTree(root: string, list: RuntimeFileList, recorded?: RecordedIdentities): Promise<TreeExamination> {
  const rootStats = await lstat(root, { bigint: true })
  if (!rootStats.isDirectory()) throw new Error(`${root} is not a directory`)
  const listed = new Map<string, number>()
  for (const [index, file] of list.files.entries()) {
    if (!isListPath(file.path)) throw new Error(`the file list names ${JSON.stringify(file.path)}, which is not a normalised relative path`)
    if (listed.has(file.path)) throw new Error(`the file list names ${file.path} twice`)
    listed.set(file.path, index)
  }
  const { files, irregular } = listTree(root)
  const problems: TreeProblem[] = irregular.map(path => ({ path, kind: 'not-regular' }))
  for (const path of files) if (!listed.has(path)) problems.push({ path, kind: 'extra' })
  const identities: (string | null)[] = list.files.map(() => null)
  const settledBefore = recorded === undefined ? 0n : recorded.capturedAt - RACY_WINDOW_NS
  const device = `${String(rootStats.dev)}:`
  const unread: number[] = []
  for (const [index, file] of list.files.entries()) {
    if (!files.has(file.path)) {
      if (!irregular.includes(file.path)) problems.push({ path: file.path, kind: 'missing' })
      continue
    }
    const expected = recorded?.identities[index] ?? null
    if (expected === null) {
      unread.push(index)
      continue
    }
    // An equal identity has the recorded change time, so the racy test reads it from the status just taken.
    const stats = lstatSync(join(root, ...file.path.split('/')), { bigint: true })
    if (`${String(stats.dev)}:${identityOf(stats)}` === `${device}${expected}` && stats.ctimeNs <= settledBefore) identities[index] = expected
    else unread.push(index)
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < unread.length) {
      const index = unread[next++]!
      const file = list.files[index]!
      const result = await checkFile(join(root, ...file.path.split('/')), file, rootStats.dev)
      if (result.problem !== undefined) problems.push(result.problem)
      identities[index] = result.identity ?? null
    }
  }
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, unread.length) }, worker))
  problems.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { problems, identities, hashed: unread.length }
}

/**
 * Describe tree problems for a refusal: the first few with their kind, and how many more.
 * @param problems - the problems, at least one.
 * @returns the description.
 */
export function describeProblems(problems: readonly TreeProblem[]): string {
  const quoted = problems.slice(0, QUOTED_PROBLEMS).map(problem => `${problem.path} (${problem.kind})`).join(', ')
  const more = problems.length - QUOTED_PROBLEMS
  return more > 0 ? `${quoted} and ${String(more)} more` : quoted
}
