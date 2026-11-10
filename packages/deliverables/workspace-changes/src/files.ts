/**
 * The Host's file operations on the private directory and on the files it copies into it. Every open refuses a final
 * symbolic link and never blocks on a named pipe, every directory on the way from the scratch root is checked by
 * device and inode before use ({@link PrivateTree}), every read accepts only a regular file, every file this plugin
 * writes is created exclusively with mode 0600, and every directory is created exclusively with mode 0700, so an
 * entry this plugin did not create is refused rather than followed or reused. Windows has no `O_NOFOLLOW` or
 * `O_NONBLOCK`; there the opens fall back to plain reads and exclusive creation.
 */
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, chmod, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { pathWithin } from '@deepseek-ai/dsh-sandbox'

/** Read without following a final link and without waiting for a writer on a named pipe. */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
/** Create a new file only, never through a final link. */
const CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
/** Bytes moved per read while copying a file. */
const COPY_CHUNK_BYTES = 1024 * 1024

/** Name of the scratch root inside the per-user cache directory. */
const SCRATCH_ROOT_NAME = 'dsh-workspace-changes'

/** Prefix of each Session's private directory under the scratch root. */
export const SESSION_DIRECTORY_PREFIX = 'session-'

/**
 * The default scratch root: this package's directory in the per-user cache directory, which no sandbox dialect grants
 * to confined commands and which lies outside the protected home. That is `%LOCALAPPDATA%` on Windows,
 * `~/Library/Caches` on macOS, and `$XDG_CACHE_HOME` when it is absolute or else `~/.cache` elsewhere.
 * @param platform - the Host platform.
 * @param env - the Host environment.
 * @param home - the Host user's home directory.
 * @returns an absolute directory path.
 */
export function defaultScratchRoot(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  const absolute = (value: string | undefined): value is string => value !== undefined && isAbsolute(value)
  switch (platform) {
    case 'win32': return join(absolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'), SCRATCH_ROOT_NAME)
    case 'darwin': return join(home, 'Library', 'Caches', SCRATCH_ROOT_NAME)
    // Linux and every other platform follow the XDG base directory specification.
    default: return join(absolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'), SCRATCH_ROOT_NAME)
  }
}

/**
 * Whether a filesystem error names a missing path.
 * @param error - the rejection.
 * @returns true for `ENOENT`.
 */
export function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Open a regular file for reading. A final symbolic link rejects with `ELOOP`; a named pipe, device, socket, or
 * directory rejects after the open, which does not block.
 * @param path - absolute path.
 * @returns the open handle; the caller closes it.
 * @throws when the path is missing, is a link, cannot be opened, or is not a regular file.
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await open(path, READ_FLAGS)
  let regular = false
  try {
    regular = (await handle.stat()).isFile()
  } finally {
    if (!regular) await handle.close()
  }
  if (!regular) throw new Error(`${path} is not a regular file`)
  return handle
}

/**
 * Create a new file with mode 0600 and write `bytes` into it.
 * @param path - absolute path whose final component must not exist.
 * @param bytes - the content.
 * @throws with code `EEXIST` when any entry, a link included, already exists at the path.
 */
export async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, CREATE_FLAGS, 0o600)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

/**
 * Copy a regular file into a new file with mode 0600, without following a link at either end.
 * @param source - absolute path of the file to copy.
 * @param target - absolute path whose final component must not exist.
 * @returns false when `source` is missing, true once copied.
 * @throws when `source` is a link or not a regular file, or `target` exists.
 */
export async function copyRegularFile(source: string, target: string): Promise<boolean> {
  let input: FileHandle
  try {
    input = await openRegularFile(source)
  } catch (error: unknown) {
    if (isMissing(error)) return false
    throw error
  }
  try {
    const output = await open(target, CREATE_FLAGS, 0o600)
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        await output.write(chunk, 0, bytesRead)
      }
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
  return true
}

/**
 * Create a directory with mode 0700 that must not exist yet; its parent must.
 * @param path - absolute path.
 * @returns `path`.
 * @throws with code `EEXIST` when any entry already exists at the path.
 */
export async function makeDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 })
  return path
}

/** The device and inode a directory had when this plugin created or first checked it. */
interface Identity {
  dev: bigint
  ino: bigint
}

/**
 * One Session's private directory and the directories created in it, each remembered by its device and inode at
 * creation, together with the scratch root's. {@link verify} checks every remembered directory with `lstat` before
 * the Host touches anything inside: each must still be a directory, not a link, with the same device and inode, so a
 * directory or one of its parents that was renamed away or replaced by a link, here or above the scratch root, is
 * refused instead of followed. The check and the operation after it are separate calls, so a swap inside that window
 * is not seen; the recorder's check of the directory against every live Session's writable roots before each use is
 * what keeps such a swap out of confined commands' reach.
 */
export class PrivateTree {
  private readonly identities = new Map<string, Identity>()

  private constructor(
    /** The canonical scratch root. */
    readonly root: string,
    /** The canonical path of this Session's private directory. */
    readonly path: string,
  ) {}

