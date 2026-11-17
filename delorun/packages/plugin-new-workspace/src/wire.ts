/**
 * What both halves of the new-workspace flow share: its exact Connection Fetch routes under `/api` and their JSON
 * messages. Every route answers the computer, and a paired device only while it holds an unlock. Browser-safe, so the
 * studio half imports it.
 * @module @delorun/plugin-new-workspace/wire
 */
import { z } from 'zod'

/** The prefix of every route of this package. */
const PREFIX = '/api/delorunNewWorkspace'

/**
 * The route that adds an existing folder as a workspace. `POST` takes {@link AddWorkspaceRequest} and answers
 * {@link AddWorkspaceAnswer}: 200 with `added`, 422 with `refused`, 400 for a request it cannot read, and 500 with
 * `failed` when the registry cannot add the folder. The studio fetches every route without its leading `/`.
 */
export const ADD_WORKSPACE_PATH = `${PREFIX}.add`

/** The route that starts cloning a Git repository into a new folder. `POST` takes {@link CloneRequest} and answers {@link CloneStart}. */
export const CLONE_PATH = `${PREFIX}.clone`

/** The route that reports a clone. `POST` takes {@link CloneStatusRequest} and answers {@link CloneStatus}. */
export const CLONE_STATUS_PATH = `${PREFIX}.cloneStatus`

/** The route that lists recent and suggested places. `POST` takes `{}` and answers {@link PlacesAnswer}. */
export const PLACES_PATH = `${PREFIX}.places`

/** The route that finds folders by name. `POST` takes {@link SearchRequest} and answers {@link SearchAnswer}. */
export const SEARCH_PATH = `${PREFIX}.search`

/** The route that describes one folder for the browser's preview column. `POST` takes {@link PreviewRequest} and answers {@link PreviewAnswer}. */
export const PREVIEW_PATH = `${PREFIX}.preview`

/** The route that makes a new folder, optionally starts Git in it, and adds it as a workspace. `POST` takes {@link CreateRequest} and answers {@link CreateAnswer}. */
export const CREATE_PATH = `${PREFIX}.create`

/** The route that reads one workspace's defaults. `POST` takes {@link DefaultsRequest} and answers {@link DefaultsAnswer}. */
export const DEFAULTS_PATH = `${PREFIX}.defaults`

/** The route that records one workspace's defaults. `POST` takes {@link SetDefaultsRequest} and answers {@link DefaultsAnswer}. */
export const SET_DEFAULTS_PATH = `${PREFIX}.setDefaults`

/** The longest path a route takes, in characters: the longest path Linux and macOS accept. */
export const MAX_PATH_LENGTH = 4096

/** The longest repository address the clone route takes. */
export const MAX_URL_LENGTH = 2048

/** The longest folder name the create and clone routes take. */
export const MAX_NAME_LENGTH = 255

/** The longest branch name the clone route takes. */
export const MAX_BRANCH_LENGTH = 255

/** The longest search text, in characters. */
export const MAX_QUERY_LENGTH = 100

/** The largest request body any route reads, in bytes: every field at its longest, JSON-escaped. */
export const MAX_BODY_BYTES = 6 * (MAX_PATH_LENGTH + MAX_URL_LENGTH + MAX_NAME_LENGTH + MAX_BRANCH_LENGTH) + 256

/**
 * The codes of the folders Delorun never adds as a workspace, as `@delorun/home`'s `WorkspaceLocationProblem` names them,
 * and `outside-roots` for a new folder outside the places this package creates folders in. The host half checks at
 * compile time that the first list holds the same codes as `@delorun/home`.
 */
export const LOCATION_PROBLEMS = [
  'filesystem-root', 'home-directory', 'delorun-home', 'contains-delorun-home', 'stock-home', 'contains-stock-home', 'not-absolute',
] as const

/** Why a folder cannot be a workspace; see {@link LOCATION_PROBLEMS}. */
export type LocationProblem = typeof LOCATION_PROBLEMS[number]

/** Why a new folder cannot go where it was asked: a {@link LocationProblem}, or outside the configured roots. */
export const PLACE_PROBLEMS = [...LOCATION_PROBLEMS, 'outside-roots'] as const

