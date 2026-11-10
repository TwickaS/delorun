/**
 * A workspace's `AGENTS.md`, read and written beside the workspace's own processes, which can change any name in the workspace
 * at any moment. Every read and write walks from the root to the workspace directory and then to the file, one name at a time.
 * A symbolic link or a non-directory at any name below the root refuses the walk, so the directories above the workspace
 * directory are checked as well as the workspace directory itself. A link or a non-regular entry reads as no file, and a write
 * refuses it.
 *
 * The walk is `proc` where `/proc/self/fd` exists and `lstat` elsewhere ({@link Walk}). Only `proc` closes the race window
 * that `lstat` leaves. Windows is refused with {@link UnsupportedHostError}, since its link checks are not verified.
 *
 * The root is opened by its own path, so a link in that path is followed; the directories above the root are not checked. A
 * relative directory is a sequence of names separated by `/`. An absolute value, or a name that is empty, `.` or `..`, or that
 * holds a NUL byte, is refused with {@link InvalidPathError}: a trailing separator or a `.` makes the kernel follow a link
 * before it, and `..` can name a directory outside the root.
 *
 * @module @delo/plugin-workspaces/files
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, type Stats } from 'node:fs'
import { lstat, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'

// Linux's O_PATH, which Node's constants omit: a descriptor that names a directory without reading it.
const O_PATH = 0o10000000

// The descriptor directory of this process, which the proc walk names held directories through unless WalkOptions.procRoot
// names another.
const PROC_FD = '/proc/self/fd'

// The mode a temporary file is created with, before it becomes FILE_MODE.
const TEMPORARY_MODE = 0o600

// The mode of a finished AGENTS.md, set explicitly so the umask does not change it.
const FILE_MODE = 0o644

// The longest `.git` file read. HEAD and config are small; a larger one shows no branch or origin.
const MAX_GIT_FILE_BYTES = 64 * 1024

/** The instructions file a chat in the workspace loads. */
export const INSTRUCTIONS = 'AGENTS.md'

/**
 * How a walk checks the names from the root down to a file.
 *
 * `proc` holds each directory open and names the next one through the descriptor directory, so the name checked is the name
 * opened. `lstat` checks each name with `lstat`, then opens the file with `O_NOFOLLOW` and checks the descriptor with `fstat`.
 * Between the check of a name and the open of a name inside it, a same-user process can replace that name, because the open
 * resolves the path again. `proc` has no such window.
 */
export type Walk = 'proc' | 'lstat'

/** The walk option of the functions that read or write `AGENTS.md` or a workspace's `.git` metadata. */
export interface WalkOptions {
  /**
   * The walk to use. Omitted, `proc` where {@link probeProcFd} finds the descriptor directory and `lstat` elsewhere. A forced
   * `proc` walk whose descriptor directory cannot be read refuses with an {@link InstructionsRefusedError} of code `unavailable`.
   */
  readonly walk?: Walk
  /**
   * The descriptor directory that the `proc` walk names held directories through. Defaults to `/proc/self/fd`. The specs set
   * a missing path to exercise the `unavailable` refusal.
   */
  readonly procRoot?: string
}

/**
 * A call on a host where the link checks are not verified: Windows.
 */
