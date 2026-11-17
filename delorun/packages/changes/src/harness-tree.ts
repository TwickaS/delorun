/**
 * The composed tree a start runs when the running runtime has approved harness files (contract C21, "Harness edits"):
 * `changes/harness/<runtime>/run/<digest>/`, a full tree of the signed installation in which every unedited file is a
 * hard link to the installation's file and every approved file is written from the store's verified object. `<digest>`
 * names the composed files ({@link composedDigest}). The signed installation under `runtimes/<runtime>/` is read, never
 * written.
 *
 * A tree is built in a temporary sibling directory and renamed into place under {@link withHarnessLock}, and checked
 * before every run ({@link checkComposedTree}): each signed path that is not approved is the installation's own file
 * (the same device and inode, or for a copy made where a hard link was refused, a regular file with the signed length,
 * SHA-256 and execute bit), each approved path a regular file with the approved digest and execute bit, and nothing
 * else exists. A tree that fails is rebuilt once; a second failure refuses with `HARNESS_CHANGED` naming the path.
 *
 * @module @delorun/changes/harness-tree
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, rename, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { ChangesError } from './errors.ts'
import { composedDigest, composedFiles, harnessChanges, harnessLeftOut, pathExists, readSignedFile, removeTree, type HarnessChange, type SignedFile, type SignedRuntime } from './harness.ts'
import { harnessCopyDirectory, harnessDirectory, harnessRunDirectory, harnessRuntimeDirectory, isRuntimeVersion } from './paths.ts'
import { readHarnessLog, readHarnessRecord, withHarnessLock } from './records.ts'
import { readObject, readVersion } from './store.ts'
import { compareCodeUnits, openRegularFile, readChunks } from './tree.ts'
import type { ChangeEntry, ChangeId, ChangeLog, ContentVersion, HarnessRecord, ObjectDigest } from './types.ts'

/** The mode of a file of a composed tree. */
const TREE_FILE_MODE = 0o444

/** The mode of an executable file, and of every directory, of a composed tree once it is filled. */
const TREE_EXECUTABLE_MODE = 0o555

/** The errors of a hard link after which a composed tree copies the installation's file instead. */
const COPY_INSTEAD = new Set(['EXDEV', 'EPERM', 'ENOTSUP'])

/** The errors of building a composed tree that mean a path is in the way of it, which refuse with `HARNESS_CHANGED`. */
const IN_THE_WAY = new Set(['ENOTDIR', 'EEXIST'])

/**
 * How long after a start chose a composed tree retention keeps it. A start chooses its tree, sets the tree's time and
 * then starts the home process that marks the runtime in use, so retention, which skips trees only once a home process
 * runs, could otherwise remove a tree a concurrent start is about to run; keeping a recent tree costs only its
 * directories and hard links, and a later start removes it.
 */
export const TREE_RETENTION_GRACE_MS = 60 * 60 * 1000

/** One way a composed tree differs from the signed release with the approved files in place. */
export interface ComposedProblem {
  /** The path relative to the tree, `/`-separated. */
  readonly path: string
  readonly kind: 'missing' | 'extra' | 'not-regular' | 'changed'
}

/** The composed tree of a runtime. */
export interface ComposedTree {
  /** `changes/harness/<runtime>/run/<digest>/`. */
  readonly directory: string
  /** The digest that names its composed files. */
  readonly digest: string
}

/** What a path of a composed tree holds. */
type TreeFile =
  | { readonly kind: 'signed', readonly file: SignedFile }
  | { readonly kind: 'approved', readonly digest: ObjectDigest, readonly size: number, readonly executable: boolean }

/**
 * The composed files of a runtime from its records, with their digest.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the versions by path and their digest, or undefined when the runtime runs its signed release.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record or the harness's log is not one Delorun wrote.
 */
export async function composition(home: string, runtime: string): Promise<{ readonly files: Readonly<Record<string, ContentVersion>>, readonly digest: string } | undefined> {
  const files = composedFiles(await readHarnessLog(home), await readHarnessRecord(home, runtime))
  return Object.keys(files).length === 0 ? undefined : { files, digest: composedDigest(files) }
}

