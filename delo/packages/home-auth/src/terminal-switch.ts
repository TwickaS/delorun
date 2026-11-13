/**
 * The terminal switch route (C14, "Elevation"): the computer reads and sets the switch, and a device reads it and turns
 * it off. A device that asks to turn it on is refused with `LOOPBACK_REQUIRED`, because the switch lowers protection,
 * unless dangerous mode holds and the device holds an unlock (README, "Dangerous mode").
 *
 * @module @delo/home-auth/terminal-switch
 */
import type { HomeAuth } from './home-auth.ts'
import { ELEVATION_PATHS, deviceSession } from './elevation-routes.ts'
import { HomeAuthError } from './errors.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'

/** The terminal switch's path. */
export const TERMINAL_SWITCH_PATH = ELEVATION_PATHS.terminal

/**
 * Build the route of the terminal switch. On a reach listener it answers the device's own session, which may read the
 * switch and turn it off, and turn it on only while dangerous mode holds and the device holds an unlock; anywhere else
 * it answers only the person at the computer, who may also turn it on.
 * @param auth - the home-auth instance.
 * @param credential - the loopback credential check.
 * @param dangerousMode - whether dangerous mode holds now, read per request.
 * @returns the handler.
 */
export function terminalSwitchHandler(auth: HomeAuth, credential: LoopbackCredential, dangerousMode: () => boolean): RouteHandler {
  return async (request, response) => {
    const listener = auth.arrivalOf(request).listener
    const fromDevice = listener !== undefined && listener !== 'loopback'
    const method = request.method === 'POST' ? 'POST' : 'GET'
    let asComputer = !fromDevice
    if (fromDevice) {
      const device = deviceSession(auth, request, response, method)
      if (device === undefined) return
      asComputer = dangerousMode() && auth.elevationOf(device.session.deviceId, device.listener) !== undefined
    } else {
      if (!personAtComputer(auth, credential, request, response, 'Changing the terminal switch', method === 'POST')) return
      if (request.method !== method) {
        sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET or POST'))
        return
      }
    }
    if (method === 'GET') {
      sendJson(response, 200, { withoutUnlock: auth.terminalWithoutUnlock() })
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      const withoutUnlock = message.withoutUnlock
      if (typeof withoutUnlock !== 'boolean') throw new HomeAuthError('BAD_REQUEST', 'the terminal switch takes withoutUnlock, true or false')
      await auth.setTerminalWithoutUnlock(withoutUnlock, asComputer ? 'computer' : 'device')
      sendJson(response, 200, { withoutUnlock: auth.terminalWithoutUnlock() })
    } catch (error) {
      sendThrown(response, error)
    }
  }
}
