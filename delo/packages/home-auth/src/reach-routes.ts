/**
 * The routes of reach sign-in and of approval at the home's own computer.
 *
 * Pre-login routes, answered only on a reach listener (a request that did not arrive on one is refused with
 * `421 HOST_MISMATCH`):
 *
 * - `GET /auth/sign-in` and `GET /auth/assets/<asset>`: the sign-in page and its two built assets, resolved against a
 *   fixed table of names.
 * - `POST /auth/device/request`: an approval request, refused with `APPROVALS_CLOSED` before its body is read while no
 *   approval window is open.
 * - `GET /auth/device/request/<request id>`: the request's state, read with `Authorization: Delo-Request <secret>`.
 * - `POST /auth/device/challenge` and `POST /auth/session`: sign-in. A session cookie the request carries names the
 *   session a sign-in rotates.
 *
 * Routes of the home's own computer, answered only on the loopback listener under a loopback `Host`, with state changes
 * refused from another origin; a request a reach listener admitted is answered `403 LOOPBACK_REQUIRED` naming the
 * action:
 *
 * - `POST /auth/devices/window`: "Add a device" opens the approval window.
 * - `GET /auth/devices/pending`: the window and the pending requests the approval form shows.
 * - `POST /auth/devices/approve`: the local approval, with the match code the person typed.
 *
 * @module @delo/home-auth/reach-routes
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type DeviceId, type PreLoginRoute, type ReachListenerId } from '@delo/contract-admission'
import { DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION, type Base64Url } from '@delo/contract-device-approval'
import type { HomeAuth } from './home-auth.ts'
import { HomeAuthError } from './errors.ts'
import { claimLabelOf, deviceIdOf, devicePublicKeyOf, platformOf } from './records.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'
import { plainPathname } from './reach-paths.ts'

/** The pre-login routes this package answers on every reach listener it serves, which is each listener's allowlist. */
export const REACH_PRE_LOGIN_ROUTES: readonly PreLoginRoute[] = [
  { method: 'GET', path: '/auth/sign-in' },
  { method: 'GET', path: '/auth/assets/<asset>' },
  { method: 'POST', path: '/auth/device/request' },
  { method: 'GET', path: '/auth/device/request/<request id>' },
  { method: 'POST', path: '/auth/device/challenge' },
  { method: 'POST', path: '/auth/session' },
  { method: 'POST', path: '/auth/owner/claim' },
]

/** Paths of the routes this module registers. */
export const REACH_PATHS = {
  signIn: '/auth/sign-in',
  assets: '/auth/assets',
  request: '/auth/device/request',
  challenge: '/auth/device/challenge',
  session: '/auth/session',
  window: '/auth/devices/window',
  pending: '/auth/devices/pending',
  approve: '/auth/devices/approve',
  cancel: '/auth/devices/cancel',
} as const

/** A built asset of the sign-in page. */
interface Asset {
  readonly type: string
  readonly body: Buffer
}

/**
 * Read one asset and name it by its content hash.
 * @param file - the file name under `assets/`.
 * @param type - its content type.
 * @returns the hashed name and the asset.
 */
function asset(file: string, type: string): [string, Asset] {
  const body = readFileSync(new URL(`../assets/${file}`, import.meta.url))
  const [stem, extension] = file.split('.') as [string, string]
  return [`${stem}-${createHash('sha256').update(body).digest('hex').slice(0, 12)}.${extension}`, { type, body }]
}

const SCRIPT = asset('sign-in.js', 'text/javascript; charset=utf-8')
const STYLE = asset('sign-in.css', 'text/css; charset=utf-8')

/** The sign-in page's assets by their content-hashed names: the only names the asset route answers. */
export const SIGN_IN_ASSETS: ReadonlyMap<string, Asset> = new Map([SCRIPT, STYLE])

/** The sign-in page's markup, `assets/sign-in.html`, with its two placeholders. */
const PAGE_TEMPLATE = readFileSync(new URL('../assets/sign-in.html', import.meta.url), 'utf8')

/**
 * The sign-in page: `assets/sign-in.html` with the paths of the two assets in place of `{{style}}` and `{{script}}`.
 * It holds markup only, and every text comes from the copy table of `assets/sign-in.js`, in the browser's language; it
 * loads only the two assets and no plugin code, and has no inline script, style or event handler.
 */
export const SIGN_IN_PAGE = PAGE_TEMPLATE
  .replace('{{style}}', `${REACH_PATHS.assets}/${STYLE[0]}`)
  .replace('{{script}}', `${REACH_PATHS.assets}/${SCRIPT[0]}`)

/**
 * The reach listener a request was admitted on, or a refusal: every pre-login route answers only on a reach listener.
 * @param auth - the home-auth instance.
 * @param request - the request.
 * @param response - the response, answered when the arrival is not a reach listener.
 * @returns the listener, or undefined when the response was answered.
 */
