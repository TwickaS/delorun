/**
 * The per-workspace permission store: one JSON file in the Delo home's
 * protected state. C1's protected files carry mode 0600 and are read through
 * the refusal rule, and this one lives under the home's `secrets/` directory,
 * which the sandbox's confinement rules deny to confined commands — so a
 * confined command can neither read the consents nor grant itself full access
 * by adding one.
 *
 * One entry per workspace, keyed by the workspace key
 * ([`./workspace.ts`](./workspace.ts)): the preset new chats in that workspace
 * start with, and when the person granted full access for it, or null while
 * full access was never granted.
 *
 * The store is one file for the whole home, which several processes change: the
 * Host of each running profile, `delorun workspace full-access` and
 * `delorun headless`. Every change reads the file, checks it and writes it while
 * holding the store's lock file ({@link withPermissionStoreLock}), so a change
 * never overwrites another process's change it did not read; and a reader on a
 * synchronous path compares the file's identity
 * ({@link permissionStoreIdentity}) with the one it read and reads the file
 * again ({@link readPermissionStoreSync}) when it differs.
 *
 * The module is free of Cordis, so the store's format, its refusals and its
 * file handling are testable without a mounted plugin.
 *
 * @module @delo/plugin-permission-defaults/store
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import {
  checkProtectedFileSync, currentHolder, holderAlive, holderIdentity, isLockId, LockFile, parseHolder, randomLockId,
  readProtectedFile, writeProtectedFile, type ProcessHolder,
} from '@delo/home'

/** Format version of the permission store. */
export const PERMISSION_STORE_VERSION = 1 as const

/** Directory of the permission store under the home's `secrets/` directory. */
export const PERMISSION_STORE_DIR = 'permission-defaults'

/** File name of the permission store inside its directory. */
export const PERMISSION_STORE_FILE = 'workspaces.json'

/** The preset a workspace starts on until the person chooses another: write inside the workspace, ask for more. */
export const SAFER_PRESET = 'workspace-write' as const

/** The preset that drops both the file-sandbox boundary and the approval prompts. */
export const FULL_ACCESS_PRESET = 'danger-full-access' as const

/** The presets a workspace default can hold: the safer one and full access. */
export type PermissionPresetName = typeof SAFER_PRESET | typeof FULL_ACCESS_PRESET

/** Every {@link PermissionPresetName}, for runtime validation of a stored value. */
export const PERMISSION_PRESETS: readonly PermissionPresetName[] = [SAFER_PRESET, FULL_ACCESS_PRESET]

/** One workspace's recorded permission: its default preset and when full access was granted for it. */
export interface WorkspacePermission {
  /** The preset new chats in this workspace start with. */
  readonly preset: PermissionPresetName
  /** When the person granted full access for this workspace, in milliseconds since the epoch, or null. */
  readonly fullAccessGrantedAt: number | null
}

/** Why a store that exists could not be read as this version's format. */
export class PermissionStoreError extends Error {
  /**
   * @param reason - what the store holds instead of this version's format.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'PermissionStoreError'
  }
}

/**
 * The store's path under a resolved Delo home: the home's `secrets/` directory
 * (contract C1's protected state), this package's own directory below it, and
 * the store's file name.
 * @param home - the resolved Delo home.
 * @returns the absolute path.
 */
export function permissionStorePath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.secrets, PERMISSION_STORE_DIR, PERMISSION_STORE_FILE)
}

/**
 * Whether a value is a plain JSON object.
 * @param value - the value to check.
 * @returns true when the value is an object and not an array or null.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is one of {@link PERMISSION_PRESETS}.
 * @param value - the value to check.
 * @returns true when the value names a preset a workspace default can hold.
 */
export function isPermissionPreset(value: unknown): value is PermissionPresetName {
  return typeof value === 'string' && PERMISSION_PRESETS.includes(value as PermissionPresetName)
}

/**
 * One workspace's entry as the store holds it.
 * @param workspace - the workspace key, named in the reason.
 * @param value - the store's value for it.
 * @returns the entry.
 * @throws {PermissionStoreError} when the value is not an object holding only
 *   the preset and the grant time, with the right types.
 */
function workspacePermissionOf(workspace: string, value: unknown): WorkspacePermission {
  const named = `the permission of the workspace ${JSON.stringify(workspace)}`
  if (!isRecord(value)) throw new PermissionStoreError(`${named} is not an object`)
  const extra = Object.keys(value).filter(key => key !== 'preset' && key !== 'fullAccessGrantedAt')
  if (extra.length > 0) throw new PermissionStoreError(`${named} sets ${extra.join(', ')}`)
  if (!isPermissionPreset(value['preset'])) {
    throw new PermissionStoreError(`${named} does not hold the preset ${PERMISSION_PRESETS.join(' or ')}`)
  }
  const grantedAt = value['fullAccessGrantedAt']
  if (grantedAt !== null && (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt))) {
    throw new PermissionStoreError(`${named} does not hold a number grant time or null`)
  }
  return { preset: value['preset'], fullAccessGrantedAt: grantedAt }
}

