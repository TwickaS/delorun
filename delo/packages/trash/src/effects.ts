/**
 * The purge effects of contract C8. A purge removes the item from each store
 * that holds its content: the rows of the SQLite FTS5 full-text index of
 * `session-query-sqlite`, the session directory of each chat with every
 * generation in it, the chat's per-session projection-cache document, the
 * attachments, the spill files, and the draft entries of
 * the item in the browser that performs the purge, under every host scope, as
 * the host-qualified keys contract sets.
 *
 * @module @delo/trash/effects
 */
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { attachmentObjectPath, encodeSegment, isSessionGenerationFilename, spillSessionDirectoryPath } from './paths.ts'
import { TrashError } from './store.ts'

/**
 * The projection cache's unit name on the storage backend, whose per-record
 * layout publishes one checkpoint document per session at
 * `<storages>/session_projcache/sessions/<id>.json`.
 */
export const PROJECTION_CACHE_UNIT = 'session_projcache'

/** A record key is the document's own file name; the backend refuses one that is not this safe. */
const SAFE_RECORD_KEY = /^[a-zA-Z0-9_-]+$/

/**
 * Refuse a store root that a symbolic link would redirect. A link planted at
 * a store's root — `<home>/attachments`, `<home>/storages`, `<home>/spill` —
 * or at the directory holding a versioned root, as the attachment store's
 * `<home>/attachments` holds `v1`, sends every delete the purge makes to
 * wherever the link points, which may be outside the home. The purge's
 * guarantee is that it removes the item from the stores it names and nothing
 * else, so a linked root is refused instead of followed.
 * @param root - the store root the effect would write into.
 * @returns whether the root is a real directory to write into; `false` when
 * it does not exist, since then there is nothing to remove.
 * @throws {TrashError} `TRASH_STORE_REFUSED` when the root or its parent is a
 * symbolic link.
 */
async function requireStoreRoot(root: string): Promise<boolean> {
  for (const path of [dirname(root), root]) {
    let stats
    try {
      stats = await lstat(path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
    if (stats.isSymbolicLink()) throw new TrashError('TRASH_STORE_REFUSED', `${path} is a symbolic link; a purge removes the item from its own stores and refuses to follow it`)
  }
  return true
}

/** The full-text index seam a purge uses when the process runs session-query-sqlite. */
export interface SessionIndexPurge {
  /**
   * Remove every indexed row of the named sessions at once.
   * @param ids - the sessions whose rows the purge removes.
   */
  forgetSessions(ids: readonly string[]): Promise<void>
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
  if (!await requireStoreRoot(sessionsRoot)) return undefined
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
  if (!await requireStoreRoot(sessionsRoot)) return []
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
 * Remove a chat's persisted projection-cache document: the per-record
 * checkpoint the cache keeps for the session holds folded values — the chat's
 * title, its first message, the plan, the goal and the todos — so a purge that
 * left it would leave the chat's content on disk. The domain republishes an
 * invalid record it moves aside as `<id>.json.bak.<stamp>`, which holds the
 * same values and goes too. A record key that is not path-safe names no
 * document, because the backend refuses to write one.
 * @param storagesRoot - the storage backend's root, `<home>/storages`.
 * @param sessionIds - the chats whose documents go.
 * @returns the documents removed.
 */
export async function removeProjectionCache(storagesRoot: string, sessionIds: readonly string[]): Promise<string[]> {
  if (!await requireStoreRoot(storagesRoot)) return []
  const table = join(storagesRoot, PROJECTION_CACHE_UNIT, 'sessions')
  let names: string[]
  try {
    names = await readdir(table)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const sessionId of sessionIds) {
    if (!SAFE_RECORD_KEY.test(sessionId)) continue
    const document = `${sessionId}.json`
    for (const name of names) {
      if (name !== document && !name.startsWith(`${document}.bak.`)) continue
      const path = join(table, name)
      await rm(path, { force: true })
      removed.push(path)
    }
  }
  return removed
}

/**
 * Remove the item's attachment objects from a versioned attachment root.
 * @param attachmentsRoot - the versioned attachment root.
 * @param digests - the lowercase hexadecimal SHA-256 digests to remove.
 */
export async function removeAttachments(attachmentsRoot: string, digests: readonly string[]): Promise<void> {
  if (!await requireStoreRoot(attachmentsRoot)) return
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
    if (!await requireStoreRoot(root)) continue
    for (const sessionId of sessionIds) {
      await rm(spillSessionDirectoryPath(root, sessionId), { recursive: true, force: true })
    }
  }
}
