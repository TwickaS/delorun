/**
 * The Phone powers route (C14, "Phone powers"), `/auth/phone-powers`. `GET` answers the level to the person at the
 * computer and to a signed-in device, which shows it read-only. `POST { level }` answers only the person at the computer
 * ({@link personAtComputer} with the studio's own origin), so a device is refused with `LOOPBACK_REQUIRED` whatever its
 * unlock: a phone never widens what a phone may do.
 *
 * @module @delorun/home-auth/phone-powers-routes
 */
import { deviceSession } from './elevation-routes.ts'
import { HomeAuthError } from './errors.ts'
import type { HomeAuth } from './home-auth.ts'
import { isPhonePowersLevel, type PhonePowers } from './phone-powers.ts'
import { personAtComputer, readMessage, sendError, sendJson, sendThrown, type LoopbackCredential, type RouteHandler } from './routes.ts'
import type { PhonePowersLevel, PhonePowersView } from './wire.ts'

/** The reads and the write the route makes of the choice. */
export interface PhonePowersAccess {
  /**
   * The level in force.
   * @returns it.
   */
  readonly current: () => PhonePowers
  /**
   * Record the person's choice.
   * @param level - the level.
   * @returns the level now in force.
   */
  readonly set: (level: PhonePowersLevel) => Promise<PhonePowers>
}

/**
 * @param powers - the level in force.
 * @returns what the route answers.
 */
function viewOf(powers: PhonePowers): PhonePowersView {
  return { level: powers.level, chosen: powers.chosen }
}

/**
 * Build the Phone powers route.
 * @param auth - the home-auth instance, which places a request.
 * @param credential - the loopback credential check.
 * @param powers - the choice.
 * @returns the handler.
 */
export function phonePowersHandler(auth: HomeAuth, credential: LoopbackCredential, powers: PhonePowersAccess): RouteHandler {
  return async (request, response) => {
    const listener = auth.arrivalOf(request).listener
    if (request.method === 'GET' && listener !== undefined && listener !== 'loopback') {
      if (deviceSession(auth, request, response, 'GET') === undefined) return
      sendJson(response, 200, viewOf(powers.current()))
      return
    }
    if (!personAtComputer(auth, credential, request, response, 'Changing Phone powers', request.method === 'POST')) return
    if (request.method === 'GET') {
      sendJson(response, 200, viewOf(powers.current()))
      return
    }
    if (request.method !== 'POST') {
      sendError(response, new HomeAuthError('METHOD_NOT_ALLOWED', 'this route takes GET or POST'))
      return
    }
    try {
      const message = await readMessage(request, response)
      if (message === undefined) return
      const { level, ...rest } = message
      if (Object.keys(rest).length > 0 || !isPhonePowersLevel(level)) throw new HomeAuthError('BAD_REQUEST', 'a Phone powers change takes level, careful or full, only')
      sendJson(response, 200, viewOf(await powers.set(level)))
    } catch (error) {
      sendThrown(response, error)
    }
  }
}
