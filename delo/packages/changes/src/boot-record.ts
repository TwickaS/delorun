/**
 * The record of which plugins under Changes loaded at the profile's last start, `run/<profile>/changes-boot.json`
 * (contract C1). The home process writes it after each start, from the Loader's rows or the start's failure, and
 * `delorun doctor` reads it to name a plugin that did not load and the change that touched it. It is a help for that
 * report and decides nothing: a start never reads it.
 *
 * The record is a protected file: written at mode 0600 by an atomic rename, and refused on read with
 * `RECORD_UNREADABLE` when another user could read it or when it is not a record Delo wrote.
 *
 * @module @delo/changes/boot-record
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delo/home'
import { ChangesError } from './errors.ts'
import { PACKAGE_NAME_PATTERN, readApproved, readChangeLog } from './records.ts'
import { compareCodeUnits } from './tree.ts'
import type { ApprovedRecord, ChangeLog } from './types.ts'

/** The record's file name under `run/<profile>/`. */
export const CHANGES_BOOT_FILE = 'changes-boot.json'

/** Schema tag of {@link BootRecord}. */
export const BOOT_RECORD_SCHEMA = 'delo.changes-boot/1'

/** How a Loader row's startup ended, as the start's audit reads it. */
export type BootRowState = 'active' | 'failed' | 'pending' | 'not-imported'

/** Every {@link BootRowState}. */
export const BOOT_ROW_STATES: readonly BootRowState[] = ['active', 'failed', 'pending', 'not-imported']

/** One Loader row of a booted profile, as the start reads it. */
export interface BootRow {
  /** The row's entry id. */
  readonly id: string
  /** The module the row imports. */
  readonly name: string
  /** Whether the row is disabled. */
  readonly disabled: boolean
  /** How its startup ended. */
  readonly state: BootRowState
}

/** One plugin under Changes at a start. */
export interface BootPlugin {
  /** The package name. */
  readonly plugin: string
  /** The rows whose module is the package or a path inside it, in the Loader's order. */
  readonly rows: readonly { readonly id: string, readonly state: BootRowState }[]
  /** Whether it has an enabled row and every enabled row became active. */
  readonly loaded: boolean
  /** Why it did not load, when the start booted and it did not. */
  readonly error?: string
}

/** The file `run/<profile>/changes-boot.json`. */
export interface BootRecord {
  readonly schema: typeof BOOT_RECORD_SCHEMA
  /** When the start booted or failed, ISO 8601. */
  readonly at: string
  /** Every plugin under Changes, by package name in code-unit order. */
  readonly plugins: readonly BootPlugin[]
  /** What the start failed with, when the profile did not boot; every plugin then has `loaded: false`. */
  readonly failure?: string
}

/** One plugin under Changes: approved, or waiting for review as an install. */
export interface ManagedPlugin {
  /** The package name. */
  readonly plugin: string
  /** The folder it is linked from. */
  readonly source: string
}

/**
 * The plugins under Changes: every approved plugin, and every plugin whose only record is a pending install.
 * @param approved - the profile's approved record.
 * @param log - the profile's change log.
 * @returns each plugin with its folder (the approved one, or the newest pending install's), by name in code-unit order.
 */
export function managedPlugins(approved: ApprovedRecord, log: ChangeLog): ManagedPlugin[] {
  const sources = new Map<string, string>()
  for (const entry of log.entries) {
    const { plugin, source } = entry.subject
    if (entry.kind === 'plugin-install' && entry.state === 'pending' && plugin !== undefined && source !== undefined) sources.set(plugin, source)
  }
  for (const [plugin, approval] of Object.entries(approved.plugins)) sources.set(plugin, approval.source)
  return [...sources].map(([plugin, source]) => ({ plugin, source })).sort((a, b) => compareCodeUnits(a.plugin, b.plugin))
}

/**
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the record's path.
 */
export function bootRecordPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), CHANGES_BOOT_FILE)
}

/** What a start reports for the record. */
export interface BootRecordRequest {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory, whose `package.json` holds the approved record. */
  readonly profileDir: string
  /** The Loader's rows after startup settled; empty when the profile did not boot. */
  readonly rows: readonly BootRow[]
  /** What the start failed with, when the profile did not boot. */
  readonly failure?: string
  /** The clock; `() => new Date()` by default. */
  readonly now?: () => Date
}

/**
 * @param plugin - a package name.
 * @param rows - the Loader's rows.
 * @param failed - whether the profile did not boot.
 * @returns the plugin's entry of the record.
 */
