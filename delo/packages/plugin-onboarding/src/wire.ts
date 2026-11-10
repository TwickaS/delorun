/**
 * What both halves share: the exact Connection Fetch routes under `/api`, which the harness serves only to an
 * owner peer, and their JSON messages. The add-workspace route also answers only a request that arrived on the loopback listener (403 `LOOPBACK_ONLY` otherwise). Browser-safe, so the studio half imports it.
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
 * What the terminal setup recorded, reduced to what onboarding uses: the ids of the sections the terminal showed or
 * asked when the record lists them, and whether reach is set up.
 */
export const SetupRecord = z.strictObject({
  sections: SectionNames.optional(),
  reachSetUp: z.boolean(),
})

/** What the terminal setup recorded, as {@link SetupRecord} parses it. */
export type SetupRecord = z.output<typeof SetupRecord>

/** The record of a profile with no usable setup record: nothing is covered and reach is not set up, so every step shows. */
export const NO_RECORD: SetupRecord = Object.freeze({ reachSetUp: false })

/**
 * The harness's route that adds a folder as a workspace. `POST` takes {@link AddWorkspaceRequest} and answers
 * {@link AddWorkspaceAnswer}: 200 with `added`, 422 with `refused`, 400 for a request it cannot read, and 500 with
 * `failed` when the registry cannot add the folder. The studio fetches it without its leading `/`.
 */
export const ADD_WORKSPACE_PATH = '/api/deloOnboarding.addWorkspace'

/** The longest path the route takes, in characters: the longest path Linux and macOS accept. */
export const MAX_PATH_LENGTH = 4096

/** The largest request body the route reads, in bytes: one path of {@link MAX_PATH_LENGTH} characters, JSON-escaped. */
export const MAX_ADD_BODY_BYTES = 6 * MAX_PATH_LENGTH + 64

/**
 * The codes of the folders Delo never adds as a workspace, as `@delo/home`'s `WorkspaceLocationProblem` names them. The
 * host half checks at compile time that the two lists hold the same codes.
 */
export const LOCATION_PROBLEMS = [
  'filesystem-root', 'home-directory', 'delo-home', 'contains-delo-home', 'stock-home', 'contains-stock-home', 'not-absolute',
] as const

/** Why a folder cannot be a workspace; see {@link LOCATION_PROBLEMS}. */
export type LocationProblem = typeof LOCATION_PROBLEMS[number]

/** The folder to add: an absolute path on the harness's computer. */
export const AddWorkspaceRequest = z.strictObject({ path: z.string().min(1).max(MAX_PATH_LENGTH) })

/** {@link AddWorkspaceRequest}'s parsed value. */
export type AddWorkspaceRequest = z.output<typeof AddWorkspaceRequest>

/** What adding a folder came to: the workspace's id, the reason the folder is refused, or a failure of the registry. */
export const AddWorkspaceAnswer = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('added'), workspaceId: z.string().min(1).max(200) }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(LOCATION_PROBLEMS) }),
  z.strictObject({ result: z.literal('failed') }),
])

/** {@link AddWorkspaceAnswer}'s parsed value. */
export type AddWorkspaceAnswer = z.output<typeof AddWorkspaceAnswer>
