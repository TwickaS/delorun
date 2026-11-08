/**
 * The two small files contract C18's check keeps under the home: read through contract C1's rules and replaced
 * atomically. A file is written as a temporary sibling and renamed over its target, so a start that reads while another
 * writes reads one record and never half of one; the directory is created at mode 0700 and the file at mode 0600, as
 * C1 requires of the home's protected state. Neither file holds a secret.
 *
 * @module @delo/release-verify/store
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PRIVATE_DIR_MODE, PROTECTED_FILE_MODE } from '@delo/contract-home-layout'

/** The suffix of the temporary sibling a write publishes through. */
const TEMPORARY_SUFFIX = '.tmp'

/**
 * Read a protected file.
 * @param path - the file's absolute path.
 * @returns the file's bytes, or `undefined` when it does not exist.
 * @throws Error when the file exists and cannot be read.
 */
export async function readProtectedFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Replace a protected file atomically, creating its directory at mode 0700 and the file at mode 0600.
 * @param path - the file's absolute path.
 * @param text - the text to write.
 * @returns when the file is published.
 */
export async function writeProtectedFile(path: string, text: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  const temporary = `${path}${TEMPORARY_SUFFIX}`
  await writeFile(temporary, text, { mode: PROTECTED_FILE_MODE })
  // `mode` at creation is masked by the process's umask, so the file is narrowed again before it is published.
  await chmod(temporary, PROTECTED_FILE_MODE)
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Whether a failure is a missing file.
 * @param error - the failure.
 * @returns `true` for `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
