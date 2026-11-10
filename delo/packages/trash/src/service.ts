/**
 * The trash service of contract C8: deleting a chat or a workspace moves it to
 * the trash, the person can restore it before its 30-day retention ends, and a
 * purge — by hand or at the retention's end — removes it from every store that
 * holds its content. A purge states that fragments may remain in the
 * operational logs until C20's 14-day retention, and it offers to clear the
 * affected log files at once; when the person accepts, it deletes them.
 *
 * @module @delo/trash/service
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearLocalLogs, type RetentionReport } from '@delo/logs'
import { PURGE_RESIDUE_MAX_DAYS, TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import {
  removeAttachments,
  removeProjectionCache,
  removeSessionDirectory,
  removeSpill,
  removeStrayGenerations,
  type SessionIndexPurge,
} from './effects.ts'
import { removeDraftEntries, type DraftStorage } from './drafts.ts'
import { takeSessionLock } from './lease.ts'
import { encodeSegment, projectKey, sessionDirectoryPath } from './paths.ts'
import {
  DAY_MS,
  isSafeOrigin,
  TrashError,
  TrashStore,
  type DeleteChatInput,
  type DeleteWorkspaceInput,
  type TrashedChat,
  type TrashItem,
  type TrashItemKind,
} from './store.ts'

/** The stores a purge effect can name in its report. */
export type PurgeStore =
  | 'full-text-index'
  | 'session-generations'
  | 'projection-cache'
  | 'attachments'
  | 'spill'
  | 'browser-drafts'
  | 'trash-content'

/** What a purge did, per C8's report. */
export interface PurgeReport {
  readonly itemId: string
  /** Every store whose purge effect removed the item's content. */
  readonly removedFrom: readonly PurgeStore[]
  logs: {
    /** Whether the affected log files, current and rotated, were deleted. */
    readonly cleared: boolean
    /**
     * Days purged fragments may remain in the retained process logs: 0 when
     * the logs were cleared, otherwise C20's retention.
     */
    readonly residueMaxDays: number
    /** The residue statement a purge states to the person. */
    readonly notice: string
  }
}

/** The stores a trash service reaches. Each is optional: an effect without its store reports nothing for it. */
export interface TrashStores {
  /** The JSONL session-persistence root, which holds every chat's session directory. */
  readonly sessionsRoot?: string
  /**
   * The storage backend's root, `<home>/storages`, which holds the projection
   * cache's per-session checkpoint documents under `session_projcache/sessions/`.
   */
  readonly storagesRoot?: string
  /** The configured spill roots. */
  readonly spillRoots?: readonly string[]
  /** The versioned attachment root, `<home>/attachments/v1`. */
  readonly attachmentsRoot?: string
  /** The full-text index seam, wired to session-query-sqlite's engine when the process runs one. */
  readonly sessionIndex?: SessionIndexPurge
  /**
   * The projection cache's live seam, when the process runs the cache: a
   * purge forgets each chat's record there too, so a pending write-behind
   * flush cannot write the purged values back after the file is removed.
   */
  readonly projectionCache?: ProjectionCachePurge
  /** The browser draft storage of the connection performing the purge. */
  readonly draftStorage?: DraftStorage
  /** The Delo home whose local operational logs the clear-logs offer deletes (C20). */
  readonly logsHome?: string
}

/** The live projection cache a purge forgets each chat in. */
export interface ProjectionCachePurge {
  /**
   * Forget one chat's record and its pending write-behind state.
   * @param sessionId - the chat whose record goes.
   */
  forget(sessionId: string): Promise<unknown>
}

/** Configuration of one trash service. */
export interface TrashServiceConfig {
  /** The trash root directory, `<home>/trash` by deployment. */
  readonly root: string
  /** The stores the service reaches; delete and purge read them per call. */
  readonly stores?: TrashStores
}

