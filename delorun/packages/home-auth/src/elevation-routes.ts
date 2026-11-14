/**
 * The elevation routes (C14, "Elevation"). A device asks for an elevation, reads its state and locks it from its own
 * studio on the reach listener its session lives on; the person at the home's own computer lists the requests and the
 * running elevations, approves a request by typing the device's code, and revokes one, through the loopback studio.
 *
 * - **Device routes** answer only a request admitted on a reach listener with a live session cookie of that listener,
 *   and a `POST` only from the studio's own origin (no foreign `Sec-Fetch-Site`, and an `Origin`, when sent, naming the
 *   request's own host). The session is read without rolling it: a roll answers only on a route the authenticator
 *   admits.
 * - **Computer routes** answer only the person at the computer ({@link personAtComputer}); a device reaching them over
 *   a reach listener is refused with `LOOPBACK_REQUIRED`, which is what keeps `elevation-approve` and `elevation-revoke`
 *   at the computer.
 *
 * @module @delorun/home-auth/elevation-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { REACH_SESSION_COOKIE, type ReachListenerId } from '@delorun/contract-admission'
import type { HomeAuth, TokenAdmission } from './home-auth.ts'
import { HomeAuthError } from './errors.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'

/** The elevation routes. */
export const ELEVATION_PATHS = {
  /** `GET`: the device's own state. */
  state: '/auth/elevation',
  /** `POST`: the device asks for an elevation. */
  request: '/auth/elevation/request',
  /** `POST`: the device ends its elevation and its waiting request. */
  lock: '/auth/elevation/lock',
  /** `GET`: the computer's list of waiting requests and running elevations. */
  pending: '/auth/elevation/pending',
  /** `POST` `{ requestId, typedCode }`: the computer approves a request. */
  approve: '/auth/elevation/approve',
  /** `POST` `{ id }`: the computer declines a request or ends an elevation. */
  revoke: '/auth/elevation/revoke',
} as const

/** A device's admitted session on the listener its request arrived on. */
export type DeviceSession = Extract<TokenAdmission, { readonly kind: 'admitted' }> & { readonly listener: ReachListenerId }

/**
 * The session token a request's cookie carries.
 * @param cookie - the `Cookie` header.
 * @returns the token, or undefined without one.
 */
function tokenOf(cookie: string | undefined): string | undefined {
  for (const pair of (cookie ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at !== -1 && pair.slice(0, at).trim() === REACH_SESSION_COOKIE) return pair.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Whether a state-changing request came from the studio's own page: no foreign `Sec-Fetch-Site`, and an `Origin`, when
 * sent, whose host is the request's own.
 * @param request - the request.
 * @returns whether it did.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  const origin = request.headers.origin
  return origin === undefined || URL.parse(origin)?.host === request.headers.host
}

/**
 * The admitted session of a device route's request, or the refusal answered.
 * @param auth - the home-auth instance.
 * @param request - the request.
 * @param response - the response, answered with the refusal.
 * @param method - the method the route takes.
 * @returns the session, or undefined when the response was answered.
 */
export function deviceSession(auth: HomeAuth, request: IncomingMessage, response: ServerResponse, method: 'GET' | 'POST'): DeviceSession | undefined {
  const listener = auth.arrivalOf(request).listener
  if (listener === undefined || listener === 'loopback') {
    sendError(response, new HomeAuthError('HOST_MISMATCH', 'This route answers a device on a reach address only'))
    return undefined
  }
  if (request.method !== method) {
    sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', `this route takes ${method}`))
    return undefined
  }
  if (method === 'POST' && !sameOrigin(request)) {
    sendError(response, new HomeAuthError('ORIGIN_MISMATCH', 'Unlocking answers only the studio\'s own page'))
    return undefined
  }
  const token = tokenOf(request.headers.cookie)
  const admission = token === undefined ? undefined : auth.admitToken(token, listener)
  if (admission?.kind !== 'admitted') {
    sendError(response, new HomeAuthError(admission?.code ?? 'NOT_SIGNED_IN', 'Sign in on this device first'))
    return undefined
  }
  return { ...admission, listener }
}

/**
 * Build the route a device reads its elevation state from.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function elevationStateHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'GET')
    if (device === undefined) return
    sendJson(response, 200, auth.elevationState(device.session.deviceId, device.listener))
  }
}

/**
 * Build the route a device asks for an elevation on; it answers the state with the code the device shows.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function elevationRequestHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'POST')
    if (device === undefined) return
    try {
      sendJson(response, 201, auth.requestElevation(device.sessionId, device.session))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route a device locks its elevation with.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function elevationLockHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'POST')
    if (device === undefined) return
    auth.lockElevation(device.session.deviceId, device.listener)
    sendJson(response, 200, auth.elevationState(device.session.deviceId, device.listener))
  }
}

/**
 * Build the route the computer lists the requests and the running elevations from.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function elevationPendingHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Approving an unlock', false)) return
    if (request.method !== 'GET') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET'))
      return
    }
    sendJson(response, 200, auth.elevationsAtComputer())
  }
}

/**
 * Build the route the computer approves a request on, with the code the person typed.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function elevationApproveHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Approving an unlock', request.method === 'POST')) return
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes POST'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.requestId !== 'string' || typeof message.typedCode !== 'string') {
        throw new HomeAuthError('BAD_REQUEST', 'an approval carries the request id and the typed code')
      }
      sendJson(response, 200, auth.approveElevation(message.requestId, message.typedCode))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route the computer declines a request or ends an elevation on.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function elevationRevokeHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Ending an unlock', request.method === 'POST')) return
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes POST'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.id !== 'string') throw new HomeAuthError('BAD_REQUEST', 'a revoke carries the request or elevation id')
      sendJson(response, 200, { revoked: auth.revokeElevation(message.id) })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}