/**
 * Parse the store's text into its workspace entries.
 * @param text - the store file's text.
 * @returns the entries, keyed by workspace key.
 * @throws {PermissionStoreError} when the text is not this version's format:
 *   no JSON document, not an object, a version other than
 *   {@link PERMISSION_STORE_VERSION}, an unknown field, or an entry whose
 *   fields are wrong.
 */
export function parsePermissionStore(text: string): ReadonlyMap<string, WorkspacePermission> {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new PermissionStoreError('the store holds no JSON document')
  }
  if (!isRecord(document)) throw new PermissionStoreError('the store is not a JSON object')
  if (document['v'] !== PERMISSION_STORE_VERSION) {
    throw new PermissionStoreError(`the store's version is ${JSON.stringify(document['v'])}, not ${String(PERMISSION_STORE_VERSION)}`)
  }
  const extra = Object.keys(document).filter(key => key !== 'v' && key !== 'workspaces')
  if (extra.length > 0) throw new PermissionStoreError(`the store sets ${extra.join(', ')}`)
  if (!isRecord(document['workspaces'])) throw new PermissionStoreError('the store does not hold a workspaces object')
  const entries = new Map<string, WorkspacePermission>()
  for (const [workspace, value] of Object.entries(document['workspaces'])) {
    if (workspace.length === 0) throw new PermissionStoreError('the store holds an entry with an empty workspace key')
    entries.set(workspace, workspacePermissionOf(workspace, value))
  }
  return entries
}

/**
 * The store's text for a set of entries: one JSON object whose workspaces are
 * sorted by key, with a trailing newline.
 * @param entries - the entries, keyed by workspace key.
 * @returns the text to write.
 */
export function serializePermissionStore(entries: ReadonlyMap<string, WorkspacePermission>): string {
  const workspaces: Record<string, WorkspacePermission> = {}
  for (const [workspace, entry] of [...entries].sort(([left], [right]) => Number(left > right) - Number(left < right))) {
    workspaces[workspace] = { preset: entry.preset, fullAccessGrantedAt: entry.fullAccessGrantedAt }
  }
  return `${JSON.stringify({ v: PERMISSION_STORE_VERSION, workspaces }, null, 2)}\n`
}

/** What reading the store found. */
export type PermissionStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable', readonly entries: ReadonlyMap<string, WorkspacePermission> }
  | { readonly kind: 'refused', readonly problem: string }

/**
 * Whether a failure is the missing store, which is no refusal: a home without a
 * permission store has recorded no workspace yet, so every workspace starts on
 * the safer preset.
 * @param error - the failure of the read.
 * @returns true when the failure reports `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The reason a failed read gives, in its own words.
 * @param error - the failure of the read.
 * @returns the failure's message, or a plain one when it has none.
 */
function problemOf(error: unknown): string {
  /* v8 ignore next -- the reads and the parser throw only Error instances; the words cover any other value. */
  return error instanceof Error ? error.message : 'the file could not be read'
}

/**
 * Read the store from its path, applying contract C1's protected-file refusal rule.
 * @param path - the store's absolute path.
 * @returns `absent` while no store exists, `readable` with its entries, or
 *   `refused` with the reason a store that exists could not be read as this
 *   version's format — a laxer mode, a symbolic link, another format, or a
 *   filesystem failure.
 */
