/**
 * The `delo-reach` row of a CLI profile (contract C7, "Configuration rows"): `delorun reach on` and `off` and setup's
 * reach section write it into the profile's own `cordis.patch.yml`, and `delorun reach status` reads it. A patch
 * replaces the row's whole `config`, so every write restates the C16 switch `reach` and the whole option.
 *
 * @module @delo/cli/reach/row
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DEFAULT_SERVE_PORT } from '@delo/contract-reach-providers'
import { profileDirectory } from '../profile.ts'
import { setPatchRow } from '../setup/writes.ts'

/** The row's id in `@delo/bundle-local`'s patch. */
export const REACH_ROW_ID = 'delo-reach'

/** The Tailscale private option as the row holds it. */
export interface TailscalePrivateRow {
  readonly enabled: boolean
  readonly address: string
  readonly servePort: number
}

/** The option of a profile that has no row of its own: off. */
export const REACH_OFF: TailscalePrivateRow = { enabled: false, address: '', servePort: DEFAULT_SERVE_PORT }

/**
 * The profile's patch file.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the path of its `cordis.patch.yml`.
 */
function patchPath(home: string, profile: string): string {
  return join(profileDirectory(home, profile), 'cordis.patch.yml')
}

/**
 * Read the Tailscale private option from the profile's own patch.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the option, or {@link REACH_OFF} when the profile sets none.
 */
export function readReachRow(home: string, profile: string): TailscalePrivateRow {
  const path = patchPath(home, profile)
  if (!existsSync(path)) return REACH_OFF
  const rows: unknown = parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) return REACH_OFF
  const list: readonly unknown[] = rows
  const row = list.find((entry): entry is object => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'id') === REACH_ROW_ID)
  const config: unknown = row === undefined ? undefined : Reflect.get(row, 'config')
  const option: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'tailscalePrivate') : undefined
  if (typeof option !== 'object' || option === null) return REACH_OFF
  const enabled: unknown = Reflect.get(option, 'enabled')
  const address: unknown = Reflect.get(option, 'address')
  const servePort: unknown = Reflect.get(option, 'servePort')
  return {
    enabled: enabled === true,
    address: typeof address === 'string' ? address : '',
    servePort: typeof servePort === 'number' ? servePort : DEFAULT_SERVE_PORT,
  }
}

/**
 * Write the Tailscale private option into the profile's own patch, with the C16 switch on.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param option - the option.
 */
export function writeReachRow(home: string, profile: string, option: TailscalePrivateRow): void {
  writeReachRowAt(patchPath(home, profile), option)
}

/**
 * Write the Tailscale private option into a profile patch file, with the C16 switch on.
 * @param path - the profile's `cordis.patch.yml`.
 * @param option - the option.
 */
export function writeReachRowAt(path: string, option: TailscalePrivateRow): void {
  setPatchRow(path, {
    id: REACH_ROW_ID,
    config: { enabled: true, tailscalePrivate: { enabled: option.enabled, address: option.address, servePort: option.servePort } },
  })
}
