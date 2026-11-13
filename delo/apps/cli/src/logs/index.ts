/**
 * `delorun logs` (contract C20): each operational log's location, size and oldest record, the recent records of a
 * surface with filters, following new records across rotations, the stored JSON, the active file's path, the clear
 * effect after confirmation, and the age check on demand. The command's router supplies the resolved Delo home and
 * the active profile ([C1](../../../../docs/contracts/c01-home-layout.md)).
 *
 * @module @delo/cli/logs
 */
import { CLI_SURFACES, DEFAULT_TAIL_RECORDS, MAX_TAIL_RECORDS, SURFACE_FILES, UPSTREAM_STARTUP_REPORTS, type LogRecord } from '@delo/contract-operational-logs'
import {
  checkProfile,
  clearLocalLogs,
  clearStartupReports,
  clearSurface,
  followLines,
  localSurfaces,
  isLogsFailure,
  oldestRecordTime,
  pruneLocalSurfaces,
  readLines,
  resolveSurface,
  startupReports,
  surfaceFiles,
  type RetentionReport,
  type StoredLine,
  type SurfaceLocation,
} from '@delo/logs'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseFailure } from '../command.ts'
import { CliError } from '../exit.ts'

/** What `delorun logs` reads and writes through, supplied by the command's router. */
export interface LogsIo {
  /** The resolved Delorun home. */
  readonly home: string
  /** The active CLI profile; `--profile` overrides it. */
  readonly profile: string
  /** Standard output. */
  readonly stdout: (text: string) => void
  /** Standard error. */
  readonly stderr: (text: string) => void
  /** Asks the person to confirm the clear; resolves `false` when they decline or cannot be asked. */
  readonly confirm: (question: string) => Promise<boolean>
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
  /** Ends `--follow`. */
  readonly signal: AbortSignal
}

/** The exit codes of `delorun logs`: done, failed or declined, and a usage error. */
export type LogsExit = 0 | 1 | 2

/** A surface name `delorun logs` accepts. */
export type CliSurface = typeof CLI_SURFACES[number]

/** The usage of `delorun logs`. */
export const LOGS_USAGE = `Usage: delorun logs [<surface>] [-n <count>] [--follow] [--since <duration>] [--session <id>] [--turn <n>] [--json]
       delorun logs [<surface>] --path
       delorun logs --clear [<surface>]
       delorun logs --prune

Surfaces: ${CLI_SURFACES.join(', ')}. Without a surface, lists every log and shows the home process's recent records.
Durations: a number and s, m, h or d, such as 30m or 2d. --profile <name> selects another CLI profile's logs.
`

/** Upstream's own warning about its startup reports. */
const STARTUP_WARNING = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.'

/** The interval at which `--follow` checks the active file, in milliseconds. */
const FOLLOW_INTERVAL_MS = 250

const DURATION = /^([1-9][0-9]*)(s|m|h|d)$/
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** A usage error: exit code 2. */
class UsageError extends Error {
  override readonly name = 'UsageError'
}

interface Options {
  readonly surface: CliSurface | undefined
  readonly count: number
  readonly follow: boolean
  readonly since: number | undefined
  readonly session: string | undefined
  readonly turn: number | undefined
  readonly json: boolean
  readonly path: boolean
  readonly clear: boolean
  readonly prune: boolean
  readonly profile: string
}

function isSurface(value: string): value is CliSurface {
  return (CLI_SURFACES as readonly string[]).includes(value)
}

/** Parse the arguments with `node:util`'s parser. */
function parseOptions(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      n: { type: 'string', short: 'n' },
      follow: { type: 'boolean' },
      since: { type: 'string' },
      session: { type: 'string' },
      turn: { type: 'string' },
      json: { type: 'boolean' },
      path: { type: 'boolean' },
      clear: { type: 'boolean' },
      prune: { type: 'boolean' },
      profile: { type: 'string' },
    },
  })
}

