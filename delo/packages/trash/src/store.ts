/**
 * The trash store: one directory per trashed item under the trash root, each
 * holding the item's record and the chat session directories the delete moved
 * in. Trash keeps the item's secrets in this one location until its retention
 * ends or a purge removes it, so a deleted chat lives in exactly one store.
 *
 * @module @delo/trash/store
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import { encodeSegment, projectKey } from './paths.ts'

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000

/** The trash item record's schema version. */
export const TRASH_ITEM_SCHEMA_VERSION = 1 as const

/** What kind of thing the person deleted. */
export type TrashItemKind = 'chat' | 'workspace'

/** One chat of a trashed item, with the origin its restore moves back to. */
export interface TrashedChat {
  /** The chat's session id. */
  readonly id: string
  /**
   * The chat's session directory relative to the sessions root the delete
   * captured, `<projectKey>/<encodedId>`, when the chat had a materialized
   * directory; absent when the chat had nothing on disk.
   */
  readonly origin?: string
  /** Name of the directory the moved session content sits under, when moved. */
  readonly movedAs?: string
  /**
   * Set while a live writer held the chat's session lock at the delete: the
   * content stays at its origin until a later start moves it in
   * (`TrashService.settle`), and a purge removes it there.
   */
  readonly pending?: true
}

/** The workspace registration a workspace delete removed, which a restore registers again. */
export interface TrashedRegistration {
  /** The workspace's title. */
  readonly title: string
  /** The workspace's directory. */
  readonly path: string
}

/** One trashed item's record, `items/<id>/item.json`. */
export interface TrashItem {
  readonly schemaVersion: typeof TRASH_ITEM_SCHEMA_VERSION
  readonly id: string
  readonly kind: TrashItemKind
  /** Human-facing name the delete captured, such as the chat's title. */
  readonly label: string
  /** The chats of the item: the one chat, or every chat of a workspace. */
  readonly chats: readonly TrashedChat[]
  /** Every chat session id of the item, in item order. */
  readonly sessionIds: readonly string[]
  /** Workspace ids of the item, when the kind is `workspace`. */
  readonly workspaceIds: readonly string[]
  /** Lowercase hexadecimal SHA-256 digests of the item's attachment objects. */
  readonly attachments: readonly string[]
  /** Epoch milliseconds at which the delete happened. */
  readonly deletedAt: number
  /** Epoch milliseconds at which the retention ends and the purge runs. */
  readonly expiresAt: number
  /** The absolute sessions root the origins are relative to. */
  readonly sessionsRoot?: string
  /** Session ids the deleting home archived for the delete, which a restore unarchives. */
  readonly archived?: readonly string[]
  /** The workspace registration a workspace delete removed, which a restore registers again. */
  readonly registration?: TrashedRegistration
}

/** Input of a chat delete. */
export interface DeleteChatInput {
  readonly sessionId: string
  /** The chat's project directory, as its session header carries it. */
  readonly cwd?: string
  /** Human-facing name captured for the item. */
  readonly label?: string
  /** Digests of the chat's attachment objects, which stay until the purge. */
  readonly attachments?: readonly string[]
  /** Session ids the deleting home archived for the delete, which a restore unarchives. */
  readonly archived?: readonly string[]
}

/** Input of a workspace delete. */
export interface DeleteWorkspaceInput {
  readonly workspaceId: string
  /** The workspace's chats, each with the header cwd it was stored under. */
  readonly chats: readonly DeleteChatInput[]
  readonly label?: string
  readonly attachments?: readonly string[]
  /** Session ids the deleting home archived for the delete, which a restore unarchives. */
  readonly archived?: readonly string[]
  /** The workspace registration the delete removes, which a restore registers again. */
  readonly registration?: TrashedRegistration
}

/** Error of the trash store and service. */
export class TrashError extends Error {
  /**
   * @param code - the stable refusal code.
   * @param message - the human-facing refusal.
   */
  constructor(readonly code: TrashErrorCode, message: string) {
    super(message)
    this.name = 'TrashError'
  }
}

/** Codes a trash refusal carries. */
export type TrashErrorCode =
  | 'TRASH_ITEM_NOT_FOUND'
  | 'TRASH_RESTORE_CONFLICT'
  | 'TRASH_SESSION_ROOT_UNAVAILABLE'
  | 'TRASH_STORE_REFUSED'
  | 'TRASH_RECORD_INVALID'

/**
 * The on-disk trash store. Directories are 0700 and records 0600, because a
 * trashed item keeps its secrets until the purge.
 */
export class TrashStore {
  private readonly root: string

  /**
   * @param root - the trash root directory, `<home>/trash` by deployment.
   */
  constructor(root: string) {
    if (!isAbsolute(root)) throw new TrashError('TRASH_RECORD_INVALID', `the trash root "${root}" is not an absolute path`)
    this.root = resolve(root)
  }

  /** The trash root this store owns. */
  get trashRoot(): string {
    return this.root
  }

  /** The directory of one item. */
  itemPath(itemId: string): string {
    return join(this.root, 'items', itemId)
  }

  /** The directory holding one moved chat's session content. */
  chatContentPath(itemId: string, movedAs: string): string {
    return join(this.itemPath(itemId), 'chats', movedAs)
  }