  /**
   * Create one Session's private directory under the scratch root, as {@link createPrivateDirectory} does, and
   * remember the identities of the root and the new directory.
   * @param root - absolute scratch root.
   * @returns the tree.
   * @throws as {@link createPrivateDirectory}.
   */
  static async create(root: string): Promise<PrivateTree> {
    const path = await createPrivateDirectory(root)
    const tree = new PrivateTree(await realpath(root), path)
    await tree.remember(tree.root)
    await tree.remember(path)
    return tree
  }

  /**
   * Create a directory inside the private directory exclusively with mode 0700 and remember it.
   * @param name - a single path component.
   * @returns the directory's path.
   * @throws when the tree no longer verifies or an entry already exists at the name.
   */
  async directory(name: string): Promise<string> {
    await this.verify()
    const path = await makeDirectory(join(this.path, name))
    await this.remember(path)
    return path
  }

  /**
   * Create a uniquely named temporary directory inside the private directory and remember it until {@link remove}.
   * @param prefix - the name's prefix.
   * @returns the directory's path.
   * @throws when the tree no longer verifies.
   */
  async temporary(prefix: string): Promise<string> {
    await this.verify()
    const path = await mkdtemp(join(this.path, prefix))
    await this.remember(path)
    return path
  }

  /**
   * Remove a directory this tree created, or the private directory itself, after verifying the tree, and forget it.
   * @param path - the directory, or {@link path}.
   * @throws when the tree no longer verifies, in which case nothing is removed.
   */
  async remove(path: string): Promise<void> {
    await this.verify()
    await rm(path, { recursive: true, force: true })
    for (const known of [...this.identities.keys()]) {
      if (known === path || known.startsWith(`${path}${sep}`)) this.identities.delete(known)
    }
  }

  /**
   * Check every remembered directory.
   * @throws when one is missing, is no longer a directory, or has another device or inode.
   */
  async verify(): Promise<void> {
    for (const [path, identity] of this.identities) {
      const stats = await lstat(path, { bigint: true })
      if (!stats.isDirectory() || stats.dev !== identity.dev || stats.ino !== identity.ino) {
        throw new Error(`private directory ${path} was replaced after it was created; nothing is read from or written to it`)
      }
    }
  }

  private async remember(path: string): Promise<void> {
    const stats = await lstat(path, { bigint: true })
    this.identities.set(path, { dev: stats.dev, ino: stats.ino })
  }
}

/**
 * Require the scratch root's `lstat` to name a directory, not a link, owned by the current user where the platform
 * reports user ids.
 * @param root - absolute scratch root.
 * @param stats - the root's `lstat`.
 * @throws when the root is a link, not a directory, or owned by another user.
 */
function assertOwnedDirectory(root: string, stats: { isDirectory(): boolean; uid: number }): void {
  if (!stats.isDirectory()) throw new Error(`scratch root ${root} is not a directory`)
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) throw new Error(`scratch root ${root} belongs to another user`)
}

/**
 * Create one Session's private directory under the scratch root. The root and its missing ancestors are created
 * first; the root must then be a directory, not a link, owned by the current user, and is narrowed to mode 0700.
 * @param root - absolute scratch root.
 * @returns the canonical path of a new, empty directory with mode 0700.
 * @throws when the root is a link, not a directory, or owned by another user.
 */
export async function createPrivateDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stats = await lstat(root)
  assertOwnedDirectory(root, stats)
  if ((stats.mode & 0o077) !== 0) await chmod(root, 0o700)
  return realpath(await mkdtemp(join(root, `${SESSION_DIRECTORY_PREFIX}${process.pid}-`)))
}

/**
 * Whether a process with this id is running, as `kill(pid, 0)` answers: a process this user may not signal is
 * running too.
 * @param pid - the process id.
 * @returns false only when no such process exists.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as { code?: unknown }).code !== 'ESRCH'
  }
}

/**
 * Remove the private directories that Host processes no longer running left under the scratch root: each
 * `session-<pid>-*` directory, not a link, whose process is gone. Before listing, the root must be a directory, not a
 * link, owned by the current user, and its canonical path must overlap no root a live Session's confined commands can
 * write; otherwise nothing is removed. A directory of this process or of a running one, a link, and any other entry
 * are left alone; a missing root removes nothing.
 * @param root - absolute scratch root.
 * @param writableRoots - the canonical roots any live Session's confined commands can write at this moment.
 * @param alive - whether a process id is running.
 * @returns the directories removed.
 * @throws when the root is a link, not a directory, owned by another user, or overlaps a writable root, in which case
 * nothing is removed.
 */
export async function removeStaleDirectories(
  root: string, writableRoots: () => readonly string[], alive: (pid: number) => boolean = processAlive,
): Promise<string[]> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(root)
  } catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  assertOwnedDirectory(root, stats)
  const canonical = await realpath(root)
  const exposed = writableRoots().find(writable => pathWithin(canonical, writable) || pathWithin(writable, canonical))
  if (exposed !== undefined) {
    throw new Error(`scratch root ${canonical} overlaps ${exposed}, which a live Session's confined commands can write; stale private directories are left in place`)
  }
  const removed: string[] = []
  for (const entry of await readdir(canonical)) {
    const match = new RegExp(`^${SESSION_DIRECTORY_PREFIX}(\\d+)-`).exec(entry)
    if (match === null) continue
    const pid = Number(match[1])
    if (pid === process.pid || alive(pid)) continue
    const path = join(canonical, entry)
    if (!(await lstat(path)).isDirectory()) continue
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
}
