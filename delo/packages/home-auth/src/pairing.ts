/**
 * The pairing choices of a home: who may ask to pair a device without an approval window, how a request is shown at the
 * computer, and the window, expiry and per-identity limits (contract C5, "Pop-up pairing").
 *
 * Every choice is a field of the plugin's `pairing` configuration, and {@link resolvePairing} is the one step that
 * turns the configuration into the values the home uses: it fills Delorun's defaults and refuses a value outside its
 * bounds with a sentence naming the field and the bounds. These are fixed and have no field: approval only at the home's
 * own computer, the 8-digit match code, the cancel after 3 wrong codes, the global cap of 5 waiting requests, session
 * rotation on approval, and that a reach session never sees or answers a request.
 *
 * The identity a request names is read from the `Tailscale-User-Login` and `Tailscale-User-Name` headers that
 * `tailscale serve` sets on every request it forwards from a user's device, replacing any copy the client sent. The
 * listener behind it is also reachable by any local process, which can send those headers itself, so they are a quota and
 * display hint and never authorisation: a request still needs the code its own screen shows, typed at the computer.
 *
 * @module @delo/home-auth/pairing
 */
import type { IncomingHttpHeaders } from 'node:http'
import { DEVICE_APPROVAL_LIMITS } from '@delo/contract-device-approval'

/** Who may ask to pair without an approval window: the computer's own Tailscale user, any device on the tailnet, or no one. */
export const WINDOWLESS_MODES = ['own-user', 'tailnet', 'window-only'] as const

/** One of {@link WINDOWLESS_MODES}. */
export type WindowlessMode = (typeof WINDOWLESS_MODES)[number]

/** How a window-less request is shown at the computer: a notice, the code box at once, or only in the lists. */
export const REQUEST_DISPLAYS = ['notice', 'dialog', 'none'] as const

/** One of {@link REQUEST_DISPLAYS}. */
export type RequestDisplay = (typeof REQUEST_DISPLAYS)[number]

/** The pairing fields as `cordis.yml` holds them; an absent field takes Delorun's default in {@link resolvePairing}. */
export interface PairingConfig {
  /** Who may ask without a window. */
  readonly mayAskWithoutWindow?: WindowlessMode
  /** How a request is shown at the computer. */
  readonly showRequest?: RequestDisplay
  /** How long an approval window stays open, in minutes. */
  readonly windowMinutes?: number
  /** How long a request waits before it expires, in minutes. */
  readonly requestExpiryMinutes?: number
  /** How many requests one Tailscale identity may have waiting without a window. */
  readonly pendingPerIdentity?: number
}

/** The pairing values the home uses. */
export interface PairingSpec {
  readonly mayAskWithoutWindow: WindowlessMode
  readonly showRequest: RequestDisplay
  readonly windowMs: number
  readonly requestExpiryMs: number
  readonly pendingPerIdentity: number
}

/** The pairing choices as the loopback studio and the commands read them. */
export interface PairingView {
  readonly mayAskWithoutWindow: WindowlessMode
  readonly showRequest: RequestDisplay
  readonly windowMinutes: number
  readonly requestExpiryMinutes: number
  readonly pendingPerIdentity: number
}

const MINUTE_MS = 60 * 1000

/** The inclusive bounds of each numeric field. */
export const PAIRING_BOUNDS = {
  windowMinutes: { min: 1, max: 15 },
  requestExpiryMinutes: { min: 1, max: 10 },
  pendingPerIdentity: { min: 1, max: 5 },
} as const

/** Delorun's pairing values. */
export const PAIRING_DEFAULTS: PairingSpec = {
  mayAskWithoutWindow: 'own-user',
  showRequest: 'notice',
  windowMs: DEVICE_APPROVAL_LIMITS.approvalWindowMs,
  requestExpiryMs: DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs,
  pendingPerIdentity: 1,
}

/**
 * Resolve the pairing configuration into the values the home uses.
 * @param config - the `pairing` field of the plugin's configuration; undefined when the profile sets none.
 * @returns every value, Delorun's default where the configuration sets none.
 * @throws {Error} naming the field and its bounds or allowed values when a field holds something else.
 */
export function resolvePairing(config: PairingConfig | undefined): PairingSpec {
  const minutes = (field: keyof typeof PAIRING_BOUNDS, fallback: number): number => {
    const value = config?.[field]
    if (value === undefined) return fallback
    const { min, max } = PAIRING_BOUNDS[field]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`home-auth: pairing.${field} must be a whole number from ${String(min)} to ${String(max)}, got ${JSON.stringify(value)}`)
    }
    return value
  }
  const choice = <T extends string>(field: string, allowed: readonly T[], value: T | undefined, fallback: T): T => {
    if (value === undefined) return fallback
    if (!allowed.includes(value)) throw new Error(`home-auth: pairing.${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
    return value
  }
  return {
    mayAskWithoutWindow: choice('mayAskWithoutWindow', WINDOWLESS_MODES, config?.mayAskWithoutWindow, PAIRING_DEFAULTS.mayAskWithoutWindow),
    showRequest: choice('showRequest', REQUEST_DISPLAYS, config?.showRequest, PAIRING_DEFAULTS.showRequest),
    windowMs: minutes('windowMinutes', PAIRING_DEFAULTS.windowMs / MINUTE_MS) * MINUTE_MS,
    requestExpiryMs: minutes('requestExpiryMinutes', PAIRING_DEFAULTS.requestExpiryMs / MINUTE_MS) * MINUTE_MS,
    pendingPerIdentity: minutes('pendingPerIdentity', PAIRING_DEFAULTS.pendingPerIdentity),
  }
}

/** The Tailscale user a request names. */
export interface TailnetIdentity {
  /** The login name, such as `person@example.com`. */
  readonly login: string
  /** The display name; the login when the header carries none. */
  readonly name: string
}

/** The longest login or name read from a header; a longer one is no identity. */
const MAX_IDENTITY_LENGTH = 200

/**
 * One header value, when it is a single printable text.
 * @param value - the header.
 * @returns the trimmed text, or undefined for an absent, repeated, empty, over-long or control-character value.
 */
function printableHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text.length > MAX_IDENTITY_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) return undefined
  return text
}

/**
 * Read the Tailscale user from the headers `tailscale serve` sets. Tailscale encodes a non-ASCII name as a
 * `=?utf-8?q?...?=` word, which is shown as sent.
 * @param headers - the request's headers.
 * @returns the identity, or undefined when the request names none, as a tagged device's does not.
 */
export function tailnetIdentityOf(headers: IncomingHttpHeaders): TailnetIdentity | undefined {
  const login = printableHeader(headers['tailscale-user-login'])
  if (login === undefined) return undefined
  return { login, name: printableHeader(headers['tailscale-user-name']) ?? login }
}

/**
 * Whether an identity may ask to pair without a window.
 * @param mode - the configured mode.
 * @param identity - the identity the request names.
 * @param computerUser - the Tailscale login of the user this computer is signed in as.
 * @returns whether the request may be accepted outside a window.
 */
export function mayAskWithoutWindow(mode: WindowlessMode, identity: TailnetIdentity | undefined, computerUser: string | undefined): boolean {
  if (identity === undefined) return false
  switch (mode) {
    case 'window-only': return false
    case 'tailnet': return true
    case 'own-user': return computerUser !== undefined && identity.login === computerUser
    default: return assertNever(mode)
  }
}

/**
 * @param value - the value no case handled.
 * @throws {Error} always.
 */
function assertNever(value: never): never {
  throw new Error(`home-auth: unhandled pairing mode ${String(value)}`)
}