/** One of {@link PLACE_PROBLEMS}. */
export type PlaceProblem = typeof PLACE_PROBLEMS[number]

/** An absolute path on the harness's computer. */
const Path = z.string().min(1).max(MAX_PATH_LENGTH)

/** The folder to add: an absolute path on the harness's computer. */
export const AddWorkspaceRequest = z.strictObject({ path: Path })

/** {@link AddWorkspaceRequest}'s parsed value. */
export type AddWorkspaceRequest = z.output<typeof AddWorkspaceRequest>

/**
 * What a folder holds, from its entries' names only, which picks the first chat's starting prompts: `empty` has no
 * visible entry, `code` is a Git repository or holds a project manifest, `files` is anything else.
 */
export const FOLDER_KINDS = ['empty', 'code', 'files'] as const

/** One of {@link FOLDER_KINDS}. */
export type FolderKind = typeof FOLDER_KINDS[number]

/** A workspace id as the registry gives it. */
const WorkspaceIdText = z.string().min(1).max(200)

/** What adding a folder came to: the workspace's id, folder and kind, the reason the folder is refused, or a failure of the registry. */
export const AddWorkspaceAnswer = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('added'), workspaceId: WorkspaceIdText, path: Path, kind: z.enum(FOLDER_KINDS) }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(LOCATION_PROBLEMS) }),
  z.strictObject({ result: z.literal('failed') }),
])

/** {@link AddWorkspaceAnswer}'s parsed value. */
export type AddWorkspaceAnswer = z.output<typeof AddWorkspaceAnswer>

/**
 * A clone to start: the repository's address, the folder to clone into (created when missing, inside the configured
 * roots), the new folder's name inside it, and the branch to check out, or the remote's default branch without one.
 */
export const CloneRequest = z.strictObject({
  url: z.string().min(1).max(MAX_URL_LENGTH),
  parent: Path,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  branch: z.string().min(1).max(MAX_BRANCH_LENGTH).optional(),
})

/** {@link CloneRequest}'s parsed value. */
export type CloneRequest = z.output<typeof CloneRequest>

/**
 * Why a clone is refused before it starts: `url-form` is not an `https://`, `ssh://` or `user@host:path` address (a
 * local path, `file://`, `ext::` and any value led by `-` are refused); `url-credentials` an `https://` address has a
 * user name or password in it; `name-form` is not one plain folder name; `branch-form` is not a plain branch name;
 * `not-empty` the folder exists and holds something; `busy` another clone runs; or a {@link PlaceProblem}.
 */
export const CLONE_PROBLEMS = ['url-form', 'url-credentials', 'name-form', 'branch-form', 'not-empty', 'busy', ...PLACE_PROBLEMS] as const

/** One of {@link CLONE_PROBLEMS}. */
export type CloneProblem = typeof CLONE_PROBLEMS[number]

/** A started clone's id, or why it did not start. */
export const CloneStart = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('started'), job: z.string().min(1).max(64) }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(CLONE_PROBLEMS) }),
])

/** {@link CloneStart}'s parsed value. */
export type CloneStart = z.output<typeof CloneStart>

/** The clone to report. */
export const CloneStatusRequest = z.strictObject({ job: z.string().min(1).max(64) })

/**
 * Why a started clone failed: `sign-in` the repository needs a sign-in the studio never asks for; `host-key` SSH could
 * not verify the host's key; `not-found` the repository or the branch does not exist, or the repository is private;
 * `network` the host could not be reached; `timeout` it took too long; `no-git` Git is not installed; `failed` any
 * other failure; `add-failed` the clone finished but the folder could not be added as a workspace.
 */
export const CLONE_FAILURES = ['sign-in', 'host-key', 'not-found', 'network', 'timeout', 'no-git', 'failed', 'add-failed'] as const

/** One of {@link CLONE_FAILURES}. */
export type CloneFailure = typeof CLONE_FAILURES[number]

