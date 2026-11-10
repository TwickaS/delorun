/**
 * The Host's file operations on the private directory and on the files it copies into it. Every open refuses a final
 * symbolic link and never blocks on a named pipe, every read accepts only a regular file, every file this plugin
 * writes is created exclusively with mode 0600, and every directory is created exclusively with mode 0700, so an
 * entry this plugin did not create is refused rather than followed or reused. Windows has no `O_NOFOLLOW` or
 * `O_NONBLOCK`; there the opens fall back to plain reads and exclusive creation.
 */
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, chmod, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

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
  if (!stats.isDirectory()) throw new Error(`scratch root ${root} is not a directory`)
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) throw new Error(`scratch root ${root} belongs to another user`)
  if ((stats.mode & 0o077) !== 0) await chmod(root, 0o700)
  return realpath(await mkdtemp(join(root, SESSION_DIRECTORY_PREFIX)))
}
