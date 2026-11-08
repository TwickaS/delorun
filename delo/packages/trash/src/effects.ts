/**
 * The purge effects of contract C8. A purge removes the item from each store
 * that holds its content: the rows of the SQLite FTS5 full-text index of
 * `session-query-sqlite`, the session directory of each chat with every
 * generation in it, the attachments, the spill files, and the draft entries of
 * the item in the browser that performs the purge, under every host scope, as
 * the host-qualified keys contract sets.
 *
 * @module @delo/trash/effects
 */
import { readdir, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { PERSISTED_KEYS } from '@delo/contract-host-qualified-keys'
import { attachmentObjectPath, encodeSegment, isSessionGenerationFilename, spillSessionDirectoryPath } from './paths.ts'

/** The full-text index seam a purge uses when the process runs session-query-sqlite. */
export interface SessionIndexPurge {
  /**
   * Remove every indexed row of the named sessions at once.
   * @param ids - the sessions whose rows the purge removes.
   */
  forgetSessions(ids: readonly string[]): Promise<void>
}

/** The browser draft storage of the studio connection performing the purge. */
export interface DraftStorage {
  /** Every stored key. */
  keys(): readonly string[]
  /**
   * Remove one stored key.
   * @param key - the key to remove.
   */
  remove(key: string): void
}

/**
 * Remove a chat's session directory from the sessions root, wherever the
 * backend's project layout placed it: every project directory is scanned for
 * the chat's encoded session directory, so a purge does not depend on the cwd
 * the caller remembers.
 * @param sessionsRoot - the JSONL session-persistence root.
 * @param sessionId - the chat whose session directory goes.
 * @returns the removed directory, or `undefined` when none existed.
 */
export async function removeSessionDirectory(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  const encoded = encodeSegment(sessionId)
  let projects: Dirent[]
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  let removed: string | undefined
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, encoded)
    try {
      const info = await stat(candidate)
      if (!info.isDirectory()) continue
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    await rm(candidate, { recursive: true, force: true })
    removed ??= candidate
  }
  return removed
}

/**
 * Remove every session generation file that reappeared at a session
 * directory's origin — a generation written between the delete's move and the
 * purge — without touching any other session's directory.
 * @param sessionsRoot - the JSONL session-persistence root.
 * @param origin - the chat's session directory relative to the root.
 * @returns the names of the generation files removed.
 */
export async function removeStrayGenerations(sessionsRoot: string, origin: string): Promise<string[]> {
  const dir = join(sessionsRoot, origin)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const name of names) {
    if (!isSessionGenerationFilename(name)) continue
    await rm(join(dir, name), { force: true })
    removed.push(name)
  }
  return removed
}

/**
 * Remove the item's attachment objects from a versioned attachment root.
 * @param attachmentsRoot - the versioned attachment root.
 * @param digests - the lowercase hexadecimal SHA-256 digests to remove.
 */
export async function removeAttachments(attachmentsRoot: string, digests: readonly string[]): Promise<void> {
  for (const sha256 of digests) {
    await rm(attachmentObjectPath(attachmentsRoot, sha256), { force: true })
  }
}

/**
 * Remove the item's spill directories from the spill storage.
 * @param spillRoots - the configured spill roots.
 * @param sessionIds - the chats whose spill files go.
 */
export async function removeSpill(spillRoots: readonly string[], sessionIds: readonly string[]): Promise<void> {
  for (const root of spillRoots) {
    for (const sessionId of sessionIds) {
      await rm(spillSessionDirectoryPath(root, sessionId), { recursive: true, force: true })
    }
  }
}

/**
 * Remove the item's draft entries from the browser's storage, under every host
 * scope: a host-qualified key of a persisted entry joins the persist name, the
 * 36-character host id, and — for a session- or store-scoped entry — the
 * upstream id exactly as the home issued it. Every key that names one of the
 * item's ids after its host id goes, whichever connection wrote it.
 * @param storage - the browser draft storage.
 * @param sessionIds - the item's chat session ids.
 * @param workspaceIds - the item's workspace ids.
 * @returns the keys removed.
 */
export function removeDraftEntries(
  storage: DraftStorage,
  sessionIds: readonly string[],
  workspaceIds: readonly string[] = [],
): string[] {
  const sessions = new Set(sessionIds)
  const workspaces = new Set(workspaceIds)
  const removed: string[] = []
  for (const entry of PERSISTED_KEYS) {
    if (entry.scope !== 'host-and-session' && entry.scope !== 'host-and-store-scope') continue
    const targets = entry.scope === 'host-and-session' ? sessions : workspaces
    if (targets.size === 0) continue
    const prefix = `${entry.name}.`
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue
      const scope = key.slice(prefix.length)
      // The host id has a fixed length, so the reader splits after it and the
      // upstream id that follows is never parsed.
      if (scope.length <= 36 + 1 || scope[36] !== '.') continue
      const upstreamId = scope.slice(36 + 1)
      if (!targets.has(upstreamId)) continue
      storage.remove(key)
      removed.push(key)
    }
  }
  return removed
}