export class UnsupportedHostError extends Error {
  /**
   * @param reason - an English message for the person.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'UnsupportedHostError'
  }
}

/**
 * A workspace directory path that is not a sequence of ordinary names below the root.
 */
export class InvalidPathError extends Error {
  /**
   * @param reason - an English message for the person.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidPathError'
  }
}

/**
 * The walk for a host, from the result of {@link probeProcFd}.
 * @param hasProcFd - whether the probe found the descriptor directory.
 * @returns `proc` when the probe found it, otherwise `lstat`.
 */
export function chooseWalk(hasProcFd: boolean): Walk {
  return hasProcFd ? 'proc' : 'lstat'
}

/**
 * Probe the host for the descriptor directory that the `proc` walk names held directories through.
 * @param procRoot - the directory to probe, `/proc/self/fd` by default.
 * @returns true on Linux when the directory exists. The probe is false on other hosts, because the `O_PATH` value that the
 * `proc` walk uses is Linux's.
 */
export function probeProcFd(procRoot = PROC_FD): boolean {
  return process.platform === 'linux' && existsSync(procRoot)
}

/**
 * A read or write of an instructions file that the files module refused. `conflict`: the file is not the revision the caller
 * named (null means the file must be absent), a symbolic link or non-regular entry holds the name, or a folder on the path is a
 * symbolic link or not a folder. `too-large`: the text, or the file being replaced, is longer than the byte limit.
 * `unavailable`: the proc walk cannot name the directories it holds, so the file was not checked.
 */
export class InstructionsRefusedError extends Error {
  /** Why the files module refused. */
  readonly code: 'conflict' | 'too-large' | 'unavailable'

  /**
   * @param code - why the files module refused.
   * @param reason - an English message for the person.
   */
  constructor(code: 'conflict' | 'too-large' | 'unavailable', reason: string) {
    super(reason)
    this.code = code
    this.name = 'InstructionsRefusedError'
  }
}

/**
 * The message of an `unavailable` refusal.
 * @param procRoot - the descriptor directory that could not be read.
 * @param cause - the failure that the read raised.
 * @returns an English message for the person.
 */
export function unavailableReason(procRoot: string, cause: unknown): string {
  return `${procRoot} cannot be read (${codeOf(cause) ?? 'no system code'}), so ${INSTRUCTIONS} cannot be checked on this host`
}

/**
 * The hexadecimal SHA-256 of a file's bytes: the revision a write replaces.
 * @param bytes - the file's content.
 * @returns the digest.
 */
export function revisionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read a workspace's `AGENTS.md`. A missing file, a symbolic link, or a non-regular entry such as a directory or a FIFO reads as
 * no file, and so does a missing folder, or a symbolic link or non-directory, on the path from the root to the workspace.
 * @param root - the workspaces root, an absolute path; the walk opens it by its path.
 * @param relativeDirectory - the workspace directory's path below the root, names separated by `/`; `''` is the root itself.
 * @param maxBytes - the longest file read, in UTF-8 bytes.
 * @param options - the walk; see {@link WalkOptions}.
 * @returns the file's text and the revision of its bytes; both null without a regular file.
 * @throws InvalidPathError when `relativeDirectory` is not a sequence of ordinary names below the root.
 * @throws InstructionsRefusedError with code `too-large` when the file is longer than `maxBytes`, and with code `unavailable`
 * when the proc walk cannot name the directories it holds.
 * @throws UnsupportedHostError on Windows.
 */
export async function readInstructions(root: string, relativeDirectory: string, maxBytes: number, options: WalkOptions = {}): Promise<{ readonly text: string | null, readonly revision: string | null }> {
  const opened = await openWorkspace(root, relativeDirectory, resolveWalk(options))
  if (opened.kind !== 'open') return { text: null, revision: null }
  try {
    const entry = await readEntry(opened.directory, INSTRUCTIONS, maxBytes)
    if (entry.kind === 'too-large') throw new InstructionsRefusedError('too-large', `${INSTRUCTIONS} is more than ${String(maxBytes)} bytes`)
    if (entry.kind !== 'file') return { text: null, revision: null }
    return { text: entry.bytes.toString('utf8'), revision: revisionOf(entry.bytes) }
  } finally {
    await opened.directory.close()
  }
}

/**
 * Replace a workspace's `AGENTS.md` with new text, or remove it for empty text, when the file still has the revision the
 * caller names. Writes to one directory run one at a time, so two writes that expect the same revision cannot both pass
 * the check. A write creates a temporary file beside the target and renames it over the target.
 * @param root - the workspaces root, an absolute path; the walk opens it by its path.
 * @param relativeDirectory - the workspace directory's path below the root, names separated by `/`; `''` is the root itself.
 * @param text - the new text; empty removes the file.
 * @param expectedRevision - the revision the file must have now; null when the file must be absent.
 * @param maxBytes - the longest text, in UTF-8 bytes.
 * @param options - the walk; see {@link WalkOptions}.
 * @returns when the file is written or removed. Empty text with no file succeeds without a change.
 * @throws InvalidPathError when `relativeDirectory` is not a sequence of ordinary names below the root.
 * @throws InstructionsRefusedError with code `too-large` when the text is longer than `maxBytes`; with code `conflict` when the
 * file is not `expectedRevision`, is a symbolic link or non-regular entry, is longer than `maxBytes`, or a folder on the path is a
 * symbolic link or not a folder; and with code `unavailable` when the proc walk cannot name the directories it holds.
 * @throws Error when the workspace folder is missing and the write would create the file in it.
 * @throws UnsupportedHostError on Windows.
 */
export async function writeInstructions(root: string, relativeDirectory: string, text: string, expectedRevision: string | null, maxBytes: number, options: WalkOptions = {}): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > maxBytes) throw new InstructionsRefusedError('too-large', `the instructions are ${String(bytes.length)} bytes, more than ${String(maxBytes)}`)
  const opened = await openWorkspace(root, relativeDirectory, resolveWalk(options))
  if (opened.kind === 'other') throw new InstructionsRefusedError('conflict', `a folder on the path to ${INSTRUCTIONS} is a symbolic link or not a folder`)
  if (opened.kind === 'absent') {
    // A missing folder holds no file: only the removal of an absent file can succeed.
    if (expectedRevision !== null) throw new InstructionsRefusedError('conflict', `${INSTRUCTIONS} changed since it was read`)
    if (bytes.length === 0) return
    throw new Error(`cannot write ${INSTRUCTIONS}: the workspace folder does not exist`)
  }
  try {
    await serialise(opened.directory.identity, () => commitInstructions(opened.directory, bytes, expectedRevision, maxBytes))
  } finally {
    await opened.directory.close()
  }
}

