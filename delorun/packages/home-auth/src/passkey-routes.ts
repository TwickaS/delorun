/**
 * The Face ID routes (C14, "Passkeys"), version 1.
 *
 * - **Device routes** answer a device on a reach listener with a live session cookie and, for a `POST`, the studio's own
 *   origin, as the PIN routes do: `state`, `registerOptions`, `register`, `addRequest`, `options`, `verify`, `pin` and `remove`.
 *   Enrolment needs a live single-use ticket ({@link PasskeyAuth.mintTicket}).
 * - **Computer routes** list the pending requests to add a passkey and approve one by the code typed at the computer.
 *   Each answers only the person at the computer ({@link personAtComputer}).
 *
 * @module @delorun/home-auth/passkey-routes
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { HomeAuthError } from './errors.ts'
import { isRecord } from './files.ts'
import { hashArgs, PASS_SETTING_ACTION, type PassView } from './grants.ts'
import { deviceSession, signedInDevice, type DeviceSession } from './elevation-routes.ts'
import { isPassMinutes, PASS_MINUTES, type PassMinutes } from './pass-setting.ts'
import type { HomeAuth } from './home-auth.ts'
import { parseAssertionRequest } from './passkey-auth.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'

/** The Face ID routes. */
export const PASSKEY_PATHS = {
  /** `GET`: the device's passkeys and whether an enrolment ticket waits. */
  state: '/auth/passkey/state',
  /** `POST` `{}`: creation options for `navigator.credentials.create`; needs a live ticket. */
  registerOptions: '/auth/passkey/register/options',
  /** `POST` `RegistrationResponseJSON`: verify the created credential and record it; needs a live ticket. */
  register: '/auth/passkey/register',
  /** `POST` `{}`: a paired device asks to add a passkey and gets the `delorun-passkey-v1` code to show. */
  addRequest: '/auth/passkey/add/request',
  /** `POST` `{ actions } | { answer }`: request options for `navigator.credentials.get`. */
  options: '/auth/passkey/options',
  /** `POST` `AuthenticationResponseJSON`: verify the assertion and mint the grant. */
  verify: '/auth/passkey/verify',
  /** `POST` `{ secret, actions } | { secret, answer }`: a correct PIN mints the same grant. */
  pin: '/auth/passkey/pin',
  /** `POST` `{ credentialId }`: the device removes one of its own passkeys; the studio first confirms the action with a grant. */
  remove: '/auth/passkey/remove',
  /** `GET`: every approved device's passkeys; a `face` action (action `auth/passkey/devices`, hash of `{}`). */
  devices: '/auth/passkey/devices',
  /** `GET`: the computer's list of pending requests to add a passkey. */
  pending: '/auth/passkey/add/pending',
  /** `POST` `{ requestId, code }`: the computer types the code a device shows. */
  approve: '/auth/passkey/add/approve',
  /** `POST` `{}`: Lock now: the device ends its own Face ID pass. */
  lock: '/auth/passkey/lock',
  /** `GET`: the pass setting and the device's live pass; `POST` `{ minutes }`: change the setting (a device needs a passkey grant). */
  pass: '/auth/passkey/pass',
} as const

/** The action name a passkey removal is confirmed under: its grant covers `{ credentialId }`. */
export const PASSKEY_REMOVE_ACTION = 'auth/passkey/remove'

/**
 * Whether a body is a created credential in the JSON form `@simplewebauthn/server` reads; it checks the fields the home
 * needs to place the call, and the library checks the rest.
 * @param message - the parsed body.
 * @returns whether it has the fields.
 */
function isRegistration(message: Readonly<Record<string, unknown>>): message is Readonly<Record<string, unknown>> & RegistrationResponseJSON {
  return typeof message.id === 'string' && typeof message.rawId === 'string' && typeof message.type === 'string' && isRecord(message.response) && typeof message.response.clientDataJSON === 'string'
}

/**
 * Whether a body is an assertion in the JSON form `@simplewebauthn/server` reads.
 * @param message - the parsed body.
 * @returns whether it has the fields.
 */
function isAssertion(message: Readonly<Record<string, unknown>>): message is Readonly<Record<string, unknown>> & AuthenticationResponseJSON {
  return typeof message.id === 'string' && typeof message.rawId === 'string' && typeof message.type === 'string' && isRecord(message.response) && typeof message.response.clientDataJSON === 'string'
}

/** The action name the cross-device passkey listing is confirmed under: its grant covers `{}`. */
export const PASSKEY_DEVICES_ACTION = 'auth/passkey/devices'

/** The name an authenticator shows for a passkey's account. */
const PASSKEY_LABEL = 'Delorun'

/**
 * The asker a device route's session names.
 * @param device - the admitted session.
 * @returns the device, listener and session.
 */
