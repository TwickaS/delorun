/**
 * The answers record of a finished setup, `profiles/<profile>/setup-answers.json`, rewritten when a control outside
 * `delorun setup` changes an answer.
 *
 * @module @delorun/setup-apply/answers-record
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPTS_OPTIONS, SETUP_DEFAULTS, type PromptsAnswer } from '@delorun/contract-setup-answers'
import { writeProtectedFile } from '@delorun/home'
import { SetupApplyError } from './errors.ts'

/** The answers record's file name inside the profile's directory. */
export const ANSWERS_FILENAME = 'setup-answers.json'

/** The answers record as JSON holds it; the caller that knows a key reads it. */
export type AnswersRecord = Readonly<Record<string, unknown>>

/**
 * Read a profile's answers record.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the record, or `undefined` when the profile has none or the file is not a JSON object. An unreadable record is
 *   not setup's answer: the defaults apply until setup records the answer again.
 */
export function readAnswersRecord(profileDirectory: string): AnswersRecord | undefined {
  const path = join(profileDirectory, ANSWERS_FILENAME)
  if (!existsSync(path)) return undefined
  let record: unknown
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (_unreadable) {
    // Not JSON: the caller applies setup's defaults.
    return undefined
  }
  return typeof record === 'object' && record !== null && !Array.isArray(record) ? Object.fromEntries(Object.entries(record)) : undefined
}

/**
 * The prompts answer a record holds.
 * @param record - the answers record, or `undefined` for a profile without one.
 * @returns the recorded answer, or setup's default for a missing record or one that names no known answer.
 */
export function promptsOf(record: AnswersRecord | undefined): PromptsAnswer {
  return PROMPTS_OPTIONS.find(option => option === record?.['prompts']) ?? SETUP_DEFAULTS.prompts
}

/**
 * The background answer a record holds.
 * @param record - the answers record, or `undefined` for a profile without one.
 * @returns the recorded answer, or setup's default for a missing record or one that holds no boolean.
 */
export function backgroundOf(record: AnswersRecord | undefined): boolean {
  const background = record?.['background']
  return typeof background === 'boolean' ? background : SETUP_DEFAULTS.background
}

/**
 * Rewrite a profile's answers record atomically at mode 0600, keeping every key `change` leaves. The caller holds the
 * home's write lock, so the read and the write see one record.
 * @param profileDirectory - the CLI profile's directory.
 * @param change - returns the next record from the current one.
 * @returns the record as written.
 * @throws {SetupApplyError} when the profile has no answers record, or the file is not a JSON object; the file is left unchanged. A profile that never ran setup has no answers to change.
 */
export async function updateAnswersRecord(profileDirectory: string, change: (record: AnswersRecord) => AnswersRecord): Promise<AnswersRecord> {
  const path = join(profileDirectory, ANSWERS_FILENAME)
  if (!existsSync(path)) throw new SetupApplyError(`${path} does not exist, so this profile has no setup answers to change; run delorun setup first`)
  let current: unknown
  try {
    current = JSON.parse(readFileSync(path, 'utf8'))
  } catch (_unreadable) {
    // A file that is not JSON is not a record setup wrote; it is reported and left as it is.
    throw new SetupApplyError(`${path} is not a setup record; it was not changed`)
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new SetupApplyError(`${path} is not a setup record; it was not changed`)
  const next = change(Object.fromEntries(Object.entries(current)))
  await writeProtectedFile(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