/**
 * Check a workspace's `AGENTS.md` against its expected revision, then write the new bytes or remove the file. The caller
 * holds the directory's write queue.
 * @param directory - the open workspace directory.
 * @param bytes - the new content; empty removes the file.
 * @param expectedRevision - the revision the file must have now; null when the file must be absent.
 * @param maxBytes - the longest file read for the check.
 * @returns when the file is written or removed.
 * @throws InstructionsRefusedError with code `conflict`, as {@link writeInstructions} documents.
 */
async function commitInstructions(directory: OpenDirectory, bytes: Buffer, expectedRevision: string | null, maxBytes: number): Promise<void> {
  const current = await readEntry(directory, INSTRUCTIONS, maxBytes)
  if (current.kind === 'other') throw new InstructionsRefusedError('conflict', `${INSTRUCTIONS} is a symbolic link or not a regular file`)
  if (current.kind === 'too-large') throw new InstructionsRefusedError('conflict', `${INSTRUCTIONS} is more than ${String(maxBytes)} bytes, so it is not the revision that was read`)
  const revision = current.kind === 'file' ? revisionOf(current.bytes) : null
  if (revision !== expectedRevision) throw new InstructionsRefusedError('conflict', `${INSTRUCTIONS} changed since it was read`)
  if (bytes.length > 0) await replaceEntry(directory, bytes)
  else if (current.kind === 'file') await removeEntry(directory)
}

/**
 * Write bytes to a new temporary file in the directory and rename it over `AGENTS.md`. The temporary file is created with
 * mode 0600 and reaches mode 0644 before the rename; a failed write or rename removes it.
 * @param directory - the open workspace directory.
 * @param bytes - the new content.
 * @returns when the file is in place.
 */
