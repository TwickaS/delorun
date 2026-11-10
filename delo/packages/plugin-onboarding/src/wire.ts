/**
 * What both halves share: the exact Connection Fetch route under `/api`, which the harness serves only to an
 * admitted peer, and its JSON message. Browser-safe, so the studio half imports it.
 * @module @delo/plugin-onboarding/wire
 */
import { z } from 'zod'

/** The harness's route. The studio fetches it without its leading `/`, relative to the document. `GET` answers {@link SetupRecord}. */
export const SETUP_RECORD_PATH = '/api/deloOnboarding.setupRecord'

/** A setup section's name: lower-case letters, digits and hyphens, starting with a letter. */
export const SECTION_NAME = /^[a-z][a-z0-9-]{0,39}$/

/** The most section names the record may hold. */
export const MAX_SECTIONS = 32

/** The section names a record lists. */
export const SectionNames = z.array(z.string().regex(SECTION_NAME)).max(MAX_SECTIONS)

/**
 * What the terminal setup recorded, reduced to what onboarding uses: the sections the person saw, answered or
 * skipped when the record lists them, and whether reach is set up.
 */
export const SetupRecord = z.strictObject({
  sections: SectionNames.optional(),
  reachSetUp: z.boolean(),
})

/** What the terminal setup recorded, as {@link SetupRecord} parses it. */
export type SetupRecord = z.output<typeof SetupRecord>

/** The record of a profile with no usable setup record: nothing is covered and reach is not set up, so every step shows. */
export const NO_RECORD: SetupRecord = Object.freeze({ reachSetUp: false })
