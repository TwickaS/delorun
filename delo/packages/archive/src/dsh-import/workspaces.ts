/**
 * The workspace registrations of a stock home: upstream's `workspace` storage
 * unit, `storages/workspace.json`. The document is read with upstream's own
 * record schemas and checked for the consistency upstream's registry refuses
 * to start without, because a registry that does not parse would stop the
 * Delo home from starting. The import writes the list from the parsed and
 * checked value, never from the stock bytes, and only with the workspaces and
 * chats it carries: a workspace whose folder is the person's home, `/`, a
 * dot-directory directly under the home, or lies in either Harness home is
 * held back ({@link sensitiveFolder}). A Delo home with a list, in a merge, keeps every record
 * it has: a stock workspace whose folder the Delo home already registers adds
 * its chats to that workspace, any other is added after the Delo home's own,
 * and a stock workspace whose identifier the Delo home holds for something else
 * refuses the merge, because an import never overwrites a record.
 *
 * @module @delo/archive/dsh-import/workspaces
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { workspaceDomainSpec, workspaceDomainState, workspaceRecord, type WorkspaceDomainState, type WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import { DshImportError } from './errors.ts'

/** The registry document's home-relative path. */
export const REGISTRY_PATH = 'storages/workspace.json'

/** One parsed and checked registry document. */
export interface Registry {
  /** The unit version the document is stamped with. */
  readonly version: number
  /** The registry state; the initial state when the document holds none yet. */
  readonly state: WorkspaceDomainState
  /** The workspace records, by identifier. */
  readonly records: ReadonlyMap<string, WorkspaceRecord>
}

/**
 * Parse and check one registry document.
 * @param text - the document's text.
 * @returns the registry.
 * @throws Error naming what is wrong, without quoting the document.
 */
export function parseRegistry(text: string): Registry {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    // The parser's message quotes the document; the reason alone is enough.
    throw new Error('it is not JSON')
  }
  const unit = field(document, 'unit')
  const version = field(unit, 'version')
  if (field(unit, 'name') !== workspaceDomainSpec.name || version !== workspaceDomainSpec.version) {
    throw new Error(`it is not a version ${String(workspaceDomainSpec.version)} workspace unit`)
  }
  const global = field(document, 'global')
  const parsedState = workspaceDomainState.safeParse(global ?? workspaceDomainSpec.global.initial)
  if (!parsedState.success) throw new Error('its registry state does not match the workspace schema')
  const table = field(field(document, 'tables'), 'workspaces') ?? {}
  if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new Error('its workspace table is not a mapping')
  const records = new Map<string, WorkspaceRecord>()
  for (const [id, value] of Object.entries(table)) {
    const parsed = workspaceRecord.safeParse(value)
    if (!parsed.success) throw new Error(`its workspace ${JSON.stringify(id)} does not match the workspace schema`)
    records.set(id, parsed.data)
  }
  checkConsistency(parsedState.data, records)
  return { version, state: parsedState.data, records }
}

/**
 * Refuse a registry upstream's registry refuses to start with.
 * @param state - the registry state.
 * @param records - the workspace records.
 * @throws Error naming the inconsistency.
 */
function checkConsistency(state: WorkspaceDomainState, records: ReadonlyMap<string, WorkspaceRecord>): void {
  const order = new Set<string>()
  for (const id of state.workspaceIds) {
    if (order.has(id) || !records.has(id)) throw new Error('its order repeats a workspace or names one it does not hold')
    order.add(id)
  }
  if (state.initialized && order.size !== records.size) throw new Error('it holds a workspace its order does not name')
  const paths = new Set<string>()
  const sessions = new Set<string>()
  for (const record of records.values()) {
    if (paths.has(record.path)) throw new Error('two of its workspaces claim one folder')
    paths.add(record.path)
    for (const id of record.sessionIds) {
      if (sessions.has(id)) throw new Error('two of its workspaces claim one chat')
      sessions.add(id)
    }
  }
}

/** The folders a workspace or a chat must not stand in, as the plan knows them. */
export interface SensitiveFolders {
  /** The person's home directory, when the environment names one. */
  readonly personHome: string | undefined
  /** The stock home's real path. */
  readonly stockHome: string
  /** The Delo home. */
  readonly deloHome: string
}

/**
 * Why a folder is one a workspace or a chat from another installation must not be carried into: the filesystem's
 * root, the person's home directory itself, a dot-directory directly under it or anything inside one, and either
 * Harness home or anything inside it. Each would give a chat that runs there access to what the person keeps there.
 * @param folder - an absolute folder from the stock home.
 * @param folders - the person's home and the two Harness homes.
 * @returns a phrase that names why, or `undefined` for any other folder.
 */
export function sensitiveFolder(folder: string, folders: SensitiveFolders): string | undefined {
  if (!isAbsolute(folder)) return 'not an absolute folder'
  const path = resolve(folder)
  if (path === resolve(sep)) return 'the root of the file system'
  if (inside(folders.stockHome, path)) return 'inside the DeepSeek Harness home'
  if (inside(folders.deloHome, path)) return 'inside the Delo home'
  if (folders.personHome === undefined) return undefined
  const home = resolve(folders.personHome)
  if (path === home) return 'your home folder itself'
  const below = relative(home, path)
  if (!below.startsWith('..') && !isAbsolute(below) && below.split(sep)[0]?.startsWith('.') === true) return 'a hidden folder of your home folder, where settings and keys live'
  return undefined
}

