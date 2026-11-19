/**
 * The per-workspace defaults store: one JSON file in the Delorun home's protected state (`secrets/new-workspace/`,
 * mode 0600, read through `@delorun/home`'s protected-file refusal rule), which the sandbox denies to confined commands.
 * It keeps, per workspace, the model and reasoning effort new chats start with and the browser choice, keyed by the
 * workspace's canonical path as `@delorun/plugin-permission-defaults` keys its store; and, home-wide, the last folder a
 * new folder or clone went in. Every change reads, checks and writes the file while holding its lock file, so a change
 * of another Host process on the same home is never overwritten unread.
 * @module @delorun/plugin-new-workspace/defaults-store
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import {
  currentHolder, holderAlive, holderIdentity, isLockId, LockFile, parseHolder, randomLockId, readProtectedFile, writeProtectedFile,
  type ProcessHolder,
} from '@delorun/home'
import { z } from 'zod'
import { MAX_PATH_LENGTH, WorkspaceDefaults } from './wire.ts'

/** Format version of the store. */
export const DEFAULTS_STORE_VERSION = 1 as const

/** The store's directory under the home's `secrets/` directory, and its file name. */
export const DEFAULTS_STORE_SEGMENTS = ['new-workspace', 'defaults.json'] as const

/** The most workspaces the store keeps; the oldest entries beyond it are dropped on the next change. */
export const MAX_STORED_WORKSPACES = 1000

/** The largest store file read, in bytes. */
const MAX_STORE_BYTES = 4 * 1024 * 1024

/** The store's document. */
const StoreDocument = z.strictObject({
  v: z.literal(DEFAULTS_STORE_VERSION),
  lastParent: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  workspaces: z.record(z.string().min(1).max(MAX_PATH_LENGTH), WorkspaceDefaults),
})

/** What the store holds. */
export type DefaultsStoreContent = z.output<typeof StoreDocument>

/** An empty store. */
const EMPTY: DefaultsStoreContent = Object.freeze({ v: DEFAULTS_STORE_VERSION, workspaces: {} })

/** Why a store that exists cannot be read or changed. */
export class DefaultsStoreError extends Error {
  /**
   * @param reason - what went wrong, naming no workspace path.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'DefaultsStoreError'
  }
}

/**
 * The store's path under a resolved Delorun home.
 * @param home - the resolved Delorun home.
 * @returns the absolute path.
 */
export function defaultsStorePath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.secrets, ...DEFAULTS_STORE_SEGMENTS)
}

/**
 * Read the store.
 * @param path - the store's path.
 * @returns what it holds; an empty store while no file exists.
 * @throws {DefaultsStoreError} when the file exists and is refused (a laxer mode, a link, another format or too large).
 */
export async function readDefaultsStore(path: string): Promise<DefaultsStoreContent> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path, MAX_STORE_BYTES)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return EMPTY
    throw new DefaultsStoreError(`the defaults store was refused: ${error instanceof Error ? error.name : 'unknown failure'}`)
  }
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch (_notJson) {
    // The parser's message quotes the file, which names workspace paths.
    throw new DefaultsStoreError('the defaults store holds no JSON document')
  }
  const parsed = StoreDocument.safeParse(document)
  if (!parsed.success) throw new DefaultsStoreError('the defaults store is not in this version\'s format')
  return parsed.data
}

/**
 * The store's text: workspaces sorted by key, two-space indent, trailing newline.
 * @param content - what to write.
 * @returns the text.
 */
export function serializeDefaultsStore(content: DefaultsStoreContent): string {
  const keys = Object.keys(content.workspaces).sort()
  const workspaces = Object.fromEntries(keys.map(key => [key, content.workspaces[key]]))
  return `${JSON.stringify({ v: DEFAULTS_STORE_VERSION, ...(content.lastParent === undefined ? {} : { lastParent: content.lastParent }), workspaces }, null, 2)}\n`
}

/** How long a change waits for another process's change to the store, in milliseconds. */
export const DEFAULTS_STORE_LOCK_WAIT_MS = 10_000

/** The record of the store's lock file. */
interface LockRecord extends ProcessHolder {
  readonly v: 1
  readonly id: string
}

/**
 * Parse a lock record.
 * @param record - the lock file's JSON object.
 * @returns the record, or `undefined` when the object is not one.
 */
function parseLockRecord(record: Readonly<Record<string, unknown>>): LockRecord | undefined {
  const holder = parseHolder(record)
  if (holder === undefined || record['v'] !== 1 || !isLockId(record['id'])) return undefined
  return { v: 1, pid: holder.pid, id: record['id'], ...holderIdentity(holder) }
}

/**
 * Change the store while holding its lock file, `<store>.lock` (`@delorun/home`'s lock file: a dead holder's record is
 * taken over, a live holder waited for).
 * @param path - the store's path; its directory is created at the private mode when missing.
 * @param change - turns what the store holds into what it should hold.
 * @param waitMs - how long to wait for a live holder.
 * @returns what the store holds after the change.
 * @throws {DefaultsStoreError} when the store is refused or the lock is not free in time; nothing is changed.
 */
export async function changeDefaultsStore(path: string, change: (content: DefaultsStoreContent) => DefaultsStoreContent, waitMs: number = DEFAULTS_STORE_LOCK_WAIT_MS): Promise<DefaultsStoreContent> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  const file = new LockFile<LockRecord>(`${path}.lock`, {
    label: 'new-workspace defaults lock', remedy: 'once no delorun process changes workspace defaults', parse: parseLockRecord, id: record => record.id,
  })
  const holder = currentHolder()
  const record: LockRecord = { v: 1, pid: holder.pid, id: randomLockId(), ...holderIdentity(holder) }
  const deadline = Date.now() + waitMs
  while (!file.create(record)) {
    const found = file.read()
    /* v8 ignore next -- the holder released the lock between this create and this read; the loop tries again. */
    if (found === undefined) continue
    if (!holderAlive(found) && await file.removeDead(found.id) === 'done') continue
    if (Date.now() >= deadline) throw new DefaultsStoreError(`process ${String(found.pid)} holds the defaults store, so nothing was changed`)
    await sleep(Math.min(10 + Math.floor(Math.random() * 40), Math.max(1, deadline - Date.now())))
  }
  try {
    const next = trimmed(change(await readDefaultsStore(path)))
    await writeProtectedFile(path, serializeDefaultsStore(next))
    return next
  } finally {
    file.release(record.id)
  }
}

/**
 * Keep at most {@link MAX_STORED_WORKSPACES} workspaces, dropping those first in key order beyond it.
 * @param content - the store's content.
 * @returns the content within the bound.
 */
function trimmed(content: DefaultsStoreContent): DefaultsStoreContent {
  const keys = Object.keys(content.workspaces)
  if (keys.length <= MAX_STORED_WORKSPACES) return content
  const kept = keys.sort().slice(keys.length - MAX_STORED_WORKSPACES)
  return { ...content, workspaces: Object.fromEntries(kept.map(key => [key, content.workspaces[key] as WorkspaceDefaults])) }
}
