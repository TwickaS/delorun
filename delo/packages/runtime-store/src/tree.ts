/**
 * Contract C2's runtime file check: a directory's regular files must be exactly the signed file list's, each with the
 * listed length and SHA-256. Any other entry (a symbolic link, device, FIFO or socket) is refused, because an archive
 * holds only regular files. The same check runs on a staged install before it is published and on the installation
 * at every start.
 *
 * @module @delo/runtime-store/tree
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeFile, RuntimeFileList } from '@delo/contract-release-manifest'

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
 * neither a regular file nor a directory.
 * @param root - the directory.
 * @returns the regular files and the other entries.
 */
async function listTree(root: string): Promise<{ readonly files: Set<string>, readonly irregular: string[] }> {
  const files = new Set<string>()
  const irregular: string[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative)
      else if (entry.isFile()) files.add(relative)
      else irregular.push(relative)
    }
  }
  await walk(root, '')
  return { files, irregular }
}

/**
 * Hash one file without following a symbolic link, comparing its length first.
 * @param path - the file.
 * @param expected - its list entry.
 * @returns the problem, or `undefined` when the file matches.
 */
async function checkFile(path: string, expected: RuntimeFile): Promise<TreeProblem | undefined> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { path: expected.path, kind: 'not-regular' }
    if (stats.size !== expected.length) return { path: expected.path, kind: 'length' }
    const hash = createHash('sha256')
    let length = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 }) as AsyncIterable<Buffer>) {
      length += chunk.byteLength
      hash.update(chunk)
    }
    if (length !== expected.length) return { path: expected.path, kind: 'length' }
    return hash.digest('hex') === expected.sha256 ? undefined : { path: expected.path, kind: 'sha256' }
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

/**
 * Compare a directory with a file list.
 * @param root - the directory; it must be a directory, not a symbolic link.
 * @param list - the verified file list.
 * @returns every problem found, empty when the directory matches.
 * @throws {Error} when `root` is not a directory, or the list names a path twice or a path that is not normalised.
 */
export async function checkTree(root: string, list: RuntimeFileList): Promise<TreeProblem[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error(`${root} is not a directory`)
  const listed = new Map<string, RuntimeFile>()
  for (const file of list.files) {
    if (!isListPath(file.path)) throw new Error(`the file list names ${JSON.stringify(file.path)}, which is not a normalised relative path`)
    if (listed.has(file.path)) throw new Error(`the file list names ${file.path} twice`)
    listed.set(file.path, file)
  }
  const { files, irregular } = await listTree(root)
  const problems: TreeProblem[] = irregular.map(path => ({ path, kind: 'not-regular' }))
  for (const path of files) if (!listed.has(path)) problems.push({ path, kind: 'extra' })
  const present: RuntimeFile[] = []
  for (const file of listed.values()) {
    if (files.has(file.path)) present.push(file)
    else if (!irregular.includes(file.path)) problems.push({ path: file.path, kind: 'missing' })
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < present.length) {
      const file = present[next++]!
      const problem = await checkFile(join(root, ...file.path.split('/')), file)
      if (problem !== undefined) problems.push(problem)
    }
  }
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, present.length) }, worker))
  return problems.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
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
