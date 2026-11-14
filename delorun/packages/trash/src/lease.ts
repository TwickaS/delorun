/**
 * The session write lock a delete takes before it moves a chat. The JSONL
 * session backend holds a kernel `flock(2)` on `session.lock` inside a chat's
 * session directory for as long as a write handle is open, which is the
 * whole time a home process keeps the chat live. A delete that moved the
 * directory under a live writer would split the chat: the writer's later
 * appends would land in the trash copy or recreate the origin. So a delete
 * takes the same lock, moves the directory while it holds it, and releases it
 * afterwards; when another holder keeps the lock, the move waits for a later
 * start (`TrashService.settle`).
 *
 * The lock file belongs to the session backend: the delete opens it without
 * creating it, so a directory without one has no writer to exclude. Windows
 * holds the backend's lock as a named semaphore rather than a file lock, so
 * there every chat with a session directory counts as held.
 *
 * @module @delorun/trash/lease
 */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** Base name of the session backend's lock file inside a session directory. */
export const SESSION_LOCK_FILENAME = 'session.lock'

/** The lock a delete holds while it moves one session directory. */
export interface HeldSessionLock {
  /** Release the lock. */
  release(): Promise<void>
}

/**
 * Take one session directory's write lock without waiting.
 * @param directory - the chat's session directory.
 * @param platform - the operating system; this process's by default.
 * @returns the held lock, or `undefined` while another holder keeps it.
 */
export async function takeSessionLock(directory: string, platform: NodeJS.Platform = process.platform): Promise<HeldSessionLock | undefined> {
  if (platform === 'win32') return undefined
  let handle: FileHandle
  try {
    handle = await open(join(directory, SESSION_LOCK_FILENAME), constants.O_RDWR | constants.O_NOFOLLOW)
  } catch (error: unknown) {
    // ENOENT: the backend never materialized a writer here, so there is no lock to take and no writer to exclude.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { release: async () => {} }
    throw error
  }
  try {
    await tryLockExclusive(handle.fd)
  } catch (error: unknown) {
    await handle.close()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return undefined
    throw error
  }
  return { release: () => handle.close() }
}
