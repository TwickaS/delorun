/**
 * The records of a `delorun setup` run. The run record, `run/<profile>/setup-progress.json`, lets an interrupted
 * setup resume at the first step that did not finish; it exists only while a run is unfinished. The answers record,
 * `profiles/<profile>/setup-answers.json`, keeps the answers after setup finishes, so the screens that apply them
 * later read the person's choices. Neither holds a credential value, and both are written at mode 0600.
 *
 * @module @delorun/cli/setup/progress
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SetupAnswers } from '@delorun/contract-setup-answers'
import { ANSWERS_FILENAME } from '@delorun/setup-apply'
import { CliError, EXIT } from '../exit.ts'
import { parseAnswers } from './answers.ts'

/** The step that creates the CLI profile; it runs before every section's writes. */
export const PROFILE_STEP = 'profile'

/**
 * The step of a section's writes.
 * @param id - the section id.
 * @returns the step name recorded in the run record.
 */
export function sectionStep(id: string): string {
  return `section:${id}`
}

/** One step setup runs: {@link PROFILE_STEP}, then one {@link sectionStep} per section. A step writes the same values when it runs again. */
export type SetupStep = string

/** The run record. */
export interface SetupProgress {
  /** The answers the run applies; the model key is never in them. */
  readonly answers: SetupAnswers
  /** The steps that finished, in run order. */
  readonly completed: readonly SetupStep[]
  /** `keep` when the run keeps the key already saved in the home, so a resumed run does not ask for it again; absent otherwise. */
  readonly credentialSource?: 'keep' | undefined
}

const progressSchema = z.strictObject({
  version: z.literal(1),
  answers: z.unknown().transform((answers, context) => {
    const checked = parseAnswers(answers)
    if (checked.success) return checked.data
    context.addIssue({ code: 'custom', message: 'not setup answers' })
    return z.NEVER
  }),
  completed: z.array(z.string()),
  credentialSource: z.literal('keep').optional(),
})

/** The run record's file name inside the profile's run directory. */
export const PROGRESS_FILENAME = 'setup-progress.json'

/**
 * Write a file atomically at mode 0600.
 * @param path - the destination.
 * @param text - the contents.
 */
function writePrivate(path: string, text: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Read the run record.
 * @param runDirectory - the profile's run directory.
 * @returns the record, or `undefined` when no run is in progress or finished setup has none.
 * @throws {CliError} `EXIT.failed` when the record is not one setup wrote.
 */
export function readProgress(runDirectory: string): SetupProgress | undefined {
  const path = join(runDirectory, PROGRESS_FILENAME)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliError(EXIT.failed, `delorun setup: ${path} is not a setup record; remove it to set up again`)
  }
  const checked = progressSchema.safeParse(parsed)
  if (!checked.success) throw new CliError(EXIT.failed, `delorun setup: ${path} is not a setup record; remove it to set up again`)
  return checked.data
}

/**
 * Write the run record atomically at mode 0600.
 * @param runDirectory - the profile's run directory, which exists.
 * @param progress - the record.
 */
export function writeProgress(runDirectory: string, progress: SetupProgress): void {
  writePrivate(join(runDirectory, PROGRESS_FILENAME), `${JSON.stringify({ version: 1, ...progress }, null, 2)}\n`)
}

/**
 * Remove the run record once every step has finished.
 * @param runDirectory - the profile's run directory.
 */
export function removeProgress(runDirectory: string): void {
  rmSync(join(runDirectory, PROGRESS_FILENAME), { force: true })
}

/**
 * Write the answers record of a finished setup.
 * @param profileDirectory - the CLI profile's directory.
 * @param answers - the answers the run applied.
 */
export function writeAnswersRecord(profileDirectory: string, answers: SetupAnswers): void {
  writePrivate(join(profileDirectory, ANSWERS_FILENAME), `${JSON.stringify({ version: 1, ...answers }, null, 2)}\n`)
}
