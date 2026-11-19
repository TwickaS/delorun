/**
 * The Face ID step for every sensitive call a reach device sends: one mechanism for Remote calls and plugin Fetch calls.
 * A call the home refuses because it needs a grant opens the confirmation through `ctx.delorunFaceGrant` (Face ID, or
 * the PIN keypad first on a device with no passkey), mints a grant for exactly that call, and sends the call once more:
 *
 * - **Remote:** the gateway asks {@link remoteDenialLift} about a call refused with `elevation-required: …`; the grant is
 *   `{ action: <method>, hash: hashArgs(args) }`, with the terminal's or picker's hold for `terminal/create` and
 *   `directoryPicker/list`, and the same call is sent again (the home keeps the grant; nothing travels in a header).
 * - **Fetch:** {@link grantingFetch} reads a `403 ELEVATION_REQUIRED` answer whose body names its grant `action`; the grant
 *   is `{ action, hash: hashRequest(method, pathname + search, body) }`, and the request is sent again with `Delorun-Grant`.
 *
 * A cancelled confirmation sends nothing more and hands the refusal to the caller, whose own error shows. Neither path
 * opens the code-from-your-computer unlock. The home's own computer is never refused, so it never reaches either path.
 * @module @delorun/bundle-local/client/face-retry
 */
import type { FaceGrant, FaceGrantHold, FaceGrantRequest, GrantingFetch, RemoteDenialLift } from '@delorun/plugin-changes/face-grant'

/** The prefix of a Remote refusal a grant lifts: `elevation-required: <action>`. */
export const ELEVATION_REASON = 'elevation-required:'

/** The request header that names the grant a Fetch call uses. */
export const GRANT_HEADER = 'Delorun-Grant'

/** The id of the folder picker's hold: the home's `PICKER_HOLD_ID`, one per device. */
export const PICKER_HOLD_ID = 'directoryPicker'

/**
 * The terminal's metadata reads that come before `terminal/create` on a device holding no terminal hold in that chat.
 * One confirmation covers them together, with the same arguments, so opening a terminal asks once for them and once
 * for the terminal itself.
 */
export const TERMINAL_METADATA: readonly string[] = ['terminal/environment', 'terminal/shells', 'terminal/list']

/**
 * The hold a grant for one Remote call opens.
 * @param endpoint - the method, `<namespace>/<method>`.
 * @param args - the call's wire arguments; `terminal/create` names its terminal in `request.id`.
 * @returns the terminal's or the picker's hold, or undefined for a call that opens none.
 */
export function holdOfCall(endpoint: string, args: Readonly<Record<string, unknown>>): FaceGrantHold | undefined {
  if (endpoint === 'directoryPicker/list') return { feature: 'picker', id: PICKER_HOLD_ID }
  if (endpoint !== 'terminal/create') return undefined
  const request = args.request
  const id: unknown = typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : undefined
  return typeof id === 'string' && id !== '' ? { feature: 'terminal', id } : undefined
}

/**
 * One confirmation at a time: a request waits for the one before it to settle, so two calls refused together each get
 * their own confirmation instead of the second ending the first.
 * @param grant - the confirmation.
 * @returns the same confirmation, queued.
 */
export function oneAtATime(grant: FaceGrant): FaceGrant {
  let last: Promise<unknown> = Promise.resolve()
  return (request) => {
    const next = last.then(() => grant(request))
    // A failed confirmation does not hold up the next one.
    last = next.catch((_failed: unknown) => undefined)
    return next
  }
}

/**
 * The handler the gateway asks about a refused Remote call.
 * @param grant - the confirmation, already queued with {@link oneAtATime}.
 * @returns the handler: true once a grant for exactly this call is minted; false for a refusal no grant lifts or a
 *   cancelled confirmation.
 */
export function remoteDenialLift(grant: FaceGrant): RemoteDenialLift {
  return async ({ endpoint, reason, args }) => {
    if (reason?.startsWith(ELEVATION_REASON) !== true) return false
    const hold = holdOfCall(endpoint, args)
    const also = TERMINAL_METADATA.includes(endpoint) ? TERMINAL_METADATA.filter(action => action !== endpoint) : undefined
    const request: FaceGrantRequest = { action: endpoint, call: { args }, ...hold === undefined ? {} : { hold }, ...also === undefined ? {} : { also } }
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
    // A caller that sends its own grant asked for it itself; a body that is not text cannot be hashed here.
    const body = init?.body ?? ''
    if (headers.has(GRANT_HEADER) || typeof body !== 'string') return response
    const url = new URL(input, baseOf())
    const grantId = await grant({ action, call: { method: (init?.method ?? 'GET').toUpperCase(), path: `${url.pathname}${url.search}`, body } })
    if (grantId === undefined || init?.signal?.aborted === true) return response
    headers.set(GRANT_HEADER, grantId)
    return fetch(input, { ...init, headers })
  }
}
