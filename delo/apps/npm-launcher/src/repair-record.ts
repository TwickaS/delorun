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
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { currentHolder, holderAlive, parseHolder, type ProcessHolder } from '@delo/home'

/** The record's file name under the home's `run/`. */
export const REPAIR_RECORD_FILE = 'repair.json'

/** The environment variable that sets the grace in whole seconds. */
export const REPAIR_MARK_GRACE_ENV = 'DELORUN_REPAIR_MARK_GRACE_SECONDS'

/** The seconds an unparsable mark counts as a repair that is writing it, unless {@link REPAIR_MARK_GRACE_ENV} sets another. */
const DEFAULT_MARK_GRACE_SECONDS = 5

/** The longest {@link REPAIR_MARK_GRACE_ENV} may set. */
const MAX_MARK_GRACE_SECONDS = 60

/**
 * Resolve how long an unparsable mark counts as running.
 * @param raw - the environment variable's value; `undefined` or empty for the default of 5 seconds.
 * @returns whole seconds, 1 to 60.
 * @throws {Error} when the value is not a whole number of seconds in that range.
 */
export function resolveRepairMarkGraceSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MARK_GRACE_SECONDS
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_MARK_GRACE_SECONDS) throw new Error(`${REPAIR_MARK_GRACE_ENV} must be a whole number of seconds from 1 to ${String(MAX_MARK_GRACE_SECONDS)}, not ${raw}`)
  return seconds
}

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
  /** A file that is not a record yet and is younger than the grace: a repair is writing it, so it counts as running. */
  | { readonly kind: 'writing' }
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
 * Whether the file is younger than the grace.
 * @param home - the resolved Delo home.
 * @param graceSeconds - the grace, from {@link resolveRepairMarkGraceSeconds}.
 * @param nowMs - the clock, in milliseconds.
 * @returns `false` when the file is gone.
 */
async function youngerThan(home: string, graceSeconds: number, nowMs: number): Promise<boolean> {
  try {
    return nowMs - (await stat(repairRecordPath(home))).mtimeMs < graceSeconds * 1000
  } catch (_gone) {
    // Removed between the read and the stat: nothing marks a repair.
    return false
  }
}

/**
 * Look at the record and remove it when its repair no longer runs. A file that does not parse and is younger than the
 * grace is not removed: a repair that wrote it may be mid-write.
 * @param home - the resolved Delo home.
 * @param graceSeconds - how long an unparsable file counts as running.
 * @param nowMs - the clock, in milliseconds; this process's by default.
 * @returns what was found; a `stale` record is already removed.
 */
export async function checkRepairRecord(home: string, graceSeconds: number, nowMs: number = Date.now()): Promise<RepairRecordState> {
  const record = await readRecord(home)
  if (record === undefined) return { kind: 'none' }
  if (record !== null && holderAlive(record)) return { kind: 'running', record }
  if (record === null && await youngerThan(home, graceSeconds, nowMs)) return { kind: 'writing' }
  await rm(repairRecordPath(home), { force: true })
  return { kind: 'stale', record: record ?? undefined }
}

/**
 * Record that this process repairs the home, for as long as the returned function has not been called.
 * @param home - the resolved Delo home.
 * @param now - the clock.
 * @param graceSeconds - how long an unparsable file counts as running.
 * @returns the state of a record found before this one (`stale` was removed) and the function that removes this record.
 * @throws {Error} when another repair runs or is writing its mark.
 */
export async function beginRepairRecord(home: string, now: Date, graceSeconds: number): Promise<{ readonly found: RepairRecordState, readonly end: () => Promise<void> }> {
  const found = await checkRepairRecord(home, graceSeconds, now.getTime())
  if (found.kind === 'running') throw new Error(`another repair runs (process ${String(found.record.pid)})`)
  if (found.kind === 'writing') throw new Error('another repair is writing its mark')
  await mkdir(join(home, DELO_HOME_ENTRIES.run), { recursive: true, mode: 0o700 })
  const record: RepairRecord = { ...currentHolder(), startedAt: now.toISOString() }
  // Written whole under a temporary name, then linked: the mark's name is never a partial file, and `link` fails when a
  // repair that started after the check linked its own first.
  const temporary = `${repairRecordPath(home)}.tmp-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    await link(temporary, repairRecordPath(home))
  } finally {
    await rm(temporary, { force: true })
  }
  return { found, end: () => rm(repairRecordPath(home), { force: true }) }
}

/**
 * The report for a record that {@link checkRepairRecord} found stale and removed. It names the program store the
 * repair may have set aside, and the command that puts it back, because a repair killed during its download leaves the
 * new store half-filled.
 * @param record - the stale record, when it could be read.
 * @param home - the resolved Delo home.
 * @returns the report.
 */
export function staleRepairText(record: RepairRecord | undefined, home: string): string {
  const runtimes = join(home, DELO_HOME_ENTRIES.runtimes)
  return `A repair${record === undefined ? '' : ` that began ${record.startedAt}`} ended without finishing; its mark in run/${REPAIR_RECORD_FILE} is removed. If it was killed during its download, the old programs are in the newest folder named ${runtimes}.set-aside-*, and this puts them back: rm -rf "${runtimes}" && mv "$(ls -d "${runtimes}".set-aside-* | tail -n 1)" "${runtimes}". delorun recover status lists the folder.`
}