function bootPlugin(plugin: string, rows: readonly BootRow[], failed: boolean): BootPlugin {
  const own = rows.filter(row => row.name === plugin || row.name.startsWith(`${plugin}/`))
  const listed = own.map(({ id, state }) => ({ id, state }))
  if (failed) return { plugin, rows: listed, loaded: false }
  const enabled = own.filter(row => !row.disabled)
  const inactive = enabled.filter(row => row.state !== 'active')
  if (enabled.length > 0 && inactive.length === 0) return { plugin, rows: listed, loaded: true }
  const error = own.length === 0
    ? 'the profile has no row for it'
    : enabled.length === 0 ? 'every row of it is disabled' : inactive.map(row => `row ${row.id} is ${row.state}`).join(', ')
  return { plugin, rows: listed, loaded: false, error }
}

/**
 * Write the record of a start: for each plugin under Changes, its rows and whether it loaded. Creates
 * `run/<profile>/` at mode 0700 when it is missing.
 * @param request - the home, the profile, its directory, the Loader's rows or the failure, and the clock.
 * @returns the record written.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the profile's `package.json` or the change log is not one Delo wrote.
 */
export async function writeBootRecord(request: BootRecordRequest): Promise<BootRecord> {
  const { home, profile, profileDir, rows, failure } = request
  const plugins = managedPlugins(await readApproved(profileDir), await readChangeLog(home, profile))
  const record: BootRecord = {
    schema: BOOT_RECORD_SCHEMA,
    at: (request.now ?? (() => new Date()))().toISOString(),
    plugins: plugins.map(({ plugin }) => bootPlugin(plugin, rows, failure !== undefined)),
    ...failure === undefined ? {} : { failure },
  }
  await mkdir(runDirectory(home, profile), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(bootRecordPath(home, profile), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * @param path - the record's path.
 * @param detail - what is wrong with it.
 * @param cause - the underlying error.
 * @returns the refusal.
 */
function unreadable(path: string, detail: string, cause?: unknown): ChangesError {
  return new ChangesError('RECORD_UNREADABLE', path, `${path} is not a record Delo wrote: ${detail}.`, cause === undefined ? undefined : { cause })
}

/**
 * @param value - a parsed value.
 * @param keys - the fields it may have.
 * @param required - the fields it must have.
 * @returns whether it is a JSON object with only those fields and every required one.
 */
function hasFields(value: unknown, keys: readonly string[], required: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const fields = Object.keys(value)
  return fields.every(key => keys.includes(key)) && required.every(key => fields.includes(key))
}

/**
 * @param value - a parsed row.
 * @returns whether it is one of a {@link BootPlugin}'s rows.
 */
function isRow(value: unknown): boolean {
  return hasFields(value, ['id', 'state'], ['id', 'state']) && typeof value.id === 'string' && BOOT_ROW_STATES.includes(value.state as BootRowState)
}

/**
 * @param value - a parsed plugin entry.
 * @returns whether it is a {@link BootPlugin}.
 */
function isPlugin(value: unknown): boolean {
  return hasFields(value, ['plugin', 'rows', 'loaded', 'error'], ['plugin', 'rows', 'loaded'])
    && typeof value.plugin === 'string' && PACKAGE_NAME_PATTERN.test(value.plugin)
    && Array.isArray(value.rows) && (value.rows as readonly unknown[]).every(isRow)
    && typeof value.loaded === 'boolean'
    && (value.error === undefined || typeof value.error === 'string')
}

/**
 * @param value - a parsed record.
 * @returns whether it is a {@link BootRecord}.
 */
function isBootRecord(value: unknown): value is BootRecord {
  return hasFields(value, ['schema', 'at', 'plugins', 'failure'], ['schema', 'at', 'plugins'])
    && value.schema === BOOT_RECORD_SCHEMA
    && typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at))
    && Array.isArray(value.plugins) && (value.plugins as readonly unknown[]).every(isPlugin)
    && (value.failure === undefined || typeof value.failure === 'string')
}

/**
 * Read the record of the profile's last start.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the record, or undefined when no start has written one.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the file cannot be read, has a mode others can read, or is not a
 *   record Delo wrote.
 */
export async function readBootRecord(home: string, profile: string): Promise<BootRecord | undefined> {
  const path = bootRecordPath(home, profile)
  let text: string
  try {
    text = (await readProtectedFile(path)).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw unreadable(path, `it cannot be read (${String(error)})`, error)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw unreadable(path, 'it is not JSON', error)
  }
  if (!isBootRecord(value)) throw unreadable(path, `it is not a ${BOOT_RECORD_SCHEMA} record`)
  return value
}