/** Where a clone stands: running with the percent received when Git reported one, added as a workspace with its folder, failed, or unknown to the harness. */
export const CloneStatus = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('running'), percent: z.number().int().min(0).max(100).optional() }),
  z.strictObject({ state: z.literal('done'), workspaceId: WorkspaceIdText, path: Path, kind: z.enum(FOLDER_KINDS) }),
  z.strictObject({ state: z.literal('failed'), failure: z.enum(CLONE_FAILURES) }),
  z.strictObject({ state: z.literal('unknown') }),
])

/** {@link CloneStatus}'s parsed value. */
export type CloneStatus = z.output<typeof CloneStatus>

/** The most recent workspaces and suggested places the places route lists. */
export const MAX_PLACES = 8

/** One recent workspace: its folder, title, what it holds and when it last changed (ISO-8601). */
export const RecentPlace = z.strictObject({ path: Path, name: z.string().min(1).max(MAX_PATH_LENGTH), kind: z.enum(FOLDER_KINDS), usedAt: z.string().max(64) })

/** {@link RecentPlace}'s parsed value. */
export type RecentPlace = z.output<typeof RecentPlace>

/** One suggested folder: an existing folder under the home directory where people keep their work. */
export const SuggestedPlace = z.strictObject({ path: Path, name: z.string().min(1).max(MAX_PATH_LENGTH) })

/** {@link SuggestedPlace}'s parsed value. */
export type SuggestedPlace = z.output<typeof SuggestedPlace>

/**
 * The places the flow starts from: the person's home directory, the recent workspaces (newest first), the suggested
 * folders that exist, and where a new folder or clone goes unless the person changes it (the last place used, else
 * `~/Projects`, which is created at the first use when missing).
 */
export const PlacesAnswer = z.strictObject({
  home: Path,
  recent: z.array(RecentPlace).max(MAX_PLACES),
  suggested: z.array(SuggestedPlace).max(MAX_PLACES),
  defaultParent: Path,
})

/** {@link PlacesAnswer}'s parsed value. */
export type PlacesAnswer = z.output<typeof PlacesAnswer>

/** A folder search: the text a folder's name holds, matched without case. */
export const SearchRequest = z.strictObject({ query: z.string().trim().min(1).max(MAX_QUERY_LENGTH) })

/** {@link SearchRequest}'s parsed value. */
export type SearchRequest = z.output<typeof SearchRequest>

/** The most folders one search returns. */
export const MAX_SEARCH_RESULTS = 50

/**
 * What a search found: the matching folders, nearest first, and whether it stopped at a bound (`complete` when it
 * walked every folder in reach, `limit` at the result or folder count, `time` at the time bound).
 */
export const SearchAnswer = z.strictObject({
  results: z.array(SuggestedPlace).max(MAX_SEARCH_RESULTS),
  stopped: z.enum(['complete', 'limit', 'time']),
})

/** {@link SearchAnswer}'s parsed value. */
export type SearchAnswer = z.output<typeof SearchAnswer>

/** The folder to describe. */
export const PreviewRequest = z.strictObject({ path: Path })

/** {@link PreviewRequest}'s parsed value. */
export type PreviewRequest = z.output<typeof PreviewRequest>

/** The most entry names a preview lists. */
export const MAX_PREVIEW_NAMES = 24

/** One top-level entry a preview lists: its name and whether it is a folder. */
export const PreviewEntry = z.strictObject({ name: z.string().min(1).max(MAX_NAME_LENGTH), folder: z.boolean() })

/** {@link PreviewEntry}'s parsed value. */
export type PreviewEntry = z.output<typeof PreviewEntry>

/**
 * What one folder holds, from its top-level names and Git's `HEAD` only: its kind, its Git branch when it is a
 * repository on a branch, whether it has an `AGENTS.md`, its first visible entries, and whether there are more; or why
 * it cannot be previewed (outside the roots, or a folder Delorun never adds); or that it cannot be read.
 */