/** Parse and check the arguments, resolving each default. */
function resolveOptions(argv: readonly string[], io: LogsIo): Options {
  let parsed
  try {
    parsed = parseOptions(argv)
  } catch (error: unknown) {
    const failure = parseFailure('logs', error)
    // The usage text follows the message, so the message does not point to it.
    if (failure instanceof CliError) throw new UsageError(failure.message.replace(/^delorun logs: /, '').replace(/\. Run delorun logs --help for usage\.$/, ''))
    throw failure
  }
  const { values, positionals } = parsed
  if (positionals.length > 1) throw new UsageError(`expected at most one surface, got ${positionals.join(' ')}`)
  const name = positionals[0]
  if (name !== undefined && !isSurface(name)) throw new UsageError(`unknown surface "${name}"; use one of ${CLI_SURFACES.join(', ')}`)
  const count = values.n === undefined ? DEFAULT_TAIL_RECORDS : Number(values.n)
  if (!Number.isInteger(count) || count < 1 || count > MAX_TAIL_RECORDS) throw new UsageError(`-n takes a whole number from 1 to ${String(MAX_TAIL_RECORDS)}`)
  let since: number | undefined
  if (values.since !== undefined) {
    const match = DURATION.exec(values.since)
    if (match === null) throw new UsageError(`--since takes a duration such as 30m or 2d, not "${values.since}"`)
    since = io.now() - Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
  }
  const turn = values.turn === undefined ? undefined : Number(values.turn)
  if (turn !== undefined && (!Number.isInteger(turn) || turn < 0)) throw new UsageError('--turn takes a turn number')
  const actions = [values.clear, values.prune, values.path, values.follow].filter(Boolean).length
  if (actions > 1) throw new UsageError('use only one of --clear, --prune, --path and --follow')
  if (values.prune === true && name !== undefined) throw new UsageError('--prune takes no surface; it prunes every local surface')
  let profile: string
  try {
    profile = checkProfile(values.profile ?? io.profile)
  } catch (error: unknown) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return {
    surface: name,
    count,
    follow: values.follow === true,
    since,
    session: values.session,
    turn,
    json: values.json === true,
    path: values.path === true,
    clear: values.clear === true,
    prune: values.prune === true,
    profile,
  }
}