/**
 * What every path of the composed tree holds.
 * @param home - the Delorun home.
 * @param signed - the signed installation.
 * @param files - the composed files.
 * @returns the tree's files by path.
 * @throws {ChangesError} `STORE_CORRUPT` when the store does not hold an approved version as one file.
 */
async function treeFiles(home: string, signed: SignedRuntime, files: Readonly<Record<string, ContentVersion>>): Promise<Map<string, TreeFile>> {
  const tree = new Map<string, TreeFile>()
  for (const file of signed.files) if (!Object.hasOwn(files, file.path)) tree.set(file.path, { kind: 'signed', file })
  for (const [path, version] of Object.entries(files)) {
    const { entries } = await readVersion(home, version)
    const [entry] = entries
    if (entries.length > 1 || (entry !== undefined && (entry.type !== 'file' || entry.path !== path))) throw new ChangesError('STORE_CORRUPT', version, `version ${version} is not the content of ${path}`)
    if (entry?.type === 'file') tree.set(path, { kind: 'approved', digest: entry.digest, size: entry.size, executable: entry.executable })
  }
  return tree
}

/**
 * How many files of a composed tree are linked or checked at once. A tree holds every file of the installation, tens of
 * thousands, and one at a time each start spent seconds waiting on single filesystem calls.
 */
const TREE_FILE_CONCURRENCY = 64

/**
 * Run work over items, at most `limit` at a time.
 * @param items - the items.
 * @param limit - how many run at once.
 * @param work - the work for one item.
 * @returns each item's result, in the items' order.
 * @throws the first failure of any item's work, once every started item has settled.
 */
async function eachLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index]!)
    }
  }
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, lane))
  const failed = lanes.find(outcome => outcome.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return results
}

/**
 * @param path - a `/`-separated relative path.
 * @returns the relative paths of the directories above it, nearest last.
 */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * Every entry below a directory that is not a directory, by `/`-separated relative path, with whether it is a regular
 * file.
 * @param root - the directory.
 * @returns the entries.
 */
async function listEntries(root: string): Promise<Map<string, boolean>> {
  const found = new Map<string, boolean>()
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative)
      else found.set(relative, entry.isFile())
    }
  }
  await walk(root, '')
  return found
}

/**
 * Whether a regular file has bytes with a digest and length and an execute bit.
 * @param path - the file.
 * @param expected - the digest, the length and the execute bit.
 * @returns whether it has.
 */
async function holds(path: string, expected: { readonly digest: string, readonly size: number, readonly executable: boolean }): Promise<boolean> {
  const { handle, stats } = await openRegularFile(path)
  try {
    if (stats.size !== expected.size || ((stats.mode & 0o100) !== 0) !== expected.executable) return false
    const hash = createHash('sha256')
    await readChunks(handle, { size: stats.size, path }, (chunk) => { hash.update(chunk) })
    return hash.digest('hex') === expected.digest
  } finally {
    await handle.close()
  }
}

/**
 * Check one path of a composed tree.
 * @param signed - the signed installation.
 * @param root - the tree.
 * @param path - the path.
 * @param file - what it holds.
 * @returns whether it holds that.
 */
async function pathHolds(signed: SignedRuntime, root: string, path: string, file: TreeFile): Promise<boolean> {
  const target = join(root, ...path.split('/'))
  if (file.kind === 'approved') return holds(target, file)
  // Device and inode numbers can pass 2^53, so they compare exactly only as bigints.
  const mine = await lstat(target, { bigint: true })
  const theirs = await lstat(join(signed.directory, ...path.split('/')), { bigint: true }).catch((_unreadable: unknown) => {
    // The installation's own start check reports a file it cannot read; the tree's file is then checked by its bytes.
    return undefined
  })
  if (theirs !== undefined && mine.dev === theirs.dev && mine.ino === theirs.ino) return true
  return holds(target, { digest: file.file.sha256, size: file.file.length, executable: file.file.executable })
}

