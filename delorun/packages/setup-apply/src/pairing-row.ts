/**
 * The `pairing` choices of a profile's `delorun-home-auth` row (contract C5, "Pop-up pairing"): `delorun setup reach` and the studio's phone access control write
 * who may ask without an approval window, and `delorun reach status` reads the row and says who may ask.
 *
 * @module @delorun/setup-apply/pairing-row
 */
import { PAIRING_DEFAULTS, resolvePairing, type PairingConfig, type PairingSpec, type WindowlessMode } from '@delorun/home-auth'
import { readPatchRow, setPatchRow } from './patch-file.ts'
import { SetupApplyError } from './errors.ts'

/** The row's id in `@delorun/bundle-local`'s patch. */
export const HOME_AUTH_ROW_ID = 'delorun-home-auth'

/**
 * Read the pairing values a profile's patch sets.
 * @param path - the profile's `cordis.patch.yml`.
 * @returns the resolved values, Delorun's defaults where the profile sets none.
 * @throws {SetupApplyError} when the patch is not a patch list, or a value is out of bounds.
 */
export function readPairingAt(path: string): PairingSpec {
  const config = readPatchRow(path, HOME_AUTH_ROW_ID, 'delorun reach')
  const pairing: unknown = config?.['pairing']
  if (pairing === undefined) return PAIRING_DEFAULTS
  try {
    return resolvePairing(pairing as PairingConfig)
  } catch (error) {
    throw new SetupApplyError(`delorun reach: ${path} sets a pairing value Delorun refuses (${error instanceof Error ? error.message : String(error)}); fix it, then run the command again`)
  }
}

/**
 * Write who may ask without an approval window into a profile's patch, keeping the row's other pairing fields. The row
 * restates no `secretsDirectory`: the plugin takes the Delorun home's own when the row omits it.
 * @param path - the profile's `cordis.patch.yml`.
 * @param mayAskWithoutWindow - the mode.
 * @throws {SetupApplyError} when the file is not a YAML patch list; it is left unchanged.
 */
export function writeMayAskAt(path: string, mayAskWithoutWindow: WindowlessMode): void {
  const current = readPatchRow(path, HOME_AUTH_ROW_ID, 'delorun setup')?.['pairing']
  const others = typeof current === 'object' && current !== null && !Array.isArray(current) ? Object.fromEntries(Object.entries(current).filter(([key, value]) => key !== 'mayAskWithoutWindow' && ['string', 'number', 'boolean'].includes(typeof value))) : {}
  setPatchRow(path, { id: HOME_AUTH_ROW_ID, config: { pairing: { ...others, mayAskWithoutWindow } as Record<string, string | number | boolean> } })
}

/**
 * The home-auth secrets directory a profile's patch sets, if it sets one: the bundle and a hand-written row may name it,
 * and the CLI's own writes omit it, so the plugin takes the Delorun home's own.
 * @param path - the profile's `cordis.patch.yml`.
 * @returns the absolute directory the row names, or undefined when the row names none or a relative one.
 * @throws {SetupApplyError} when the patch is not a patch list.
 */
export function readSecretsDirectoryAt(path: string): string | undefined {
  const directory: unknown = readPatchRow(path, HOME_AUTH_ROW_ID, 'delorun reach')?.['secretsDirectory']
  return typeof directory === 'string' && directory.startsWith('/') ? directory : undefined
}
