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
 * The module is free of Cordis, so the store's format, its refusals and its
 * file handling are testable without a mounted plugin.
 *
 * @module @delo/plugin-permission-defaults/store
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'

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
  for (const workspace of [...entries.keys()].sort()) {
    const entry = entries.get(workspace)
    if (entry !== undefined) workspaces[workspace] = { preset: entry.preset, fullAccessGrantedAt: entry.fullAccessGrantedAt }
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
