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
import { claimLabelOf, deviceIdOf, devicePublicKeyOf } from './records.ts'
import { arrivedOnLoopback, cameFromOwnOrigin, readMessage, sendError, sendJson, sendThrown, type RouteHandler } from './routes.ts'

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

/** The sign-in page. Its text is the page's own, in English; it loads only the two assets and no plugin code. */
const SIGN_IN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Delorun</title>
<link rel="stylesheet" href="/auth/assets/${STYLE[0]}">
<script type="module" src="/auth/assets/${SCRIPT[0]}"></script>
</head>
<body>
<main>
<h1>Sign in to Delorun</h1>
<section data-step="start"><p>Checking this device…</p></section>
<section data-step="request" hidden>
<p>This device is not approved for this home yet. On the home's computer, open the studio's settings and choose <strong>Add a device</strong>, or run <code>delorun devices approve</code>. Then name this device and ask for approval here.</p>
<form id="request-form">
<label>Name of this device <input id="label" required maxlength="64" value="My phone"></label>
<button type="submit">Ask for approval</button>
</form>
</section>
<section data-step="code" hidden>
<p>Type this code at the home's computer:</p>
<p id="match-code"></p>
<p>This page signs you in once the home approves the code.</p>
</section>
<p id="error" role="alert"></p>
</main>
</body>
</html>
`

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

/**
 * Build the sign-in page route.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function signInPageHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (reachArrival(auth, request, response) === undefined || !method(request, response, 'GET')) return
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
        const platform = typeof message.platform === 'string' ? message.platform.slice(0, DEVICE_APPROVAL_LIMITS.platformMaxChars) : ''
        const accepted = await auth.requestApproval({
          devicePublicKey,
          deviceId: deviceIdOf(devicePublicKey),
          deviceNonce: brandString<Base64Url>(deviceNonce),
          label: claimLabelOf(message.label),
          platform,
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
 * @returns the handler.
 */
export function windowHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (!arrivedOnLoopback(auth, request, response, 'Adding a device')) return
    if (!method(request, response, 'POST') || !cameFromOwnOrigin(request, response)) return
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
 * @returns the handler.
 */
export function pendingHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (!arrivedOnLoopback(auth, request, response, 'Approving a device')) return
    if (!method(request, response, 'GET')) return
    sendJson(response, 200, { windowClosesAt: auth.approvals.windowOpenUntil() ?? null, pending: auth.pendingApprovals() })
  }
}

/**
 * Build the local approval route.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function approveHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (!arrivedOnLoopback(auth, request, response, 'Approving a device')) return
    if (!method(request, response, 'POST') || !cameFromOwnOrigin(request, response)) return
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
  return new URL(request.url ?? '/', 'http://route.invalid').pathname
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
