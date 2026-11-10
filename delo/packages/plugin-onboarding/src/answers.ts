/**
 * Reads the terminal setup's answers record for the studio. The file is data from the profile directory, so only the
 * fields onboarding uses are validated, the rest is never read into anything served, and a reason that is logged
 * never quotes the file.
 * @module @delo/plugin-onboarding/answers
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { NO_RECORD, SectionNames, type SetupRecord } from './wire.ts'

/** The record's file name inside the CLI profile's directory, as `delorun setup` writes it. */
export const SETUP_ANSWERS_FILENAME = 'setup-answers.json'

/** The largest record read: setup's document is a few hundred bytes, so a larger file is not one setup wrote. */
export const MAX_ANSWERS_BYTES = 64 * 1024

/** The reach option that means reach is not set up. */
const REACH_OFF = 'none'

/** The fields used; other fields are tolerated and ignored. */
const Used = z.object({
  reach: z.object({ option: z.string().min(1).max(64) }),
  sections: z.unknown().optional(),
})

/**
 * Name where a document failed validation without echoing what the file held.
 * @param error - the validation failure.
 * @returns the failing field paths, joined.
 */
function locations(error: z.ZodError): string {
  return error.issues.map(issue => (issue.path.length === 0 ? '(document)' : issue.path.join('.'))).join(', ')
}

/**
 * Read the setup record of a profile.
 * @param directory - the profile's directory, or undefined where the harness was not launched from a profile.
 * @param warn - called with a sentence when the file exists but cannot be used; the file's contents are never in it.
 * @returns the record, or {@link NO_RECORD} when the file is absent or unusable, so every step shows.
 */
export async function readSetupRecord(directory: string | undefined, warn: (message: string) => void): Promise<SetupRecord> {
  if (directory === undefined) return NO_RECORD
  const path = join(directory, SETUP_ANSWERS_FILENAME)
  let text: string
  try {
    const status = await stat(path)
    if (!status.isFile() || status.size > MAX_ANSWERS_BYTES) {
      warn(`${SETUP_ANSWERS_FILENAME} is not a regular file of at most ${String(MAX_ANSWERS_BYTES)} bytes; onboarding shows every step`)
      return NO_RECORD
    }
    text = await readFile(path, 'utf8')
  } catch (error) {
    // An absent file is the normal state before setup; any other failure is reported without the system's message.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${SETUP_ANSWERS_FILENAME} could not be read; onboarding shows every step`)
    return NO_RECORD
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The parser's message quotes part of the text, so only the fact is reported.
    warn(`${SETUP_ANSWERS_FILENAME} is not JSON; onboarding shows every step`)
    return NO_RECORD
  }
  const used = Used.safeParse(parsed)
  if (!used.success) {
    warn(`${SETUP_ANSWERS_FILENAME} lacks a usable ${locations(used.error)}; onboarding shows every step`)
    return NO_RECORD
  }
  const reachSetUp = used.data.reach.option !== REACH_OFF
  if (used.data.sections === undefined) return { reachSetUp }
  const sections = SectionNames.safeParse(used.data.sections)
  if (!sections.success) {
    warn(`${SETUP_ANSWERS_FILENAME} lists sections in a form onboarding does not read; it ignores the list`)
    return { reachSetUp }
  }
  return { sections: sections.data, reachSetUp }
}