/**
 * Compare a composed tree with the signed release and the composed files.
 * @param home - the Delorun home.
 * @param signed - the signed installation.
 * @param files - the composed files.
 * @param root - the tree.
 * @returns the first problem in path order, or undefined when the tree holds exactly the composition.
 * @throws {ChangesError} `STORE_CORRUPT` when the store does not hold an approved version.
 */
export async function composedProblem(home: string, signed: SignedRuntime, files: Readonly<Record<string, ContentVersion>>, root: string): Promise<ComposedProblem | undefined> {
  const expected = await treeFiles(home, signed, files)
  const found = await listEntries(root)
  const paths = [...new Set([...expected.keys(), ...found.keys()])].sort(compareCodeUnits)
  // Every path is checked, many at once; the first in path order that differs, or fails to be read, decides.
  const outcomes = await eachLimited(paths, TREE_FILE_CONCURRENCY, async (path): Promise<ComposedProblem['kind'] | { readonly failed: unknown } | undefined> => {
    const file = expected.get(path)
    const regular = found.get(path)
    if (file === undefined) return 'extra'
    if (regular === undefined) return 'missing'
    if (!regular) return 'not-regular'
    try {
      return await pathHolds(signed, root, path, file) ? undefined : 'changed'
    } catch (failed) {
      return { failed }
    }
  })
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === undefined) continue
    if (typeof outcome === 'object') throw outcome.failed
    return { path: paths[index]!, kind: outcome }
  }
  return undefined
}

/**
 * Write a file of a composed tree from bytes, read-only.
 * @param path - the file.
 * @param bytes - its bytes.
 * @param executable - whether it is executable.
 */
async function writeTreeFile(path: string, bytes: Buffer, executable: boolean): Promise<void> {
  const mode = executable ? TREE_EXECUTABLE_MODE : TREE_FILE_MODE
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
  await chmod(path, mode)
}

/**
 * Build a composed tree in a new directory: hard links to the installation's unedited files, or copies where a hard
 * link is refused, and the approved files from the store's verified objects; then every directory read-only.
 * @param home - the Delorun home.
 * @param signed - the signed installation.
 * @param files - the composed files.
 * @param root - the new directory.
 */
async function buildTree(home: string, signed: SignedRuntime, files: Readonly<Record<string, ContentVersion>>, root: string): Promise<void> {
  const directories = new Set<string>([root])
  await mkdir(root, { mode: PRIVATE_DIR_MODE })
  const entries = [...await treeFiles(home, signed, files)].sort(([a], [b]) => compareCodeUnits(a, b))
  const place = async ([path, file]: readonly [string, TreeFile]): Promise<void> => {
    const target = join(root, ...path.split('/'))
    if (file.kind === 'approved') {
      await writeTreeFile(target, await readObject(home, file.digest), file.executable)
      return
    }
    try {
      await link(join(signed.directory, ...path.split('/')), target)
    } catch (error) {
      if (!COPY_INSTEAD.has(String((error as NodeJS.ErrnoException).code))) throw error
      await writeTreeFile(target, await readSignedFile(signed, file.file), file.file.executable)
    }
  }
  const paths = new Set(entries.map(([path]) => path))
  if (entries.some(([path]) => ancestorsOf(path).some(ancestor => paths.has(ancestor)))) {
    // A list that names a path below one of its own files: placed one at a time in path order, so the build fails at
    // that path as a path in the way.
    for (const entry of entries) {
      await mkdir(dirname(join(root, ...entry[0].split('/'))), { recursive: true, mode: PRIVATE_DIR_MODE })
      await place(entry)
    }
    return
  }
  // Every directory first, parents before children, so the files can then be placed in any order.
  for (const [path] of entries) {
    const missing: string[] = []
    // Each directory joins the set as it is found, so the walk ends at the root's own filesystem root at the latest.
    for (let directory = dirname(join(root, ...path.split('/'))); !directories.has(directory); directory = dirname(directory)) {
      directories.add(directory)
      missing.push(directory)
    }
    for (const directory of missing.reverse()) await mkdir(directory, { mode: PRIVATE_DIR_MODE })
  }
  await eachLimited(entries, TREE_FILE_CONCURRENCY, place)
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, TREE_EXECUTABLE_MODE)
}

