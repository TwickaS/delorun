/**
 * The two record lines of `delorun doctor`, each read offline from a record other commands write:
 *
 * - `release-log`: the running release's release-log check state, which installs, starts and `delorun verify` record in
 *   `trust/release-log.json` (contracts C1 and C18). `verified` passes; `unchecked` warns with the time since which the
 *   release has stayed unchecked and the reason the last attempt recorded, in `delorun verify`'s words; `failed` fails
 *   with the refusal. No state for the running release warns, because C18 treats a release with no completed check as
 *   unchecked; a state record that does not read warns too, because the next start or `delorun verify` checks the
 *   release again and rewrites it.
 * - `import`: the record of completed stock-home imports, through a {@link DshImportRecordReader} the command is given.
 *   No line is printed without a reader.
 *
 * Neither check reads the network or writes a file. A record laxer than 0600, a link or another user's file throws
 * `SECRET_FILE_MODE`, which the command turns into the check's `fail` line.
 *
 * @module @delorun/cli/doctor/records
 */
import { checkStatePath, readCheckState, readProtectedFile, ReleaseLogRefusalError, type RecordedCheck } from '@delorun/release-verify'
import { uncheckedSinceWarning, utcText } from '../verify/checks.ts'
import type { CheckResult } from './checks.ts'

/** One completed stock-home import, with the fields of the import record's entry that the `import` line prints. */
export interface DshImportRecordEntry {
  /** When the import completed, in RFC 3339 UTC. */
  readonly at: string
  /** The stock home's real path. */
  readonly source: string
  /** The chats copied. */
  readonly chats: number
  /** The workspaces carried. */
  readonly workspaces: number
  /** The profiles carried, by name. */
  readonly profiles: readonly string[]
  /** The credentials copied, by name. */
  readonly credentials: readonly string[]
  /** The stock home's entries the import left behind. */
  readonly skipped: number
}

/**
 * Reads the record of completed stock-home imports.
 * @param home - the resolved Delorun home.
 * @returns the record's entries, oldest first; none when no import completed.
 * @throws when the record exists and cannot be read.
 */
export type DshImportRecordReader = (home: string) => Promise<readonly DshImportRecordEntry[]>

/**
 * Text from a record, on one line: each run of control characters, line breaks included, becomes one space, so a
 * record cannot move the cursor or start a second line.
 * @param text - the recorded text.
 * @returns the text without control characters.
 */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}]+/gu, ' ')
}

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @param plural - the plural noun.
 * @returns such as `1 chat` or `3 chats`.
 */
function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : plural}`
}

/**
 * The `release-log` line: the running release's recorded release-log check state.
 * @param home - the resolved Delorun home.
 * @param release - the running release's version.
 * @param now - the clock, in Unix seconds.
 * @returns the line's result.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the state record is a link, another user's or laxer than 0600.
 * @throws Error when the state record exists and cannot be read.
 */
export async function checkReleaseLog(home: string, release: string, now: number): Promise<CheckResult> {
  const path = checkStatePath(home)
  const bytes = await readProtectedFile(path)
  let record: RecordedCheck | undefined
  try {
    record = bytes === undefined ? undefined : readCheckState(bytes).get(release)
  } catch (error) {
    // readCheckState refuses a record that does not read with ReleaseLogRefusalError and throws nothing else.
    const reason = error instanceof ReleaseLogRefusalError ? error.detail : String(error)
    return { name: 'release-log', status: 'warn', message: `the release-log state at ${path} does not read (${oneLine(reason)}); the next start or delorun verify checks release ${release} again and rewrites it.` }
  }
  if (record === undefined) {
    return { name: 'release-log', status: 'warn', message: `no release-log check of release ${release} is recorded in ${path}; run delorun verify to check it against the release log.` }
  }
  switch (record.state) {
    case 'verified':
      return { name: 'release-log', status: 'pass', message: `release ${release} verified against the release log at ${utcText(record.lastAttempt)}.` }
    case 'failed': {
      const refusal = record.refusal ?? record.failure ?? 'no refusal recorded'
      return { name: 'release-log', status: 'fail', message: `the release log refused release ${release} (${refusal}) at ${utcText(record.lastAttempt)}: ${oneLine(record.detail ?? 'no detail recorded')}` }
    }
    case 'unchecked': {
      const why = record.detail === undefined
        ? `the last attempt, at ${utcText(record.lastAttempt)}, recorded no reason`
        : `the last attempt, at ${utcText(record.lastAttempt)}, recorded: ${oneLine(record.detail)}`
      return { name: 'release-log', status: 'warn', message: uncheckedSinceWarning(release, record.uncheckedSince ?? record.lastAttempt, now, why) }
    }
  }
}

/**
 * The `import` line: the newest completed stock-home import. It warns when that import left entries behind.
 * @param home - the resolved Delorun home.
 * @param read - reads the import record.
 * @returns the line's result.
 * @throws the reader's error when the record cannot be read.
 */
export async function checkImportRecord(home: string, read: DshImportRecordReader): Promise<CheckResult> {
  const entries = await read(home)
  const newest = entries.at(-1)
  if (newest === undefined) return { name: 'import', status: 'pass', message: 'no stock DeepSeek Harness home has been imported into this home.' }
  const carried = `${counted(newest.chats, 'chat')}, ${counted(newest.workspaces, 'workspace')}, ${counted(newest.profiles.length, 'profile')} and ${counted(newest.credentials.length, 'credential')}`
  const imported = `the newest of ${counted(entries.length, 'stock-home import')}, from ${oneLine(newest.source)} at ${oneLine(newest.at)}, carried ${carried}`
  if (newest.skipped === 0) return { name: 'import', status: 'pass', message: `${imported}.` }
  return { name: 'import', status: 'warn', message: `${imported}; it left ${counted(newest.skipped, 'entry', 'entries')} of the stock home behind, which it did not copy.` }
}
