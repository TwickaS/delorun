/**
 * The flow's requests to the Host: one typed client per route of `../wire.ts`. Each answer is parsed with its wire schema,
 * and every failure comes back as a value, never a rejection, so a screen shows an honest state in place.
 * @module @delorun/plugin-new-workspace/client/api
 */
import { z } from 'zod'
import {
  ADD_WORKSPACE_PATH, AddWorkspaceAnswer, CLONE_PATH, CLONE_STATUS_PATH, CloneStart, CloneStatus, CREATE_PATH, CreateAnswer,
  DEFAULTS_PATH, DefaultsAnswer, PLACES_PATH, PlacesAnswer, PREVIEW_PATH, PreviewAnswer, SEARCH_PATH, SearchAnswer, SET_DEFAULTS_PATH,
  type CloneRequest, type CreateRequest, type WorkspaceDefaults,
} from '../wire.ts'

/** Why a request got no answer: the device needs an unlock, it must be made at the computer, or it failed for any other reason. */
export type ApiFailure = 'locked' | 'refused-arrival' | 'failed'

/** A parsed answer, or why there was none. */
export type ApiResult<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly reason: ApiFailure }

/** The home's route that sets one workspace's network. `POST` takes `{ path, network: { access, hosts } }` and answers `{ network }`. */
export const NETWORK_SET_PATH = '/api/delorunNetwork.set'

/**
 * The network a workspace's commands get, as `@delorun/plugin-permission-defaults` stores it: `open`, `allowlist` (the hosts
 * only) or `off`. The home answers a change that loosens the network without `confirmed: true` with `NETWORK_UNCONFIRMED`;
 * this flow only narrows the default `open`, so it never sends `confirmed`, and such an answer is a failure.
 */
export const NetworkSetting = z.strictObject({
  access: z.enum(['open', 'allowlist', 'off']),
  hosts: z.array(z.string()),
})

/** {@link NetworkSetting}'s parsed value. */
export type NetworkSetting = z.output<typeof NetworkSetting>

/** The home's answer to a network change: the setting now in effect. */
export const NetworkAnswer = z.looseObject({ network: z.looseObject({ access: z.enum(['open', 'allowlist', 'off']), hosts: z.array(z.string()) }) })

/** {@link NetworkAnswer}'s parsed value. */
export type NetworkAnswer = z.output<typeof NetworkAnswer>

/** The routes by the name the unlock report and the log use. */
type RouteName = 'places' | 'search' | 'preview' | 'add' | 'create' | 'clone' | 'cloneStatus' | 'defaults' | 'setDefaults' | 'setNetwork'

/** The flow's requests. */
export interface NewWorkspaceApi {
  /**
   * Read the recent and suggested places and where a new folder goes.
   * @returns the places.
   */
  places(): Promise<ApiResult<PlacesAnswer>>
  /**
   * Search folders by name.
   * @param query - the text a folder's name holds.
   * @param signal - cancels a search a newer one supersedes.
   * @returns the folders found and why the search stopped.
   */
  search(query: string, signal?: AbortSignal): Promise<ApiResult<SearchAnswer>>
  /**
   * Describe one folder.
   * @param path - the folder.
   * @param signal - cancels a preview a newer one supersedes.
   * @returns what the folder holds, or why it cannot be a workspace.
   */
  preview(path: string, signal?: AbortSignal): Promise<ApiResult<PreviewAnswer>>
  /**
   * Add an existing folder as a workspace.
   * @param path - the folder.
   * @returns the workspace, or why the folder was refused.
   */
  add(path: string): Promise<ApiResult<AddWorkspaceAnswer>>
  /**
   * Make a new folder and add it as a workspace.
   * @param request - where it goes, its name and whether Git starts in it.
   * @returns the workspace, or why nothing was made.
   */
  create(request: CreateRequest): Promise<ApiResult<CreateAnswer>>
  /**
   * Start cloning a repository.
   * @param request - the address, the folder and the branch.
   * @returns the clone's job, or why it did not start.
   */
  clone(request: CloneRequest): Promise<ApiResult<CloneStart>>
  /**
   * Read a clone's progress.
   * @param job - the job {@link NewWorkspaceApi.clone} returned.
   * @returns where the clone stands.
   */
  cloneStatus(job: string): Promise<ApiResult<CloneStatus>>
  /**
   * Read one workspace's defaults.
   * @param path - the workspace's folder.
   * @returns its defaults.
   */
  defaults(path: string): Promise<ApiResult<DefaultsAnswer>>
  /**
   * Record one workspace's defaults, which replace what it held.
   * @param path - the workspace's folder.
   * @param defaults - the defaults to keep.
   * @returns the defaults now kept.
   */
  setDefaults(path: string, defaults: WorkspaceDefaults): Promise<ApiResult<DefaultsAnswer>>
  /**
   * Set one workspace's network for commands, through the home's own route.
   * @param path - the workspace's canonical folder, as the Host returned it.
   * @param network - the access and, for an allowlist, the hosts.
   * @returns the setting now in effect.
   */
  setNetwork(path: string, network: NetworkSetting): Promise<ApiResult<NetworkAnswer>>
}

