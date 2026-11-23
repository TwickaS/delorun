/**
 * The pairing choices of a home as the browser reads them, free of Cordis and Node: the values a choice may take, the
 * bounds of the numeric ones, and the row they are written to. [`./pairing.ts`](./pairing.ts) resolves them into the
 * values the home uses.
 *
 * @module @delorun/home-auth/wire
 */

import { DEVICE_APPROVAL_LIMITS } from '@delorun/contract-device-approval'

/** The wrong match codes after which a request is cancelled; fixed, not configurable. */
export const PAIRING_WRONG_CODES = DEVICE_APPROVAL_LIMITS.wrongTypedCodesPerRequest

/** The row id `@delorun/bundle-local` inserts for the plugin, whose `pairing` section Settings → Devices writes. */
export const HOME_AUTH_ROW = 'delorun-home-auth'

/** Who may ask to pair without an approval window: the computer's own Tailscale user, any device on the tailnet, or no one. */
export const WINDOWLESS_MODES = ['own-user', 'tailnet', 'window-only'] as const

/** One of {@link WINDOWLESS_MODES}. */
export type WindowlessMode = (typeof WINDOWLESS_MODES)[number]

/** How a window-less request is shown at the computer: a notice, the pop-up with the code box at once, or only in the lists. */
export const REQUEST_DISPLAYS = ['notice', 'dialog', 'none'] as const

/** One of {@link REQUEST_DISPLAYS}. */
export type RequestDisplay = (typeof REQUEST_DISPLAYS)[number]

/** The pairing fields as `cordis.yml` holds them; an absent field takes Delorun's default when the home resolves them. */
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

/** The pairing choices as the loopback studio and the commands read them. */
export interface PairingView {
  readonly mayAskWithoutWindow: WindowlessMode
  readonly showRequest: RequestDisplay
  readonly windowMinutes: number
  readonly requestExpiryMinutes: number
  readonly pendingPerIdentity: number
}

/** The inclusive bounds of each numeric field. */
export const PAIRING_BOUNDS = {
  windowMinutes: { min: 1, max: 15 },
  requestExpiryMinutes: { min: 1, max: 10 },
  pendingPerIdentity: { min: 1, max: 5 },
} as const
