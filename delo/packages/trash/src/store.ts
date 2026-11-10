/**
 * The trash store: one directory per trashed item under the trash root, each
 * holding the item's record and the chat session directories the delete moved
 * in. Trash keeps the item's secrets in this one location until its retention
 * ends or a purge removes it, so a deleted chat lives in exactly one store.
 *
 * A record is written whole, through a temporary file that is flushed and
 * renamed over it, so a crash leaves the old record or the new one and never a
 * torn one. A record that cannot be read is reported as damaged, with its
 * directory, and nothing reads its paths. Every path a record names is checked
 * to be exactly two encoded segments, the shape the session backend writes, so
 * a tampered record cannot reach outside the sessions root or the item.
 *
 * @module @delo/trash/store
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
   * The chat's session directory relative to the configured sessions root,
   * `<projectKey>/<encodedId>`, when the chat had a materialized directory;
   * absent when the chat had nothing on disk.
   */
  readonly origin?: string
  /**
   * Name of the directory under the item's `chats/` the content moves to. It
   * is recorded before the move, so a crash between the two leaves the
   * content at its origin and the record naming where it would have gone;
   * restore and settle look on disk rather than trust the record alone.
   */
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
  /** The chats of the item still in the trash: the one chat, or every chat of a workspace. */
  readonly chats: readonly TrashedChat[]
  /** The session id of every chat in {@link chats}, in item order. */
  readonly sessionIds: readonly string[]
  /** Workspace ids of the item, when the kind is `workspace`. */
  readonly workspaceIds: readonly string[]
  /** Lowercase hexadecimal SHA-256 digests of the attachments the item's chats name. */
  readonly attachments: readonly string[]
  /** Epoch milliseconds at which the delete happened. */
  readonly deletedAt: number
  /** Epoch milliseconds at which the retention ends and the purge runs. */
  readonly expiresAt: number
  /** Session ids the deleting home archived for the delete, which a restore unarchives. */
  readonly archived?: readonly string[]
  /** The workspace registration a workspace delete removed, which a restore registers again. */
  readonly registration?: TrashedRegistration
}

/** An item directory whose record cannot be read. Nothing acts on it; a person inspects the directory. */
export interface DamagedItem {
  /** The directory's name under `items/`. */
  readonly id: string
  /** The item directory. */
  readonly directory: string
  /** Why the record cannot be read. */
  readonly reason: string
}

/** Input of a chat delete. */
export interface DeleteChatInput {
  readonly sessionId: string
  /** The chat's project directory, as its session header carries it. */
  readonly cwd?: string
  /** Human-facing name captured for the item. */
  readonly label?: string
  /** Digests of the chat's attachments, added to the ones the delete finds in its generations. */
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
  /** The stable refusal code. */
  readonly code: TrashErrorCode