/**
 * The composed tree a start of the runtime runs, built when it does not exist and checked: under the harness lock, a
 * tree that fails its check is rebuilt once, in a temporary sibling directory renamed into place.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the runtime's signed installation, verified by the runtime store's start check.
 * @returns the tree, or undefined when the runtime runs its signed release.
 * @throws {ChangesError} `HARNESS_CHANGED` naming the path when the rebuilt tree fails its check too, or when a path is
 *   in the way of the build (`ENOTDIR` or `EEXIST`: a file where a directory belongs, or what another builder wrote);
 *   `RECORD_UNREADABLE`; `STORE_CORRUPT` when the store does not hold an approved version; `RUNTIME_CHANGED` when a
 *   signed file a copy reads differs from the list.
 */
export async function prepareComposedTree(home: string, runtime: string, signed: SignedRuntime): Promise<ComposedTree | undefined> {
  return withHarnessLock(home, async () => {
    const composed = await composition(home, runtime)
    if (composed === undefined) return undefined
    const directory = join(harnessRunDirectory(home, runtime), composed.digest)
    try {
      await buildComposedTree(home, signed, composed.files, directory)
    } catch (error) {
      if (!IN_THE_WAY.has(String((error as NodeJS.ErrnoException).code))) throw error
      throw await inTheWay(directory, error as NodeJS.ErrnoException & { readonly dest?: string })
    }
    // The time marks the tree chosen, so retention keeps it while this start's home process is not yet running.
    const now = new Date()
    await utimes(directory, now, now)
    return { directory, digest: composed.digest }
  })
}

/**
 * Leave a composed tree in place that holds exactly the composition: the one there, or one built and renamed into
 * place.
 * @param home - the Delorun home.
 * @param signed - the signed installation.
 * @param files - the composed files.
 * @param directory - the tree.
 * @throws {ChangesError} `HARNESS_CHANGED` naming the path when the rebuilt tree fails its check.
 */
async function buildComposedTree(home: string, signed: SignedRuntime, files: Readonly<Record<string, ContentVersion>>, directory: string): Promise<void> {
  if (await isDirectory(directory) && await composedProblem(home, signed, files, directory) === undefined) return
  const runs = dirname(directory)
  await mkdir(runs, { recursive: true, mode: PRIVATE_DIR_MODE })
  const staging = join(runs, `.${basename(directory)}.delorun-tmp-${randomBytes(8).toString('hex')}`)
  try {
    await buildTree(home, signed, files, staging)
    await removeTree(directory)
    await rename(staging, directory)
  } finally {
    await removeTree(staging)
  }
  const problem = await composedProblem(home, signed, files, directory)
  if (problem !== undefined) throw treeRefusal(directory, problem)
}

/**
 * @param path - a path.
 * @returns whether it is a directory, not following a link; false when nothing is there.
 * @throws the filesystem error other than `ENOENT`, such as `ENOTDIR` when a file stands where a parent belongs.
 */
async function isDirectory(path: string): Promise<boolean> {
  return await pathExists(path) && (await lstat(path)).isDirectory()
}

/**
 * The refusal of a build a path was in the way of: for `ENOTDIR` the nearest parent of the failed path that is not a
 * directory, else the failed path (a hard link's destination).
 * @param directory - the tree.
 * @param error - the `ENOTDIR` or `EEXIST` failure.
 * @returns the refusal that names the path.
 */
async function inTheWay(directory: string, error: NodeJS.ErrnoException & { readonly dest?: string }): Promise<ChangesError> {
  let path = error.dest ?? error.path ?? directory
  if (error.code === 'ENOTDIR') {
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
      const stats = await lstat(parent).catch((_missing: unknown) => {
        // A parent that is not there is not the one in the way; the walk goes on up.
        return undefined
      })
      if (stats !== undefined && !stats.isDirectory()) path = parent
    }
  }
  const what = error.code === 'ENOTDIR' ? 'is a file where Delorun needs a directory' : 'is already there'
  return new ChangesError('HARNESS_CHANGED', path, `${path} ${what} to build the harness with your approved changes in ${directory}, so Delorun does not run it. If no other start of Delorun runs, remove ${path} and start Delorun again.`, { cause: error })
}