export const PreviewAnswer = z.discriminatedUnion('result', [
  z.strictObject({
    result: z.literal('folder'),
    kind: z.enum(FOLDER_KINDS),
    git: z.boolean(),
    branch: z.string().min(1).max(MAX_BRANCH_LENGTH).optional(),
    agentsFile: z.boolean(),
    entries: z.array(PreviewEntry).max(MAX_PREVIEW_NAMES),
    more: z.boolean(),
  }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(PLACE_PROBLEMS) }),
  z.strictObject({ result: z.literal('unreadable') }),
])

/** {@link PreviewAnswer}'s parsed value. */
export type PreviewAnswer = z.output<typeof PreviewAnswer>

/** A new folder: where it goes (created when missing), its name, and whether Git starts in it. */
export const CreateRequest = z.strictObject({
  parent: Path,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  git: z.boolean(),
})

/** {@link CreateRequest}'s parsed value. */
export type CreateRequest = z.output<typeof CreateRequest>

/**
 * Why a new folder was not made: `name-form` is not one plain folder name; `exists` something is there already; or a
 * {@link PlaceProblem}.
 */
export const CREATE_PROBLEMS = ['name-form', 'exists', ...PLACE_PROBLEMS] as const

/** One of {@link CREATE_PROBLEMS}. */
export type CreateProblem = typeof CREATE_PROBLEMS[number]

/**
 * What making the folder came to: added as a workspace (with `git` false when Git was asked for and could not start,
 * so the folder stays without it), refused before anything was made, or failed (nothing is left behind).
 */
export const CreateAnswer = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('added'), workspaceId: WorkspaceIdText, path: Path, git: z.boolean() }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(CREATE_PROBLEMS) }),
  z.strictObject({ result: z.literal('failed') }),
])

/** {@link CreateAnswer}'s parsed value. */
export type CreateAnswer = z.output<typeof CreateAnswer>

/** The browser choices a workspace's chats can start with: the isolated browser, or none. */
export const BROWSER_CHOICES = ['isolated', 'none'] as const

/** One of {@link BROWSER_CHOICES}. */
export type BrowserChoice = typeof BROWSER_CHOICES[number]

/** The longest provider route, model id or reasoning effort the defaults store keeps. */
export const MAX_MODEL_TEXT = 200

/**
 * The model a workspace's new chats start with, as the `model/selection` session event names it: the provider route,
 * the model id, and the reasoning effort (the thinking level), or the model's own default without one.
 */
export const WorkspaceModel = z.strictObject({
  provider: z.string().min(1).max(MAX_MODEL_TEXT),
  model: z.string().min(1).max(MAX_MODEL_TEXT),
  reasoningEffort: z.string().min(1).max(MAX_MODEL_TEXT).optional(),
})

/** {@link WorkspaceModel}'s parsed value. */
export type WorkspaceModel = z.output<typeof WorkspaceModel>

/** One workspace's defaults: the model its new chats start with and its browser choice. An absent field follows the home's own default. */
export const WorkspaceDefaults = z.strictObject({
  model: WorkspaceModel.optional(),
  browser: z.enum(BROWSER_CHOICES).optional(),
})

/** {@link WorkspaceDefaults}'s parsed value. */
export type WorkspaceDefaults = z.output<typeof WorkspaceDefaults>

/** The workspace whose defaults to read, by its folder. */
export const DefaultsRequest = z.strictObject({ path: Path })

/** {@link DefaultsRequest}'s parsed value. */
export type DefaultsRequest = z.output<typeof DefaultsRequest>

/** The defaults to record for a workspace, which replace what it held. */
export const SetDefaultsRequest = z.strictObject({ path: Path, defaults: WorkspaceDefaults })

/** {@link SetDefaultsRequest}'s parsed value. */
export type SetDefaultsRequest = z.output<typeof SetDefaultsRequest>

/** A workspace's defaults, or why they cannot be read or kept (`refused` names a folder that cannot be a workspace). */
export const DefaultsAnswer = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('defaults'), defaults: WorkspaceDefaults }),
  z.strictObject({ result: z.literal('refused'), problem: z.enum(LOCATION_PROBLEMS) }),
  z.strictObject({ result: z.literal('failed') }),
])

/** {@link DefaultsAnswer}'s parsed value. */
export type DefaultsAnswer = z.output<typeof DefaultsAnswer>
