/**
 * The `delorun-reach` row of a CLI profile (contract C7, "Configuration rows"): `delorun reach on` and `off`, setup's
 * reach section and the studio's phone access control write it into the profile's own `cordis.patch.yml`, and `delorun
 * reach status` reads it. A patch replaces the row's whole `config`, so every write restates the C16 switch `reach` and
 * the whole option.
 *
 * @module @delorun/setup-apply/reach-row
 */
import { existsSync, readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parse } from 'yaml'
import type { StudioAddress } from '@delorun/contract-admission'
import { ELEVATION_LIMITS } from '@delorun/contract-oidc-passkeys'
import { DEFAULT_SERVE_CHECK_INTERVAL_MS, DEFAULT_SERVE_PORT, LISTENER_PORT_RANGE, type ReachConfigRows } from '@delorun/contract-reach-providers'
import { REACH_PATHS } from '@delorun/home-auth'
import { chooseListenerPort, isPortFree } from '@delorun/reach'
import { setPatchRow } from './patch-file.ts'

/** The row's id in `@delorun/bundle-local`'s patch. */
export const REACH_ROW_ID = 'delorun-reach'

/** The Tailscale private option as the row holds it. */
export interface TailscalePrivateRow {
  readonly enabled: boolean
  readonly address: string
  readonly servePort: number
  /** The fixed port on `127.0.0.1` the serve target names; `0` until `delorun reach on tailscale` chooses one. */
  readonly listenerPort: number
  readonly serveCheckIntervalMs: number
  /** How many minutes sensitive actions stay unlocked on a device the person approves; the reach service checks the range. */
  readonly elevationMinutes: number
}

/** The option of a profile that has no row of its own: off. */
export const REACH_OFF: TailscalePrivateRow = { enabled: false, address: '', servePort: DEFAULT_SERVE_PORT, listenerPort: 0, serveCheckIntervalMs: DEFAULT_SERVE_CHECK_INTERVAL_MS, elevationMinutes: ELEVATION_LIMITS.defaultMinutes }

/**
 * Read the Tailscale private option from a profile patch file.
 * @param path - the profile's `cordis.patch.yml`.
 * @returns the option, or {@link REACH_OFF} when the file sets none.
 */
export function readReachRowAt(path: string): TailscalePrivateRow {
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
  const listenerPort: unknown = Reflect.get(option, 'listenerPort')
  const interval: unknown = Reflect.get(option, 'serveCheckIntervalMs')
  const elevationMinutes: unknown = Reflect.get(option, 'elevationMinutes')
  return {
    enabled: enabled === true,
    address: typeof address === 'string' ? address : '',
    servePort: typeof servePort === 'number' ? servePort : DEFAULT_SERVE_PORT,
    listenerPort: typeof listenerPort === 'number' ? listenerPort : 0,
    serveCheckIntervalMs: typeof interval === 'number' ? interval : DEFAULT_SERVE_CHECK_INTERVAL_MS,
    elevationMinutes: typeof elevationMinutes === 'number' ? elevationMinutes : ELEVATION_LIMITS.defaultMinutes,
  }
}

/**
 * Write the Tailscale private option into a profile patch file, with the C16 switch on.
 * @param path - the profile's `cordis.patch.yml`.
 * @param option - the option.
 */
export function writeReachRowAt(path: string, option: TailscalePrivateRow): void {
  setPatchRow(path, {
    id: REACH_ROW_ID,
    config: {
      enabled: true,
      tailscalePrivate: {
        enabled: option.enabled, address: option.address, servePort: option.servePort, listenerPort: option.listenerPort, serveCheckIntervalMs: option.serveCheckIntervalMs,
        elevationMinutes: option.elevationMinutes,
      },
    },
  })
}

/**
 * The sign-in page of a studio address, which a phone opens to ask for approval.
 * @param address - the option's studio address, as the row records it.
 * @returns `<address>/auth/sign-in`.
 */
export function signInAddress(address: string): string {
  return `${address.replace(/\/$/, '')}${REACH_PATHS.signIn}`
}

/**
 * The fixed listener port to record: the row's own, chosen once, unless it is unset or, while Delorun is stopped, another
 * program holds it; then a free port chosen at random from {@link LISTENER_PORT_RANGE}.
 * @param current - the row's `listenerPort`.
 * @param running - whether the profile's home runs, holding the row's port itself.
 * @returns the port.
 */
export async function listenerPortFor(current: number, running: boolean): Promise<number> {
  const valid = Number.isInteger(current) && current >= 1 && current <= 65_535
  if (valid && (running || await isPortFree(current))) return current
  return chooseListenerPort(LISTENER_PORT_RANGE)
}

/**
 * The reach service's rows of a profile's Tailscale private row.
 * @param row - the row, as {@link readReachRowAt} reads it.
 * @returns the rows the service resolves.
 */
export function reachRowsOf(row: TailscalePrivateRow): ReachConfigRows {
  return { tailscalePrivate: { ...row, address: brandString<StudioAddress>(row.address) } }
}