function askerOf(device: DeviceSession): { readonly deviceId: DeviceSession['session']['deviceId']; readonly listener: DeviceSession['listener']; readonly sessionId: string } {
  return { deviceId: device.session.deviceId, listener: device.listener, sessionId: device.sessionId }
}

/**
 * Build a device route that answers JSON for one method.
 * @param auth - the home-auth instance.
 * @param method - the route's method.
 * @param run - the work, given the admitted session and the parsed body (empty for a `GET`).
 * @returns the handler.
 */
function deviceRoute(auth: HomeAuth, method: 'GET' | 'POST', run: (device: DeviceSession, message: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, method)
    if (device === undefined) return
    try {
      const message = method === 'POST' ? await readMessage(request, response) : {}
      if (message === undefined) return
      sendJson(response, 200, await run(device, message))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route a device reads its passkeys from.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyStateHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'GET', device => auth.passkeys.stateOf(device.session.deviceId))
}

/**
 * Build the route a device gets creation options from.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyRegisterOptionsHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', device => auth.passkeys.registrationOptions(askerOf(device), device.session.address, PASSKEY_LABEL))
}

/**
 * Build the route a device records a created credential on.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyRegisterHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', (device, message) => {
    if (!isRegistration(message)) throw new HomeAuthError('BAD_REQUEST', 'an enrolment carries the credential the device created')
    return auth.passkeys.register(askerOf(device), device.session.address, message)
  })
}

/**
 * Build the route a paired device asks to add a passkey on.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyAddRequestHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', device => auth.passkeys.requestAdd(askerOf(device), device.session.address))
}

/**
 * Build the route a device gets assertion options from.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyOptionsHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', (device, message) => auth.passkeys.assertionOptions(askerOf(device), device.session.address, parseAssertionRequest(message)))
}

/**
 * Build the route a device submits an assertion to.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyVerifyHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', (device, message) => {
    if (!isAssertion(message)) throw new HomeAuthError('BAD_REQUEST', 'a confirmation carries the assertion the device made')
    return auth.passkeys.verify(askerOf(device), device.session.address, message)
  })
}

/**
 * Build the route a device mints a grant on with its PIN.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyPinHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', (device, message) => {
    const { secret, ...rest } = message
    if (typeof secret !== 'string') throw new HomeAuthError('BAD_REQUEST', 'a PIN confirmation carries the PIN or passcode')
    return auth.passkeys.pinGrant(askerOf(device), secret, parseAssertionRequest(rest))
  })
}

/**
 * Use up the grant for one `face` call of a device route, keyed by the JCS hash of its arguments.
 * @param auth - the home-auth instance.
 * @param device - the admitted session.
 * @param action - the action name.
 * @param args - the call's arguments as the home received them.
 * @param refusal - the sentence of the refusal.
 * @param factor - `passkey` when only a grant a passkey minted may be used; a grant the PIN minted is then left unused and refused.
 * @throws {HomeAuthError} `ELEVATION_REQUIRED` without a live grant for exactly these arguments, or with only a PIN grant when `factor` is `passkey`.
 */
function useGrant(auth: HomeAuth, device: DeviceSession, action: string, args: Readonly<Record<string, unknown>>, refusal: string, factor?: 'passkey'): void {
  const hash = hashArgs(args)
  const holder = { deviceId: device.session.deviceId, listener: device.listener }
  if (hash === undefined || (factor !== undefined && auth.grants.peek(holder, action, hash)?.factor !== factor) || auth.grants.consume(holder, action, hash) === undefined) {
    throw new HomeAuthError('ELEVATION_REQUIRED', refusal)
  }
}

