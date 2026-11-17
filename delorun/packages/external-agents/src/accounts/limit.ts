/**
 * Whether a provider is at a reached plan limit now, from its stored figures alone. The start gate asks this before
 * it starts a program: a window the program reported as reached, whose reset time is still in the future, refuses
 * the start until that time. A reached window with no reset time, or one whose reset time has passed, never refuses,
 * because nothing says it still holds (stale figures never refuse).
 *
 * @module @delorun/external-agents/accounts/limit
 */
import type { AccountState, StoredWindow } from './wire.ts'

/** A reached limit that refuses a start. */
export interface ReachedLimit {
  /** The window's kind, such as `five-hour`; the latest-resetting one when several are reached. */
  readonly kind: string
  /** When it resets, in milliseconds since the epoch; always after the `now` it was found at. */
  readonly resetsAt: number
}

/**
 * The reached limit that refuses a start now, if any.
 * @param account - the provider's stored figures, or undefined when none are stored.
 * @param now - the current time, in milliseconds since the epoch.
 * @returns the reached window that resets last, or undefined when no window refuses.
 */
export function reachedLimit(account: AccountState | undefined, now: number): ReachedLimit | undefined {
  let found: ReachedLimit | undefined
  for (const window of account?.windows ?? []) {
    if (window.status !== 'reached' || window.resetsAt === undefined || window.resetsAt <= now) continue
    if (found === undefined || window.resetsAt > found.resetsAt) found = { kind: window.kind, resetsAt: window.resetsAt }
  }
  return found
}

/**
 * Whether a window's figures may still hold: `current` while its reset time is in the future or unknown, `reset`
 * once the reset time has passed with no figures seen since, which a surface shows as "reset at …, not checked since".
 * @param window - the stored window.
 * @param now - the current time, in milliseconds since the epoch.
 * @returns the window's standing.
 */
export function windowStanding(window: StoredWindow, now: number): 'current' | 'reset' {
  return window.resetsAt !== undefined && window.resetsAt <= now ? 'reset' : 'current'
}
