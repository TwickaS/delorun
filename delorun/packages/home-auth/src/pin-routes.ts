/**
 * The PIN mode routes (C14, "PIN mode"), version 1.
 *
 * - **Device routes** answer a device on a reach listener with a live session cookie and, for a `POST`, the studio's own
 *   origin, as the elevation routes do. `POST /auth/pin/unlock` takes `{ secret }` and answers the page unlock's token,
 *   once; it answers `PIN_NOT_ALLOWED_ON_ADDRESS` on any listener but the Tailscale private one. `POST /auth/pin/touch`
 *   and `POST /auth/pin/lock` name the unlock by the `Delorun-Unlock` header, never by the URL.
 * - **Computer routes** set or replace the PIN and turn the mode on (`set`), change the idle minutes and lock-when-hidden
 *   without the secret (`options`), turn it off (`off`) and resume unlocks after a home-wide pause (`resume`). Each answers only the person at the computer ({@link personAtComputer}), so a device
 *   is refused with `LOOPBACK_REQUIRED`: in version 1 a device never sets, changes or clears the PIN.
 *
 * @module @delorun/home-auth/pin-routes
 */
import type { LiftField } from './dangerous-settings.ts'
import { HomeAuthError } from './errors.ts'
import { deviceSession, type DeviceSession } from './elevation-routes.ts'
import type { HomeAuth } from './home-auth.ts'
import { unlockTokenOf } from './unlock-token.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'

/** The PIN mode routes. */
export const PIN_PATHS = {
  /** `GET`: what PIN mode is for the device's studio. */
  state: '/auth/pin/state',
  /** `POST` `{ secret }`: unlock this page. */
  unlock: '/auth/pin/unlock',
  /** `POST`: activity on an unlocked page. */
  touch: '/auth/pin/touch',
  /** `POST`: lock this page. */
  lock: '/auth/pin/lock',
  /** `GET`: the computer's view of the mode. */
  mode: '/auth/pin/mode',
  /** `POST` `{ secret, idleMinutes?, lockWhenHidden? }`: the computer sets the PIN and turns the mode on. */
  set: '/auth/pin/set',
  /** `POST` `{ idleMinutes?, lockWhenHidden? }`: the computer changes the two options without the secret. */
  options: '/auth/pin/options',
  /** `POST`: the computer turns the mode off. */
  off: '/auth/pin/off',
  /** `POST`: the computer resumes PIN unlocks after a home-wide pause. */
  resume: '/auth/pin/resume',
} as const

/**
 * The asker a device route's session names.
 * @param device - the admitted session.
 * @returns the device, listener and session.
 */
function askerOf(device: DeviceSession): { readonly deviceId: DeviceSession['session']['deviceId']; readonly listener: DeviceSession['listener']; readonly sessionId: string } {
  return { deviceId: device.session.deviceId, listener: device.listener, sessionId: device.sessionId }
}

/**
 * Build the route a device reads PIN mode's state from.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function pinStateHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'GET')
    if (device === undefined) return
    sendJson(response, 200, auth.pin.stateOf(device.session.deviceId, device.listener, unlockTokenOf(request)))
  }
}

/**
 * Build the route a device unlocks its page on.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function pinUnlockHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'POST')
    if (device === undefined) return
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      if (typeof message.secret !== 'string') throw new HomeAuthError('BAD_REQUEST', 'an unlock carries the PIN or passcode')
      // A device that holds a passkey confirms each action with Face ID or its PIN as a one-action grant, never a window.
      if (auth.passkeys.enabled() && auth.passkeyStore.forDevice(device.session.deviceId).length > 0) {
        throw new HomeAuthError('ELEVATION_REQUIRED', 'This device confirms each action with Face ID or your PIN. It has no unlock window')
      }
      sendJson(response, 200, await auth.pin.unlock(askerOf(device), message.secret))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route a device reports activity on an unlocked page to.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function pinTouchHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'POST')
    if (device === undefined) return
    try {
      const token = unlockTokenOf(request)
      if (token === undefined) throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
      sendJson(response, 200, auth.pin.touch(token, askerOf(device)))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route a device locks its page on.
 * @param auth - the home-auth instance.
 * @returns the handler.
 */