/** The residue statement a purge carries. */
export const PURGE_RESIDUE_NOTICE =
  `Purged content may remain in the operational logs for up to ${PURGE_RESIDUE_MAX_DAYS} days, `
  + 'until the operational logs\' own retention removes it. Accept the clear-logs offer to delete the '
  + 'affected log files, current and rotated, at once.'

/** One chat located under a sessions root. */
interface LocatedChat {
  readonly id: string
  readonly cwd: string | undefined
  readonly originDir: string
  readonly originRelative: string
}

/**
 * The trash, restore and purge service, with C8's retention.
 */
export class TrashService {
  private readonly store: TrashStore
  private readonly stores: TrashStores

  /**
   * @param config - the trash root and the stores the service reaches.
   */
  constructor(config: TrashServiceConfig) {
    this.store = new TrashStore(config.root)
    this.stores = config.stores ?? {}
  }

  /** The trash root the service owns. */
  get trashRoot(): string {
    return this.store.trashRoot
  }

  /**
   * Delete one chat: its session directory, with every generation in it, moves
   * into the trash as the content's one storage location, and the chat waits
   * in the trash for its 30-day retention.
   * @param input - the chat to delete.
   * @param now - the delete time, in epoch milliseconds; defaults to now.
   * @returns the created item.
   */
  async deleteChat(input: DeleteChatInput, now: number = Date.now()): Promise<TrashItem> {
    const sessionsRoot = this.requireSessionsRoot()
    const located = await locateChat(sessionsRoot, input.sessionId, input.cwd)
    const chats: TrashItem['chats'] = located === undefined
      ? [{ id: input.sessionId }]
      : [{ id: input.sessionId, origin: located.originRelative }]
    const item = await this.store.createItem('chat', input.label ?? input.sessionId, {
      chats,
      sessionIds: [input.sessionId],
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      sessionsRoot,
    }, now)
    if (located !== undefined) await this.moveIn(item.id, located)
    return (await this.store.readItem(item.id))!
  }

