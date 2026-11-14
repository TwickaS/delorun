/**
 * The page's requests to the PIN mode routes (C14, "PIN mode"): the mode's state for this device, unlock, touch and
 * lock. `touch`, `lock` and the state's `unlock` field name the page's unlock by the `Delorun-Unlock` header; the token
 * is passed in by the caller from the token holder and is never stored here.
 *
 * @module @delorun/bundle-local/client/pin-api
 */
import { call, fields, hostFailureOf, isBoolean, isString, isTime, readServedRoute, type Check, type HostFetch } from './host-api.ts'
import { HOST_MISMATCH } from './devices-api.ts'

/** The PIN mode routes. */
export const PIN_ROUTES = {
  state: '/auth/pin/state',
  unlock: '/auth/pin/unlock',
  touch: '/auth/pin/touch',
  lock: '/auth/pin/lock',
} as const

/** The header that names the page's unlock. */
export const UNLOCK_HEADER = 'Delorun-Unlock'

/** The Host error codes the PIN routes answer with that the page tells apart. */
export const PIN_CODES = {
  invalid: 'PIN_INVALID',
  paused: 'PIN_UNLOCKS_PAUSED',
  off: 'PIN_MODE_OFF',
  address: 'PIN_NOT_ALLOWED_ON_ADDRESS',
  unlockInvalid: 'UNLOCK_INVALID',
} as const

/** What a device's studio learns of PIN mode: whether it is on, what it takes, and this page's unlock if it holds one. */
export type PinState =
  | { readonly kind: 'off' }
  | {
    readonly kind: 'on'
    readonly secret: 'pin' | 'passcode'
    readonly idleMinutes: number
    readonly paused: boolean
    /** Whether a page locks when it becomes hidden; absent reads as false. */
    readonly lockWhenHidden?: boolean
    readonly unlock: { readonly unlockId: string; readonly endsAt: number; readonly idleEndsAt: number } | null
  }

/** What `POST /auth/pin/unlock` answers, once: the token this page keeps. */
export interface PinUnlock {
  readonly token: string
  readonly unlockId: string
  readonly endsAt: number
  readonly idleEndsAt: number
}

/** What `POST /auth/pin/touch` answers. */
export interface PinTouch {
  readonly unlockId: string
  readonly idleEndsAt: number
  readonly endsAt: number
}

const isUnlockRecord = fields({ unlockId: isString, endsAt: isTime, idleEndsAt: isTime })
const isPinState: Check = value => {
  if (!fields({ kind: isString })(value)) return false
  const state = value as { kind: string; unlock?: unknown; secret?: unknown; lockWhenHidden?: unknown }
  if (state.kind === 'off') return true
  return state.kind === 'on'
    && fields({ secret: v => v === 'pin' || v === 'passcode', idleMinutes: isTime, paused: isBoolean })(value)
    && (state.lockWhenHidden === undefined || isBoolean(state.lockWhenHidden))
    && (state.unlock === null || isUnlockRecord(state.unlock))
}
const isPinUnlock = fields({ token: isString, unlockId: isString, endsAt: isTime, idleEndsAt: isTime })
const isPinTouch = fields({ unlockId: isString, idleEndsAt: isTime, endsAt: isTime })

const tokenHeader = (token: string | null): Record<string, string> => token === null ? {} : { [UNLOCK_HEADER]: token }

/**
 * Read PIN mode's state for this device.
 * @param fetch - the request function.
 * @param token - the page's unlock token, or null while locked.
 * @returns the state, or undefined for a home without the routes (404) or a page on the computer's own address.
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export async function readPinState(fetch: HostFetch, token: string | null): Promise<PinState | undefined> {
  try {
    return await readServedRoute<PinState>(fetch, PIN_ROUTES.state, isPinState, { headers: tokenHeader(token) })
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind === 'refused' && failure.code === HOST_MISMATCH) return undefined
    throw error
  }
}

/**
 * Unlock this page with the PIN or passcode.
 * @param fetch - the request function.
 * @param secret - what the person typed.
 * @returns the unlock, with the token.
 * @throws {HostRequestError} `PIN_INVALID`, `PIN_UNLOCKS_PAUSED`, `PIN_MODE_OFF`, `PIN_NOT_ALLOWED_ON_ADDRESS`, an
 *   unreachable Host or an unreadable answer.
 */
export function unlockPin(fetch: HostFetch, secret: string): Promise<PinUnlock> {
  return call<PinUnlock>(fetch, PIN_ROUTES.unlock, isPinUnlock, { secret })
}

/**
 * Report activity on an unlocked page.
 * @param fetch - the request function.
 * @param token - the page's unlock token.
 * @returns the unlock's new idle end.
 * @throws {HostRequestError} `UNLOCK_INVALID` when the unlock ended, an unreachable Host or an unreadable answer.
 */
export function touchPin(fetch: HostFetch, token: string): Promise<PinTouch> {
  return call<PinTouch>(fetch, PIN_ROUTES.touch, isPinTouch, {}, { headers: tokenHeader(token) })
}

/**
 * Lock this page.
 * @param fetch - the request function.
 * @param token - the page's unlock token.
 * @param keepalive - whether the request must outlive the page, as one sent on `pagehide`.
 * @throws {HostRequestError} `UNLOCK_INVALID` when the unlock already ended, an unreachable Host or an unreadable answer.
 */
export async function lockPin(fetch: HostFetch, token: string, keepalive = false): Promise<void> {
  await call<{ locked: boolean }>(fetch, PIN_ROUTES.lock, fields({ locked: isBoolean }), {}, { headers: tokenHeader(token), keepalive })
}

/** A wrong PIN's outcome as the page tells it: tries left, or the device removed after the last miss. */
export type PinMiss = { readonly kind: 'wrong'; readonly triesLeft: number | undefined } | { readonly kind: 'removed' }

/**
 * Tell a wrong try from the removal after the last one, by the fields a `PIN_INVALID` refusal carries.
 * @param fields - the refusal's body: `triesLeft` (number) and `removed` (boolean).
 * @returns the outcome; a refusal without the fields reads as a wrong try with no count.
 */
export function pinMissOf(fields: Readonly<Record<string, unknown>> | undefined): PinMiss {
  if (fields?.removed === true) return { kind: 'removed' }
  return { kind: 'wrong', triesLeft: typeof fields?.triesLeft === 'number' ? fields.triesLeft : undefined }
}
