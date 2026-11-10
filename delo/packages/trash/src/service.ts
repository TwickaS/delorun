/**
 * The trash service of contract C8: deleting a chat or a workspace moves it to
 * the trash, the person can restore it before its 30-day retention ends, and a
 * purge, by hand or at the retention's end, removes it from every store that
 * holds its content. A purge states that fragments may remain in the
 * operational logs until C20's 14-day retention, and it offers to clear the
 * home's operational logs at once; when the person accepts, it clears every
 * local log, not only the records of the purged item.
 *
 * Every path the service writes is derived from the configured sessions root
 * and the item's own directory; the record supplies only two-segment names,
 * which the store validates. A delete records where each chat goes before it
 * moves it, and a restore checks every target before it moves anything back,
 * rewrites the record after each chat it returns, and never removes an item
 * whose directory still holds chat content.
 *
 * @module @delo/trash/service
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clearLocalLogs } from '@delo/logs'
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
import { directoryDigests, treeDigests } from './session-text.ts'
import {
  contentName,
  DAY_MS,
  isSafeOrigin,
  pathExists,
  TrashError,
  TrashStore,
  type DamagedItem,
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
  /** Every store the purge reached for the item's content. */
  readonly removedFrom: readonly PurgeStore[]
  /** Attachments the item's chats named that another chat still names, so they were kept. */
  readonly attachmentsKept: number
  logs: {
    /** Whether every local operational log was cleared without a failure. */
    readonly cleared: boolean
    /** Each log the clear could not change, by message; empty when the clear was not asked for or succeeded. */
    readonly failures: readonly string[]
    /**
     * Days purged fragments may remain in the retained process logs: 0 when
     * the logs were cleared, otherwise C20's retention.
     */
    readonly residueMaxDays: number
    /** The residue statement a purge states to the person. */
    readonly notice: string
  }
}

/** Why a retention pass purged nothing. */
export type RetentionPause =
  /** An item was deleted later than the clock now reads, or the clock reads earlier than the last pass. */
  | 'clock-behind'
  /** The clock reads more than {@link RETENTION_MAX_GAP_DAYS} days after the last pass. */
  | 'clock-jump'

/** What one retention pass did. */
export interface RetentionOutcome {
  /** One report per purged item. */
  readonly purged: readonly PurgeReport[]
  /** Set when the pass purged nothing because the clock is not trustworthy. */
  readonly paused?: RetentionPause | undefined
}

/**
 * The longest gap between two retention passes that the clock is trusted
 * over. A clock that jumps further forward would make every item look
 * expired; the pass pauses once, records the new time, and runs at the next
 * start if the clock stays there.
 */
export const RETENTION_MAX_GAP_DAYS = 365

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
  /** The Delo home whose local operational logs the clear-logs offer clears (C20). */
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
  + 'until the operational logs\' own retention removes it. Accepting the clear-logs offer clears every '
  + 'operational log of the home at once, current and rotated, not only the records of this item.'

