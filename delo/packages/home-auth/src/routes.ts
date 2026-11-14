/**
 * The routes the owner's claim and the device list answer on: `POST /auth/owner/claim`, `GET /auth/devices` and
 * `POST /auth/devices/remove`, plus the refusal a reach listener answers a claim with.
 *
 * Every one of the three routes decides where its request arrived before it reads the body: a request that did not arrive
 * on the loopback listener, or that arrived under a `Host` naming another address, is refused. For the claim, C5 requires
 * `403 OWNER_CLAIM_LOOPBACK_ONLY` and a sentence naming the loopback listener and SSH port forwarding, whatever the body
 * holds; the device list and the removal answer the same kind of refusal with `421 HOST_MISMATCH`, and the removal
 * additionally refuses a browser request that came from another origin with `403 ORIGIN_MISMATCH`. Without those checks a
 * page on another site reaches the home's records through a name that resolves to `127.0.0.1` — DNS rebinding — or posts
 * the removal across sites. The device list and the removal are owner-only, so an unclaimed home answers `403 NO_OWNER`
 * rather than an empty list.
 *
 * @module @delo/home-auth/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId } from '@delo/contract-admission'
import { DEVICE_APPROVAL_VERSION } from '@delo/contract-device-approval'
import type { HomeAuth } from './home-auth.ts'
import { HomeAuthError, refusalBody, STRUCTURED_REFUSALS } from './errors.ts'
import { isForeignFetchSite, isLoopbackHost, isSameLoopbackOrigin, loopbackAddressOf } from '@delo/home'
import { isRecord } from './files.ts'
import { devicePublicKeyOf } from './records.ts'

/** The claim route, C5's `POST /auth/owner/claim`. */
export const OWNER_CLAIM_PATH = '/auth/owner/claim' as const

/** The device list route. */
export const DEVICES_PATH = '/auth/devices' as const

/** The route that revokes one device. */
export const DEVICE_REMOVE_PATH = '/auth/devices/remove' as const

/** The largest message body a route reads, in bytes; C5's claim carries a key, a code and a label. */
export const MAX_BODY_BYTES = 16 * 1024

/** The sentence a claim that did not arrive on loopback is answered with, which C5 requires to name loopback and SSH port forwarding. */
const LOOPBACK_ONLY_SENTENCE = 'Claim the home on its own computer, at the loopback listener, or through SSH port forwarding to it; a reach address cannot claim a home'

/** The sentence the device routes answer a request that did not arrive on the loopback listener with. */
const DEVICE_ROUTE_SENTENCE = 'Read and remove devices on the home\'s own computer, at the loopback listener, or through SSH port forwarding to it; this route answers no other address'

/** The sentence a removal that came from another origin is answered with. */
const FOREIGN_ORIGIN_SENTENCE = 'Remove a device from the studio open on the home itself; a page on another address cannot remove one'

/** The sentence a claim whose `Host` is no loopback authority is answered with. */
const NO_AUTHORITY_SENTENCE = 'A claim names the loopback listener\'s own address as its Host, such as 127.0.0.1:3080'

/** A request handler, as the web server takes it. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/**
 * The loopback credential check upstream's own routes use: `connection.requestRejection(request)`, which applies the
 * Host and Origin fence and requires the browser's signed launch cookie or a live API credential.
 * @param request - the request.
 * @returns `401` or `403` to refuse it, or undefined when it carries the credential.
 */
export type LoopbackCredential = (request: IncomingMessage) => 401 | 403 | undefined

/** The sentence a request without the loopback credential is answered with. */
const NO_CREDENTIAL_SENTENCE = 'Open the studio on the home\'s own computer from the address delorun start printed; this route needs the studio\'s own sign-in'

/** The sentence a state-changing request without the studio's own `Origin` is answered with. */
const NO_ORIGIN_SENTENCE = 'Change devices from the studio open on the home itself, or with delorun devices; a request that names no studio origin cannot'

/**
 * The refusal a reach listener answers `POST /auth/owner/claim` with, before it reads the body: C5 requires
 * `OWNER_CLAIM_LOOPBACK_ONLY` and a sentence naming the loopback listener and SSH port forwarding.
 * @returns the status and the body a dispatcher writes for a claim on a reach listener.
 */
export function reachClaimRefusal(): { readonly status: number; readonly body: string } {
  return {
    status: new HomeAuthError('OWNER_CLAIM_LOOPBACK_ONLY', LOOPBACK_ONLY_SENTENCE).status,
    body: refusalBody('OWNER_CLAIM_LOOPBACK_ONLY', LOOPBACK_ONLY_SENTENCE),
  }
}

/**
 * Build the claim route.
 * @param auth - the home-auth instance to claim with.
 * @returns the handler for {@link OWNER_CLAIM_PATH}.
 */
