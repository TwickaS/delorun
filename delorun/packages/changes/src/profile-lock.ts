/**
 * The profile's write lock, upstream's `withFileLock(<profile>/package.json)`: which changes to the profile's files
 * run one at a time, across processes and within one. It is not reentrant across independent operations, so a caller
 * that holds it and then runs a change that takes it again — a change nested inside its own call chain — waits for its
 * own hold until the wait expires and then fails with the lock's timeout, naming this process as the holder.
 * {@link withProfileWriteLock} is the one way Delorun's code takes it: the wait is the profile's own, which a `pnpm`
 * run can hold, and upstream's lock lets a nested take of the same lock through ([atomic write](../../../../packages/util/atomic-write/src/index.ts)).
 *
 * @module @delorun/changes/profile-lock
 */
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** How long a change to a profile waits for the profile write lock: upstream plugin management's default, which a `pnpm` run can hold. */
export const PROFILE_LOCK_WAIT_MS = 120_000

/** How long one change waits for the profile write lock. */
export interface ProfileWriteLockOptions {
  /** How long to wait for another writer's hold; {@link PROFILE_LOCK_WAIT_MS} by default. */
  readonly waitMs?: number
}

/**
 * Run one change to a profile's files under the profile write lock. A change that runs inside another change to the
 * same profile, in the call chain that holds the lock, runs without waiting for it; a change started by anything else
 * waits for the holder, so two writes to one profile still take turns.
 * @param profileDir - the profile directory.
 * @param operation - the change, run while nothing else writes the profile.
 * @param options - how long to wait for another writer.
 * @returns what the operation returned.
 * @throws the lock's timeout when another writer holds it past `waitMs`; the operation's own error otherwise.
 */
export async function withProfileWriteLock<T>(profileDir: string, operation: () => Promise<T>, options?: ProfileWriteLockOptions): Promise<T> {
  return await withFileLock(join(profileDir, 'package.json'), operation, { waitMs: options?.waitMs ?? PROFILE_LOCK_WAIT_MS })
}