async function replaceEntry(directory: OpenDirectory, bytes: Buffer): Promise<void> {
  const temporary = directory.inside(`.${INSTRUCTIONS}.delo-${randomUUID()}`)
  let renamed = false
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, TEMPORARY_MODE)
    try {
      await file.writeFile(bytes)
      await file.chmod(FILE_MODE)
    } finally {
      await file.close()
    }
    await rename(temporary, directory.inside(INSTRUCTIONS))
    renamed = true
  } finally {
    // The failure that stopped the write is the one reported. A temporary file that cannot be removed stays hidden under a Delo name.
    if (!renamed) await unlink(temporary).catch(() => undefined)
  }
}

/**
 * Remove a workspace's `AGENTS.md`. A name that is already gone is not an error.
 * @param directory - the open workspace directory.
 * @returns when the name is gone.
 */
async function removeEntry(directory: OpenDirectory): Promise<void> {
  try {
    await unlink(directory.inside(INSTRUCTIONS))
  } catch (error) {
    // Only a file removed by another process after the check is an absent name here.
    if (codeOf(error) !== 'ENOENT') throw error
  }
}

// The writes queued for each directory, keyed by its device and inode, so two paths to one directory share a queue.
const queues = new Map<string, Promise<void>>()

/**
 * Run a task once the tasks queued for the same directory have settled.
 * @param key - the directory's device and inode.
 * @param task - the task.
 * @returns the task's result, or its rejection.
 */
function serialise<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task)
  const settled = run.then(() => undefined, () => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}

/** What a name holds in an open directory: nothing, a link or non-regular entry, a regular file longer than the limit, or a regular file's bytes. */
type Entry =
  | { readonly kind: 'absent' }
  | { readonly kind: 'other' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'file', readonly bytes: Buffer }

/**
 * Read a name of an open directory when it is a regular file. The name is checked with `lstat` before it is opened, so a
 * link, FIFO, socket or device is not opened. The open uses `O_NOFOLLOW` and `O_NONBLOCK`, and the descriptor is checked
 * again before its bytes are read.
 * @param directory - the workspace directory or a directory inside it.
 * @param name - the name inside it, without a separator.
 * @param maxBytes - the longest file read.
 * @returns what the name holds.
 */
async function readEntry(directory: OpenDirectory, name: string, maxBytes: number): Promise<Entry> {
  const path = directory.inside(name)
  let stats: Stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (!stats.isFile()) return { kind: 'other' }
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
  } catch (error) {
    // The name changed after lstat: it was removed, replaced by a link (ELOOP), or replaced by a socket (ENXIO).
    const code = codeOf(error)
    if (code === 'ENOENT') return { kind: 'absent' }
    if (code === 'ELOOP' || code === 'ENXIO') return { kind: 'other' }
    throw error
  }
  try {
    const fileStats = await file.stat()
    if (!fileStats.isFile()) return { kind: 'other' }
    if (fileStats.size > maxBytes) return { kind: 'too-large' }
    // One byte past the limit detects a file that grew after its size was read.
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return total > maxBytes ? { kind: 'too-large' } : { kind: 'file', bytes: buffer.subarray(0, total) }
  } finally {
    await file.close()
  }
}

/** A directory that the walk reached, or a directory inside one, with the means to name a name inside it. */
interface OpenDirectory {
  /** The device and inode as `dev:ino`, which keys the directory's write queue. */
  readonly identity: string
  /** The path of a name inside the directory: through the held descriptor for `proc`, through the checked path for `lstat`. */
  readonly inside: (name: string) => string
  /** Releases the descriptor that `proc` holds; `lstat` holds none. */
  readonly close: () => Promise<void>
}

/** An open directory, a missing name, or a symbolic link or non-directory at the path. */
type Opening =
  | { readonly kind: 'open', readonly directory: OpenDirectory }
  | { readonly kind: 'absent' }
  | { readonly kind: 'other' }