  /**
   * Delete one workspace: every chat of the workspace moves into the trash as
   * one item, and the item records the workspace id its browser entries name.
   * @param input - the workspace to delete.
   * @param now - the delete time, in epoch milliseconds; defaults to now.
   * @returns the created item.
   */
  async deleteWorkspace(input: DeleteWorkspaceInput, now: number = Date.now()): Promise<TrashItem> {
    const sessionsRoot = this.requireSessionsRoot()
    const locatedChats: Array<LocatedChat | undefined> = []
    const chats: TrashedChat[] = []
    const sessionIds: string[] = []
    for (const chat of input.chats) {
      const located = await locateChat(sessionsRoot, chat.sessionId, chat.cwd)
      locatedChats.push(located)
      chats.push(located === undefined ? { id: chat.sessionId } : { id: chat.sessionId, origin: located.originRelative })
      sessionIds.push(chat.sessionId)
    }
    const item = await this.store.createItem('workspace', input.label ?? input.workspaceId, {
      chats,
      sessionIds,
      workspaceIds: [input.workspaceId],
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.registration === undefined ? {} : { registration: input.registration }),
      sessionsRoot,
    }, now)
    for (const located of locatedChats) {
      if (located !== undefined) await this.moveIn(item.id, located)
    }
    return (await this.store.readItem(item.id))!
  }

  /**
   * Move in every chat a live writer kept at its origin when it was deleted,
   * now that the writer has let its session lock go. A home runs this at
   * start, before any chat is live again.
   * @returns how many chats moved into the trash.
   */
  async settle(): Promise<number> {
    let settled = 0
    for (const item of await this.store.listItems()) {
      if (item.sessionsRoot === undefined) continue
      for (const chat of item.chats) {
        if (chat.pending !== true || chat.origin === undefined || !isSafeOrigin(chat.origin)) continue
        const originDir = join(item.sessionsRoot, chat.origin)
        if (!await isDirectory(originDir)) continue
        if (await this.moveIn(item.id, { id: chat.id, cwd: undefined, originDir, originRelative: chat.origin })) settled++
      }
    }
    return settled
  }

  /**
   * Restore one item before its retention ends: every moved chat returns to
   * its origin session directory, byte for byte, and the item leaves the trash.
   * @param itemId - the item to restore.
   * @returns the item that was restored.
   */
  async restore(itemId: string): Promise<TrashItem> {
    const item = await this.store.readItem(itemId)
    if (item === undefined) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${itemId}"`)
    for (const chat of item.chats) {
      // A pending chat never left its origin, so it is restored where it is.
      if (chat.movedAs === undefined) continue
      await this.store.moveChatBack(item, chat)
    }
    await this.store.removeItem(itemId)
    return item
  }

  /**
   * Purge one item permanently: the full-text index rows, the session
   * directories with every generation, the chat's projection-cache document,
   * the attachments, the spill files, the browser draft entries and the
   * trash's own copy all go in one purge, and the report states the log
   * residue or, with the offer accepted, clears the affected log files.
   * @param itemId - the item to purge.
   * @param options - `clearLogs` accepts the log-clearing offer.
   * @returns the purge report.
   */
  async purge(itemId: string, options: { clearLogs?: boolean } = {}): Promise<PurgeReport> {
    const item = await this.store.readItem(itemId)
    if (item === undefined) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${itemId}"`)
    const removedFrom: PurgeStore[] = []
    const sessionsRoot = this.stores.sessionsRoot ?? item.sessionsRoot

    if (item.sessionIds.length > 0 && this.stores.sessionIndex !== undefined) {
      await this.stores.sessionIndex.forgetSessions(item.sessionIds)
      removedFrom.push('full-text-index')
    }
    if (sessionsRoot !== undefined) {
      for (const chat of item.chats) {
        if (chat.origin !== undefined && isSafeOrigin(chat.origin)) {
          await removeStrayGenerations(sessionsRoot, chat.origin)
        }
        await removeSessionDirectory(sessionsRoot, chat.id)
      }
      removedFrom.push('session-generations')
    }
    if (item.sessionIds.length > 0 && (this.stores.projectionCache !== undefined || this.stores.storagesRoot !== undefined)) {
      for (const sessionId of item.sessionIds) await this.stores.projectionCache?.forget(sessionId)
      if (this.stores.storagesRoot !== undefined) await removeProjectionCache(this.stores.storagesRoot, item.sessionIds)
      removedFrom.push('projection-cache')
    }
    if (this.stores.attachmentsRoot !== undefined && item.attachments.length > 0) {
      await removeAttachments(this.stores.attachmentsRoot, item.attachments)
      removedFrom.push('attachments')
    }
    if (this.stores.spillRoots !== undefined && this.stores.spillRoots.length > 0 && item.sessionIds.length > 0) {
      await removeSpill(this.stores.spillRoots, item.sessionIds)
      removedFrom.push('spill')
    }
    if (this.stores.draftStorage !== undefined
      && (item.sessionIds.length > 0 || item.workspaceIds.length > 0)) {
      removeDraftEntries(this.stores.draftStorage, item.sessionIds, item.workspaceIds)
      removedFrom.push('browser-drafts')
    }
    await this.store.removeItem(itemId)
    removedFrom.push('trash-content')

    const clearLogs = options.clearLogs === true && this.stores.logsHome !== undefined
    let clearedReport: RetentionReport | undefined
    if (clearLogs) clearedReport = clearLocalLogs(this.stores.logsHome!)
    return {
      itemId,
      removedFrom,
      logs: {
        cleared: clearedReport !== undefined,
        residueMaxDays: clearedReport !== undefined ? 0 : PURGE_RESIDUE_MAX_DAYS,
        notice: PURGE_RESIDUE_NOTICE,
      },
    }
  }

  /**
   * Purge every item whose retention has ended. A retention purge is not a
   * person's choice, so it never clears the operational logs; the residue
   * stays until C20's own retention removes it.
   * @param now - the retention check time, in epoch milliseconds.
   * @returns one report per purged item.
   */
  async enforceRetention(now: number = Date.now()): Promise<PurgeReport[]> {
    const reports: PurgeReport[] = []
    for (const item of await this.store.listItems()) {
      if (item.expiresAt > now) continue
      reports.push(await this.purge(item.id))
    }
    return reports
  }

  /**
   * List the trash, oldest delete first.
   * @param now - the observation time, which marks each item expired or not.
   * @returns every item with its retention state.
   */
  async list(now: number = Date.now()): Promise<readonly (TrashItem & { expired: boolean; retentionDays: number })[]> {
    return (await this.store.listItems()).map(item => ({
      ...item,
      expired: item.expiresAt <= now,
      retentionDays: TRASH_RETENTION_DAYS,
    }))
  }

  /** The sessions root delete needs, or the refusal for its absence. */
  private requireSessionsRoot(): string {
    const root = this.stores.sessionsRoot
    if (root === undefined) {
      throw new TrashError(
        'TRASH_SESSION_ROOT_UNAVAILABLE',
        'deleting a chat needs the session-persistence root in the service stores',
      )
    }
    return root
  }

  /**
   * Move one located chat into its item while holding the chat's session
   * lock, or mark it pending when a live writer holds the lock.
   * @param itemId - the item the chat belongs to.
   * @param located - the chat's session directory.
   * @returns whether the chat's content moved.
   */
  private async moveIn(itemId: string, located: LocatedChat): Promise<boolean> {
    const lock = await takeSessionLock(located.originDir)
    let chat: TrashedChat
    try {
      chat = lock === undefined
        ? { id: located.id, origin: located.originRelative, pending: true }
        : await this.store.moveChatIn(itemId, located.originDir, located.originRelative, located.cwd, located.id)
    } finally {
      await lock?.release()
    }
    const item = (await this.store.readItem(itemId))!
    await this.store.writeItem({ ...item, chats: item.chats.map(existing => existing.id === chat.id ? chat : existing) })
    return chat.movedAs !== undefined
  }
}