function reachArrival(auth: HomeAuth, request: IncomingMessage, response: ServerResponse): ReachListenerId | undefined {
  const listener = auth.arrivalOf(request).listener
  if (listener === undefined || listener === 'loopback') {
    sendError(response, new HomeAuthError('HOST_MISMATCH', 'This route answers on a reach address only'))
    return undefined
  }
  return listener
}

/**
 * Answer a request whose method the route does not take.
 * @param request - the request.
 * @param response - the response.
 * @param method - the method the route takes.
 * @returns whether the method is the route's.
 */
function method(request: IncomingMessage, response: ServerResponse, method: 'GET' | 'POST'): boolean {
  if (request.method === method) return true
  sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', `this route takes ${method}`))
  return false
}

/** The query parameter of the sign-in page that names where a device lands once it is signed in. */
export const NEXT_PARAMETER = 'next'

/** The longest landing target the sign-in page carries; a longer one lands on the studio's page instead. */
const MAX_NEXT_LENGTH = 2048

/**
 * Where a signed-in device may land after the sign-in page: a request target on the reach address's own origin that names
 * exactly one plain path ({@link plainPathname}) outside `/auth`, so the page can send the device back where it aimed and
 * nowhere else. An absolute or scheme-relative URL, a backslash, a dot segment, an escaped separator, a control
 * character or a space has no landing.
 * @param target - the candidate, origin-form, with its query.
 * @returns the target, or undefined when it may not be a landing.
 */
export function landingOf(target: string): string | undefined {
  if (target.length > MAX_NEXT_LENGTH || /[\\\u0000-\u0020\u007f]/u.test(target)) return undefined
  const pathname = plainPathname(target)
  if (pathname === undefined || pathname === '/' || pathname === '/auth' || pathname.startsWith('/auth/')) return undefined
  return target
}

/**
 * The sign-in page's address for a browser that opened `target` without a session: the page alone, or with the target
 * as its landing when {@link landingOf} accepts it.
 * @param target - the request target the browser opened, origin-form.
 * @returns the same-origin path the authenticator redirects the browser to.
 */
export function signInLocation(target: string): string {
  const landing = landingOf(target)
  return landing === undefined ? REACH_PATHS.signIn : `${REACH_PATHS.signIn}?${NEXT_PARAMETER}=${encodeURIComponent(landing)}`
}

/**
 * Build the sign-in page route. A `next` the page may not land on is answered with `303` to the page without it, so the
 * page's script reads only a landing this route accepted.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function signInPageHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (reachArrival(auth, request, response) === undefined || !method(request, response, 'GET')) return
    const next = new URL(targetOf(request), 'http://route.invalid').searchParams.getAll(NEXT_PARAMETER)
    if (next.length > 1 || (next.length === 1 && landingOf(next[0] ?? '') === undefined)) {
      response.statusCode = 303
      response.setHeader('location', REACH_PATHS.signIn)
      response.setHeader('cache-control', 'no-store')
      response.end()
      return
    }
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(SIGN_IN_PAGE)
  }
}

/**
 * Build the asset route. The segment is looked up in {@link SIGN_IN_ASSETS} as it arrived, never decoded and joined to
 * a directory path.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function assetHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (reachArrival(auth, request, response) === undefined || !method(request, response, 'GET')) return
    const name = pathnameOf(request).slice(REACH_PATHS.assets.length + 1)
    const found = SIGN_IN_ASSETS.get(name)
    if (found === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    response.statusCode = 200
    response.setHeader('content-type', found.type)
    response.end(found.body)
  }
}

/**
 * Build the approval request route and its state route, which share a path: `POST` creates, `GET <path>/<id>` reads.
 * @param auth - the home-auth instance.
 * @returns the handler for the path and its one-segment children.
 */
