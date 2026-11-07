/**
 * A workspace's `AGENTS.md`, read and written beside the workspace's own processes, which can change any name in the
 * workspace at any moment. Every name is opened relative to an open directory through `/proc/self/fd`, with
 * `O_NOFOLLOW`, so a symbolic link a process planted cannot point the harness at a file outside the workspace.
 * The walk needs Linux; other hosts fail with an error rather than read the wrong file.
 *
 * @module @delo/plugin-workspaces/files
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'

// Linux's O_PATH, which Node's constants omit: a descriptor that names a directory without reading it.
const O_PATH = 0o10000000

// The mode a temporary file is created with, before it becomes FILE_MODE.
const TEMPORARY_MODE = 0o600

// The mode of a finished AGENTS.md, set explicitly so the umask does not change it.
const FILE_MODE = 0o644

// The longest `.git` file read. HEAD and config are small; a larger one shows no branch or origin.
const MAX_GIT_FILE_BYTES = 64 * 1024

/** The instructions file a chat in the workspace loads. */
export const INSTRUCTIONS = 'AGENTS.md'

/**
 * A read or write of an instructions file that the files module refused. `conflict`: the file is not the revision
 * the caller named (null means the file must be absent), or a symbolic link or non-regular entry holds the name.
 * `too-large`: the text, or the file being replaced, is longer than the byte limit.
 */