/** The walk for one call: the walk the caller names, or the one {@link chooseWalk} gives for this host, and its descriptor directory. */
interface ResolvedWalk {
  /** How each name is checked. */
  readonly walk: Walk
  /** The descriptor directory that the `proc` walk names held directories through. */
  readonly procRoot: string
}

/**
 * Open the workspace directory by walking from the root down its relative path, one name at a time.
 * @param root - the root's path, opened by the path as given.
 * @param relativeDirectory - the workspace directory's path below the root; `''` is the root itself.
 * @param walk - the resolved walk.
 * @returns the open workspace directory, or `absent` or `other` at the first name that is missing, or is a link or a non-directory.
 * @throws InvalidPathError when `relativeDirectory` is not a sequence of ordinary names below the root.
 * @throws InstructionsRefusedError with code `unavailable` when the proc walk cannot name the directories it holds.
 * @throws Error on a system failure other than a missing name or a link.
 */
async function openWorkspace(root: string, relativeDirectory: string, walk: ResolvedWalk): Promise<Opening> {
  const names = namesBelow(relativeDirectory)
  if (walk.walk === 'proc') await requireDescriptorDirectory(walk.procRoot)
  const top = await openRoot(root, walk)
  if (top.kind !== 'open') return top
  let directory = top.directory
  for (const name of names) {
    const parent = directory
    const child = await openName(parent, name, walk).finally(() => parent.close())
    if (child.kind !== 'open') return child
    directory = child.directory
  }
  return { kind: 'open', directory }
}

/**
 * Check that the proc walk's descriptor directory can be read before any name is resolved through it. A missing workspace
 * folder is then refused too, rather than answered as no file.
 * @param procRoot - the descriptor directory.
 * @returns when it can be read.
 * @throws InstructionsRefusedError with code `unavailable` when it cannot.
 */
async function requireDescriptorDirectory(procRoot: string): Promise<void> {
  try {
    await stat(procRoot)
  } catch (error) {
    throw new InstructionsRefusedError('unavailable', unavailableReason(procRoot, error))
  }
}

/**
 * Open the root, the first directory of the walk. Its path is followed as given.
 * @param root - the root's path.
 * @param walk - the resolved walk.
 * @returns the opening of the root.
 */
async function openRoot(root: string, walk: ResolvedWalk): Promise<Opening> {
  try {
    return walk.walk === 'proc' ? await openDescriptor(root, walk.procRoot, true) : await checkDirectory(root, true)
  } catch (error) {
    return openingOf(error)
  }
}

/**
 * Open a name inside an open directory, refusing a symbolic link or a non-directory at it.
 * @param parent - the open directory that holds the name.
 * @param name - the name, without a separator.
 * @param walk - the resolved walk.
 * @returns the opening of the name.
 */
async function openName(parent: OpenDirectory, name: string, walk: ResolvedWalk): Promise<Opening> {
  try {
    return walk.walk === 'proc' ? await openDescriptor(parent.inside(name), walk.procRoot, false) : await checkDirectory(parent.inside(name), false)
  } catch (error) {
    return openingOf(error)
  }
}

/**
 * Open a directory with `O_PATH` and hold its descriptor. Names inside it then resolve through the descriptor directory, so a
 * rename or a replacement of the path after the open does not change what is checked.
 * @param path - the directory's path.
 * @param procRoot - the descriptor directory that names inside the directory resolve through.
 * @param followsLink - whether a symbolic link at the path is followed; false refuses one, as for every name below the root.
 * @returns the open directory, or `other` for a non-directory.
 * @throws InstructionsRefusedError with code `unavailable` when the descriptor directory does not name the held descriptor; the
 * descriptor is closed first.
 * @throws Error with the system code of a failed open, which {@link openingOf} maps.
 */
