/**
 * Read and write C1's protected files: every file under `secrets/`,
 * `trust/`, `status/` and `catalogue/`, the start token, the supervisor's
 * roots file and the operational log files (contract C1, "Modes and the
 * refusal rule"). A write creates the file at mode 0600 through exclusive
 * creation and an atomic rename; a read refuses a file that is a symbolic
 * link, not a regular file, another user's, or has a group or other bit set.
 *
 * Linux and macOS only: Windows has no mode bits, and C1's DACL check is not
 * implemented here, so on Windows a read checks only that the path is a
 * regular file.
 *
 * @module @delo/home/protected-file
 */
import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FORBIDDEN_MODE_BITS, PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { HomeLayoutError, shellPath } from './errors.ts'

const POSIX = process.platform !== 'win32'

/**
 * The refusal for a protected file that is not what C1 requires, or `undefined` when it is.
 * @param path - the file.
 * @param stats - its `lstat` or `fstat` result.
 * @returns the refusal, or `undefined`.
 */
function refusal(path: string, stats: Stats): HomeLayoutError | undefined {
  if (stats.isSymbolicLink()) return new HomeLayoutError('SECRET_FILE_MODE', path, `${path} is a symbolic link; a protected file must be a regular file`)
  if (!stats.isFile()) return new HomeLayoutError('SECRET_FILE_MODE', path, `${path} is not a regular file`)
  if (!POSIX) return undefined
  if (stats.uid !== process.getuid?.()) return new HomeLayoutError('SECRET_FILE_MODE', path, `${path} belongs to another user (uid ${String(stats.uid)})`)
  const mode = stats.mode & 0o777
  if ((mode & FORBIDDEN_MODE_BITS) === 0) return undefined
  return new HomeLayoutError('SECRET_FILE_MODE', path, `${path} has mode ${mode.toString(8).padStart(4, '0')}, which other users can read; it must be 0600`, `chmod 600 ${shellPath(path)}`)
}

/**
 * Check a protected file without reading it.
 * @param path - the absolute file path.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` naming the path, with the `chmod 600` fix for a laxer mode.
 * @throws the filesystem error, such as `ENOENT`, when the path cannot be examined.
 */
export async function checkProtectedFile(path: string): Promise<void> {
  const problem = refusal(path, await lstat(path))
  if (problem !== undefined) throw problem
}

/**
 * Read a protected file after checking it. The path is examined with `lstat`
 * before it is opened, so a FIFO or device is never opened, and the opened
 * descriptor must be the same file with the same check passing, so a file
 * swapped in between is refused.
 * @param path - the absolute file path.
 * @returns the file's bytes.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` naming the path, with the `chmod 600` fix for a laxer mode.
 * @throws the filesystem error, such as `ENOENT`, when the file cannot be read.
 */
export async function readProtectedFile(path: string): Promise<Buffer> {
  const before = await lstat(path)
  const problem = refusal(path, before)
  if (problem !== undefined) throw problem
  let handle
  try {
    handle = await open(path, POSIX ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : 'r')
  } catch (error) {
    // O_NOFOLLOW reports a symbolic link swapped in after the lstat as ELOOP.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HomeLayoutError('SECRET_FILE_MODE', path, `${path} is a symbolic link; a protected file must be a regular file`)
    throw error
  }
  try {
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino) throw new HomeLayoutError('SECRET_FILE_MODE', path, `${path} was replaced while it was being read`)
    const opened = refusal(path, after)
    if (opened !== undefined) throw opened
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Write a protected file atomically at mode 0600: the bytes go to a sibling
 * temporary file created exclusively at that mode, are flushed, and the file is
 * renamed over the path; on Linux and macOS the directory is flushed after the
 * rename. A failed write removes the temporary file and leaves the path unchanged.
 * @param path - the absolute file path; its directory must exist.
 * @param data - the file's contents.
 */
export async function writeProtectedFile(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(8).toString('hex')}`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (POSIX ? constants.O_NOFOLLOW : 0)
  const handle = await open(temporary, flags, PROTECTED_FILE_MODE)
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      // ENOENT: the rename already moved it. Any other failure leaves a stray temporary file, reported with the write's own error.
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], `could not write ${path} or remove ${temporary}`)
    })
    throw error
  }
  if (!POSIX) return
  const directory = await open(dirname(path), constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