/** What the client needs from the page. */
export interface ApiOptions {
  /**
   * Called when a route was refused for want of a grant the person did not give, after the Face ID step of `fetch`.
   * @param route - the route refused, such as `add`.
   */
  readonly unlockNeeded?: ((route: string) => void) | undefined
  /** The studio's `fetch` with the Face ID step, or the page's own; the page's own is read at each call when absent. */
  readonly fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
}

/** The Host's error codes for a refused arrival. */
const ELEVATION_REQUIRED = 'ELEVATION_REQUIRED'
const LOOPBACK_REQUIRED = 'LOOPBACK_REQUIRED'

/**
 * Read the error code of a refusal.
 * @param response - a 403 answer.
 * @returns the `error` field, or undefined when the body is not JSON with one.
 */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  let body: unknown
  try {
    body = await response.json()
  } catch (_notJson) {
    // A refusal without JSON is treated like any other failure.
    return undefined
  }
  const code: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
  return typeof code === 'string' ? code : undefined
}

/**
 * Create the flow's client.
 * @param options - the unlock report and, for a test, the `fetch`.
 * @returns one request per route.
 */
export function createApi(options: ApiOptions): NewWorkspaceApi {
  /** Report a failure once, by route name only, unless the caller cancelled the request. */
  const fail = (route: RouteName, reason: ApiFailure, signal: AbortSignal | undefined): { readonly ok: false, readonly reason: ApiFailure } => {
    if (signal?.aborted !== true) console.warn(`delorun new workspace: ${route} failed (${reason})`)
    return { ok: false, reason }
  }
  const call = async <S extends z.ZodType>(route: RouteName, path: string, schema: S, body: object, signal?: AbortSignal): Promise<ApiResult<z.output<S>>> => {
    const send = options.fetch ?? globalThis.fetch
    let response: Response
    try {
      response = await send(path.slice(1), {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (_unreachable) {
      // The page could not ask, or the caller cancelled the request.
      return fail(route, 'failed', signal)
    }
    if (response.status === 403) {
      const code = await errorCodeOf(response)
      if (code === ELEVATION_REQUIRED) {
        options.unlockNeeded?.(route)
        return fail(route, 'locked', signal)
      }
      return fail(route, code === LOOPBACK_REQUIRED ? 'refused-arrival' : 'failed', signal)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch (_notJson) {
      // A body that is not JSON is a failure, whatever the status.
      return fail(route, 'failed', signal)
    }
    const parsed = schema.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : fail(route, 'failed', signal)
  }
  return {
    places: () => call('places', PLACES_PATH, PlacesAnswer, {}),
    search: (query, signal) => call('search', SEARCH_PATH, SearchAnswer, { query }, signal),
    preview: (path, signal) => call('preview', PREVIEW_PATH, PreviewAnswer, { path }, signal),
    add: path => call('add', ADD_WORKSPACE_PATH, AddWorkspaceAnswer, { path }),
    create: request => call('create', CREATE_PATH, CreateAnswer, request),
    clone: request => call('clone', CLONE_PATH, CloneStart, request),
    cloneStatus: job => call('cloneStatus', CLONE_STATUS_PATH, CloneStatus, { job }),
    defaults: path => call('defaults', DEFAULTS_PATH, DefaultsAnswer, { path }),
    setDefaults: (path, defaults) => call('setDefaults', SET_DEFAULTS_PATH, DefaultsAnswer, { path, defaults }),
    setNetwork: (path, network) => call('setNetwork', NETWORK_SET_PATH, NetworkAnswer, { path, network }),
  }
}
