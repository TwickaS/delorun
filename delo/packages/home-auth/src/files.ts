/**
 * The two file operations every store of `~/.delo/secrets/home-auth/` uses: read one JSON record through contract C1's
 * protected-file check, and write one atomically at mode 0600.
 *
 * A missing file is no record, which is what an unclaimed home's stores read as. A file that exists but is not this
 * package's JSON — or is reachable by another user — is a typed `STORE_INVALID` failure, so a corrupt or exposed store
 * refuses to answer instead of reading as empty and letting a claim replace it.
 *
 * @module @delo/home-auth/files
 */
import { basename } from 'node:path'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { HomeAuthError } from './errors.ts'

/**
 * Read the JSON value a store file holds.
 * @param path - the absolute path of the file.
 * @returns the parsed value, or undefined when the file does not exist.
 * @throws {HomeAuthError} `STORE_INVALID` when the file is refused, cannot be read or does not hold JSON; the message
 *   names the file's base name only, because a refusal reaches a client.
 */
export async function readStoreFile(path: string): Promise<unknown> {
  let bytes: Uint8Array
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (systemCode(error) === 'ENOENT') return undefined
    throw new HomeAuthError('STORE_INVALID', `${basename(path)} is not a protected file this home can read (${systemCode(error) ?? 'unreadable'})`)
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch {
    throw new HomeAuthError('STORE_INVALID', `${basename(path)} is not JSON`)
  }
}

/**
 * Write a store file atomically at mode 0600.
 * @param path - the absolute path of the file; its directory must exist.
 * @param value - the value to write as JSON with a trailing newline.
 * @throws the failure contract C1's write raises, such as `ENOENT` for a missing directory.
 */
export async function writeStoreFile(path: string, value: unknown): Promise<void> {
  await writeProtectedFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The operating system's error code of a failure, such as `ENOENT`.
 * @param error - the failure.
 * @returns the code, or undefined when the failure has none.
 */
function systemCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * Whether a value read from a file or a message is a plain object with string keys.
 * @param value - the value.
 * @returns whether it is such an object.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a finite number of milliseconds since the epoch.
 * @param value - the value.
 * @returns whether it is such a number.
 */
export function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
