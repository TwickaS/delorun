/**
 * What the trash plugin does on the harness, apart from its routes: deleting a
 * chat or a workspace archives its chats with their running work stopped and
 * moves them into the trash, a restore moves them back, registers a deleted
 * workspace again and unarchives what the delete archived, and a purge
 * removes an item from every store contract C8 names. Every operation runs
 * after the one before it has finished, so two moves of one chat never
 * overlap.
 *
 * @module @delo/plugin-trash/operations
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { PURGE_RESIDUE_MAX_DAYS, TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import { TrashService, type RetentionOutcome, type TrashItem, type TrashStores } from '@delo/trash'
import type { EmptyOutcome, PurgeOutcome, TrashEntry, TrashListing } from './wire.ts'

/** The part of upstream's workspace registry the trash uses. */
export type TrashRegistry = Pick<WorkspaceRegistry, 'archivedSessionIds' | 'archiveSession' | 'unarchiveSession' | 'list' | 'create' | 'delete'>

/** Where the trash and the stores it reaches live, and the seams the harness mounts now. */
export interface TrashOperationsConfig {
  /** The trash root. */
  readonly trashRoot: string
  /** The stores, read again for each operation, because the services behind the seams come and go. */
  readonly stores: () => TrashStores
  /** The workspace registry. */
  readonly registry: TrashRegistry
  /** Report a failure the operation contained, so the person's request still completed. */
  readonly warn: (message: string) => void
}

/** A refusal of a trash operation that names what the person asked for. */
export class TrashOperationError extends Error {
  readonly code: 'WORKSPACE_NOT_FOUND'

  /**
   * @param code - the refusal code.
   * @param message - one sentence for the log.
   */
  constructor(code: 'WORKSPACE_NOT_FOUND', message: string) {
    super(message)
    this.code = code
    this.name = 'TrashOperationError'
  }
}

/**
 * The studio's view of one trash item.
 * @param item - the item.
 * @returns the entry.
 */
export function entryOf(item: TrashItem): TrashEntry {
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    deletedAt: item.deletedAt,
    expiresAt: item.expiresAt,
    sessionIds: item.sessionIds,
    workspaceIds: item.workspaceIds,
  }
}

/**
 * The trash plugin's operations over one home.
 */
export class TrashOperations {
  private tail: Promise<unknown> = Promise.resolve()

  private readonly config: TrashOperationsConfig

  /**
   * @param config - the trash root, the stores, the registry and the warning sink.
   */
  constructor(config: TrashOperationsConfig) {
    this.config = config
  }

  /**
   * At start: move in the chats a live writer held when they were deleted,
   * then purge every item whose retention has ended.
   * @param now - the start time.
   * @returns the retention pass's outcome: the purged items, or why it paused.
   */
  start(now: number = Date.now()): Promise<RetentionOutcome> {
    return this.serial(async () => {
      await this.service().settle()
      return await this.service().enforceRetention(now)
    })
  }

  /**
   * The trash, oldest delete first.
   * @returns the listing.
   */
  list(): Promise<TrashListing> {
    return this.serial(async () => {
      const service = this.service()
      return {
        items: (await service.list()).map(entryOf),
        damaged: (await service.damaged()).map(({ id, directory, reason }) => ({ id, directory, reason })),
        retentionDays: TRASH_RETENTION_DAYS,
        residueDays: PURGE_RESIDUE_MAX_DAYS,
      }
    })
  }

  /**
   * Move one chat to the trash: archive it with its running work stopped,
   * then move its session directory into the trash.
   * @param sessionId - the chat.
   * @param label - the chat's name as the studio shows it.
   * @returns the new entry.
   */
  deleteChat(sessionId: SessionId, label: string | undefined): Promise<TrashEntry> {
    return this.serial(async () => {
      const archived = await this.archive([sessionId])
      return entryOf(await this.service().deleteChat({ sessionId, ...(label === undefined ? {} : { label }), archived }))
    })
  }