/**
 * Whether one path is a folder or lies inside it.
 * @param outer - the folder.
 * @param inner - the path.
 * @returns true when `inner` is `outer` or below it.
 */
export function inside(outer: string, inner: string): boolean {
  const path = relative(resolve(outer), resolve(inner))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * A registry with only the workspaces and chats the import carries.
 * @param registry - the stock registry.
 * @param keepWorkspace - whether a workspace is carried.
 * @param keepChat - whether a chat, by Session identifier, is carried.
 * @returns the registry without the others: each kept workspace lists only kept chats, and the order, the archived and the pinned chats name only what is kept.
 */
export function restrictRegistry(registry: Registry, keepWorkspace: (id: string) => boolean, keepChat: (id: string) => boolean): Registry {
  const records = new Map([...registry.records].filter(([id]) => keepWorkspace(id)).map(([id, record]) => [id, { ...record, sessionIds: record.sessionIds.filter(keepChat) }] as const))
  const state: WorkspaceDomainState = {
    ...registry.state,
    workspaceIds: registry.state.workspaceIds.filter(id => records.has(id)),
    archivedSessionIds: registry.state.archivedSessionIds.filter(keepChat),
    pinnedSessionIds: registry.state.pinnedSessionIds.filter(keepChat),
  }
  return { version: registry.version, state, records }
}

/**
 * The text of a registry in upstream's JSON unit layout.
 * @param registry - the registry.
 * @returns the document, two-space JSON with a trailing newline.
 */
export function serializeRegistry(registry: Registry): string {
  return `${JSON.stringify({ unit: { name: workspaceDomainSpec.name, version: registry.version }, global: registry.state, tables: { workspaces: Object.fromEntries(registry.records) } }, null, 2)}\n`
}

/**
 * Merge a stock registry into the Delo home's.
 * @param delo - the Delo home's registry.
 * @param stock - the stock home's registry, which the plan refused if it was interrupted mid-change.
 * @returns the merged document's text, in upstream's JSON unit layout, or `undefined` when the stock registry adds nothing.
 * @throws DshImportError `DSH_IMPORT_REGISTRY_REFUSED` when the Delo home's registry was interrupted mid-change, and `DSH_IMPORT_ID_COLLISION` when the two hold one identifier for different workspaces.
 */
export function mergeRegistries(delo: Registry, stock: Registry): string | undefined {
  if (delo.state.pendingMutation !== undefined) {
    throw new DshImportError('DSH_IMPORT_REGISTRY_REFUSED', 'the Delo home\'s workspace list was interrupted while it changed; start Delo once so it finishes the change, stop it, and import again', REGISTRY_PATH)
  }
  const records = new Map(delo.records)
  const order = [...delo.state.workspaceIds]
  const byPath = new Map([...records].map(([id, record]) => [record.path, id]))
  const accounted = new Set([...records.values()].flatMap(record => record.sessionIds))
  let changed = false
  for (const id of stock.state.workspaceIds) {
    const record = stock.records.get(id) as WorkspaceRecord
    const fresh = record.sessionIds.filter(session => !accounted.has(session))
    for (const session of fresh) accounted.add(session)
    const existing = records.get(id)
    if (existing !== undefined) {
      if (existing.path !== record.path) {
        throw new DshImportError('DSH_IMPORT_ID_COLLISION', `the stock home and the Delo home both hold the workspace ${JSON.stringify(id)} for different folders, and an import never overwrites a workspace`, REGISTRY_PATH)
      }
      if (fresh.length > 0) {
        records.set(id, { ...existing, sessionIds: [...existing.sessionIds, ...fresh] })
        changed = true
      }
      continue
    }
    const holder = byPath.get(record.path)
    if (holder !== undefined) {
      if (fresh.length === 0) continue
      const held = records.get(holder) as WorkspaceRecord
      records.set(holder, { ...held, sessionIds: [...held.sessionIds, ...fresh] })
    } else {
      records.set(id, { ...record, sessionIds: fresh })
      order.push(id)
      byPath.set(record.path, id)
    }
    changed = true
  }
  const archivedSessionIds = union(delo.state.archivedSessionIds, stock.state.archivedSessionIds)
  const pinnedSessionIds = union(delo.state.pinnedSessionIds, stock.state.pinnedSessionIds)
  if (!changed && archivedSessionIds.length === delo.state.archivedSessionIds.length && pinnedSessionIds.length === delo.state.pinnedSessionIds.length) return undefined
  return serializeRegistry({ version: delo.version, state: { ...delo.state, initialized: true, workspaceIds: order, archivedSessionIds, pinnedSessionIds }, records })
}

/**
 * The members of two lists, the first list's order first.
 * @param first - one list.
 * @param second - the other list.
 * @returns every member once.
 */
function union<T>(first: readonly T[], second: readonly T[]): T[] {
  return [...new Set([...first, ...second])]
}

/**
 * One field of a parsed JSON value.
 * @param value - the value.
 * @param key - the field.
 * @returns the field's value, or `undefined` when the value is not an object or lacks it.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}