export async function readPermissionStore(path: string): Promise<PermissionStoreRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    return { kind: 'refused', problem: problemOf(error) }
  }
  try {
    return { kind: 'readable', entries: parsePermissionStore(bytes.toString('utf8')) }
  } catch (error) {
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/**
 * Write the store at its path through contract C1's protected-file write: a
 * sibling temporary file at mode 0600, flushed and renamed over the path. The
 * store's directory is created at the private directory mode when missing.
 * @param path - the store's absolute path.
 * @param entries - the entries to write, keyed by workspace key.
 */
export async function writePermissionStore(path: string, entries: ReadonlyMap<string, WorkspacePermission>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(path, serializePermissionStore(entries))
}

/**
 * The preset a workspace starts on, from its entry: the safer preset while the
 * workspace has no entry at all, which is every workspace the person has not
 * chosen for yet.
 * @param entries - the store's entries.
 * @param workspace - the workspace key.
 * @returns the workspace's default preset.
 */
export function defaultPresetOf(entries: ReadonlyMap<string, WorkspacePermission>, workspace: string): PermissionPresetName {
  return entries.get(workspace)?.preset ?? SAFER_PRESET
}

/**
 * Whether the person granted full access for a workspace.
 * @param entries - the store's entries.
 * @param workspace - the workspace key.
 * @returns true when an entry holds a grant time for the workspace.
 */
export function fullAccessGranted(entries: ReadonlyMap<string, WorkspacePermission>, workspace: string): boolean {
  return (entries.get(workspace)?.fullAccessGrantedAt ?? null) !== null
}

/**
 * The identity of the store file as a synchronous reader compares it: device, inode, size and modification time, or
 * `absent` while no file exists. Every write renames a new file over the path, so a write changes the inode.
 * @param path - the store's absolute path.
 * @returns the identity's text; for a path that cannot be examined, the failure's code, which differs from every
 *   identity of a readable file.
 */
export function permissionStoreIdentity(path: string): string {
  try {
    const stats = lstatSync(path)
    return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`
  } catch (error) {
    return isMissing(error) ? 'absent' : `unexaminable:${String((error as NodeJS.ErrnoException).code)}`
  }
}

/**
 * Read the store synchronously, for a reader that must answer before it can await: contract C1's protected-file rule
 * is checked on the path, the file is opened without following a symbolic link, and the opened file must be the one
 * that was checked.
 * @param path - the store's absolute path.
 * @returns what {@link readPermissionStore} returns for the same file.
 */
export function readPermissionStoreSync(path: string): PermissionStoreRead {
  const read = readPermissionStoreSyncText(path)
  if (read.kind !== 'text') return read
  try {
    return { kind: 'readable', entries: parsePermissionStore(read.text) }
  } catch (error) {
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/**
 * The protected-file read both synchronous readers share.
 * @param path - the file's absolute path.
 * @returns the text, `absent`, or `refused` with the reason.
 */
function readPermissionStoreSyncText(path: string): { readonly kind: 'text', readonly text: string } | { readonly kind: 'absent' } | { readonly kind: 'refused', readonly problem: string } {
  try {
    const checked = checkProtectedFileSync(path)
    const fd = openSync(path, READ_FLAGS)
    try {
      const opened = fstatSync(fd)
      /* v8 ignore next -- a file renamed over the path between the check and the open; no test can order that. */
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new PermissionStoreError(`${path} was replaced while it was being read`)
      return { kind: 'text', text: readFileSync(fd, 'utf8') }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/** The open flags of the synchronous read: never follow a symbolic link where the platform can refuse one. */
/* v8 ignore next -- the platform decides which side runs; the suite runs on Linux and macOS. */
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)

/** How long a change waits for another process's change to the store, in milliseconds. */
export const PERMISSION_STORE_LOCK_WAIT_MS = 10_000

/** The record of the store's lock file. */
interface StoreLockRecord extends ProcessHolder {
  /** Record version. */
  readonly v: 1
  /** A random id, never reused, naming the guard that may remove this record. */
  readonly id: string
}

/**
 * Parse a lock record.
 * @param record - the lock file's JSON object.
 * @returns the record, or `undefined` when the object is not one.
 */
function parseLockRecord(record: Readonly<Record<string, unknown>>): StoreLockRecord | undefined {
  const holder = parseHolder(record)
  if (holder === undefined || record['v'] !== 1 || !isLockId(record['id'])) return undefined
  return { v: 1, pid: holder.pid, id: record['id'], ...holderIdentity(holder) }
}

/**
 * Run one change to the store while holding its lock file, `<store>.lock`, `@delo/home`'s lock file shared by Delo's
 * locks: created whole, and a record whose holder process is dead removed under a takeover guard. A live holder is
 * waited for. The change reads, checks and writes the store inside the lock, so a concurrent change of another
 * process is either read by it or waits for it.
 * @param path - the store's absolute path; its directory is created at the private directory mode when missing.
 * @param change - the change.
 * @param waitMs - how long to wait for a live holder.
 * @returns the change's result.
 * @throws {PermissionStoreError} naming the holder's process when the lock is not free in time; nothing is changed.
 */
export async function withPermissionStoreLock<T>(path: string, change: () => Promise<T>, waitMs: number = PERMISSION_STORE_LOCK_WAIT_MS): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  const file = new LockFile<StoreLockRecord>(`${path}.lock`, {
    label: 'permission store lock', remedy: 'once no delorun process changes full access', parse: parseLockRecord, id: record => record.id,
  })
  const holder = currentHolder()
  const record: StoreLockRecord = { v: 1, pid: holder.pid, id: randomLockId(), ...holderIdentity(holder) }
  const deadline = Date.now() + waitMs
  while (!file.create(record)) {
    const found = file.read()
    /* v8 ignore next -- the holder released the lock between this create and this read; the loop tries again. */
    if (found === undefined) continue
    if (!holderAlive(found) && await file.removeDead(found.id) === 'done') continue
    if (Date.now() >= deadline) {
      throw new PermissionStoreError(`process ${String(found.pid)} has been changing the permission store for longer than ${String(waitMs / 1000)} seconds, so nothing was changed; try again once it finishes`)
    }
    await sleep(Math.min(10 + Math.floor(Math.random() * 40), Math.max(1, deadline - Date.now())))
  }
  try {
    return await change()
  } finally {
    file.release(record.id)
  }
}

/** The version of the dangerous-mode warning text a person accepts in `delorun setup`, recorded in the grant file. */
export const DANGEROUS_WARNING_VERSION = 1

/** Format version of the dangerous-mode grant file. */
const DANGEROUS_GRANT_VERSION = 1

/** File name of the dangerous-mode grant file, beside the permission store. */
export const DANGEROUS_GRANT_FILE = 'full-access-everywhere.json'

/** What reading the dangerous-mode grant file found. */
export type DangerousGrantRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid', readonly grantedAt: string }
  | { readonly kind: 'refused', readonly problem: string }

/**
 * The dangerous-mode grant file's path: `<home>/secrets/permission-defaults/full-access-everywhere.json`, next to the
 * store and under the same lock. Only `delorun setup` writes it.
 * @param home - the resolved Delo home.
 * @returns the absolute path.
 */
export function dangerousGrantPath(home: string): string {
  return join(dirname(permissionStorePath(home)), DANGEROUS_GRANT_FILE)
}

/**
 * Parse the grant file's text.
 * @param text - the file's text.
 * @returns the grant time, or the reason the text is not this version's grant.
 */
export function parseDangerousGrant(text: string): DangerousGrantRead {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    // The parser's message quotes the text; the reason names the file only.
    return { kind: 'refused', problem: 'the dangerous-mode grant file holds no JSON document' }
  }
  const grantedAt = isRecord(document) ? document['grantedAt'] : undefined
  const known = isRecord(document) && Object.keys(document).length === 3 && document['v'] === DANGEROUS_GRANT_VERSION && document['warning'] === DANGEROUS_WARNING_VERSION
  if (!known || typeof grantedAt !== 'string' || Number.isNaN(Date.parse(grantedAt))) {
    return { kind: 'refused', problem: 'the dangerous-mode grant file is not in the format this version reads' }
  }
  return { kind: 'valid', grantedAt }
}

/**
 * Read the grant file under contract C1's protected-file refusal rule: a symbolic link, a mode laxer than 0600 or
 * another format counts as no grant and is named in the problem.
 * @param path - the grant file's absolute path.
 * @returns `absent` while no file exists, `valid` with the grant time, or `refused` with the reason.
 */
export async function readDangerousGrant(path: string): Promise<DangerousGrantRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    return { kind: 'refused', problem: problemOf(error) }
  }
  return parseDangerousGrant(bytes.toString('utf8'))
}

/**
 * Read the grant file synchronously, with the checks of {@link readPermissionStoreSync}.
 * @param path - the grant file's absolute path.
 * @returns what {@link readDangerousGrant} returns for the same file.
 */
export function readDangerousGrantSync(path: string): DangerousGrantRead {
  const read = readPermissionStoreSyncText(path)
  return read.kind === 'text' ? parseDangerousGrant(read.text) : read
}

/**
 * Write the grant file while holding the store's lock, at mode 0600.
 * @param home - the resolved Delo home.
 * @param now - the grant time.
 * @returns when the file is replaced.
 */
export async function writeDangerousGrant(home: string, now: Date = new Date()): Promise<void> {
  const path = dangerousGrantPath(home)
  const text = `${JSON.stringify({ v: DANGEROUS_GRANT_VERSION, grantedAt: now.toISOString(), warning: DANGEROUS_WARNING_VERSION }, null, 2)}\n`
  await withPermissionStoreLock(permissionStorePath(home), async () => {
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(path, text)
  })
}

/**
 * Remove the grant file while holding the store's lock; a symbolic link is removed as a link.
 * @param home - the resolved Delo home.
 * @returns whether a file was removed.
 */
export async function removeDangerousGrant(home: string): Promise<boolean> {
  const path = dangerousGrantPath(home)
  try {
    await lstat(path)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  return withPermissionStoreLock(permissionStorePath(home), async () => {
    await rm(path, { force: true })
    return true
  })
}