  /**
   * Create the item record with C8's retention, without moving content yet.
   * @param kind - what the person deleted.
   * @param label - the human-facing name.
   * @param input - the item's chats, workspace ids and attachments.
   * @param now - the delete time, in epoch milliseconds.
   * @returns the written record.
   */
  async createItem(
    kind: TrashItemKind,
    label: string,
    input: {
      chats: readonly TrashedChat[]
      sessionIds: readonly string[]
      workspaceIds?: readonly string[]
      attachments?: readonly string[]
      sessionsRoot?: string
      archived?: readonly string[]
      registration?: TrashedRegistration
    },
    now: number,
  ): Promise<TrashItem> {
    const item: TrashItem = {
      schemaVersion: TRASH_ITEM_SCHEMA_VERSION,
      id: `${now.toString(36)}-${randomSuffix()}`,
      kind,
      label,
      chats: input.chats,
      sessionIds: input.sessionIds,
      workspaceIds: input.workspaceIds ?? [],
      attachments: input.attachments ?? [],
      deletedAt: now,
      expiresAt: now + TRASH_RETENTION_DAYS * DAY_MS,
      ...(input.sessionsRoot === undefined ? {} : { sessionsRoot: input.sessionsRoot }),
      ...(input.archived === undefined || input.archived.length === 0 ? {} : { archived: input.archived }),
      ...(input.registration === undefined ? {} : { registration: input.registration }),
    }
    await mkdir(this.itemPath(item.id), { recursive: true, mode: 0o700 })
    await this.writeItem(item)
    return item
  }

  /** Write one item's record at 0600. */
  async writeItem(item: TrashItem): Promise<void> {
    await writeFile(this.recordPath(item.id), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 })
  }

  /**
   * Move one chat's session directory into the item's content, making the
   * trash the content's one storage location.
   * @param itemId - the item the chat joins.
   * @param originDir - the chat's session directory at the sessions root.
   * @param originRelative - the directory relative to the sessions root.
   * @param cwd - the chat's project directory, for the content's name.
   * @param sessionId - the chat's session id, for the content's name.
   * @returns the chat record the item then holds.
   */
  async moveChatIn(
    itemId: string,
    originDir: string,
    originRelative: string,
    cwd: string | undefined,
    sessionId: string,
  ): Promise<TrashedChat> {
    const movedAs = contentName(cwd, sessionId)
    const target = this.chatContentPath(itemId, movedAs)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await moveDirectory(originDir, target)
    return { id: sessionId, origin: originRelative, movedAs }
  }

  /**
   * Move one moved chat's session content back to its origin.
   * @param item - the item holding the chat.
   * @param chat - the chat to restore.
   * @returns the directory the chat was restored to.
   */
  async moveChatBack(item: TrashItem, chat: TrashedChat): Promise<string> {
    if (chat.origin === undefined || chat.movedAs === undefined || item.sessionsRoot === undefined) {
      throw new TrashError('TRASH_RECORD_INVALID', `item "${item.id}" chat "${chat.id}" has no moved content to restore`)
    }
    const source = this.chatContentPath(item.id, chat.movedAs)
    const target = join(item.sessionsRoot, chat.origin)
    let exists = false
    try {
      exists = (await stat(target)).isDirectory()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    if (exists) {
      throw new TrashError(
        'TRASH_RESTORE_CONFLICT',
        `restoring "${chat.id}" would overwrite the session directory at ${target}`,
      )
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await moveDirectory(source, target)
    return target
  }

  /**
   * Read one item's record.
   * @param itemId - the item to read.
   * @returns the record, or `undefined` when no item carries the id.
   */
  async readItem(itemId: string): Promise<TrashItem | undefined> {
    let raw: string
    try {
      raw = await readFile(this.recordPath(itemId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    }
    const parsed = JSON.parse(raw) as TrashItem
    if (parsed.schemaVersion !== TRASH_ITEM_SCHEMA_VERSION || typeof parsed.id !== 'string') {
      throw new TrashError('TRASH_RECORD_INVALID', `the trash record of "${itemId}" is not a version ${TRASH_ITEM_SCHEMA_VERSION} item`)
    }
    return parsed
  }

  /**
   * List every item's record, oldest delete first.
   * @returns the records; a directory without a record is skipped.
   */
  async listItems(): Promise<TrashItem[]> {
    let entries: string[]
    try {
      entries = await readdir(join(this.root, 'items'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
      throw error
    }
    const items: TrashItem[] = []
    for (const entry of entries) {
      const item = await this.readItem(entry).catch(() => undefined)
      if (item !== undefined) items.push(item)
    }
    return items.sort((left, right) => left.deletedAt - right.deletedAt || left.id.localeCompare(right.id))
  }

  /**
   * Remove one item's whole directory: the record and the content it holds.
   * @param itemId - the item to remove.
   */
  async removeItem(itemId: string): Promise<void> {
    await rm(this.itemPath(itemId), { recursive: true, force: true })
  }

  /** The record file of one item. */
  private recordPath(itemId: string): string {
    if (itemId.includes('/') || itemId.includes('\\') || itemId === '.' || itemId === '..') {
      throw new TrashError('TRASH_RECORD_INVALID', `"${itemId}" is not a trash item id`)
    }
    return join(this.itemPath(itemId), 'item.json')
  }
}

/**
 * Whether one relative origin stays inside its sessions root.
 * @param origin - the recorded relative path.
 * @returns whether restore can safely join it under the sessions root.
 */
export function isSafeOrigin(origin: string): boolean {
  if (isAbsolute(origin) || origin.split(/[\\/]/).includes('..')) return false
  return relative('/a', join('/a', origin)).split(/[\\/]/).includes('..') === false
}

/**
 * Move a directory tree, falling back to copy-and-remove across devices.
 * @param from - the source directory.
 * @param to - the target directory, which must not exist.
 */
export async function moveDirectory(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EXDEV') throw error
    // The copy keeps each file's mode, and refuses a target that appeared meanwhile rather than merge into it.
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Derive the content directory name of one moved chat. */
function contentName(cwd: string | undefined, sessionId: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return `${project}/${encodeSegment(sessionId)}`
}

/** A short random suffix for item ids. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

/** Exported for tests that need a private scratch root. */
export async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'delo-trash-'))
}
