/**
 * The record of the last failed reload in a work session, `run/<profile>/changes-work.json` (contract C1): which plugin
 * failed to load from its folder, when, and the error. Delorun writes it when it went back to the content that last loaded,
 * and removes it when a reload in a work session succeeds or a new session starts. The studio's badge and
 * `delorun doctor` read it; it decides nothing.
 *
 * The record is a protected file: written at mode 0600 by an atomic rename, and refused on read with
 * `RECORD_UNREADABLE` when another user could read it or when it is not a record Delorun wrote.
 *
 * @module @delorun/changes/work-record
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delorun/home'
import { ChangesError } from './errors.ts'
import { PACKAGE_NAME_PATTERN } from './records.ts'

/** The record's file name under `run/<profile>/`. */
export const CHANGES_WORK_FILE = 'changes-work.json'

/** Schema tag of {@link WorkFailureRecord}. */
export const WORK_FAILURE_SCHEMA = 'delorun.changes-work/1'

/** The file `run/<profile>/changes-work.json`. */
export interface WorkFailureRecord {
  readonly schema: typeof WORK_FAILURE_SCHEMA
  /** The plugin whose folder content failed to load. */
  readonly plugin: string
  /** When the reload failed, ISO 8601. */
  readonly at: string
  /** What the running Host reported. */
  readonly error: string
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the record's path.
 */
export function workFailurePath(home: string, profile: string): string {
  return join(runDirectory(home, profile), CHANGES_WORK_FILE)
}

/**
 * Write the record of a failed reload in a work session. Creates `run/<profile>/` at mode 0700 when it is missing.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param failure - the plugin, the time and the error.
 * @returns the record written.
 */
export async function writeWorkFailure(home: string, profile: string, failure: Omit<WorkFailureRecord, 'schema'>): Promise<WorkFailureRecord> {
  const record: WorkFailureRecord = { schema: WORK_FAILURE_SCHEMA, plugin: failure.plugin, at: failure.at, error: failure.error }
  await mkdir(runDirectory(home, profile), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(workFailurePath(home, profile), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * Remove the record of a failed reload, when there is one.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 */
export async function removeWorkFailure(home: string, profile: string): Promise<void> {
  await rm(workFailurePath(home, profile), { force: true })
}

/**
 * @param path - the record's path.
 * @param detail - what is wrong with it.
 * @param cause - the underlying error.
 * @returns the refusal.
 */
function unreadable(path: string, detail: string, cause?: unknown): ChangesError {
  return new ChangesError('RECORD_UNREADABLE', path, `${path} is not a record Delorun wrote: ${detail}.`, cause === undefined ? undefined : { cause })
}

/**
 * @param value - a parsed value.
 * @returns whether it is a {@link WorkFailureRecord}: exactly its fields, each of its type.
 */
function isWorkFailure(value: unknown): value is WorkFailureRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const fields = value as Readonly<Record<string, unknown>>
  return Object.keys(fields).sort().join(',') === 'at,error,plugin,schema'
    && fields.schema === WORK_FAILURE_SCHEMA
    && typeof fields.plugin === 'string' && PACKAGE_NAME_PATTERN.test(fields.plugin)
    && typeof fields.at === 'string' && !Number.isNaN(Date.parse(fields.at))
    && typeof fields.error === 'string'
}

/**
 * Read the record of the last failed reload in a work session.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the record, or undefined when there is none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the file cannot be read, has a mode others can read, or is not a
 *   record Delorun wrote.
 */
export async function readWorkFailure(home: string, profile: string): Promise<WorkFailureRecord | undefined> {
  const path = workFailurePath(home, profile)
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
  if (!isWorkFailure(value)) throw unreadable(path, `it is not a ${WORK_FAILURE_SCHEMA} record`)
  return value
}
