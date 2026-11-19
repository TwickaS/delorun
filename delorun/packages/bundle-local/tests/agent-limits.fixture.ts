/** Stored account figures for the agent-limits specs: the shapes the home's `accounts` route answers. */
import type { AccountView, StoredWindow } from '@delorun/external-agents/accounts/wire'

/** The time every fixture's answer was made: 2026-11-17 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

/** A minute and an hour, in milliseconds. */
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** A record whose optional fields may be given as `undefined` to leave them out. */
export type Loosely<T> = { [K in keyof T]?: T[K] | undefined }

/**
 * @param value - an object.
 * @returns a copy without the fields that are `undefined`.
 */
function dropUndefined<T extends object>(value: Loosely<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T
}

/**
 * @param change - the fields to set.
 * @returns a window seen a minute before {@link NOW} that resets in an hour.
 */
export function window(change: Loosely<StoredWindow> & Pick<StoredWindow, 'kind'>): StoredWindow {
  return dropUndefined({ status: 'allowed', usedPercent: 10, resetsAt: NOW + HOUR, seenAt: NOW - MINUTE, source: 'probe', ...change })
}

/**
 * @param change - the fields to set.
 * @returns an added, signed-in Claude Code on the Max plan with two healthy windows.
 */
export function account(change: Loosely<AccountView> = {}): AccountView {
  return dropUndefined<AccountView>({
    provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', checkedAt: NOW - MINUTE,
    windows: [window({ kind: 'five_hour', usedPercent: 32 }), window({ kind: 'seven_day', usedPercent: 12, resetsAt: NOW + 50 * HOUR })],
    ...change,
  })
}
