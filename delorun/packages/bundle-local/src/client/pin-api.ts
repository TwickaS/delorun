/**
 * The page's requests to the PIN mode routes (C14, "PIN mode"): the mode's state for this device, and the
 * computer-only routes that set the mode. A device holds no PIN unlock: the home refuses `POST /auth/pin/unlock` to every
 * device, so this module has no request for it.
 *
 * @module @delorun/bundle-local/client/pin-api
 */
import { call, fields, hostFailureOf, isBoolean, isString, isTime, readServedRoute, type Check, type HostFetch } from './host-api.ts'
import { HOST_MISMATCH } from './devices-api.ts'

/** The PIN mode route a device reads. */
export const PIN_ROUTES = {
  state: '/auth/pin/state',
} as const

/** What a device's studio learns of PIN mode: whether it is on and what it takes. */
export type PinState =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly secret: 'pin' | 'passcode'; readonly idleMinutes: number; readonly paused: boolean }

const isPinState: Check = value => {
  if (!fields({ kind: isString })(value)) return false
  const state = value as { kind: string }
  if (state.kind === 'off') return true
  return state.kind === 'on' && fields({ secret: v => v === 'pin' || v === 'passcode', idleMinutes: isTime, paused: isBoolean })(value)
}

/**
 * Read PIN mode's state for this device.
 * @param fetch - the request function.
 * @returns the state, or undefined for a home without the routes (404) or a page on the computer's own address.
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export async function readPinState(fetch: HostFetch): Promise<PinState | undefined> {
  try {
    return await readServedRoute<PinState>(fetch, PIN_ROUTES.state, isPinState)
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind === 'refused' && failure.code === HOST_MISMATCH) return undefined
    throw error
  }
}

/** The computer-only PIN mode routes. */
export const PIN_COMPUTER_ROUTES = {
  mode: '/auth/pin/mode',
  set: '/auth/pin/set',
  off: '/auth/pin/off',
  resume: '/auth/pin/resume',
} as const

/** PIN mode as the computer reads it. */
export interface PinMode {
  readonly enabled: boolean
  /** What the secret is; absent while the mode is off. */
  readonly kind?: 'pin' | 'passcode'
  readonly idleMinutes: number
  readonly lockWhenHidden: boolean
  /** Whether PIN unlocks are paused home-wide after too many wrong tries. */
  readonly paused: boolean
  /** The settings a page loosened whose set-back failed and is retried, by namespace and field. */
  readonly setBackWaiting?: readonly { readonly ns: string; readonly field: string }[]
}

const isPinMode: Check = value => fields({ enabled: isBoolean, idleMinutes: isTime, lockWhenHidden: isBoolean, paused: isBoolean })(value)
  && (!('kind' in (value as object)) || (value as { kind?: unknown }).kind === undefined || ['pin', 'passcode'].includes((value as { kind: string }).kind))

/**
 * Read PIN mode at the computer.
 * @param fetch - the request function.
 * @returns the mode, or undefined for a home without the routes (404).
 * @throws {HostRequestError} `LOOPBACK_REQUIRED` away from the computer, an unreachable Host or an unreadable answer.
 */
export function readPinMode(fetch: HostFetch): Promise<PinMode | undefined> {
  return readServedRoute<PinMode>(fetch, PIN_COMPUTER_ROUTES.mode, isPinMode)
}

/**
 * Set or replace the PIN or passcode and turn the mode on.
 * @param fetch - the request function.
 * @param body - the secret and the two settings.
 * @throws {HostRequestError} `PIN_WEAK` for a secret that breaks a rule, `BAD_REQUEST`, an unreachable Host or an unreadable answer.
 */
export async function setPinMode(fetch: HostFetch, body: { readonly secret: string; readonly idleMinutes: number; readonly lockWhenHidden: boolean }): Promise<void> {
  await call<{ enabled: boolean }>(fetch, PIN_COMPUTER_ROUTES.set, fields({ enabled: isBoolean }), body)
}

/**
 * Turn PIN mode off.
 * @param fetch - the request function.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function turnPinOff(fetch: HostFetch): Promise<void> {
  await call<{ enabled: boolean }>(fetch, PIN_COMPUTER_ROUTES.off, fields({ enabled: isBoolean }), {})
}

/**
 * Resume PIN unlocks after a home-wide pause.
 * @param fetch - the request function.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function resumePin(fetch: HostFetch): Promise<void> {
  await call<{ paused: boolean }>(fetch, PIN_COMPUTER_ROUTES.resume, fields({ paused: isBoolean }), {})
}
