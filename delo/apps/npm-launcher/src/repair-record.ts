/**
 * The home-level record that marks a `delorun repair` in progress: `run/repair.json`, written before the repair
 * changes anything and removed when it ends. A profile's home lock covers only a profile that has a run directory, so a
 * profile that is new while the repair runs would otherwise start the program being set aside. Every launcher start
 * reads this record first and refuses while its holder runs.
 *
 * The record names the repairing process (its id, start time and pid namespace) the way a home lock record does, so a
 * record left by a repair that was killed is told from a live one by {@link holderAlive}: it is reported and removed.
 *
 * @module @delo/npm-launcher/repair-record
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { currentHolder, holderAlive, parseHolder, type ProcessHolder } from '@delo/home'

/** The record's file name under the home's `run/`. */
export const REPAIR_RECORD_FILE = 'repair.json'

/** What a repair record names. */
export interface RepairRecord extends ProcessHolder {
  /** When the repair began, as an ISO 8601 time. */
  readonly startedAt: string
}

/** What looking at the record found. */
export type RepairRecordState =
  /** No repair is recorded. */
  | { readonly kind: 'none' }
  /** A repair runs: its process exists. */
  | { readonly kind: 'running', readonly record: RepairRecord }
  /** A record from a repair that no longer runs, which the check removed. */
  | { readonly kind: 'stale', readonly record: RepairRecord | undefined }

/**
 * The record's path.
 * @param home - the resolved Delo home.
 * @returns `<home>/run/repair.json`.
 */
export function repairRecordPath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.run, REPAIR_RECORD_FILE)
}

/**
 * Read the record.
 * @param home - the resolved Delo home.
 * @returns the record; `undefined` when there is none; `null` when the file is not a record.
 */
async function readRecord(home: string): Promise<RepairRecord | undefined | null> {
  let text: string
  try {
    text = await readFile(repairRecordPath(home), 'utf8')
  } catch (_absent) {
    // No file: no repair is recorded.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_notJson) {
    // A torn or foreign file names no running repair.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const fields = parsed as Record<string, unknown>
  const holder = parseHolder(fields)
  return holder === undefined || typeof fields.startedAt !== 'string' ? null : { ...holder, startedAt: fields.startedAt }
}

/**
 * Look at the record and remove it when its repair no longer runs.
 * @param home - the resolved Delo home.
 * @returns what was found; a `stale` record is already removed.
 */
export async function checkRepairRecord(home: string): Promise<RepairRecordState> {
  const record = await readRecord(home)
  if (record === undefined) return { kind: 'none' }
  if (record !== null && holderAlive(record)) return { kind: 'running', record }
  await rm(repairRecordPath(home), { force: true })
  return { kind: 'stale', record: record ?? undefined }
}

/**
 * Record that this process repairs the home, for as long as the returned function has not been called.
 * @param home - the resolved Delo home.
 * @param now - the clock.
 * @returns the state of a record found before this one (`stale` was removed) and the function that removes this record.
 * @throws {Error} when another repair runs; the record it wrote stays.
 */
export async function beginRepairRecord(home: string, now: Date): Promise<{ readonly found: RepairRecordState, readonly end: () => Promise<void> }> {
  const found = await checkRepairRecord(home)
  if (found.kind === 'running') throw new Error(`another repair runs (process ${String(found.record.pid)})`)
  await mkdir(join(home, DELO_HOME_ENTRIES.run), { recursive: true, mode: 0o700 })
  const record: RepairRecord = { ...currentHolder(), startedAt: now.toISOString() }
  // `wx` fails when a repair that started after the check wrote its record first.
  await writeFile(repairRecordPath(home), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
  return { found, end: () => rm(repairRecordPath(home), { force: true }) }
}

/**
 * The report for a record that {@link checkRepairRecord} found stale and removed.
 * @param record - the stale record, when it could be read.
 * @returns one sentence.
 */
export function staleRepairText(record: RepairRecord | undefined): string {
  return `A repair${record === undefined ? '' : ` that began ${record.startedAt}`} ended without finishing; its mark in run/${REPAIR_RECORD_FILE} is removed.`
}