  /**
   * Move one workspace to the trash: archive its chats with their running
   * work stopped, move them into one trash item that records the
   * registration, then remove the registration.
   * @param workspaceId - the workspace.
   * @returns the new entry.
   * @throws {TrashOperationError} `WORKSPACE_NOT_FOUND` for an id the registry does not hold.
   */
  deleteWorkspace(workspaceId: string): Promise<TrashEntry> {
    return this.serial(async () => {
      const workspace = this.config.registry.list().find(candidate => candidate.id === workspaceId)
      if (workspace === undefined) throw new TrashOperationError('WORKSPACE_NOT_FOUND', `no workspace carries the id "${workspaceId}"`)
      const sessionIds = [...workspace.sessionIds]
      const archived = await this.archive(sessionIds)
      const item = await this.service().deleteWorkspace({
        workspaceId,
        label: workspace.title,
        chats: sessionIds.map(sessionId => ({ sessionId })),
        archived,
        registration: { title: workspace.title, path: workspace.path },
      })
      await this.config.registry.delete(workspace.id).catch((error: unknown) => {
        this.config.warn(`the workspace "${workspace.title}" stays registered after its chats moved to the trash: ${String(error)}`)
      })
      return entryOf(item)
    })
  }

  /**
   * Restore one item: its chats move back, a deleted workspace is registered
   * again with its chats, and every chat the delete archived is unarchived.
   * @param itemId - the item.
   * @returns the restored entry.
   */
  restore(itemId: string): Promise<TrashEntry> {
    return this.serial(async () => {
      const item = await this.service().restore(itemId)
      if (item.registration !== undefined) {
        try {
          const workspace = await this.config.registry.create(item.registration.path, item.registration.title)
          for (const sessionId of [...item.sessionIds].reverse()) {
            await workspace.attachSession(SessionId(sessionId)).catch((error: unknown) => {
              this.config.warn(`a restored chat could not rejoin its workspace: ${String(error)}`)
            })
          }
        } catch (error: unknown) {
          this.config.warn(`the restored workspace "${item.registration.title}" could not be registered again: ${String(error)}`)
        }
      }
      for (const sessionId of item.archived ?? []) {
        await this.config.registry.unarchiveSession(SessionId(sessionId)).catch((error: unknown) => {
          this.config.warn(`a restored chat stays archived: ${String(error)}`)
        })
      }
      return entryOf(item)
    })
  }

  /**
   * Delete one item forever.
   * @param itemId - the item.
   * @param clearLogs - whether the person accepted clearing every operational log of the home now.
   * @returns what the purge did.
   */
  purge(itemId: string, clearLogs: boolean): Promise<PurgeOutcome> {
    return this.serial(async () => {
      const service = this.service()
      const item = (await service.list()).find(candidate => candidate.id === itemId)
      const report = await service.purge(itemId, { clearLogs })
      return {
        item: entryOf(item!),
        removedFrom: report.removedFrom,
        attachmentsKept: report.attachmentsKept,
        logsCleared: report.logs.cleared,
        logFailures: report.logs.failures,
        residueMaxDays: report.logs.residueMaxDays,
      }
    })
  }

  /**
   * Delete every item forever.
   * @param clearLogs - whether the person accepted clearing every operational log of the home now, which the last
   *   purge does once.
   * @returns what the purges did.
   */
  empty(clearLogs: boolean): Promise<EmptyOutcome> {
    return this.serial(async () => {
      const service = this.service()
      const items = await service.list()
      let cleared = false
      let failures: readonly string[] = []
      for (const [index, item] of items.entries()) {
        const report = await service.purge(item.id, { clearLogs: clearLogs && index === items.length - 1 })
        cleared = report.logs.cleared
        failures = report.logs.failures
      }
      return { items: items.map(entryOf), logsCleared: cleared, logFailures: failures, residueMaxDays: cleared ? 0 : PURGE_RESIDUE_MAX_DAYS }
    })
  }

  /**
   * Archive every chat that is not archived yet, stopping its running work.
   * A chat the registry does not know is left as it is.
   * @param sessionIds - the chats.
   * @returns the chats this call archived.
   */
  private async archive(sessionIds: readonly SessionId[]): Promise<SessionId[]> {
    const before = new Set(this.config.registry.archivedSessionIds)
    const archived: SessionId[] = []
    for (const sessionId of sessionIds) {
      if (before.has(sessionId)) continue
      try {
        await this.config.registry.archiveSession(sessionId, { stopActivity: true })
      } catch (error: unknown) {
        if (error instanceof WorkspaceUnknownSessionError) continue
        throw error
      }
      archived.push(sessionId)
    }
    return archived
  }

  /**
   * A trash service over the stores the harness mounts now.
   * @returns the service.
   */
  private service(): TrashService {
    return new TrashService({ root: this.config.trashRoot, stores: this.config.stores() })
  }

  /**
   * Run one operation after the one before it has finished.
   * @param operation - the operation.
   * @returns its result.
   */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch((error: unknown) => {
      // The caller receives this failure through `result`; the chain only needs to continue.
      void error
    })
    return result
  }
}