/**
 * @param directory - the tree.
 * @param problem - what differs.
 * @returns the refusal that names the path.
 */
function treeRefusal(directory: string, problem: ComposedProblem): ChangesError {
  const path = join(directory, ...problem.path.split('/'))
  return new ChangesError('HARNESS_CHANGED', path, `${path} is ${problem.kind === 'changed' ? 'not the signed or approved file' : problem.kind === 'missing' ? 'missing' : problem.kind === 'extra' ? 'a file Delorun did not put there' : 'not a regular file'}, so Delorun does not run the harness with your approved changes from ${directory}. See what differs with: delorun verify`)
}

/**
 * Check the composed tree a process runs from: it must be the tree the runtime's records compose now, and hold exactly
 * that composition.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the runtime's signed installation, verified by the runtime store's start check.
 * @param directory - the tree, `changes/harness/<runtime>/run/<digest>/`.
 * @throws {ChangesError} `HARNESS_CHANGED` when the records compose another tree, or the tree differs, naming the path.
 */
export async function checkComposedTree(home: string, runtime: string, signed: SignedRuntime, directory: string): Promise<void> {
  const composed = await composition(home, runtime)
  if (composed?.digest !== basename(directory)) {
    throw new ChangesError('HARNESS_CHANGED', directory, `${directory} is not the harness your approved changes to Delorun ${runtime} compose now; start Delorun again to run them.`)
  }
  const problem = await composedProblem(home, signed, composed.files, directory)
  if (problem !== undefined) throw treeRefusal(directory, problem)
}

/** What one retention of the harness's directories did. */
export interface HarnessRetention {
  /** The directories removed. */
  readonly removed: readonly string[]
  /** The directories whose removal failed, with why; the next retention tries again. */
  readonly failed: readonly { readonly path: string, readonly error: string }[]
}

/** What a retention keeps and removes. */
export interface HarnessRetentionRequest {
  /** The running runtime version. */
  readonly runtime: string
  /**
   * The digest of its composed tree to keep; every other tree of the runtime is removed, except one a start chose
   * within {@link TREE_RETENTION_GRACE_MS}.
   */
  readonly keep?: string
  /** Whether the runtime's other trees may be removed: false while another home process may run from one. */
  readonly removeTrees: boolean
  /** The runtime versions the store has installed; every other runtime's directory under `changes/harness/` is removed. */
  readonly installed: ReadonlySet<string>
}

/**
 * Remove the running runtime's other composed trees, except one whose time a start set within
 * {@link TREE_RETENTION_GRACE_MS}, and the `changes/harness/<runtime>/` directories of runtimes the store no longer has
 * installed, each made writable first. A failure to remove one is reported and leaves it.
 * @param home - the Delorun home.
 * @param request - the runtime, the tree to keep, whether trees may be removed, and the installed runtimes.
 * @returns what was removed and what was not.
 */
export async function retainHarness(home: string, request: HarnessRetentionRequest): Promise<HarnessRetention> {
  return withHarnessLock(home, async () => {
    const removed: string[] = []
    const failed: { path: string, error: string }[] = []
    const remove = async (path: string): Promise<void> => {
      try {
        await removeTree(path)
        removed.push(path)
      } catch (error) {
        failed.push({ path, error: (error as Error).message })
      }
    }
    if (request.removeTrees) {
      const runs = harnessRunDirectory(home, request.runtime)
      const chosenBefore = Date.now() - TREE_RETENTION_GRACE_MS
      for (const name of await namesIn(runs)) {
        if (name !== request.keep && (await lstat(join(runs, name))).mtimeMs < chosenBefore) await remove(join(runs, name))
      }
    }
    for (const name of await namesIn(harnessDirectory(home))) {
      if (isRuntimeVersion(name) && !request.installed.has(name)) await remove(harnessRuntimeDirectory(home, name))
    }
    return { removed, failed }
  })
}

