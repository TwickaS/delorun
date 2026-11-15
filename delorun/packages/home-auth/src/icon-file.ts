/**
 * The home's one branding icon file. The theme row holds only the hash of the image; the bytes live in
 * `storages/delorun-theme/branding-icon` under the Delorun home, which the update's session-data copy already
 * includes (`storages/` is copied whole). A reader returns the bytes only when they hash to the row's hash, so a
 * file replaced behind the row's back, a row from another profile and a truncated write all show the default.
 * @module @delorun/home-auth/icon-file
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { checkImageBytes, ICON_MAX_BYTES, IMAGE_HASH, type ImageType } from '@delorun/brand/branding'

/** The path segments of the icon file under the Delorun home. */
export const ICON_FILE_SEGMENTS = ['storages', 'delorun-theme', 'branding-icon'] as const

/**
 * The SHA-256 of image bytes, as the row stores it.
 * @param bytes - the image.
 * @returns 64 lowercase hex digits.
 */
export function hashImage(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Check and store an uploaded image atomically as the home's icon file.
 * @param path - the icon file's path.
 * @param bytes - the request body.
 * @param declaredType - the content type the request declared, if any; it must match the first bytes.
 * @returns the image's hash and type, or a problem in plain words when the bytes are refused (nothing is written then).
 */
export function storeIcon(path: string, bytes: Uint8Array, declaredType: string | undefined): { readonly ok: true; readonly hash: string; readonly type: ImageType } | { readonly ok: false; readonly problem: string } {
  const checked = checkImageBytes(bytes, declaredType)
  if (!checked.ok) return checked
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return { ok: true, hash: hashImage(bytes), type: checked.type }
}

/**
 * Read the icon file for a hash.
 * @param path - the icon file's path, or undefined while the home path is unknown.
 * @param hash - the hash the theme row holds.
 * @returns the bytes when the file exists, is within the size limit and hashes to `hash`; otherwise undefined.
 */
export function readIcon(path: string | undefined, hash: string): Uint8Array | undefined {
  if (path === undefined || !IMAGE_HASH.test(hash)) return undefined
  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (_missing) {
    // No file, or one that cannot be read: the row's hash then matches nothing and the default shows.
    return undefined
  }
  return bytes.length <= ICON_MAX_BYTES && hashImage(bytes) === hash ? bytes : undefined
}
