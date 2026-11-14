/**
 * The two small files contract C18's check keeps under the home's `trust/`, read and written under contract C1's rule
 * for protected files through `@delorun/home`: a file that is a symbolic link, belongs to another user or is laxer than
 * 0600 is refused, and a write replaces the file atomically at mode 0600 through a temporary sibling, so a start that
 * reads while another writes reads one record and never half of one. The directory is created at mode 0700. Neither
 * file holds a secret.
 *
 * This is the one module of the package that reaches the filesystem.
 *
 * @module @delorun/release-verify/store
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { readProtectedFile as readHomeFile, writeProtectedFile as writeHomeFile } from '@delorun/home'

/**
 * Read a protected file.
 * @param path - the file's absolute path.
 * @returns the file's bytes, or `undefined` when it does not exist.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the file is a link, another user's or laxer than 0600.
 * @throws Error when the file exists and cannot be read.
 */
export async function readProtectedFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readHomeFile(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Replace a protected file atomically at mode 0600, creating its directory at mode 0700.
 * @param path - the file's absolute path.
 * @param text - the text to write.
 * @returns when the file is published.
 */
export async function writeProtectedFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeHomeFile(path, text)
}

/**
 * Whether a failure is a missing file.
 * @param error - the failure.
 * @returns `true` for `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