export class InstructionsRefusedError extends Error {
  /**
   * @param code - why the files module refused.
   * @param reason - an English message for the person.
   */
  constructor(readonly code: 'conflict' | 'too-large', reason: string) {
    super(reason)
    this.name = 'InstructionsRefusedError'
  }
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
 * Read a workspace's `AGENTS.md`. A missing file, a symbolic link, or a non-regular entry such as a directory or a FIFO
 * reads as no file, and so does a missing workspace directory or a symbolic link at its path.
 * @param directory - the workspace's directory, an absolute path.
 * @param maxBytes - the longest file read, in UTF-8 bytes.
 * @returns the file's text and the revision of its bytes; both null without a regular file.
 * @throws InstructionsRefusedError with code `too-large` when the file is longer than `maxBytes`.
 */
export async function readInstructions(directory: string, maxBytes: number): Promise<{ readonly text: string | null, readonly revision: string | null }> {
  const opened = await openDirectory(directory)
  if (opened.kind !== 'open') return { text: null, revision: null }
  try {
    const entry = await readEntry(opened.handle, INSTRUCTIONS, maxBytes)
    if (entry.kind === 'too-large') throw new InstructionsRefusedError('too-large', `${INSTRUCTIONS} is more than ${String(maxBytes)} bytes`)
    if (entry.kind !== 'file') return { text: null, revision: null }
    return { text: entry.bytes.toString('utf8'), revision: revisionOf(entry.bytes) }
  } finally {
    await opened.handle.close()
  }
}

/**
 * Replace a workspace's `AGENTS.md` with new text, or remove it for empty text, when the file still has the revision the
 * caller names. Writes to one directory run one at a time, so two writes that expect the same revision cannot both pass
 * the check. A write creates a temporary file beside the target and renames it over the target.
 * @param directory - the workspace's directory, an absolute path.
 * @param text - the new text; empty removes the file.
 * @param expectedRevision - the revision the file must have now; null when the file must be absent.
 * @param maxBytes - the longest text, in UTF-8 bytes.
 * @returns when the file is written or removed. Empty text with no file succeeds without a change.
 * @throws InstructionsRefusedError with code `too-large` when the text is longer than `maxBytes`, and with code `conflict`
 * when the file is not `expectedRevision`, is a symbolic link or non-regular entry, or is longer than `maxBytes`.
 * @throws Error when the workspace directory is missing and the write would create the file in it.
 */
export async function writeInstructions(directory: string, text: string, expectedRevision: string | null, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > maxBytes) throw new InstructionsRefusedError('too-large', `the instructions are ${String(bytes.length)} bytes, more than ${String(maxBytes)}`)
  const opened = await openDirectory(directory)
  if (opened.kind === 'other') throw new InstructionsRefusedError('conflict', `${directory} is a symbolic link or not a directory`)
  if (opened.kind === 'absent') {
    // A missing directory holds no file: only the removal of an absent file can succeed.
    if (expectedRevision !== null) throw new InstructionsRefusedError('conflict', `${INSTRUCTIONS} changed since it was read`)
    if (bytes.length === 0) return
    throw new Error(`cannot write ${INSTRUCTIONS}: ${directory} does not exist`)
  }
  try {
    const { dev, ino } = await opened.handle.stat()
    await serialise(`${String(dev)}:${String(ino)}`, () => commitInstructions(opened.handle, bytes, expectedRevision, maxBytes))
  } finally {
    await opened.handle.close()
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
async function commitInstructions(directory: FileHandle, bytes: Buffer, expectedRevision: string | null, maxBytes: number): Promise<void> {
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
async function replaceEntry(directory: FileHandle, bytes: Buffer): Promise<void> {
  const temporary = inside(directory, `.${INSTRUCTIONS}.delo-${randomUUID()}`)
  let renamed = false
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, TEMPORARY_MODE)
    try {
      await file.writeFile(bytes)
      await file.chmod(FILE_MODE)
    } finally {
      await file.close()
    }
    await rename(temporary, inside(directory, INSTRUCTIONS))
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
async function removeEntry(directory: FileHandle): Promise<void> {
  try {
    await unlink(inside(directory, INSTRUCTIONS))
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
 * @param directory - the open directory.
 * @param name - the name inside it, without a separator.
 * @param maxBytes - the longest file read.
 * @returns what the name holds.
 */
async function readEntry(directory: FileHandle, name: string, maxBytes: number): Promise<Entry> {
  const path = inside(directory, name)
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

/** An open workspace directory, a missing path, or a symbolic link or non-directory at the path. */
type Directory =
  | { readonly kind: 'open', readonly handle: FileHandle }
  | { readonly kind: 'absent' }
  | { readonly kind: 'other' }

/**
 * Open a directory without following a symbolic link at its path. The operating system resolves the parents of the path,
 * which the harness chooses.
 * @param directory - the directory's path, absolute.
 * @returns the open directory, `absent` for a missing path, or `other` for a symbolic link or a non-directory.
 * @throws Error on a host other than Linux, which has no `/proc/self/fd`.
 */
async function openDirectory(directory: string): Promise<Directory> {
  if (process.platform !== 'linux') throw new Error(`the instructions files need Linux, which /proc/self/fd requires; this host is ${process.platform}`)
  try {
    return { kind: 'open', handle: await open(directory, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') return { kind: 'absent' }
    if (code === 'ENOTDIR' || code === 'ELOOP') return { kind: 'other' }
    throw error
  }
}

// A name inside an open directory, resolved through the descriptor, so renaming the path does not move what was opened.
const inside = (directory: FileHandle, name: string): string => `/proc/self/fd/${String(directory.fd)}/${name}`

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
 * @param directory - the workspace's directory, an absolute path.
 * @returns the origin URL and the branch, each null when unknown. The origin is null for a URL with a user name or password.
 */
export async function repositoryOf(directory: string): Promise<{ readonly origin: string | null, readonly branch: string | null }> {
  const workspace = await openDirectory(directory)
  if (workspace.kind !== 'open') return { origin: null, branch: null }
  try {
    return await gitRepository(workspace.handle)
  } finally {
    await workspace.handle.close()
  }
}

/**
 * The origin and branch that a workspace's `.git` directory holds.
 * @param workspace - the open workspace directory.
 * @returns the origin and the branch, each null when unknown.
 */
async function gitRepository(workspace: FileHandle): Promise<{ readonly origin: string | null, readonly branch: string | null }> {
  const git = await openDirectory(inside(workspace, '.git'))
  if (git.kind !== 'open') return { origin: null, branch: null }
  try {
    const head = await readGitFile(git.handle, 'HEAD')
    const config = await readGitFile(git.handle, 'config')
    return { origin: config === undefined ? null : originOf(config), branch: branchOf(head) }
  } finally {
    await git.handle.close()
  }
}

/**
 * Read a small text file of a `.git` directory. A file that is too large, is not a regular file, or cannot be read shows as
 * absent, because the branch and origin are display values that must not fail a listing.
 * @param git - the open `.git` directory.
 * @param name - the file's name.
 * @returns the text, or undefined when the file is absent.
 */
async function readGitFile(git: FileHandle, name: string): Promise<string | undefined> {
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