export function pinLockHandler(auth: HomeAuth): RouteHandler {
  return async (request, response) => {
    const device = deviceSession(auth, request, response, 'POST')
    if (device === undefined) return
    try {
      const token = unlockTokenOf(request)
      if (token === undefined) throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
      auth.pin.lock(token, askerOf(device))
      sendJson(response, 200, { locked: true })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route the computer reads PIN mode from.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @param setBackWaiting - the settings whose set-back failed and is being retried, by namespace and field.
 * @returns the handler.
 */
export function pinModeHandler(auth: HomeAuth, credential: LoopbackCredential, setBackWaiting: () => readonly LiftField[]): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, 'PIN mode', false)) return
    if (request.method !== 'GET') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET'))
      return
    }
    sendJson(response, 200, { ...auth.pin.summary(), setBackWaiting: setBackWaiting() })
  }
}

/**
 * Build a computer-only `POST` route of PIN mode.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @param action - the action's name as a refusal states it.
 * @param run - the change, given the parsed body.
 * @returns the handler.
 */
function computerPost(auth: HomeAuth, credential: LoopbackCredential, action: string, run: (message: Readonly<Record<string, unknown>>) => Promise<unknown>): RouteHandler {
  return async (request, response) => {
    if (!personAtComputer(auth, credential, request, response, action, request.method === 'POST')) return
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes POST'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      sendJson(response, 200, await run(message))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}

/**
 * Build the route the computer sets the PIN and turns the mode on with.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function pinSetHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return computerPost(auth, credential, 'Setting the PIN', async (message) => {
    const { secret, idleMinutes, lockWhenHidden } = message
    if (typeof secret !== 'string') throw new HomeAuthError('BAD_REQUEST', 'a PIN change carries the PIN or passcode')
    if (idleMinutes !== undefined && typeof idleMinutes !== 'number') throw new HomeAuthError('BAD_REQUEST', 'idleMinutes is a number of minutes')
    if (lockWhenHidden !== undefined && typeof lockWhenHidden !== 'boolean') throw new HomeAuthError('BAD_REQUEST', 'lockWhenHidden is true or false')
    return { enabled: true, secret: await auth.pin.set(secret, { idleMinutes, lockWhenHidden }) }
  })
}

/**
 * Build the route the computer changes the idle minutes and lock-when-hidden with, without the secret.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function pinOptionsHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return computerPost(auth, credential, 'Changing PIN mode options', async (message) => {
    const { idleMinutes, lockWhenHidden, ...rest } = message
    if (Object.keys(rest).length > 0) throw new HomeAuthError('BAD_REQUEST', 'an options change takes idleMinutes and lockWhenHidden only')
    if (idleMinutes !== undefined && typeof idleMinutes !== 'number') throw new HomeAuthError('BAD_REQUEST', 'idleMinutes is a number of minutes')
    if (lockWhenHidden !== undefined && typeof lockWhenHidden !== 'boolean') throw new HomeAuthError('BAD_REQUEST', 'lockWhenHidden is true or false')
    return auth.pin.setOptions({ idleMinutes, lockWhenHidden })
  })
}

/**
 * Build the route the computer turns the mode off with.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function pinOffHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return computerPost(auth, credential, 'Turning PIN mode off', async () => {
    await auth.pin.off()
    return { enabled: false }
  })
}

/**
 * Build the route the computer resumes PIN unlocks with.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @returns the handler.
 */
export function pinResumeHandler(auth: HomeAuth, credential: LoopbackCredential): RouteHandler {
  return computerPost(auth, credential, 'Resuming PIN unlocks', async () => {
    await auth.pin.resume()
    return { paused: false }
  })
}