/**
 * Build the route a device lists every approved device's passkeys on. It is a `face` action
 * ({@link PASSKEY_DEVICES_ACTION}) because it reads device metadata.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyDevicesHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'GET', (device) => {
    useGrant(auth, device, PASSKEY_DEVICES_ACTION, {}, 'Confirm with Face ID or your PIN to see the passkeys of your devices')
    return { devices: auth.passkeys.allDevices() }
  })
}

/**
 * Build the route a device removes a passkey on: its own, or another device's when the body names `deviceId`. It is a
 * `face` action ({@link PASSKEY_REMOVE_ACTION}): the home uses up a grant for exactly the body sent, `{ credentialId }`
 * or `{ credentialId, deviceId }`, and refuses `ELEVATION_REQUIRED` without one.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyRemoveHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', async (device, message) => {
    const { credentialId, deviceId, ...rest } = message
    if (typeof credentialId !== 'string' || (deviceId !== undefined && typeof deviceId !== 'string') || Object.keys(rest).length > 0) {
      throw new HomeAuthError('BAD_REQUEST', 'a removal names the passkey and, for another device, its device id')
    }
    const record = auth.passkeyStore.find(credentialId)
    if (record === undefined || record.deviceId !== (deviceId ?? device.session.deviceId)) throw new HomeAuthError('BAD_REQUEST', 'that device has no such passkey')
    // Another device's passkey comes off only with a passkey: a PIN seen on a stolen phone must not strip Face ID from the owner's other phones.
    const another = record.deviceId !== device.session.deviceId
    if (another) useGrant(auth, device, PASSKEY_REMOVE_ACTION, message, 'Removing another device\'s passkey needs Face ID on this device, or you at your computer', 'passkey')
    else useGrant(auth, device, PASSKEY_REMOVE_ACTION, message, 'Confirm with Face ID or your PIN to remove this passkey')
    return { removed: await auth.passkeys.remove(record.deviceId, credentialId) }
  })
}

/**
 * Build the route the computer lists pending requests to add a passkey from.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function passkeyPendingHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Adding Face ID', false)) return
    if (request.method !== 'GET') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET'))
      return
    }
    try {
      sendJson(response, 200, { pending: auth.passkeys.pendingAdds() })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route the computer approves adding a passkey on, by the code the device shows.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function passkeyApproveHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'Adding Face ID', request.method === 'POST')) return
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes POST'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.requestId !== 'string' || typeof message.code !== 'string') throw new HomeAuthError('BAD_REQUEST', 'an approval names the request and the code typed')
      auth.passkeys.approveAdd(message.requestId, message.code)
      sendJson(response, 200, { approved: true })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build Lock now: the device ends its own Face ID pass on this listener (a `free` row: it only takes access away).
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function passkeyLockHandler(auth: HomeAuth): RouteHandler {
  return deviceRoute(auth, 'POST', device => ({ ended: auth.grants.endPass({ deviceId: device.session.deviceId, listener: device.listener }, 'lock-now') }))
}

/** What the pass route answers. */
export interface PassAnswer {
  /** The length in effect, in minutes; 0 is "Every time". */
  readonly minutes: PassMinutes
  /** The lengths the setting takes. */
  readonly choices: readonly PassMinutes[]
  /** The asking device's live pass, or null; always null at the computer, which never asks. */
  readonly pass: PassView | null
}

/**
 * Build the pass route. `GET` answers {@link PassAnswer}. `POST` `{ minutes }` changes the setting: at the computer as any
 * other setting there; from a device only with a grant a passkey minted for exactly the body sent
 * ({@link PASS_SETTING_ACTION}), which no Face ID pass stands in for (an always-ask row). A length outside
 * {@link PASS_MINUTES} is refused `BAD_REQUEST`. A change applies to the next pass; a live pass keeps its end.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function passkeyPassHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  const answer = (pass: PassView | undefined): PassAnswer => ({ minutes: auth.passMinutes(), choices: PASS_MINUTES, pass: pass ?? null })
  const parse = (message: Readonly<Record<string, unknown>>): PassMinutes => {
    const { minutes, ...rest } = message
    if (!isPassMinutes(minutes) || Object.keys(rest).length > 0) throw new HomeAuthError('BAD_REQUEST', `the pass length is one of ${PASS_MINUTES.join(', ')} minutes`)
    return minutes
  }
  const onDevice = deviceRouteBoth(auth, async (device, message, method) => {
    const holder = { deviceId: device.session.deviceId, listener: device.listener }
    if (method === 'GET') return answer(auth.grants.passOf(holder))
    const minutes = parse(message)
    useGrant(auth, device, PASS_SETTING_ACTION, message, 'Changing how long Face ID lasts needs Face ID on this device each time, or you at your computer', 'passkey')
    await auth.passSetting.set(minutes)
    return answer(auth.grants.passOf(holder))
  })
  return async (request, response) => {
    if (signedInDevice(auth, request) !== undefined) {
      await onDevice(request, response)
      return
    }
    const post = request.method === 'POST'
    if (!personAtComputer(auth, credential, request, response, 'Changing how long Face ID lasts', post)) return
    if (!post && request.method !== 'GET') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET or POST'))
      return
    }
    try {
      if (post) {
        const message = await readMessage(request, response)
        if (message === undefined) return
        await auth.passSetting.set(parse(message))
      }
      sendJson(response, 200, answer(undefined))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build a device route that answers JSON for `GET` and `POST`.
 * @param auth - the home-auth instance.
 * @param run - the work, given the admitted session, the parsed body (empty for a `GET`) and the method.
 * @returns the handler.
 */
function deviceRouteBoth(auth: HomeAuth, run: (device: DeviceSession, message: Readonly<Record<string, unknown>>, method: 'GET' | 'POST') => Promise<unknown>): RouteHandler {
  return async (request, response) => {
    const method = request.method === 'POST' ? 'POST' : 'GET'
    const device = deviceSession(auth, request, response, method)
    if (device === undefined) return
    try {
      const message = method === 'POST' ? await readMessage(request, response) : {}
      if (message === undefined) return
      sendJson(response, 200, await run(device, message, method))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}
