/**
 * The home-level record that marks a `delorun repair` in progress: `run/repair.json`, written before the repair
 * changes anything and removed when it ends. A profile's home lock covers only a profile that has a run directory, so a
 * profile that is new while the repair runs would otherwise start the program being set aside. Every launcher start
 * reads this record first and refuses while its holder runs.
 *
 * The record names the repairing process (its id, start time and pid namespace) the way a home lock record does, so a
 * record left by a repair that was killed is told from a live one by {@link holderAlive}: it is reported and removed.
 *
 * @module @delorun/npm-launcher/repair-record
 */
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { runtimesSetAsideName } from '@delorun/update/home-data'
import { currentHolder, holderAlive, parseHolder, type ProcessHolder } from '@delorun/home'

/** The record's file name under the home's `run/`. */
export const REPAIR_RECORD_FILE = 'repair.json'

/** The environment variable that sets the grace in whole seconds. */
export const REPAIR_MARK_GRACE_ENV = 'DELORUN_REPAIR_MARK_GRACE_SECONDS'

/** The seconds an unparsable mark counts as a repair that is writing it, unless {@link REPAIR_MARK_GRACE_ENV} sets another. */
const DEFAULT_MARK_GRACE_SECONDS = 5

/** How often {@link checkRepairRecord} looks again after the mark changed under it. */
const CHECK_ATTEMPTS = 5

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
  /** The absolute path the repair sets the old program store aside to; written before the move, so it may not exist. */
  readonly setAside?: string
  /** The absolute path `repair --reset-trust` sets the old trust records aside to; written before the move, so it may not exist. */
  readonly trustSetAside?: string
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
 * @param home - the resolved Delorun home.
 * @returns `<home>/run/repair.json`.
 */
export function repairRecordPath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.run, REPAIR_RECORD_FILE)
}

/** The mark as read: its exact text, and what the text names. */
interface ReadMark {
  /** The file's bytes as text, which {@link removeUnchanged} compares before it removes the file. */
  readonly text: string
  /** The record; `null` when the file is not a record. */
  readonly record: RepairRecord | null
}

/**
 * Read the record.
 * @param home - the resolved Delorun home.
 * @returns the mark; `undefined` when there is none.
 */
async function readMark(home: string): Promise<ReadMark | undefined> {
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
    return { text, record: null }
  }
  if (typeof parsed !== 'object' || parsed === null) return { text, record: null }
  const fields = parsed as Record<string, unknown>
  const holder = parseHolder(fields)
  if (holder === undefined || typeof fields.startedAt !== 'string') return { text, record: null }
  return { text, record: { ...holder, startedAt: fields.startedAt, ...typeof fields.setAside === 'string' ? { setAside: fields.setAside } : {}, ...typeof fields.trustSetAside === 'string' ? { trustSetAside: fields.trustSetAside } : {} } }
}

/**
 * Remove the mark only when it still holds the text that was read. A repair that started after that read replaces the
 * file with its own mark, which must stay.
 *
 * A read followed by a remove leaves a gap in which a repair can link its own mark, so the removal claims the file
 * first: it moves the file to a name of its own with `rename`, which is atomic, and compares what it moved. A match is
 * removed. A mismatch is a newer mark, which goes back with `link`: `link` fails when a later mark already sits at the
 * path, and then that later mark stays and the moved one is dropped. The mark is absent from its path only between the
 * move and the link, and only when the file changed after the read above, which is the case this guards.
 * @param home - the resolved Delorun home.
 * @param text - the mark's text as the caller read or wrote it.
 * @returns `true` when the file is gone, `false` when it holds other text and was left.
 */