/** The local surface a name selects. */
function locate(surface: 'home' | 'supervisor' | 'desktop-host', home: string, profile: string): SurfaceLocation {
  return resolveSurface({ kind: surface, home, profile })
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/** Control characters from captured output are shown escaped, so a record cannot drive the terminal. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * One record in C20's human form: `<ts> <level> <surface> [<sessionId>/<turn>] <msg>`, with an error's name, code and
 * message after it.
 * @param record - the record.
 * @returns the line, without its newline.
 */
export function formatRecord(record: LogRecord): string {
  const keys = record.sessionId === undefined ? '' : ` [${record.sessionId}${record.turn === undefined ? '' : `/${String(record.turn)}`}]`
  const err = record.err === undefined ? '' : ` (${record.err.name}${record.err.code === undefined ? '' : ` ${record.err.code}`}: ${record.err.message})`
  return printable(`${record.ts} ${record.level} ${record.surface}${keys} ${record.msg}${err}`)
}

function matches(options: Options): (line: StoredLine) => boolean {
  return ({ record }) => record !== undefined
    && (options.since === undefined || Date.parse(record.ts) >= options.since)
    && (options.session === undefined || record.sessionId === options.session)
    && (options.turn === undefined || record.turn === options.turn)
}

function print(io: LogsIo, options: Options, line: StoredLine): void {
  // `matches` admits only lines that are records.
  io.stdout(`${options.json ? line.line : formatRecord(line.record!)}\n`)
}

function reportFailures(io: LogsIo, report: RetentionReport): LogsExit {
  for (const failure of report.failures) io.stderr(`${failure.message}\n`)
  return report.failures.length === 0 ? 0 : 1
}

/** The overview: every surface with its location, whether it exists, its size and its oldest record. */
function overview(io: LogsIo, profile: string): void {
  const fixed = [locate('home', io.home, profile), locate('supervisor', io.home, profile), locate('desktop-host', io.home, profile)]
  const found = localSurfaces(io.home).filter(location => !fixed.some(item => item.surface === location.surface))
  io.stdout(`Logs under ${join(io.home, 'logs')}\n`)
  for (const location of [...fixed, ...found]) {
    let state: string
    try {
      const files = surfaceFiles(location)
      const paths = [...files.active === undefined ? [] : [files.active], ...files.rotated.map(file => file.path)]
      if (paths.length === 0) {
        state = 'not created'
      } else {
        const bytes = paths.reduce((total, path) => total + lstatSync(path).size, 0)
        const oldest = paths.map(path => oldestRecordTime(path)).filter(time => time !== undefined).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
        state = `${size(bytes)} in ${String(paths.length)} file${paths.length === 1 ? '' : 's'}, oldest record ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'none'}`
      }
    } catch (error: unknown) {
      if (!isLogsFailure(error)) throw error
      state = `refused: ${error.message}`
    }
    io.stdout(`  ${location.surface}  ${location.file}  ${state}\n`)
  }
  const reports = startupReports(io.home)
  io.stdout(`  startup  ${join(io.home, UPSTREAM_STARTUP_REPORTS)}  ${String(reports.length)} upstream startup report${reports.length === 1 ? '' : 's'}\n`)
}

function startup(io: LogsIo): void {
  const reports = startupReports(io.home)
  io.stdout(`Upstream's startup reports, written by upstream's dsh command, never by delorun. ${STARTUP_WARNING}\n`)
  for (const path of reports) io.stdout(`  ${path}  ${size(lstatSync(path).size)}\n`)
  if (reports.length === 0) io.stdout('  none\n')
}

function relay(io: LogsIo): void {
  io.stdout(`The relay's log is ${SURFACE_FILES.relay} inside the self-hosted relay's container, not on this machine.\n`)
  io.stdout(`Read it on the relay's host with: docker exec <relay-container> tail -n ${String(DEFAULT_TAIL_RECORDS)} ${SURFACE_FILES.relay}\n`)
}

async function clear(io: LogsIo, options: Options): Promise<LogsExit> {
  const { surface } = options
  if (surface === 'relay') throw new UsageError('the relay\'s log is inside its container; clear it there')
  const what = surface === undefined
    ? 'every local operational log and upstream\'s startup reports'
    : surface === 'startup' ? 'upstream\'s startup reports' : `the ${locate(surface, io.home, options.profile).surface} log`
  if (!await io.confirm(`Delete the rotated files and empty the active file of ${what}? The records cannot be recovered.`)) {
    io.stderr('Nothing was cleared.\n')
    return 1
  }
  const report = surface === undefined
    ? clearLocalLogs(io.home)
    : surface === 'startup' ? clearStartupReports(io.home) : clearSurface(locate(surface, io.home, options.profile))
  for (const path of report.deleted) io.stdout(`deleted ${path}\n`)
  for (const path of report.emptied) io.stdout(`emptied ${path}\n`)
  return reportFailures(io, report)
}

function prune(io: LogsIo): LogsExit {
  const report = pruneLocalSurfaces(io.home, io.now())
  for (const path of report.deleted) io.stdout(`deleted ${path}\n`)
  if (report.deleted.length === 0) io.stdout('No log file is older than the retention period.\n')
  return reportFailures(io, report)
}

async function records(io: LogsIo, options: Options, location: SurfaceLocation): Promise<void> {
  const keep = matches(options)
  let skipped = 0
  const counted = (line: StoredLine): boolean => {
    if (line.record === undefined) skipped += 1
    return keep(line)
  }
  for (const line of readLines(location, options.count, counted)) print(io, options, line)
  if (skipped > 0) io.stderr(`${String(skipped)} line${skipped === 1 ? ' is' : 's are'} not a log record and ${skipped === 1 ? 'was' : 'were'} left out.\n`)
  if (options.follow) {
    await followLines(location, { onLine: (line) => { if (keep(line)) print(io, options, line) }, signal: io.signal, intervalMs: FOLLOW_INTERVAL_MS })
  }
}

/**
 * Run `delorun logs`.
 * @param argv - the arguments after `logs`.
 * @param io - the home, the profile, the streams, the confirmation prompt, the clock and the signal ending `--follow`.
 * @returns the exit code: 0 on success, 1 when a log was refused, could not be changed or the clear was declined, and
 *   2 for a usage error.
 */
export async function runLogs(argv: readonly string[], io: LogsIo): Promise<LogsExit> {
  let options: Options
  try {
    options = resolveOptions(argv, io)
  } catch (error: unknown) {
    if (!(error instanceof UsageError)) throw error
    io.stderr(`delorun logs: ${error.message}\n${LOGS_USAGE}`)
    return 2
  }
  try {
    if (options.prune) return prune(io)
    if (options.clear) return await clear(io, options)
    const surface = options.surface ?? 'home'
    if (options.path) {
      if (surface === 'startup') throw new UsageError(`upstream's startup reports have no active file; they are ${join(io.home, UPSTREAM_STARTUP_REPORTS)}`)
      io.stdout(`${surface === 'relay' ? SURFACE_FILES.relay : locate(surface, io.home, options.profile).file}\n`)
      return 0
    }
    if (surface === 'startup') {
      startup(io)
      return 0
    }
    if (surface === 'relay') {
      relay(io)
      return 0
    }
    const location = locate(surface, io.home, options.profile)
    if (options.surface === undefined && !options.json && !options.follow) {
      overview(io, options.profile)
      io.stdout(`\nLast ${String(options.count)} records of ${location.surface}:\n`)
    }
    await records(io, options, location)
    return 0
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      io.stderr(`delorun logs: ${error.message}\n`)
      return 2
    }
    if (!isLogsFailure(error)) throw error
    io.stderr(`delorun logs: ${error.message}\n`)
    return 1
  }
}
