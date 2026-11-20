/**
 * The Face ID step for every sensitive call a reach device sends: one mechanism for Remote calls and plugin Fetch calls.
 * A call the home refuses because it needs a grant opens the confirmation through `ctx.delorunFaceGrant` (Face ID, or
 * the PIN keypad first on a device with no passkey), mints a grant for exactly that call, and sends the call once more:
 *
 * - **Remote:** the gateway asks {@link remoteDenialLift} about a call refused with `elevation-required: …`; the grant is
 *   `{ action: <method>, hash: hashArgs(args) }`, with the terminal's or picker's hold for `terminal/create`,
 *   `terminal/attach` and `directoryPicker/list`, and the same call is sent again (the home keeps the grant; nothing travels in a header).
 * - **Fetch:** {@link grantingFetch} reads a `403 ELEVATION_REQUIRED` answer whose body names its grant `action`; the grant
 *   is `{ action, hash: hashRequest(method, pathname + search, body) }`, and the request is sent again with `Delorun-Grant`.
 *
 * A cancelled confirmation sends nothing more and hands the refusal to the caller, whose own error shows. Neither path
 * opens the code-from-your-computer unlock. The home's own computer is never refused, so it never reaches either path.
 * The calls of {@link NEVER_ASKED} are never asked about: the studio sends them without a tap. Every confirmation of the
 * page, these and the Changes, Update and approval ones, waits its turn in one {@link ConfirmationQueue}.
 * @module @delorun/bundle-local/client/face-retry
 */
import { PASS_GRANT_ID, type FaceGrant, type FaceGrantHold, type FaceGrantRequest, type GrantingFetch } from '@delorun/plugin-changes/face-grant'

/** The fields of the gateway's `RemoteDenialQuestion` the Face ID step reads: a refused Remote call or stream open. */
export interface RefusedRemoteCall {
  /** The refused `<namespace>/<method>`. */
  readonly endpoint: string
  /** The policy's reason, such as `elevation-required: terminal/create`; undefined when absent. */
  readonly reason: string | undefined
  /** The call's wire arguments, exactly as they were sent and will be sent again. */
  readonly args: Readonly<Record<string, unknown>>
  /** The call's cancellation, which skips or closes its confirmation. */
  readonly signal: AbortSignal
}

/** A handler for the gateway's `ctx.remote.$liftDenials`: true sends the refused call once more. */
export type RemoteDenialHandler = (denial: RefusedRemoteCall) => Promise<boolean>

/** The prefix of a Remote refusal a grant lifts: `elevation-required: <action>`. */
export const ELEVATION_REASON = 'elevation-required:'

/** The request header that names the grant a Fetch call uses. */
export const GRANT_HEADER = 'Delorun-Grant'

/** The id of the folder picker's hold: the home's `PICKER_HOLD_ID`, one per device. */
export const PICKER_HOLD_ID = 'directoryPicker'

/**
 * The Remote methods the Face ID step never asks about, with why: the studio sends each on load, on reconnect, on a
 * home broadcast, on a timer or from a model-written plugin's own code, never from a tap, so a sheet for one would be a
 * sheet nobody asked for. Each stays refused on a phone, and its surface works at the computer.
 */
export const NEVER_ASKED = {
  'dynamicCordisRunner/syncInspectManifest': 'publishes the page\'s inspect providers on load and on every reconnect',
  'dynamicCordisRunner/resolveInspectQuery': 'answers an inspect query the home broadcasts',
  'dynamicCordisRunner/reportRenderFailure': 'reports a model-written plugin\'s render failure on its own',
  'dynamicCordisRunner/reportClientGuardFailure': 'reports a model-written plugin\'s guard failure on its own',
  'dynamicCordisRunner/inventory': 'reads the model-written plugins on load, on reconnect and on each home broadcast about them',
  'dynamicCordisRunner/runHostHalf': 'starts a run, also on its own for an automatic activation the home broadcasts; one run makes several of these calls',
  'dynamicCordisRunner/getClientCode': 'loads a run\'s browser code as the step after runHostHalf',
  'dynamicCordisRunner/invoke': 'is called by a model-written plugin\'s own code, on its own timers',
  'dynamicCordisRunner/resolveRequestRun': 'answers the home\'s run request as the last step of a run',
  'dynamicCordisRunner/settleUserRun': 'settles a run as its last step',
  'terminal/watch': 'the chat header opens the roster of the chat\'s terminals on every chat view',
  'terminal/retain': 'keeps every saved terminal tab alive on load and on reconnect, on screen or not; the terminal view on screen asks through terminal/attach, whose grant opens the hold this call then rides',
} as const satisfies Readonly<Record<string, string>>

/** One confirmation at a time across the page. */
export interface ConfirmationQueue {
  /**
   * Run one confirmation once the one before it has settled.
   * @param confirm - shows the confirmation and settles when the person answers.
   * @returns what the confirmation settled with.
   */
  readonly run: <T>(confirm: () => Promise<T>) => Promise<T>
}

