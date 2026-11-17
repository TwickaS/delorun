/**
 * The `delorun-reach` row of a CLI profile (contract C7, "Configuration rows"): `delorun reach on` and `off` and setup's
 * reach section write it into the profile's own `cordis.patch.yml`, and `delorun reach status` reads it. A patch
 * replaces the row's whole `config`, so every write restates the C16 switch `reach` and the whole option.
 *
 * @module @delorun/cli/reach/row
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ELEVATION_LIMITS } from '@delorun/contract-oidc-passkeys'
import { DEFAULT_SERVE_CHECK_INTERVAL_MS, DEFAULT_SERVE_PORT, LISTENER_PORT_RANGE } from '@delorun/contract-reach-providers'
import { REACH_PATHS } from '@delorun/home-auth'
import { chooseListenerPort, isPortFree } from '@delorun/reach'
import { profileDirectory } from '../profile.ts'
import { setPatchRow } from '../setup/writes.ts'

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
 * The profile's patch file.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the path of its `cordis.patch.yml`.
 */
export function profilePatchPath(home: string, profile: string): string {
  return join(profileDirectory(home, profile), 'cordis.patch.yml')
}

/**
 * Read the Tailscale private option from the profile's own patch.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the option, or {@link REACH_OFF} when the profile sets none.
 */
export function readReachRow(home: string, profile: string): TailscalePrivateRow {
  return readReachRowAt(profilePatchPath(home, profile))
}

/**
 * The whole `config` of the `delorun-reach` row in the profile's own patch, as the file holds it: what the Loader gives
 * the row when no later layer sets it, since a patch replaces the row's whole `config`.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the config, or undefined when the file has no such row or the row no `config`.
 */
export function readReachRowConfig(home: string, profile: string): unknown {
  return reachRowConfigAt(profilePatchPath(home, profile))
}

/**
 * The whole `config` of the `delorun-reach` row in a profile patch file.
 * @param path - the profile's `cordis.patch.yml`.
 * @returns the config, or undefined when the file is missing, is not a list of rows, or has no such row with a `config`.
 */
function reachRowConfigAt(path: string): unknown {
  if (!existsSync(path)) return undefined
  const rows: unknown = parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) return undefined
  const list: readonly unknown[] = rows
  const row = list.find((entry): entry is object => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'id') === REACH_ROW_ID)
  return row === undefined ? undefined : Reflect.get(row, 'config')
}

/**
 * Read the Tailscale private option from a profile patch file.
 * @param path - the profile's `cordis.patch.yml`.
 * @returns the option, or {@link REACH_OFF} when the file sets none.
 */
export function readReachRowAt(path: string): TailscalePrivateRow {
  return reachOptionOf(reachRowConfigAt(path))
}

/**
 * The Tailscale private option of a `delorun-reach` row's config, each missing or mistyped field at its default.
 * @param config - the row's whole config, as {@link readReachRowConfig} reads it.
 * @returns the option, or {@link REACH_OFF} when the config sets none.
 */
export function reachOptionOf(config: unknown): TailscalePrivateRow {
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
 * Write the Tailscale private option into the profile's own patch, with the C16 switch on.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param option - the option.
 */
export function writeReachRow(home: string, profile: string, option: TailscalePrivateRow): void {
  writeReachRowAt(profilePatchPath(home, profile), option)
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