async function openDescriptor(path: string, procRoot: string, followsLink: boolean): Promise<Opening> {
  const handle = await open(path, O_PATH | constants.O_DIRECTORY | (followsLink ? 0 : constants.O_NOFOLLOW))
  let stats: Stats
  try {
    stats = await handle.stat()
  } catch (error) {
    await handle.close()
    throw error
  }
  if (!stats.isDirectory()) {
    await handle.close()
    return { kind: 'other' }
  }
  const held = `${procRoot}/${String(handle.fd)}`
  try {
    await stat(held)
  } catch (error) {
    await handle.close()
    throw new InstructionsRefusedError('unavailable', unavailableReason(procRoot, error))
  }
  return { kind: 'open', directory: { identity: identityOf(stats), inside: (name) => `${held}/${name}`, close: () => handle.close() } }
}

/**
 * Check a path with `lstat`, or with `stat` when a link at the path is followed. A symbolic link or a non-directory reads as
 * `other`. The names inside the directory are then opened by path, so a same-user process can replace a directory between
 * the check and an open of a name inside it; the `proc` walk has no such window.
 * @param path - the path.
 * @param followsLink - whether a symbolic link at the path is followed.
 * @returns the directory, or `other` for a refused link or a non-directory.
 */
async function checkDirectory(path: string, followsLink: boolean): Promise<Opening> {
  const stats = followsLink ? await stat(path) : await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { kind: 'other' }
  return { kind: 'open', directory: { identity: identityOf(stats), inside: (name) => `${path}/${name}`, close: () => Promise.resolve() } }
}

/**
 * The opening that a failed open or check of a name stands for.
 * @param error - the failure.
 * @returns `absent` for ENOENT, and `other` for ENOTDIR and ELOOP, which mean a non-directory or a link at the name.
 * @throws the failure for any other code, so a system error is never answered as a missing name.
 */
function openingOf(error: unknown): Opening {
  const code = codeOf(error)
  if (code === 'ENOENT') return { kind: 'absent' }
  if (code === 'ENOTDIR' || code === 'ELOOP') return { kind: 'other' }
  throw error
}

/**
 * The names from the root down to the workspace directory.
 * @param relativeDirectory - the workspace directory's path below the root.
 * @returns the names in order; none for the root itself.
 * @throws InvalidPathError when the path is absolute, or a name is empty, `.` or `..`, or holds a NUL byte.
 */
function namesBelow(relativeDirectory: string): readonly string[] {
  if (relativeDirectory === '') return []
  if (relativeDirectory.startsWith('/')) throw new InvalidPathError(`${JSON.stringify(relativeDirectory)} is absolute, not a path below the root`)
  const names = relativeDirectory.split('/')
  if (names.some((name) => name === '' || name === '.' || name === '..' || name.includes('\0'))) {
    throw new InvalidPathError(`${JSON.stringify(relativeDirectory)} has a name that is not an ordinary name below the root`)
  }
  return names
}

/**
 * The walk for one call: the walk the caller names, or the one {@link chooseWalk} gives for this host.
 * @param options - the caller's options.
 * @returns the walk and the descriptor directory it names through.
 * @throws UnsupportedHostError on Windows.
 */
function resolveWalk(options: WalkOptions): ResolvedWalk {
  if (process.platform === 'win32') throw new UnsupportedHostError('the instructions files do not run on Windows, whose link checks are not verified')
  const procRoot = options.procRoot ?? PROC_FD
  return { walk: options.walk ?? chooseWalk(probeProcFd(procRoot)), procRoot }
}

/**
 * The device and inode of a directory, as the key of its write queue.
 * @param stats - the directory's stats.
 * @returns `dev:ino`.
 */