/**
 * Create the page's queue.
 * @returns a queue in which a failed confirmation does not hold up the next one.
 */
export function confirmationQueue(): ConfirmationQueue {
  let last: Promise<unknown> = Promise.resolve()
  return {
    run: (confirm) => {
      const next = last.then(confirm)
      // A failed confirmation does not hold up the next one.
      last = next.catch((_failed: unknown) => undefined)
      return next
    },
  }
}

/**
 * The hold a grant for one Remote call opens.
 * @param endpoint - the method, `<namespace>/<method>`.
 * @param args - the call's wire arguments; `terminal/create` names its terminal in `request.id`, `terminal/attach` in `id`.
 * @returns the terminal's or the picker's hold, or undefined for a call that opens none.
 */
export function holdOfCall(endpoint: string, args: Readonly<Record<string, unknown>>): FaceGrantHold | undefined {
  if (endpoint === 'directoryPicker/list') return { feature: 'picker', id: PICKER_HOLD_ID }
  if (endpoint !== 'terminal/create' && endpoint !== 'terminal/attach') return undefined
  const named = endpoint === 'terminal/create' ? args.request : args
  const id: unknown = typeof named === 'object' && named !== null ? Reflect.get(named, 'id') : undefined
  return typeof id === 'string' && id !== '' ? { feature: 'terminal', id } : undefined
}

/**
 * One confirmation at a time: a request waits for the one before it to settle, so two calls refused together each get
 * their own confirmation instead of the second ending the first. A request whose call was cancelled while it waited is
 * skipped.
 * @param grant - the confirmation.
 * @param queue - the page's queue; a new one by default.
 * @returns the same confirmation, queued.
 */
export function oneAtATime(grant: FaceGrant, queue: ConfirmationQueue = confirmationQueue()): FaceGrant {
  // A call cancelled while it waited needs no confirmation.
  return request => queue.run(async () => request.signal?.aborted === true ? undefined : await grant(request))
}

/**
 * The handler the gateway asks about a refused Remote call.
 * @param grant - the confirmation, already queued with {@link oneAtATime}.
 * @returns the handler: true once a grant for exactly this call is minted; false for a refusal no grant lifts, a call of
 *   {@link NEVER_ASKED} (which never joins the queue) or a cancelled confirmation.
 */
export function remoteDenialLift(grant: FaceGrant): RemoteDenialHandler {
  return async ({ endpoint, reason, args, signal }) => {
    if (reason?.startsWith(ELEVATION_REASON) !== true || Object.hasOwn(NEVER_ASKED, endpoint)) return false
    const hold = holdOfCall(endpoint, args)
    const request: FaceGrantRequest = { action: endpoint, call: { args }, signal, ...hold === undefined ? {} : { hold } }
    return await grant(request) !== undefined
  }
}

/**
 * The grant action a refused Fetch answer names.
 * @param response - the answer.
 * @returns the action of a `403 ELEVATION_REQUIRED` that names one, otherwise undefined.
 */
async function liftableActionOf(response: Response): Promise<string | undefined> {
  if (response.status !== 403) return undefined
  let body: unknown
  try {
    body = await response.clone().json()
  } catch (_notJson) {
    // An answer that is not JSON names no action.
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const code: unknown = Reflect.get(body, 'error') ?? Reflect.get(body, 'code')
  const action: unknown = Reflect.get(body, 'action')
  return code === 'ELEVATION_REQUIRED' && typeof action === 'string' && action !== '' ? action : undefined
}

/**
 * The page's `fetch` with the Face ID step.
 * @param fetch - the page's `fetch`.
 * @param grant - the confirmation, already queued with {@link oneAtATime}.
 * @param baseOf - the document's base URL, which a relative path is resolved against for the hash.
 * @returns the function: the first answer, or the answer to the granted request sent once more.
 */
export function grantingFetch(fetch: GrantingFetch, grant: FaceGrant, baseOf: () => string = () => globalThis.document.baseURI): GrantingFetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    const action = await liftableActionOf(response)
    if (action === undefined) return response
    const headers = new Headers(init?.headers)
    // A caller that sends its own grant asked for it itself, except one that relied on the page's Face ID pass: the home
    // refusing that means the pass ended, so the call is asked with a sheet. A body that is not text cannot be hashed here.
    const body = init?.body ?? ''
    if ((headers.has(GRANT_HEADER) && headers.get(GRANT_HEADER) !== PASS_GRANT_ID) || typeof body !== 'string') return response
    const url = new URL(input, baseOf())
    const grantId = await grant({ action, call: { method: (init?.method ?? 'GET').toUpperCase(), path: `${url.pathname}${url.search}`, body }, ...init?.signal == null ? {} : { signal: init.signal } })
    if (grantId === undefined || init?.signal?.aborted === true) return response
    headers.set(GRANT_HEADER, grantId)
    return fetch(input, { ...init, headers })
  }
}
