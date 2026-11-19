/**
 * What both halves of the trash plugin share: the harness's routes and the
 * JSON each one answers. Browser-safe.
 *
 * @module @delorun/plugin-trash/wire
 */

/**
 * The harness's routes, each `POST` with a JSON body. The studio fetches each
 * without its leading `/`, relative to the document. A refusal answers a
 * 4xx status with a {@link TrashRefusal}.
 */
export const TRASH_PATHS = {
  /** `{}` → {@link TrashListing}. */
  list: '/api/delorunTrash.list',
  /** `{ sessionId, label? }` → {@link TrashEntry}: the chat moves to the trash. */
  deleteChat: '/api/delorunTrash.deleteChat',
  /** `{ workspaceId }` → {@link TrashEntry}: the workspace's chats and its registration move to the trash. */
  deleteWorkspace: '/api/delorunTrash.deleteWorkspace',
  /** `{ itemId }` → {@link TrashEntry}: the item returns to where it was deleted from. */
  restore: '/api/delorunTrash.restore',
  /** `{ itemId, clearLogs }` → {@link PurgeOutcome}: the item is deleted forever. */
  purge: '/api/delorunTrash.purge',
  /** `{ clearLogs }` → {@link EmptyOutcome}: every item is deleted forever. */
  empty: '/api/delorunTrash.empty',
  /** `{}` → {@link SetAsideListing}: what a rollback set aside and the copies an update took. */
  setAside: '/api/delorunTrash.setAside',
  /** `{ path }` → {@link SetAsideRemoved}: one entry of {@link SetAsideListing} is deleted forever; needs an unlock. */
  removeSetAside: '/api/delorunTrash.removeSetAside',
} as const

/** One item in the trash, as the studio lists it. */
export interface TrashEntry {
  /** The item's id. */
  readonly id: string
  /** What the person deleted. */
  readonly kind: 'chat' | 'workspace'
  /** The chat's or the workspace's name when it was deleted. */
  readonly label: string
  /** Epoch milliseconds of the delete. */
  readonly deletedAt: number
  /** Epoch milliseconds at which the retention ends and the item is deleted forever. */
  readonly expiresAt: number
  /** The chats the item holds. */
  readonly sessionIds: readonly string[]
  /** The workspace the item holds, for a workspace. */
  readonly workspaceIds: readonly string[]
}

/** An item directory whose record cannot be read: nothing restores, purges or expires it. */
export interface DamagedEntry {
  /** The directory's name. */
  readonly id: string
  /** The item directory on the harness. */
  readonly directory: string
  /** Why its record cannot be read. */
  readonly reason: string
}

/** The answer to {@link TRASH_PATHS}.list. */
export interface TrashListing {
  /** Every item, oldest delete first. */
  readonly items: readonly TrashEntry[]
  /** Every item directory whose record cannot be read. */
  readonly damaged: readonly DamagedEntry[]
  /** Days the trash keeps an item. */
  readonly retentionDays: number
  /** Days purged fragments may remain in the operational logs unless they are cleared. */
  readonly residueDays: number
}

/** The answer to {@link TRASH_PATHS}.purge. */
export interface PurgeOutcome {
  /** The purged item. */
  readonly item: TrashEntry
  /** The stores the purge removed the item's content from. */
  readonly removedFrom: readonly string[]
  /** Attachments the item named that another chat still names, so they were kept. */
  readonly attachmentsKept: number
  /** Whether every operational log of the home was cleared without a failure. */
  readonly logsCleared: boolean
  /** Each log the clear could not change; empty when no clear was asked for or it succeeded. */
  readonly logFailures: readonly string[]
  /** Days purged fragments may remain in the operational logs: 0 when they were cleared. */
  readonly residueMaxDays: number
}

/** The answer to {@link TRASH_PATHS}.empty. */
export interface EmptyOutcome {
  /** Every purged item. */
  readonly items: readonly TrashEntry[]
  /** Whether every operational log of the home was cleared without a failure. */
  readonly logsCleared: boolean
  /** Each log the clear could not change; empty when no clear was asked for or it succeeded. */
  readonly logFailures: readonly string[]
  /** Days purged fragments may remain in the operational logs: 0 when they were cleared. */
  readonly residueMaxDays: number
}

/** One directory of chat data that a rollback set aside, or that an update copied before it switched. */
export interface SetAsideEntry {
  /** The directory's path relative to the home; `removeSetAside` takes it back unchanged. */
  readonly path: string
  /** `set-aside`: the chats a rollback moved out of use; `copy`: the chat data an update copied so a rollback can restore it. */
  readonly kind: 'set-aside' | 'copy'
  /** The directory's size in bytes. */
  readonly bytes: number
}

/** The answer to {@link TRASH_PATHS}.setAside. */
export interface SetAsideListing {
  readonly entries: readonly SetAsideEntry[]
}

/** The answer to {@link TRASH_PATHS}.removeSetAside. */
export interface SetAsideRemoved {
  /** The entry that was deleted. */
  readonly path: string
}

/** Why a route refused. */
export type TrashRefusalCode =
  | 'BAD_REQUEST'
  | 'TRASH_ITEM_NOT_FOUND'
  | 'TRASH_RESTORE_CONFLICT'
  | 'WORKSPACE_NOT_FOUND'
  /** The path names no listed set-aside or copy directory. */
  | 'NOT_KEPT_DATA'
  /** A rollback runs, a restore is unfinished, or an update record still needs the copy. */
  | 'DATA_IN_USE'
  /** The studio runs no profile whose update record guards the copies. */
  | 'KEPT_DATA_UNAVAILABLE'
  | 'TRASH_FAILED'

/** The body of a refusal. */
export interface TrashRefusal {
  /** The refusal's code. */
  readonly code: TrashRefusalCode
  /** One sentence for the log; the studio shows its own copy for the code. */
  readonly message: string
}
