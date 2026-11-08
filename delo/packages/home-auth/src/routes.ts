/**
 * The routes the owner's claim and the device list answer on: `POST /auth/owner/claim`, `GET /auth/devices` and
 * `POST /auth/devices/remove`, plus the refusal a reach listener answers a claim with.
 *
 * The claim route decides the arrival before it reads the body, which C5 requires: a claim that did not arrive on the
 * loopback listener is answered `403 OWNER_CLAIM_LOOPBACK_ONLY` with a sentence naming the loopback listener and SSH
 * port forwarding, whatever its body holds. The device list and the removal are owner-only, so an unclaimed home
 * answers `403 NO_OWNER` rather than an empty list.
 *
 * @module @delo/home-auth/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delo/contract-admission'
import { DEVICE_APPROVAL_VERSION } from '@delo/contract-device-approval'
import { HomeAuth } from './home-auth.ts'
import { HomeAuthError, refusalBody } from './errors.ts'
import { isLoopbackHost } from './arrival.ts'
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

/** A request handler, as the web server takes it. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

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
    const arrival = HomeAuth.arrivalOf(request)
    // C5: the arrival is decided before the body is read, and its refusal names what to do instead.
    if (arrival.listener !== 'loopback' || !isLoopbackHost(arrival.host)) {
      sendError(response, new HomeAuthError('OWNER_CLAIM_LOOPBACK_ONLY', LOOPBACK_ONLY_SENTENCE))
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
        address: studioAddressOf(arrival.host),
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
 * @returns the handler for {@link DEVICES_PATH}.
 */
export function devicesHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
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
 * @returns the handler for {@link DEVICE_REMOVE_PATH}.
 */
export function removeDeviceHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'Remove a device with a POST to /auth/devices/remove'))
      return
    }
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
 * The studio address a loopback claim binds its device to: the request's own authority over plain HTTP, because the
 * loopback listener serves HTTP.
 * @param host - the request's `Host` header.
 * @returns the address as an origin.
 */
function studioAddressOf(host: string | undefined): StudioAddress {
  return brandString<StudioAddress>(`http://${(host ?? '127.0.0.1').toLowerCase()}`)
}

/**
 * Read one JSON object from a request body, refusing a body over {@link MAX_BODY_BYTES}.
 * @param request - the request.
 * @param response - the response, answered with a refusal and left open on failure.
 * @returns the message, or undefined when the body was refused.
 */
async function readMessage(request: IncomingMessage, response: ServerResponse): Promise<Readonly<Record<string, unknown>> | undefined> {
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
    value = JSON.parse(text) as unknown
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
function sendThrown(response: ServerResponse, error: unknown): void {
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
function sendError(response: ServerResponse, error: HomeAuthError): void {
  response.statusCode = error.status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(refusalBody(error.code, error.detail))
}

/**
 * Answer with a JSON value.
 * @param response - the response.
 * @param status - the status code.
 * @param value - the value, written as JSON.
 */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}