/**
 * Whether a path is a directory.
 * @param path - the path.
 * @returns whether it exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Locate one chat's session directory under the sessions root: first the
 * directory the given project derives, then the `_no-cwd` directory, then
 * every project directory the root holds, since a session id is unique across
 * the root.
 * @param sessionsRoot - the JSONL session-persistence root.
 * @param sessionId - the chat's session id.
 * @param cwd - the chat's project directory, when the caller knows it.
 * @returns the located chat, or `undefined` when no directory holds it.
 */
async function locateChat(
  sessionsRoot: string,
  sessionId: string,
  cwd: string | undefined,
): Promise<LocatedChat | undefined> {
  const encoded = encodeSegment(sessionId)
  const candidates: LocatedChat[] = []
  if (cwd !== undefined) {
    candidates.push({
      id: sessionId,
      cwd,
      originDir: sessionDirectoryPath(sessionsRoot, cwd, sessionId),
      originRelative: join(projectKey(cwd), encoded),
    })
  }
  candidates.push({
    id: sessionId,
    cwd: undefined,
    originDir: sessionDirectoryPath(sessionsRoot, undefined, sessionId),
    originRelative: join('_no-cwd', encoded),
  })
  let projects: string[] = []
  try {
    projects = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  for (const project of projects) {
    candidates.push({
      id: sessionId,
      cwd: undefined,
      originDir: join(sessionsRoot, project, encoded),
      originRelative: join(project, encoded),
    })
  }
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate.originDir)).isDirectory()) continue
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    return candidate
  }
  return undefined
}

export type { TrashItem, TrashItemKind }
export { TrashError, TrashStore, DAY_MS, isSafeOrigin }