  /**
   * @param code - the stable refusal code.
   * @param message - the human-facing refusal.
   */
  constructor(code: TrashErrorCode, message: string) {
    super(message)
    this.code = code
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

/** One encoded path segment as the session backend writes it. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/

/** An item id: the delete time in base 36, a hyphen and a random suffix. */
const ITEM_ID = /^[0-9a-z]+-[0-9a-z]+$/

/** A lowercase hexadecimal SHA-256 digest. */
const DIGEST = /^[0-9a-f]{64}$/

/**
 * Whether a recorded path is exactly two encoded segments, `<project>/<chat>`,
 * the shape of a session directory under the sessions root and of a moved
 * chat under an item's `chats/`. Anything else could name a directory outside
 * the store the record belongs to.
 * @param path - the recorded relative path.
 * @returns whether the path has that shape.
 */
export function isSafeOrigin(path: string): boolean {
  const segments = path.split('/')
  return segments.length === 2 && segments.every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/**
 * The on-disk trash store. Directories are 0700 and records 0600, because a
 * trashed item keeps its secrets until the purge.
 */
export class TrashStore {
  /** The trash root directory, `<home>/trash` by deployment. */
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
    if (!ITEM_ID.test(itemId)) throw new TrashError('TRASH_RECORD_INVALID', `"${itemId}" is not a trash item id`)
    return join(this.root, 'items', itemId)
  }

  /**
   * The directory holding one moved chat's session content.
   * @param itemId - the item.
   * @param movedAs - the chat's recorded name under `chats/`.
   * @returns the directory.
   * @throws {TrashError} `TRASH_RECORD_INVALID` when the name is not two encoded segments.
   */
  chatContentPath(itemId: string, movedAs: string): string {
    if (!isSafeOrigin(movedAs)) throw new TrashError('TRASH_RECORD_INVALID', `item "${itemId}" names the content "${movedAs}", which is not a chat directory name`)
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
      archived?: readonly string[]
      registration?: TrashedRegistration
    },
    now: number,
  ): Promise<TrashItem> {
    const item: TrashItem = {
      schemaVersion: TRASH_ITEM_SCHEMA_VERSION,
      id: `${Math.max(0, Math.trunc(now)).toString(36)}-${randomBytes(4).toString('hex')}`,
      kind,
      label,
      chats: input.chats,
      sessionIds: input.sessionIds,
      workspaceIds: input.workspaceIds ?? [],
      attachments: input.attachments ?? [],
      deletedAt: now,
      expiresAt: now + TRASH_RETENTION_DAYS * DAY_MS,
      ...(input.archived === undefined || input.archived.length === 0 ? {} : { archived: input.archived }),
      ...(input.registration === undefined ? {} : { registration: input.registration }),
    }
    validateItem(item, item.id)
    await mkdir(this.itemPath(item.id), { recursive: true, mode: 0o700 })
    await this.writeItem(item)
    return item
  }

  /**
   * Write one item's record at 0600, whole: the bytes go to a temporary file
   * created exclusively, are flushed, and the file is renamed over the record.
   * @param item - the record.
   */
  async writeItem(item: TrashItem): Promise<void> {
    validateItem(item, item.id)
    const path = this.recordPath(item.id)
    const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(item, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, path)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  /**
   * Move one chat's session directory into the item's content. The caller
   * has recorded `movedAs` before calling.
   * @param itemId - the item the chat joins.
   * @param originDir - the chat's session directory at the sessions root.
   * @param movedAs - the recorded name under the item's `chats/`.
   */
  async moveChatIn(itemId: string, originDir: string, movedAs: string): Promise<void> {
    const target = this.chatContentPath(itemId, movedAs)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await moveDirectory(originDir, target)
  }

  /**
   * Whether one moved chat's content is in the item, on disk.
   * @param itemId - the item.
   * @param movedAs - the recorded name under `chats/`.
   * @returns whether the directory exists.
   */
  async holdsChat(itemId: string, movedAs: string): Promise<boolean> {
    return await pathExists(this.chatContentPath(itemId, movedAs))
  }

  /**
   * Move one chat's content from the item back to a session directory.
   * @param itemId - the item.
   * @param movedAs - the recorded name under `chats/`.
   * @param target - the session directory to restore to, which must not exist.
   */
  async moveChatBack(itemId: string, movedAs: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await moveDirectory(this.chatContentPath(itemId, movedAs), target)
  }

  /**
   * Read one item's record.
   * @param itemId - the item to read.
   * @returns the record, or `undefined` when no item carries the id, which includes a string that is no item id.
   * @throws {TrashError} `TRASH_RECORD_INVALID` when the record is not a valid item.
   */
  async readItem(itemId: string): Promise<TrashItem | undefined> {
    if (!ITEM_ID.test(itemId)) return undefined
    let raw: string
    try {
      raw = await readFile(this.recordPath(itemId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      // The parse error's text names a byte position, which says nothing a person can act on.
      void error
      throw new TrashError('TRASH_RECORD_INVALID', `the trash record of "${itemId}" is not JSON`)
    }
    return validateItem(parsed, itemId)
  }

  /**
   * Read every item directory: the records that are valid, oldest delete
   * first, and every directory whose record cannot be read.
   * @returns both lists.
   */
  async scan(): Promise<{ readonly items: TrashItem[], readonly damaged: DamagedItem[] }> {
    let entries: string[]
    try {
      entries = await readdir(join(this.root, 'items'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { items: [], damaged: [] }
      throw error
    }
    const items: TrashItem[] = []
    const damaged: DamagedItem[] = []
    for (const entry of entries.sort()) {
      const directory = join(this.root, 'items', entry)
      if (!ITEM_ID.test(entry)) {
        damaged.push({ id: entry, directory, reason: 'the directory\'s name is not a trash item id' })
        continue
      }
      try {
        const item = await this.readItem(entry)
        if (item === undefined) damaged.push({ id: entry, directory, reason: 'the directory holds no item.json' })
        else items.push(item)
      } catch (error: unknown) {
        damaged.push({ id: entry, directory, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    items.sort((left, right) => left.deletedAt - right.deletedAt || left.id.localeCompare(right.id))
    return { items, damaged }
  }

  /**
   * List every valid item's record, oldest delete first.
   * @returns the records; a damaged directory is in {@link scan}'s other list.
   */
  async listItems(): Promise<TrashItem[]> {
    return (await this.scan()).items
  }

  /**
   * Remove one item's whole directory: the record and the content it holds.
   * @param itemId - the item to remove.
   */
  async removeItem(itemId: string): Promise<void> {
    await rm(this.itemPath(itemId), { recursive: true, force: true })
  }

  /**
   * Whether an item's `chats/` still holds any file.
   * @param itemId - the item.
   * @returns true when chat content remains.
   */
  async holdsContent(itemId: string): Promise<boolean> {
    let entries
    try {
      entries = await readdir(join(this.itemPath(itemId), 'chats'), { recursive: true, withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
    return entries.some(entry => !entry.isDirectory())
  }

  /** The record file of one item. */
  private recordPath(itemId: string): string {
    return join(this.itemPath(itemId), 'item.json')
  }
}

/**
 * Validate one parsed record: every field the format defines, with the paths
 * it names in their only safe shape.
 * @param value - the parsed record.
 * @param itemId - the directory it was read from.
 * @returns the record.
 * @throws {TrashError} `TRASH_RECORD_INVALID` naming the first field that is wrong.
 */
function validateItem(value: unknown, itemId: string): TrashItem {
  const invalid = (what: string): TrashError => new TrashError('TRASH_RECORD_INVALID', `the trash record of "${itemId}" ${what}`)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('is not an object')
  const record = value as Record<string, unknown>
  const strings = (field: string, test: (text: string) => boolean = () => true): void => {
    const list = record[field]
    if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string' && test(entry))) throw invalid(`has no valid ${field}`)
  }
  if (record.schemaVersion !== TRASH_ITEM_SCHEMA_VERSION) throw invalid(`is not a version ${String(TRASH_ITEM_SCHEMA_VERSION)} item`)
  if (record.id !== itemId) throw invalid('names another item id')
  if (record.kind !== 'chat' && record.kind !== 'workspace') throw invalid('has no valid kind')
  if (typeof record.label !== 'string') throw invalid('has no label')
  if (!Number.isFinite(record.deletedAt) || !Number.isFinite(record.expiresAt)) throw invalid('has no valid times')
  strings('sessionIds')
  strings('workspaceIds')
  strings('attachments', digest => DIGEST.test(digest))
  if (record.archived !== undefined) strings('archived')
  const registration = record.registration as Record<string, unknown> | undefined
  if (registration !== undefined && (typeof registration !== 'object' || registration === null
    || typeof registration.title !== 'string' || typeof registration.path !== 'string')) throw invalid('has no valid registration')
  if (!Array.isArray(record.chats)) throw invalid('has no chats')
  for (const chat of record.chats as unknown[]) {
    const fields = chat as Record<string, unknown> | null
    if (typeof fields !== 'object' || fields === null || typeof fields.id !== 'string') throw invalid('has a chat without an id')
    for (const key of ['origin', 'movedAs'] as const) {
      const path = fields[key]
      if (path !== undefined && (typeof path !== 'string' || !isSafeOrigin(path))) throw invalid(`names the ${key} ${JSON.stringify(path)}, which is not a chat directory name`)
    }
    if (fields.pending !== undefined && fields.pending !== true) throw invalid('has a chat with an invalid pending mark')
  }
  return value as TrashItem
}

/**
 * Whether a path exists, without following a link at its end.
 * @param path - the path.
 * @returns whether anything stands there.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Move a directory tree, falling back to copy-and-remove across devices. The
 * target must not exist: a rename would replace an empty directory there, and
 * a copy would merge into a full one, so either is refused first.
 * @param from - the source directory.
 * @param to - the target directory.
 * @throws Error with code `EEXIST` when something stands at the target.
 */
export async function moveDirectory(from: string, to: string): Promise<void> {
  if (await pathExists(to)) throw Object.assign(new Error(`${to} exists, and a move never replaces or merges into it`), { code: 'EEXIST' })
  try {
    await rename(from, to)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EXDEV') throw error
    // The copy keeps each file's mode. The source goes only after the copy finished; a removal that fails partway
    // leaves the rest of the source, which a restore then refuses to overwrite.
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * The content directory name of one moved chat.
 * @param cwd - the chat's project directory, when known.
 * @param sessionId - the chat's session id.
 * @returns `<projectKey>/<encodedId>`.
 */
export function contentName(cwd: string | undefined, sessionId: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return `${project}/${encodeSegment(sessionId)}`
}

/**
 * A private scratch root, for specs.
 * @returns the directory.
 */
export async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'delo-trash-'))
}