export function approvalRequestHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const listener = reachArrival(auth, request, response)
    if (listener === undefined) return
    const pathname = pathnameOf(request)
    try {
      if (pathname === REACH_PATHS.request) {
        if (!method(request, response, 'POST')) return
        // C5: outside a window the request is refused before its body is read.
        auth.approvals.assertWindowOpen()
        const message = await readMessage(request, response)
        if (message === undefined) return
        if (message.v !== DEVICE_APPROVAL_VERSION) throw new HomeAuthError('BAD_REQUEST', 'this home reads version 1 messages only')
        const devicePublicKey = devicePublicKeyOf(message.devicePublicKey, 'BAD_REQUEST')
        const deviceNonce = message.deviceNonce
        if (typeof deviceNonce !== 'string' || Buffer.from(deviceNonce, 'base64url').length !== DEVICE_APPROVAL_LIMITS.nonceBytes) {
          throw new HomeAuthError('BAD_REQUEST', 'a request carries a 16-byte device nonce')
        }
        const accepted = await auth.requestApproval({
          devicePublicKey,
          deviceId: deviceIdOf(devicePublicKey),
          deviceNonce: brandString<Base64Url>(deviceNonce),
          label: claimLabelOf(message.label),
          platform: platformOf(message.platform),
        }, { listener, source: auth.arrivalOf(request).source })
        sendJson(response, 201, accepted)
        return
      }
      if (!method(request, response, 'GET')) return
      const id = pathname.slice(REACH_PATHS.request.length + 1)
      const presented = /^Delo-Request (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
      sendJson(response, 200, { state: auth.approvalState(id, presented) })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the challenge route.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function challengeHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const listener = reachArrival(auth, request, response)
    if (listener === undefined || !method(request, response, 'POST')) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      const challenge = await auth.challenge(deviceIdField(message.deviceId), listener)
      sendJson(response, 200, { challenge })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the session route: creation from a device-key signature, or the rotation of the session the request's cookie
 * names. It sets the session cookie C4 defines.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function sessionHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const listener = reachArrival(auth, request, response)
    if (listener === undefined || !method(request, response, 'POST')) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.challenge !== 'string' || typeof message.signature !== 'string') {
        throw new HomeAuthError('BAD_REQUEST', 'a sign-in carries the challenge and its signature')
      }
      const rotate = sessionCookieOf(request.headers.cookie)
      const signedIn = await auth.signIn({
        deviceId: deviceIdField(message.deviceId),
        challenge: message.challenge,
        signature: message.signature,
        listener,
        ...(rotate === undefined ? {} : { rotate }),
      })
      response.setHeader('set-cookie', sessionCookie(signedIn.token, signedIn.expiresAt, Date.now()))
      sendJson(response, 201, { sessionId: signedIn.sessionId, expiresAt: signedIn.expiresAt })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route that opens the approval window: "Add a device" in the loopback studio.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function windowHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Adding a device', request.method === 'POST')) return
    if (!method(request, response, 'POST')) return
    try {
      sendJson(response, 200, { closesAt: await auth.openApprovalWindow() })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route the approval form reads: whether the window is open and the pending requests.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function pendingHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Approving a device', false)) return
    if (!method(request, response, 'GET')) return
    sendJson(response, 200, { windowClosesAt: auth.approvals.windowOpenUntil() ?? null, pending: auth.pendingApprovals() })
  }
}

/**
 * Build the local approval route.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function approveHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Approving a device', request.method === 'POST')) return
    if (!method(request, response, 'POST')) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.requestId !== 'string' || typeof message.typedCode !== 'string') {
        throw new HomeAuthError('BAD_REQUEST', 'an approval carries the request id and the typed code')
      }
      const device = await auth.approveLocally(message.requestId, message.typedCode)
      sendJson(response, 200, { device: { id: device.id, label: device.label, address: device.address } })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route that cancels a pending request at the home's own computer: "Cancel" beside a waiting device in the
 * loopback studio, which frees its place among the 5 pending.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function cancelHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Cancelling a device request', request.method === 'POST')) return
    if (!method(request, response, 'POST')) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.requestId !== 'string') throw new HomeAuthError('BAD_REQUEST', 'a cancellation carries the request id')
      auth.approvals.cancel(message.requestId)
      sendJson(response, 200, { cancelled: message.requestId })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * C4's session cookie: host-only, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, for the seconds left to the absolute
 * expiry.
 * @param token - the session token.
 * @param expiresAt - the absolute expiry, in milliseconds since the epoch.
 * @param now - the time, in milliseconds since the epoch.
 * @returns the complete `Set-Cookie` value.
 */
export function sessionCookie(token: string, expiresAt: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `${REACH_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}`
}

/**
 * A request's path.
 * @param request - the request, whose target node:http always sets.
 * @returns the path, without the query.
 */
export function pathnameOf(request: { readonly url?: string | undefined }): string {
  return new URL(targetOf(request), 'http://route.invalid').pathname
}

/**
 * A request's target, origin-form with its query.
 * @param request - the request, whose target node:http always sets.
 * @returns the target, `/` without one.
 */
export function targetOf(request: { readonly url?: string | undefined }): string {
  return request.url ?? '/'
}

/**
 * Read a message's device id.
 * @param value - the field.
 * @returns the id.
 * @throws {HomeAuthError} `BAD_REQUEST` when it is not a 43-character base64url text.
 */
function deviceIdField(value: unknown): DeviceId {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HomeAuthError('BAD_REQUEST', 'a sign-in carries the device id')
  return brandString<DeviceId>(value)
}

/**
 * The session token a request's cookie carries.
 * @param cookie - the `Cookie` header.
 * @returns the token, or undefined without one.
 */
function sessionCookieOf(cookie: string | undefined): string | undefined {
  for (const pair of (cookie ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at !== -1 && pair.slice(0, at).trim() === REACH_SESSION_COOKIE) return pair.slice(at + 1).trim()
  }
  return undefined
}
