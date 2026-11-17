/**
 * The load-failure lines of `delorun doctor`: the plugin rows that did not activate at the CLI profile's last start,
 * read from the home process's operational log (`home-<profile>`, contract C20).
 *
 * The home process captures its standard error into that log, one record per line with `source: 'captured'` and
 * `logger: 'stderr'`, and every record carries the start id of its process. The last start is the start id of the
 * newest record. After a start's tree settles, upstream's startup audit (`auditStartupEntries` in
 * `@deepseek-ai/dsh-app-boot`) writes `<bin>: warning: N entry|entries did not activate` to standard error, then one
 * line `<id> (<name>): <detail>` per row, each followed by the lines of its error's stack. The lines are read from the
 * last such warning of the last start; only the first line of a row's detail is reported.
 *
 * Upstream's hot-reload warnings are not read: a reload that leaves every row active writes nothing, so an earlier
 * reload warning cannot say whether the row still fails. A required row that did not activate stops the start with
 * an error that the log does not hold. A home with no logged start passes with a line that says so.
 *
 * @module @delorun/cli/doctor/last-start
 */
import { readLines, resolveSurface } from '@delorun/logs'
import { readableTime } from '../output.ts'
import type { CheckResult } from './checks.ts'

/** One row the startup audit reported. */
export interface InactiveRow {
  /** The row's Loader entry id. */
  readonly id: string
  /** The module the row loads: a package name or a path. */
  readonly name: string
  /** The first line of why it did not activate. */
  readonly detail: string
}

/** What the log holds about the last start. */
export interface LastStart {
  /** The start's id. */
  readonly startId: string
  /** The time of the oldest record of the start the log still holds. */
  readonly at: string
  /** The rows the start's last audit reported; empty when it reported none. */
  readonly inactive: readonly InactiveRow[]
}

/** The audit's first line: `activationDiagnostic` in `packages/boot/app-boot/src/index.ts`. */
const AUDIT_HEADER = /^\S+: warning: (\d+) (?:entry|entries) did not activate$/
/**
 * One row of the audit: `inactiveDiagnostic` in the same file, `<id> (<name>): <detail>`. The id excludes parentheses
 * and a trailing colon, so the first line of an error stack such as `Error: (x): y` is not read as a row.
 */
const AUDIT_ROW = /^([^\s()]*[^\s():]) \((.+?)\): (.*)$/

/**
 * The rows of the last startup audit among a start's standard-error lines.
 * @param lines - the lines, oldest first.
 * @returns the rows of the last audit, as many as its first line counts when the lines hold them all; `undefined` when
 *   no audit is among the lines.
 */
export function parseStartupAudit(lines: readonly string[]): InactiveRow[] | undefined {
  const header = lines.findLastIndex(line => AUDIT_HEADER.test(line))
  if (header === -1) return undefined
  const count = Number(AUDIT_HEADER.exec(lines[header]!)![1])
  const rows: InactiveRow[] = []
  for (const line of lines.slice(header + 1)) {
    if (rows.length === count) break
    const row = AUDIT_ROW.exec(line)
    if (row !== null) rows.push({ id: row[1]!, name: row[2]!, detail: row[3]! })
  }
  return rows
}

/**
 * Read the last start of the CLI profile's home process from its log.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the last start, or `undefined` when the log holds no record of one.
 * @throws {HomeLayoutError} when C1's refusal rule refuses the log's directory or a file of it.
 */
export function readLastStart(home: string, profile: string): LastStart | undefined {
  let startId: string | undefined
  let at = ''
  const lines = readLines(resolveSurface({ kind: 'home', home, profile }), Number.POSITIVE_INFINITY, ({ record }) => {
    if (record?.startId === undefined) return false
    // The lines arrive newest first, so the first start id seen is the last start's.
    startId ??= record.startId
    if (record.startId !== startId) return false
    at = record.ts
    return record.source === 'captured' && record.logger === 'stderr'
  })
  if (startId === undefined) return undefined
  const messages = lines.flatMap(line => line.record === undefined ? [] : [line.record.msg])
  return { startId, at, inactive: parseStartupAudit(messages) ?? [] }
}

/**
 * The load-failure lines: one `fail` line per row that did not activate at the last start, or one `pass` line when no
 * start is logged or the last one reported none.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the lines.
 * @throws {HomeLayoutError} when C1's refusal rule refuses the log's directory or a file of it.
 */
export function checkLastStart(home: string, profile: string): CheckResult[] {
  const start = readLastStart(home, profile)
  if (start === undefined) return [{ name: 'plugins', status: 'pass', message: `no start of the profile ${profile} is logged, so no plugin is known to have failed to load.` }]
  if (start.inactive.length === 0) return [{ name: 'plugins', status: 'pass', message: `the last start of the profile ${profile}, at ${readableTime(start.at)}, logged no plugin row that did not activate.` }]
  return start.inactive.map(row => ({
    name: 'plugin',
    subject: row.name,
    status: 'fail',
    message: `did not activate at the last start: ${row.detail} (row ${row.id}, start at ${readableTime(start.at)})`,
  }))
}