/**
 * @param directory - a directory.
 * @returns the names of the directories in it; none when it does not exist.
 */
async function namesIn(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** What the composed tree of a runtime holds, as `verify` and `doctor` report it. */
export type ComposedTreeState =
  /** The runtime has no approved harness file, so a start runs its signed installation. */
  | { readonly kind: 'signed' }
  /** No tree is built for the current composition yet; the next start builds it. */
  | { readonly kind: 'not-built', readonly directory: string }
  /** The tree holds exactly the composition. */
  | { readonly kind: 'passed', readonly directory: string }
  /** The tree differs: `problem` names the path. */
  | { readonly kind: 'failed', readonly directory: string, readonly problem: string }
  /** The tree was not checked, because the signed release did not verify. */
  | { readonly kind: 'not-checked', readonly directory: string }

/** The harness of one runtime, as `verify` and `doctor` report it. */
export interface HarnessStatus {
  /** The runtime version. */
  readonly runtime: string
  /**
   * The files whose approved content differs from the signed release's, with the change that approved each, by path;
   * `unreviewed` when a start applied that change without review while protection was off.
   */
  readonly approved: readonly { readonly file: string, readonly change: ChangeId, readonly unreviewed: boolean }[]
  /** The writable copy's `app/` directory, when it exists. */
  readonly copy?: string
  /** The changes waiting for review in the copy; empty when the signed release was not read. */
  readonly pending: readonly HarnessChange[]
  /** The changes a failed start left out that stay out. */
  readonly leftOut: readonly ChangeEntry[]
  /** The composed tree. */
  readonly tree: ComposedTreeState
}

/**
 * Report a runtime's harness without writing anything: its approved files, its copy and the changes waiting there, the
 * changes a failed start left out, and its composed tree checked against the signed release.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the runtime's signed installation, verified by the runtime store's start check; undefined when it did
 *   not verify, which leaves the tree and the copy unchecked.
 * @returns the report.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record or the harness's log is not one Delorun wrote; as reading the
 *   copy does.
 */
export async function harnessStatus(home: string, runtime: string, signed: SignedRuntime | undefined): Promise<HarnessStatus> {
  const record = await readHarnessRecord(home, runtime)
  const log = await readHarnessLog(home)
  const approved = Object.entries(record.files).sort(([a], [b]) => compareCodeUnits(a, b)).map(([file, entry]) => ({ file, change: entry.change, unreviewed: log.entries.some(logged => logged.id === entry.change && logged.decidedFrom === 'unreviewed') }))
  const copy = harnessCopyDirectory(home, runtime)
  const hasCopy = await pathExists(copy)
  const pending = signed === undefined || !hasCopy ? [] : (await harnessChanges({ home, runtime, signed: () => Promise.resolve(signed) }, { cache: false })).changes
  return {
    runtime,
    approved,
    ...hasCopy ? { copy: join(copy, 'app') } : {},
    pending,
    leftOut: harnessLeftOut(log, record),
    tree: await treeState(home, runtime, signed, log, record),
  }
}

/**
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the verified installation, or undefined.
 * @param log - the harness's change log.
 * @param record - the runtime's record.
 * @returns the composed tree's state.
 */
async function treeState(home: string, runtime: string, signed: SignedRuntime | undefined, log: ChangeLog, record: HarnessRecord): Promise<ComposedTreeState> {
  const files = composedFiles(log, record)
  if (Object.keys(files).length === 0) return { kind: 'signed' }
  const directory = join(harnessRunDirectory(home, runtime), composedDigest(files))
  if (!await pathExists(directory)) return { kind: 'not-built', directory }
  if (signed === undefined) return { kind: 'not-checked', directory }
  let problem: ComposedProblem | undefined
  try {
    problem = await composedProblem(home, signed, files, directory)
  } catch (error) {
    // The store no longer holds an approved version, or the tree cannot be read: a report names it as failed.
    return { kind: 'failed', directory, problem: `${directory} cannot be checked: ${(error as Error).message}` }
  }
  return problem === undefined ? { kind: 'passed', directory } : { kind: 'failed', directory, problem: treeRefusal(directory, problem).detail }
}
