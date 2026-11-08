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
  removeDraftEntries,
  removeSessionDirectory,
  removeSpill,
  removeStrayGenerations,
  type DraftStorage,
  type SessionIndexPurge,
} from './effects.ts'
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
  /** The configured spill roots. */
  readonly spillRoots?: readonly string[]
  /** The versioned attachment root, `<home>/attachments/v1`. */
  readonly attachmentsRoot?: string
  /** The full-text index seam, wired to session-query-sqlite's engine when the process runs one. */
  readonly sessionIndex?: SessionIndexPurge
  /** The browser draft storage of the connection performing the purge. */
  readonly draftStorage?: DraftStorage
  /** The Delo home whose local operational logs the clear-logs offer deletes (C20). */
  readonly logsHome?: string
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
      sessionsRoot,
    }, now)
    if (located !== undefined) {
      const moved = await this.store.moveChatIn(item.id, located.originDir, located.originRelative, located.cwd, input.sessionId)
      await this.writeChat(item, moved)
    }
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
      sessionsRoot,
    }, now)
    for (let index = 0; index < locatedChats.length; index++) {
      const located = locatedChats[index]
      if (located === undefined) continue
      const moved = await this.store.moveChatIn(item.id, located.originDir, located.originRelative, located.cwd, located.id)
      await this.writeChat(item, moved)
    }
    return (await this.store.readItem(item.id))!
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
      if (chat.movedAs === undefined) continue
      await this.store.moveChatBack(item, chat)
    }
    await this.store.removeItem(itemId)
    return item
  }

  /**
   * Purge one item permanently: the full-text index rows, the session
   * directories with every generation, the attachments, the spill files, the
   * browser draft entries and the trash's own copy all go in one purge, and
   * the report states the log residue or, with the offer accepted, clears the
   * affected log files.
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

  /** Write one chat's moved-content record into its item. */
  private async writeChat(item: TrashItem, chat: TrashItem['chats'][number]): Promise<void> {
    const chats = item.chats.map(existing => existing.id === chat.id ? chat : existing)
    await this.store.writeItem({ ...item, chats })
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