async function removeUnchanged(home: string, text: string): Promise<boolean> {
  const path = repairRecordPath(home)
  const now = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (now === undefined) return true
  // Most changes are seen here, and leave the mark in place.
  if (now !== text) return false
  const claimed = `${path}.claim-${randomBytes(8).toString('hex')}`
  try {
    await rename(path, claimed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  let moved: string
  try {
    moved = await readFile(claimed, 'utf8')
  } catch (error) {
    // The claim is the only copy of whichever mark was there: it goes back before the error is raised.
    await putBack(claimed, path).catch(() => undefined)
    throw error
  }
  if (moved === text) {
    await rm(claimed, { force: true })
    return true
  }
  // A newer mark was in the path when it was claimed: put it back, and once more if that failed, before the error is raised.
  try {
    await putBack(claimed, path)
  } catch (error) {
    await putBack(claimed, path).catch(() => undefined)
    throw error
  }
  return false
}

/**
 * Put a claimed mark back at the mark's path with `link`, which fails when a mark is there, and drop the claim.
 * @param claimed - the unique name the mark was moved to.
 * @param path - the mark's path.
 * @throws {Error} when `link` fails other than because a newer mark is there; the claim is then left in place.
 */
async function putBack(claimed: string, path: string): Promise<void> {
  try {
    await link(claimed, path)
  } catch (error) {
    // EEXIST: a newer mark than the claimed one sits at the path. It wins.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await rm(claimed, { force: true })
}

/**
 * Whether the file is younger than the grace.
 * @param home - the resolved Delorun home.
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
 * @param home - the resolved Delorun home.
 * @param graceSeconds - how long an unparsable file counts as running.
 * @param nowMs - the clock, in milliseconds; this process's by default.
 * @returns what was found; a `stale` record is already removed.
 */
export async function checkRepairRecord(home: string, graceSeconds: number, nowMs: number = Date.now()): Promise<RepairRecordState> {
  // A mark that changes between the read and the removal belongs to a repair that started meanwhile; it is looked at again.
  for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt++) {
    const mark = await readMark(home)
    if (mark === undefined) return { kind: 'none' }
    const { record } = mark
    if (record !== null && holderAlive(record)) return { kind: 'running', record }
    if (record === null && await youngerThan(home, graceSeconds, nowMs)) return { kind: 'writing' }
    if (await removeUnchanged(home, mark.text)) return { kind: 'stale', record: record ?? undefined }
  }
  // The mark kept changing under the check: a repair is starting.
  return { kind: 'writing' }
}

/**
 * Record that this process repairs the home, for as long as the returned function has not been called.
 * @param home - the resolved Delorun home.
 * @param now - the clock.
 * @param graceSeconds - how long an unparsable file counts as running.
 * @returns the state of a record found before this one (`stale` was removed), the function that removes this record, and the
 *   functions that add the path the old program store and the old trust records are set aside to.
 * @throws {Error} when another repair runs or is writing its mark.
 */
export async function beginRepairRecord(home: string, now: Date, graceSeconds: number): Promise<{ readonly found: RepairRecordState, readonly end: () => Promise<void>, readonly noteSetAside: (path: string) => Promise<void>, readonly noteTrustSetAside: (path: string) => Promise<void> }> {
  const found = await checkRepairRecord(home, graceSeconds, now.getTime())
  if (found.kind === 'running') throw new Error(`another repair runs (process ${String(found.record.pid)})`)
  if (found.kind === 'writing') throw new Error('another repair is writing its mark')
  await mkdir(join(home, DELORUN_HOME_ENTRIES.run), { recursive: true, mode: 0o700 })
  const record: RepairRecord = { ...currentHolder(), startedAt: now.toISOString() }
  // The text this process last wrote to the mark; `end` removes the mark only while it still holds that text.
  let written = `${JSON.stringify(record)}\n`
  // Written whole under a temporary name, then linked: the mark's name is never a partial file, and `link` fails when a
  // repair that started after the check linked its own first.
  const temporary = `${repairRecordPath(home)}.tmp-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(temporary, written, { flag: 'wx', mode: 0o600 })
    await link(temporary, repairRecordPath(home))
  } finally {
    await rm(temporary, { force: true })
  }
  // What the mark names so far; each note rewrites the whole mark, so a later note keeps an earlier one.
  let named: RepairRecord = record
  const note = async (fields: Partial<Pick<RepairRecord, 'setAside' | 'trustSetAside'>>): Promise<void> => {
    const rewritten = `${repairRecordPath(home)}.tmp-${randomBytes(8).toString('hex')}`
    const next = { ...named, ...fields }
    const text = `${JSON.stringify(next)}\n`
    try {
      await writeFile(rewritten, text, { flag: 'wx', mode: 0o600 })
      await rename(rewritten, repairRecordPath(home))
      written = text
      named = next
    } finally {
      await rm(rewritten, { force: true })
    }
  }
  return { found, end: async () => { await removeUnchanged(home, written) }, noteSetAside: path => note({ setAside: path }), noteTrustSetAside: path => note({ trustSetAside: path }) }
}

/**
 * The name `repair --reset-trust` gives the trust records it sets aside, and the restore command of a stale mark gives the
 * new ones it moves aside in their place.
 * @param time - the compact UTC time from {@link stamp}.
 * @param ordinal - a number that tells a second folder of the same second from the first; none for the first.
 * @returns `trust.set-aside-<time>`, with `-<ordinal>` when one is given.
 */
export function trustSetAsideName(time: string, ordinal?: number): string {
  return `${DELORUN_HOME_ENTRIES.trust}.set-aside-${time}${ordinal === undefined ? '' : `-${String(ordinal)}`}`
}

/** A time as the compact UTC stamp that names a set-aside directory. */
export function stamp(time: Date): string {
  return time.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
}

/** The characters PowerShell reads as a single quote: the ASCII one and U+2018 to U+201B. */
const POWERSHELL_QUOTE = /['\u2018\u2019\u201A\u201B]/gu

/**
 * Quote a path as one literal word of the person's shell.
 * @param path - the path.
 * @param platform - `win32` for PowerShell, anything else for a POSIX shell.
 * @returns the path in single quotes, with each single quote inside (including U+2018 to U+201B) doubled for PowerShell or written `'\''` for POSIX, so
 *   `$`, double quotes and backticks stay literal.
 */
export function quoteForShell(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `'${path.replaceAll(POWERSHELL_QUOTE, '$&$&')}'` : `'${path.replaceAll("'", "'\\''")}'`
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/**
 * The report for a record that {@link checkRepairRecord} found stale and removed. It names the program store the
 * repair set aside and a command that puts it back, only when the record names that folder and it still exists. The
 * command never deletes: it moves the current store to a new folder next to it, then moves the set-aside folder back.
 * @param record - the stale record, when it could be read.
 * @param home - the resolved Delorun home.
 * @param now - the clock, which names the folder the current store moves to.
 * @param platform - the person's platform, which picks the shell the command is written for.
 * @returns the report.
 */
export async function staleRepairText(record: RepairRecord | undefined, home: string, now: Date = new Date(), platform: NodeJS.Platform = process.platform): Promise<string> {
  const lead = `A repair${record === undefined ? '' : ` that began ${record.startedAt}`} ended without finishing; its mark in run/${REPAIR_RECORD_FILE} is removed.`
  const setAside = record?.setAside !== undefined && await exists(record.setAside) ? record.setAside : undefined
  const trustSetAside = record?.trustSetAside !== undefined && await exists(record.trustSetAside) ? record.trustSetAside : undefined
  if (setAside === undefined && trustSetAside === undefined) {
    return `${lead} No set-aside folder of the old programs was recorded, so there is nothing to put back. Run delorun repair again.`
  }
  const move = (from: string, to: string): string => (platform === 'win32' ? `Move-Item -LiteralPath ${from} -Destination ${to}` : `mv ${from} ${to}`)
  const joinSteps = (steps: readonly string[]): string => steps.join(platform === 'win32' ? '; ' : ' && ')
  const parts = [lead]
  if (setAside !== undefined) {
    const runtimes = join(home, DELORUN_HOME_ENTRIES.runtimes)
    // Ordinal 1 keeps it apart from the repair's own set-aside, which may carry the same second; `recover status` lists both.
    const unfinished = runtimesSetAsideName(stamp(now), 1)
    const quoted = { runtimes: quoteForShell(runtimes, platform), setAside: quoteForShell(setAside, platform), unfinished: quoteForShell(join(home, unfinished), platform) }
    const steps = [...await exists(runtimes) ? [move(quoted.runtimes, quoted.unfinished)] : [], move(quoted.setAside, quoted.runtimes)]
    parts.push(`If it was killed during its download, the old programs are in ${setAside}, and this puts them back, keeping the unfinished store in ${unfinished}: ${joinSteps(steps)}. delorun recover status lists the folders.`)
  }
  if (trustSetAside !== undefined) {
    const trust = join(home, DELORUN_HOME_ENTRIES.trust)
    const unfinished = trustSetAsideName(stamp(now), 1)
    const quoted = { trust: quoteForShell(trust, platform), setAside: quoteForShell(trustSetAside, platform), unfinished: quoteForShell(join(home, unfinished), platform) }
    const steps = [...await exists(trust) ? [move(quoted.trust, quoted.unfinished)] : [], move(quoted.setAside, quoted.trust)]
    parts.push(`The trust records it set aside for --reset-trust are in ${trustSetAside}, and this puts them back, keeping the new ones in ${unfinished}: ${joinSteps(steps)}. delorun recover status does not list trust folders.`)
  }
  return parts.join(' ')
}
