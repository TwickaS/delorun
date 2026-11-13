/**
 * What the actions of Changes share ([actions](./actions.ts), [work sessions](./work.ts)): upstream's profile write
 * lock, the clock and the profile history version an action records. Not part of the package's exports.
 *
 * @module @delo/changes/action-support
 */
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { openHistory } from '@delo/profile-safety'
import type { ChangesContext } from './actions.ts'
import { PROFILE_LOCK_WAIT_MS } from './enforce.ts'

/**
 * @param ctx - the profile.
 * @returns the time an action records, ISO 8601.
 */
export function timeOf(ctx: ChangesContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString()
}

/**
 * Run under upstream's profile write lock.
 * @param ctx - the profile and the lock wait.
 * @param run - the work.
 * @returns what it returned.
 */
export function locked<T>(ctx: ChangesContext, run: () => Promise<T>): Promise<T> {
  return withFileLock(join(ctx.profileDir, 'package.json'), run, { waitMs: ctx.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/**
 * Record one profile history version, changed by the person.
 * @param ctx - the profile and its history.
 * @param summary - the version's subject.
 * @returns the version's id, or nothing when no profile file differs from the latest version.
 */
export async function recordVersion(ctx: ChangesContext, summary: string): Promise<{ readonly historyVersion?: string }> {
  const version = await (ctx.history ?? openHistory({ profileDir: ctx.profileDir })).record(summary, { kind: 'person' })
  return version === undefined ? {} : { historyVersion: version }
}