/** The file under the trash root that records the last retention pass. */
export const RETENTION_RECORD = 'retention.json'

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
    const attachments = await this.attachmentsOf([located], input.attachments)
    const item = await this.store.createItem('chat', input.label ?? input.sessionId, {
      chats: [chatRecord(input.sessionId, located)],
      sessionIds: [input.sessionId],
      attachments,
      ...(input.archived === undefined ? {} : { archived: input.archived }),
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
    for (const chat of input.chats) locatedChats.push(await locateChat(sessionsRoot, chat.sessionId, chat.cwd))
    const attachments = await this.attachmentsOf(locatedChats, [...input.attachments ?? [], ...input.chats.flatMap(chat => chat.attachments ?? [])])
    const item = await this.store.createItem('workspace', input.label ?? input.workspaceId, {
      chats: input.chats.map((chat, index) => chatRecord(chat.sessionId, locatedChats[index])),
      sessionIds: input.chats.map(chat => chat.sessionId),
      workspaceIds: [input.workspaceId],
      attachments,
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.registration === undefined ? {} : { registration: input.registration }),
    }, now)
    for (const located of locatedChats) {
      if (located !== undefined) await this.moveIn(item.id, located)
    }
    return (await this.store.readItem(item.id))!
  }

  /**
   * Move in every chat whose content is still at its origin: one a live
   * writer kept there when it was deleted, or one a crash left there after
   * the record named its place in the trash. A home runs this at start,
   * before any chat is live again.
   * @returns how many chats moved into the trash.
   */
  async settle(): Promise<number> {
    const sessionsRoot = this.stores.sessionsRoot
    if (sessionsRoot === undefined) return 0
    let settled = 0
    for (const item of await this.store.listItems()) {
      for (const chat of item.chats) {
        if (chat.origin === undefined) continue
        if (chat.movedAs !== undefined && await this.store.holdsChat(item.id, chat.movedAs)) continue
        const originDir = join(sessionsRoot, chat.origin)
        if (!await isDirectory(originDir)) continue
        if (await this.moveIn(item.id, { id: chat.id, cwd: undefined, originDir, originRelative: chat.origin }, chat.movedAs)) settled++
      }
    }
    return settled
  }

  /**
   * Restore one item before its retention ends: every chat whose content the
   * item holds returns to its origin session directory, byte for byte, and the
   * item leaves the trash. Every target is checked before anything moves, and
   * the record is rewritten after each chat returns, so a restore that stops
   * partway leaves a record of exactly what is still in the trash.
   * @param itemId - the item to restore.
   * @returns the item as it was before the restore.
   * @throws {TrashError} `TRASH_RESTORE_CONFLICT` when a session directory stands at a target, before anything moves.
   */
  async restore(itemId: string): Promise<TrashItem> {
    const sessionsRoot = this.requireSessionsRoot()
    const item = await this.store.readItem(itemId)
    if (item === undefined) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${itemId}"`)
    const returning: TrashedChat[] = []
    for (const chat of item.chats) {
      if (chat.movedAs === undefined || !await this.store.holdsChat(item.id, chat.movedAs)) continue
      if (chat.origin === undefined) {
        throw new TrashError('TRASH_RECORD_INVALID', `item "${item.id}" holds chat "${chat.id}" without the origin to restore it to`)
      }
      if (await pathExists(join(sessionsRoot, chat.origin))) {
        throw new TrashError('TRASH_RESTORE_CONFLICT', `restoring "${chat.id}" would overwrite the session directory at ${join(sessionsRoot, chat.origin)}`)
      }
      returning.push(chat)
    }
    let remaining = item
    for (const chat of returning) {
      await this.store.moveChatBack(item.id, chat.movedAs!, join(sessionsRoot, chat.origin!))
      remaining = { ...remaining, chats: remaining.chats.filter(entry => entry !== chat), sessionIds: remaining.sessionIds.filter(id => id !== chat.id) }
      await this.store.writeItem(remaining)
    }
    if (await this.store.holdsContent(item.id)) {
      throw new TrashError('TRASH_RESTORE_CONFLICT', `item "${item.id}" still holds chat content after the restore, so it stays in the trash`)
    }
    await this.store.removeItem(itemId)
    return item
  }

  /**
   * Purge one item permanently: the full-text index rows, the session
   * directories with every generation, the chat's projection-cache document,
   * the attachments no other chat names, the spill files, the browser draft
   * entries and the trash's own copy all go in one purge, and the report
   * states the log residue or, with the offer accepted, clears the logs.
   * @param itemId - the item to purge.
   * @param options - `clearLogs` accepts the log-clearing offer.
   * @returns the purge report.
   */
  async purge(itemId: string, options: { clearLogs?: boolean } = {}): Promise<PurgeReport> {
    const item = await this.store.readItem(itemId)
    if (item === undefined) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${itemId}"`)
    const removedFrom: PurgeStore[] = []
    const sessionsRoot = this.stores.sessionsRoot

    if (item.sessionIds.length > 0 && this.stores.sessionIndex !== undefined) {
      await this.stores.sessionIndex.forgetSessions(item.sessionIds)
      removedFrom.push('full-text-index')
    }
    let attachmentsKept = 0
    let attachments: readonly string[] = []
    if (this.stores.attachmentsRoot !== undefined && item.attachments.length > 0) {
      const named = await this.namedElsewhere(item)
      attachments = item.attachments.filter(digest => !named.has(digest))
      attachmentsKept = item.attachments.length - attachments.length
    }
    if (sessionsRoot !== undefined) {
      for (const chat of item.chats) {
        if (chat.origin !== undefined) await removeStrayGenerations(sessionsRoot, chat.origin)
        await removeSessionDirectory(sessionsRoot, chat.id)
      }
      removedFrom.push('session-generations')
    }
    if (item.sessionIds.length > 0 && (this.stores.projectionCache !== undefined || this.stores.storagesRoot !== undefined)) {
      for (const sessionId of item.sessionIds) await this.stores.projectionCache?.forget(sessionId)
      if (this.stores.storagesRoot !== undefined) await removeProjectionCache(this.stores.storagesRoot, item.sessionIds)
      removedFrom.push('projection-cache')
    }
    if (this.stores.attachmentsRoot !== undefined && attachments.length > 0) {
      await removeAttachments(this.stores.attachmentsRoot, attachments)
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

    const failures = options.clearLogs === true && this.stores.logsHome !== undefined
      ? clearLocalLogs(this.stores.logsHome).failures.map(failure => failure.message)
      : undefined
    const cleared = failures !== undefined && failures.length === 0
    return {
      itemId,
      removedFrom,
      attachmentsKept,
      logs: {
        cleared,
        failures: failures ?? [],
        residueMaxDays: cleared ? 0 : PURGE_RESIDUE_MAX_DAYS,
        notice: PURGE_RESIDUE_NOTICE,
      },
    }
  }

  /**
   * Purge every item whose retention has ended. A retention purge is not a
   * person's choice, so it never clears the operational logs. The pass purges
   * nothing when the clock is not trustworthy: when an item was deleted later
   * than the clock now reads, when the clock reads earlier than the last pass,
   * or when it reads more than {@link RETENTION_MAX_GAP_DAYS} days after it.
   * @param now - the retention check time, in epoch milliseconds.
   * @returns the purged items, or the reason the pass paused.
   */
  async enforceRetention(now: number = Date.now()): Promise<RetentionOutcome> {
    const items = await this.store.listItems()
    const lastRunAt = await this.lastRetentionRun()
    let paused: RetentionPause | undefined
    if (items.some(item => item.deletedAt > now) || (lastRunAt !== undefined && now < lastRunAt)) paused = 'clock-behind'
    else if (lastRunAt !== undefined && now - lastRunAt > RETENTION_MAX_GAP_DAYS * DAY_MS) paused = 'clock-jump'
    if (paused !== 'clock-behind') await this.recordRetentionRun(now)
    if (paused !== undefined) return { purged: [], paused }
    const purged: PurgeReport[] = []
    for (const item of items) {
      if (item.expiresAt > now) continue
      purged.push(await this.purge(item.id))
    }
    return { purged }
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

  /**
   * The item directories whose records cannot be read. Nothing restores,
   * purges or expires them; a person inspects each directory.
   * @returns each damaged directory with the reason.
   */
  async damaged(): Promise<readonly DamagedItem[]> {
    return (await this.store.scan()).damaged
  }

  /** The sessions root delete and restore need, or the refusal for its absence. */
  private requireSessionsRoot(): string {
    const root = this.stores.sessionsRoot
    if (root === undefined) {
      throw new TrashError(
        'TRASH_SESSION_ROOT_UNAVAILABLE',
        'deleting or restoring a chat needs the session-persistence root in the service stores',
      )
    }
    return root
  }

  /**
   * The attachment digests a delete records: the given ones and every one the chats' generations name, when the
   * service reaches an attachment store.
   * @param located - the chats' session directories.
   * @param given - digests the caller names.
   * @returns the digests, each once, sorted.
   */
  private async attachmentsOf(located: ReadonlyArray<LocatedChat | undefined>, given: readonly string[] = []): Promise<string[]> {
    const found = new Set(given)
    if (this.stores.attachmentsRoot !== undefined) {
      for (const chat of located) {
        if (chat !== undefined) for (const digest of await directoryDigests(chat.originDir)) found.add(digest)
      }
    }
    return [...found].sort()
  }

  /**
   * The attachment digests every chat outside one item names: each live chat
   * under the sessions root and each chat of every other item in the trash.
   * @param item - the item being purged.
   * @returns the digests.
   */
  private async namedElsewhere(item: TrashItem): Promise<Set<string>> {
    const sessionsRoot = this.stores.sessionsRoot
    const skip = new Set(sessionsRoot === undefined ? [] : item.chats.flatMap(chat => chat.origin === undefined ? [] : [join(sessionsRoot, chat.origin)]))
    const named = sessionsRoot === undefined ? new Set<string>() : await treeDigests(sessionsRoot, skip)
    for (const other of await this.store.listItems()) {
      if (other.id === item.id) continue
      for (const digest of other.attachments) named.add(digest)
      for (const digest of await treeDigests(join(this.store.itemPath(other.id), 'chats'))) named.add(digest)
    }
    return named
  }

  /**
   * Move one located chat into its item while holding the chat's session
   * lock, or mark it pending when a live writer holds the lock. The record
   * names the chat's place in the trash before the move, so a crash between
   * the two leaves the content at its origin with a record that says where it
   * was going, which settle and restore read against the disk.
   * @param itemId - the item the chat belongs to.
   * @param located - the chat's session directory.
   * @param recorded - the name the record already gives the chat's place, if any.
   * @returns whether the chat's content moved.
   */
  private async moveIn(itemId: string, located: LocatedChat, recorded?: string): Promise<boolean> {
    const lock = await takeSessionLock(located.originDir)
    const movedAs = recorded ?? contentName(located.cwd, located.id)
    try {
      if (lock === undefined) {
        await this.writeChat(itemId, { id: located.id, origin: located.originRelative, pending: true })
        return false
      }
      await this.writeChat(itemId, { id: located.id, origin: located.originRelative, movedAs })
      await this.store.moveChatIn(itemId, located.originDir, movedAs)
      return true
    } finally {
      await lock?.release()
    }
  }

  /**
   * Replace one chat's record within its item.
   * @param itemId - the item.
   * @param chat - the chat's new record.
   */
  private async writeChat(itemId: string, chat: TrashedChat): Promise<void> {
    const item = (await this.store.readItem(itemId))!
    await this.store.writeItem({ ...item, chats: item.chats.map(existing => existing.id === chat.id ? chat : existing) })
  }

  /**
   * The time of the last retention pass.
   * @returns epoch milliseconds, or `undefined` when no pass is recorded or the record is not one.
   */
  private async lastRetentionRun(): Promise<number | undefined> {
    let raw: string
    try {
      raw = await readFile(join(this.store.trashRoot, RETENTION_RECORD), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    }
    let value: unknown
    try {
      value = (JSON.parse(raw) as { lastRunAt?: unknown }).lastRunAt
    } catch (error: unknown) {
      // An unreadable record is the same as none: the pass then trusts the items' own times only.
      void error
      return undefined
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /**
   * Record the time of a retention pass.
   * @param now - the pass's time.
   */
  private async recordRetentionRun(now: number): Promise<void> {
    try {
      await writeFile(join(this.store.trashRoot, RETENTION_RECORD), `${JSON.stringify({ lastRunAt: now })}\n`, { mode: 0o600 })
    } catch (error: unknown) {
      // ENOENT: the trash root does not exist yet, so nothing was ever deleted and no pass needs recording.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * The record of one chat before its content moves.
 * @param sessionId - the chat.
 * @param located - its session directory, when it has one.
 * @returns the record.
 */
function chatRecord(sessionId: string, located: LocatedChat | undefined): TrashedChat {
  return located === undefined ? { id: sessionId } : { id: sessionId, origin: located.originRelative }
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
      originRelative: `${projectKey(cwd)}/${encoded}`,
    })
  }
  candidates.push({
    id: sessionId,
    cwd: undefined,
    originDir: sessionDirectoryPath(sessionsRoot, undefined, sessionId),
    originRelative: `_no-cwd/${encoded}`,
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
      originRelative: `${project}/${encoded}`,
    })
  }
  for (const candidate of candidates) {
    if (!isSafeOrigin(candidate.originRelative)) continue
    if (!await isDirectory(candidate.originDir)) continue
    return candidate
  }
  return undefined
}

export type { TrashItem, TrashItemKind }
export { TrashError, TrashStore, DAY_MS, isSafeOrigin }