export function claimHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const arrival = auth.arrivalOf(request)
    // C5: the arrival is decided before the body is read, and its refusal names what to do instead.
    if (arrival.listener !== 'loopback' || !isLoopbackHost(arrival.host)) {
      sendError(response, new HomeAuthError('OWNER_CLAIM_LOOPBACK_ONLY', LOOPBACK_ONLY_SENTENCE))
      return
    }
    // The address a claim records is the listener's own origin, whatever spelling of loopback the request used. A header
    // that is no authority at all — userinfo, a path, a query, an impossible port — is refused before the body is read,
    // so a header an attacker wrote is never written to the device record.
    const address = loopbackAddressOf(arrival.host)
    if (address === undefined) {
      sendError(response, new HomeAuthError('BAD_REQUEST', NO_AUTHORITY_SENTENCE))
      return
    }
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'Claim the home with a POST to /auth/owner/claim'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (message.v !== DEVICE_APPROVAL_VERSION) {
        sendError(response, new HomeAuthError('BAD_REQUEST', 'this home reads version 1 messages only'))
        return
      }
      if (typeof message.ownerCode !== 'string' || typeof message.label !== 'string') {
        sendError(response, new HomeAuthError('BAD_REQUEST', 'a claim carries the owner code and the device label'))
        return
      }
      const claim = await auth.claim({
        ...arrival,
        ownerCode: message.ownerCode,
        devicePublicKey: devicePublicKeyOf(message.devicePublicKey, 'BAD_REQUEST'),
        label: message.label,
        address,
      })
      sendJson(response, 201, {
        owner: { claimedAt: claim.owner.claimedAt, firstDeviceId: claim.owner.firstDeviceId },
        device: { id: claim.device.id, label: claim.device.label, address: claim.device.address },
      })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the device list route.
 * @param auth - the home-auth instance to list from.
 * @param credential - the loopback credential check.
 * @returns the handler for {@link DEVICES_PATH}.
 */
export function devicesHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    // The listing names the owner and every device, so it answers on the loopback listener only, under a `Host` that
    // names it, to the studio's own credential: a rebinding name reaches this port while its `Host` still says whose
    // page asked, and any local process reaches the port at all.
    if (!personAtComputer(auth, credential, request, response, 'The device list', false)) return
    if (request.method !== 'GET') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'Read the device list with a GET to /auth/devices'))
      return
    }
    try {
      sendJson(response, 200, await auth.devices())
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route that revokes one device.
 * @param auth - the home-auth instance to revoke with.
 * @param credential - the loopback credential check.
 * @returns the handler for {@link DEVICE_REMOVE_PATH}.
 */
export function removeDeviceHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    // Removing a device ends its sessions, so the arrival is decided before anything is read: a foreign `Host` is a
    // rebinding name, a request without the studio's credential is a local program, and a foreign or absent `Origin` or
    // a cross-site fetch is a page the person never asked to remove anything.
    if (request.method !== 'POST') {
      if (!personAtComputer(auth, credential, request, response, 'Removing a device', false)) return
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'Remove a device with a POST to /auth/devices/remove'))
      return
    }
    if (!personAtComputer(auth, credential, request, response, 'Removing a device', true)) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (message.v !== DEVICE_APPROVAL_VERSION || typeof message.deviceId !== 'string' || message.deviceId === '') {
        sendError(response, new HomeAuthError('BAD_REQUEST', 'a removal carries the device id'))
        return
      }
      const result = await auth.revokeDevice(brandString<DeviceId>(message.deviceId))
      sendJson(response, 200, result)
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Answer a request that did not arrive on the loopback listener under a `Host` naming it, which both device routes
 * require: the loopback listener is the only place this home claims, lists and removes devices, and the `Host` answer is
 * what keeps a page on another origin, reached through a name that resolves to `127.0.0.1`, away from the records.
 * A request a reach listener admitted is answered `403 LOOPBACK_REQUIRED` naming the action, which is what the remote
 * studio shows; any other foreign arrival is answered `421 HOST_MISMATCH`.
 * @param auth - the home-auth instance, which decides the arrival.
 * @param request - the request.
 * @param response - the response, answered with the refusal when the arrival is foreign.
 * @param action - the action's name as the refusal states it, in sentence case.
 * @returns whether the route may answer the request.
 */
export function arrivedOnLoopback(auth: HomeAuth, request: IncomingMessage, response: ServerResponse, action = 'This'): boolean {
  const host = request.headers.host
  const listener = auth.arrivalOf(request).listener
  // A request a reach listener admitted carries a session of a remote device: the home names what it needs instead.
  if (listener !== undefined && listener !== 'loopback') {
    sendError(response, new HomeAuthError('LOOPBACK_REQUIRED', `${action} needs you at your computer: open the studio on the home's own computer`))
    return false
  }
  if (listener !== 'loopback' || !isLoopbackHost(host) || loopbackAddressOf(host) === undefined) {
    sendError(response, new HomeAuthError('HOST_MISMATCH', DEVICE_ROUTE_SENTENCE))
    return false
  }
  return true
}