function identityOf(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`
}

/**
 * The system error code of a failure, such as `ENOENT`.
 * @param error - the failure.
 * @returns the code, or undefined when the failure has none.
 */
function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * A workspace's repository, read from its `.git` directory without running git: the `origin` remote's URL and the branch
 * `HEAD` names. A missing `.git`, a `.git` file (a linked worktree or a submodule), or a symbolic link at either path shows no
 * repository, and a detached `HEAD` shows no branch.
 * @param root - the workspaces root, an absolute path; the walk opens it by its path.
 * @param relativeDirectory - the workspace directory's path below the root; `''` is the root itself.
 * @param options - the walk; see {@link WalkOptions}.
 * @returns the origin URL and the branch, each null when unknown. The origin is null for a URL with a user name or password.
 * @throws InvalidPathError when `relativeDirectory` is not a sequence of ordinary names below the root.
 * @throws InstructionsRefusedError with code `unavailable` when the proc walk cannot name the directories it holds.
 * @throws UnsupportedHostError on Windows.
 */
export async function repositoryOf(root: string, relativeDirectory: string, options: WalkOptions = {}): Promise<{ readonly origin: string | null, readonly branch: string | null }> {
  const walk = resolveWalk(options)
  const workspace = await openWorkspace(root, relativeDirectory, walk)
  if (workspace.kind !== 'open') return { origin: null, branch: null }
  try {
    return await gitRepository(workspace.directory, walk)
  } finally {
    await workspace.directory.close()
  }
}

/**
 * The origin and branch that a workspace's `.git` directory holds.
 * @param workspace - the open workspace directory.
 * @param walk - the resolved walk that reached the workspace directory.
 * @returns the origin and the branch, each null when unknown.
 */
async function gitRepository(workspace: OpenDirectory, walk: ResolvedWalk): Promise<{ readonly origin: string | null, readonly branch: string | null }> {
  const git = await openName(workspace, '.git', walk)
  if (git.kind !== 'open') return { origin: null, branch: null }
  try {
    const head = await readGitFile(git.directory, 'HEAD')
    const config = await readGitFile(git.directory, 'config')
    return { origin: config === undefined ? null : originOf(config), branch: branchOf(head) }
  } finally {
    await git.directory.close()
  }
}

/**
 * Read a small text file of a `.git` directory. A file that is too large, is not a regular file, or cannot be read shows as
 * absent, because the branch and origin are display values that must not fail a listing.
 * @param git - the open `.git` directory.
 * @param name - the file's name.
 * @returns the text, or undefined when the file is absent.
 */
async function readGitFile(git: OpenDirectory, name: string): Promise<string | undefined> {
  let entry: Entry
  try {
    entry = await readEntry(git, name, MAX_GIT_FILE_BYTES)
  } catch (error) {
    // Unreadable metadata hides the branch or origin only.
    const code = codeOf(error)
    if (code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
  return entry.kind === 'file' ? entry.bytes.toString('utf8') : undefined
}

/**
 * The branch a `HEAD` file names.
 * @param head - the file's text, or undefined when the file is absent.
 * @returns the branch name, or null for a detached or absent `HEAD`.
 */
function branchOf(head: string | undefined): string | null {
  if (head === undefined) return null
  return /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? null
}

/**
 * The `url` of `[remote "origin"]` in a Git config file.
 * @param config - the file's text.
 * @returns the URL for display, or null when the file has no origin or the origin has a user name or password.
 */
function originOf(config: string): string | null {
  let inOrigin = false
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line)
      continue
    }
    const match = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null
    if (match?.[1] !== undefined) return withoutCredentials(match[1].trim())
  }
  return null
}

/**
 * A remote's URL for display. A URL with a user name or password gives null, since the harness never shows one. A query and a
 * fragment are dropped, because a token can sit in either. An address that is not a URL, such as `git@host:path`, is returned
 * as written.
 * @param url - the URL as configured.
 * @returns the URL, or null when it has a user name or password.
 */
function withoutCredentials(url: string): string | null {
  if (!URL.canParse(url)) return url
  const parsed = new URL(url)
  if (parsed.username !== '' || parsed.password !== '') return null
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}
