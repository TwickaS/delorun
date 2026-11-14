/**
 * Retention of C20's process logs: the age check, which deletes each file of a surface whose oldest record is older
 * than 14 days, and the clear effect that `delorun logs --clear` and purge's offer run. Only a surface's own files
 * (`<name>.log` and `<name>.log.<n>` in its directory) and upstream's `logs/startup-*.log` reports are ever deleted
 * or emptied; session logs under `sessions/` are never read, rotated or deleted.
 *
 * @module @delorun/logs/retention
 */
import { AGE_CHECK_INTERVAL_MS, RECORD_MAX_BYTES, RETENTION_MS } from '@delorun/contract-operational-logs'
import { closeSync, constants, ftruncateSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { checkPrivateDirectorySync } from '@delorun/home'
import { isLogsFailure, LogsError, type LogsFailure } from './errors.ts'
import { checkedLogFile, lstatOrMissing, rotatedFile, rotatedIndex, surfaceOfDirectory, type SurfaceLocation } from './files.ts'
import { rotateFiles } from './writer.ts'

/** A surface's files that exist, newest first: the active file, then `.1` upward. */
export interface SurfaceFiles {
  /** The active file, when it exists. */
  readonly active?: string
  /** Rotated files by index, ascending. */
  readonly rotated: readonly { readonly index: number; readonly path: string }[]
}

/** What an age check or a clear did. */
export interface RetentionReport {
  /** Files deleted. */
  readonly deleted: readonly string[]
  /** Active files emptied in place. */
  readonly emptied: readonly string[]
  /** Surfaces or files that were refused or failed, which were left as they were. */
  readonly failures: readonly LogsFailure[]
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

function failureOf(error: unknown, path: string): LogsFailure {
  return isLogsFailure(error) ? error : new LogsError('LOG_WRITE_FAILED', `${path} could not be changed`, path, { cause: error })
}

/**
 * The files of a surface, after C1's refusal rule on its directory.
 * @param location - the surface.
 * @returns the files that exist; none when the directory does not exist.
 * @throws {HomeLayoutError} `HOME_MODE` when the directory is refused.
 */
export function surfaceFiles(location: SurfaceLocation): SurfaceFiles {
  if (lstatOrMissing(location.dir) === undefined) return { rotated: [] }
  checkPrivateDirectorySync(location.dir)
  const rotated: { index: number; path: string }[] = []
  let active: string | undefined
  for (const name of readdirSync(location.dir)) {
    if (join(location.dir, name) === location.file) active = location.file
    const index = rotatedIndex(location, name)
    if (index !== undefined) rotated.push({ index, path: rotatedFile(location, index) })
  }
  rotated.sort((a, b) => a.index - b.index)
  return { ...active === undefined ? {} : { active }, rotated }
}

/**
 * The time of a log file's oldest record: its first line's `ts`. When the first line holds no readable time, the
 * earlier of the file's birth and modification times stands in, so an unreadable file still ages.
 * @param path - the file.
 * @returns milliseconds since the epoch, or `undefined` for an empty file.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when C1's refusal rule refuses the file.
 */
export function oldestRecordTime(path: string): number | undefined {
  const stats = checkedLogFile(path)
  if (stats === undefined) return undefined
  if (stats.size === 0) return undefined
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  const buffer = Buffer.alloc(Math.min(stats.size, RECORD_MAX_BYTES))
  let length: number
  try {
    length = readSync(fd, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(fd)
  }
  const text = buffer.subarray(0, length).toString('utf8')
  const newline = text.indexOf('\n')
  const ts = parseTime(newline === -1 ? text : text.slice(0, newline))
  if (ts !== undefined) return ts
  return stats.birthtimeMs > 0 ? Math.min(stats.birthtimeMs, stats.mtimeMs) : stats.mtimeMs
}

function parseTime(line: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (_error: unknown) {
    // Not a JSON line: the caller falls back to the file's own times.
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('ts' in value) || typeof value.ts !== 'string') return undefined
  const time = Date.parse(value.ts)
  return Number.isNaN(time) ? undefined : time
}

function expired(path: string, now: number): boolean {
  const oldest = oldestRecordTime(path)
  return oldest !== undefined && now - oldest > RETENTION_MS
}

/**
 * The age check over one surface: delete each rotated file whose oldest record is older than 14 days, and an expired
 * active file after rotating it, so a writer that holds it continues in a new active file.
 * @param location - the surface.
 * @param now - the time of the check.
 * @returns the files deleted and any failure; a missing directory has nothing to delete.
 */
export function pruneSurface(location: SurfaceLocation, now: number): RetentionReport {
  const deleted: string[] = []
  const failures: LogsFailure[] = []
  let files: SurfaceFiles
  try {
    files = surfaceFiles(location)
  } catch (error: unknown) {
    return { deleted, emptied: [], failures: [failureOf(error, location.dir)] }
  }
  for (const { path } of files.rotated) {
    try {
      if (expired(path, now)) {
        unlinkSync(path)
        deleted.push(path)
      }
    } catch (error: unknown) {
      failures.push(failureOf(error, path))
    }
  }
  if (files.active !== undefined) {
    try {
      if (expired(files.active, now)) {
        rotateFiles(location)
        const rotated = rotatedFile(location, 1)
        unlinkSync(rotated)
        deleted.push(files.active)
      }
    } catch (error: unknown) {
      failures.push(failureOf(error, files.active))
    }
  }
  return { deleted, emptied: [], failures }
}

/**
 * Every local surface under a home's `logs/` directory: each `home-<profile>`, `supervisor-<profile>` and
 * `desktop-host` directory found there.
 * @param home - the Delorun home.
 * @returns their locations, sorted by surface name.
 */
export function localSurfaces(home: string): SurfaceLocation[] {
  const logs = join(home, 'logs')
  if (lstatOrMissing(logs) === undefined) return []
  if (logsRootRefusal(home) !== undefined) return []
  return readdirSync(logs, { withFileTypes: true })
    .filter(entry => !entry.isFile())
    .map(entry => surfaceOfDirectory(home, entry.name))
    .filter(location => location !== undefined)
    .sort((a, b) => a.surface.localeCompare(b.surface))
}

/**
 * C1's refusal of the home's `logs` directory, or `undefined` when it is a directory of its own. A symbolic link
 * planted in its place would send every read, empty and delete of the age check and the clear effect wherever it
 * points, so both report the refusal and touch nothing under it.
 * @param home - the Delorun home.
 * @returns the refusal, or `undefined` when the directory is absent or private.
 */
function logsRootRefusal(home: string): LogsFailure | undefined {
  const logs = join(home, 'logs')
  if (lstatOrMissing(logs) === undefined) return undefined
  try {
    checkPrivateDirectorySync(logs)
    return undefined
  } catch (error: unknown) {
    return isLogsFailure(error) ? error : failureOf(error, logs)
  }
}

function merge(reports: readonly RetentionReport[]): RetentionReport {
  return {
    deleted: reports.flatMap(report => report.deleted),
    emptied: reports.flatMap(report => report.emptied),
    failures: reports.flatMap(report => report.failures),
  }
}

/**
 * The age check over every local surface of a home and upstream's startup reports, which every Delorun process runs as
 * it starts and `delorun logs --prune` runs on demand; the logs of a stopped process are pruned too.
 * @param home - the Delorun home.
 * @param now - the time of the check.
 * @returns the files deleted and any failure; a refused surface is reported and the others are still pruned.
 */
export function pruneLocalSurfaces(home: string, now: number): RetentionReport {
  const refusal = logsRootRefusal(home)
  if (refusal !== undefined) return { deleted: [], emptied: [], failures: [refusal] }
  return merge([...localSurfaces(home).map(location => pruneSurface(location, now)), pruneStartupReports(home, now)])
}

/** The options of {@link startAgeChecks}. */
export interface AgeCheckOptions {
  /** The Delorun home whose local surfaces are checked. */
  readonly home: string
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
  /** Receives each check's report, such as to log what was deleted and what was refused. */
  readonly onReport: (report: RetentionReport) => void
}

/**
 * Run the age check now and every 3,600 seconds while the process runs. The interval does not keep the process
 * alive.
 * @param options - the home, the clock and where reports go.
 * @returns a disposer that stops the checks.
 */
export function startAgeChecks(options: AgeCheckOptions): () => void {
  const check = (): void => { options.onReport(pruneLocalSurfaces(options.home, options.now())) }
  check()
  const timer = setInterval(check, AGE_CHECK_INTERVAL_MS)
  timer.unref()
  return () => { clearInterval(timer) }
}

/**
 * The clear effect over one surface: delete its rotated files and empty its active file in place, so a running
 * writer continues in the emptied file.
 * @param location - the surface.
 * @returns what was deleted and emptied, and any failure.
 */
export function clearSurface(location: SurfaceLocation): RetentionReport {
  const deleted: string[] = []
  const emptied: string[] = []
  const failures: LogsFailure[] = []
  let files: SurfaceFiles
  try {
    files = surfaceFiles(location)
  } catch (error: unknown) {
    return { deleted, emptied, failures: [failureOf(error, location.dir)] }
  }
  for (const { path } of files.rotated) {
    try {
      unlinkSync(path)
      deleted.push(path)
    } catch (error: unknown) {
      failures.push(failureOf(error, path))
    }
  }
  if (files.active !== undefined) {
    const path = files.active
    try {
      // `surfaceFiles` listed it, so `lstat` finds it unless it was removed since; then there is nothing to empty.
      if (checkedLogFile(path) !== undefined) {
        const fd = openSync(path, constants.O_WRONLY | NO_FOLLOW)
        try {
          ftruncateSync(fd, 0)
        } finally {
          closeSync(fd)
        }
        emptied.push(path)
      }
    } catch (error: unknown) {
      failures.push(failureOf(error, path))
    }
  }
  return { deleted, emptied, failures }
}

/**
 * Upstream's startup reports under a home: the regular files `logs/startup-*.log`, which upstream's `dsh` entry
 * writes and which may hold credential values.
 * @param home - the Delorun home.
 * @returns their paths, sorted.
 */
export function startupReports(home: string): string[] {
  const logs = join(home, 'logs')
  if (lstatOrMissing(logs) === undefined) return []
  return readdirSync(logs, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^startup-.*\.log$/.test(entry.name))
    .map(entry => join(logs, entry.name))
    .sort()
}

/**
 * Delete upstream's startup reports, as `delorun logs --clear startup` and purge's offer do.
 * @param home - the Delorun home.
 * @returns the reports deleted and any failure.
 */
export function clearStartupReports(home: string): RetentionReport {
  const deleted: string[] = []
  const failures: LogsFailure[] = []
  for (const path of startupReports(home)) {
    try {
      unlinkSync(path)
      deleted.push(path)
    } catch (error: unknown) {
      failures.push(failureOf(error, path))
    }
  }
  return { deleted, emptied: [], failures }
}

/**
 * Delete upstream's startup reports that are older than the retention window. A report holds no records of its own,
 * so its age is the file's own last write, the same fallback the age check takes for a surface file whose records
 * carry no time. Without this pass a report upstream wrote once stays for the life of the home, which is why the age
 * check reaches them too.
 * @param home - the Delorun home.
 * @param now - the time of the check.
 * @returns the reports deleted and any failure.
 */
export function pruneStartupReports(home: string, now: number): RetentionReport {
  const deleted: string[] = []
  const failures: LogsFailure[] = []
  for (const path of startupReports(home)) {
    try {
      if (now - statSync(path).mtimeMs < RETENTION_MS) continue
      unlinkSync(path)
      deleted.push(path)
    } catch (error: unknown) {
      failures.push(failureOf(error, path))
    }
  }
  return { deleted, emptied: [], failures }
}

/**
 * The clear effect over every local surface and upstream's startup reports, which `delorun logs --clear` without a
 * surface and purge's offer run, because captured records do not always carry a session id.
 * @param home - the Delorun home.
 * @returns everything deleted and emptied, and any failure.
 */
export function clearLocalLogs(home: string): RetentionReport {
  const refusal = logsRootRefusal(home)
  if (refusal !== undefined) return { deleted: [], emptied: [], failures: [refusal] }
  return merge([...localSurfaces(home).map(clearSurface), clearStartupReports(home)])
}