/**
 * Decide that a request comes from the person at the home's computer: it arrived on the loopback listener under a
 * loopback `Host` ({@link arrivedOnLoopback}), it carries the studio's own credential as upstream's routes require it,
 * and, when it changes state, it names the studio's own loopback origin in `Origin` and no foreign `Sec-Fetch-Site`. A
 * local program without the launch cookie or an API credential is refused, and so is a state change whose `Origin` is
 * absent, because a browser always sends `Origin` with a `POST`.
 * @param auth - the home-auth instance, which decides the arrival.
 * @param credential - the loopback credential check.
 * @param request - the request.
 * @param response - the response, answered with the refusal.
 * @param action - the action's name as a refusal states it, in sentence case.
 * @param changesState - whether the request changes state.
 * @returns whether the route may answer the request.
 */
export function personAtComputer(auth: HomeAuth, credential: LoopbackCredential, request: IncomingMessage, response: ServerResponse, action: string, changesState: boolean): boolean {
  if (!arrivedOnLoopback(auth, request, response, action)) return false
  const rejection = credential(request)
  if (rejection !== undefined) {
    sendError(response, rejection === 401 ? new HomeAuthError('NOT_SIGNED_IN', NO_CREDENTIAL_SENTENCE) : new HomeAuthError('ORIGIN_MISMATCH', NO_CREDENTIAL_SENTENCE))
    return false
  }
  if (!changesState) return true
  if (!cameFromOwnOrigin(request, response)) return false
  if (!isSameLoopbackOrigin(request.headers.origin, request.headers.host)) {
    sendError(response, new HomeAuthError('ORIGIN_MISMATCH', NO_ORIGIN_SENTENCE))
    return false
  }
  return true
}

/**
 * Answer a state-changing request that a browser sent from another origin, or from a site the person did not open the
 * studio on: `Origin` must be the request's own loopback origin and `Sec-Fetch-Site` must not name a foreign one. A
 * client that sends neither header is a program rather than a page.
 * @param request - the request.
 * @param response - the response, answered with the refusal when the origin is foreign.
 * @returns whether the route may answer the request.
 */
export function cameFromOwnOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  if (isForeignFetchSite(request.headers['sec-fetch-site'])) {
    sendError(response, new HomeAuthError('ORIGIN_MISMATCH', FOREIGN_ORIGIN_SENTENCE))
    return false
  }
  const origin = request.headers.origin
  if (origin !== undefined && !isSameLoopbackOrigin(origin, request.headers.host)) {
    sendError(response, new HomeAuthError('ORIGIN_MISMATCH', FOREIGN_ORIGIN_SENTENCE))
    return false
  }
  return true
}

/**
 * Read one JSON object from a request body, refusing a body over {@link MAX_BODY_BYTES}.
 * @param request - the request.
 * @param response - the response, answered with a refusal and left open on failure.
 * @returns the message, or undefined when the body was refused.
 */
export async function readMessage(request: IncomingMessage, response: ServerResponse): Promise<Readonly<Record<string, unknown>> | undefined> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for await (const chunk of request) {
      const part = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array)
      bytes += part.byteLength
      if (bytes > MAX_BODY_BYTES) {
        sendError(response, new HomeAuthError('BAD_REQUEST', `a message is at most ${String(MAX_BODY_BYTES)} bytes`))
        request.destroy()
        return undefined
      }
      chunks.push(part)
    }
  } catch {
    sendError(response, new HomeAuthError('BAD_REQUEST', 'the request body could not be read'))
    return undefined
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    sendError(response, new HomeAuthError('BAD_REQUEST', 'a message is a JSON object'))
    return undefined
  }
  if (!isRecord(value)) {
    sendError(response, new HomeAuthError('BAD_REQUEST', 'a message is a JSON object'))
    return undefined
  }
  return value
}

/**
 * Answer a thrown value: a home-auth refusal with its own status and code, and nothing else with a bare 500, so an
 * unexpected failure never carries its message to a client.
 * @param response - the response.
 * @param error - the thrown value.
 */
export function sendThrown(response: ServerResponse, error: unknown): void {
  if (error instanceof HomeAuthError) {
    sendError(response, error)
    return
  }
  response.statusCode = 500
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }))
}

/**
 * Answer a refusal with its status, code and sentence.
 * @param response - the response.
 * @param error - the refusal.
 */
export function sendError(response: ServerResponse, error: HomeAuthError): void {
  response.statusCode = error.status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(refusalBody(error.code, error.detail, STRUCTURED_REFUSALS.has(error.code) ? error.details : {}))
}

/**
 * Answer with a JSON value.
 * @param response - the response.
 * @param status - the status code.
 * @param value - the value, written as JSON.
 */
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}
