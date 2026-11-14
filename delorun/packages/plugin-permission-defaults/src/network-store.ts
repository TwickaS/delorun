/**
 * The per-workspace network store: one JSON file beside the permission store in the Delorun home's protected state, at
 * mode 0600, so a confined command can neither read a workspace's allowlist nor widen it. One entry per workspace,
 * keyed by the workspace key ([`./workspace.ts`](./workspace.ts)): its access and its allowlist. A workspace without
 * an entry has the deployment's default network.
 *
 * Free of Cordis, so the format, its refusals and its file handling are testable without a mounted plugin.
 *
 * @module @delorun/plugin-permission-defaults/network-store
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delorun/home'
import { isNetworkAccess, parseHostList, type WorkspaceNetwork } from './network.ts'
import { PERMISSION_STORE_DIR } from './store.ts'

/** Format version of the network store. */
export const NETWORK_STORE_VERSION = 1 as const

/** File name of the network store inside the permission store's directory. */
export const NETWORK_STORE_FILE = 'network.json'

/** Why a network store that exists could not be read as this version's format. */
export class NetworkStoreError extends Error {
  /**
   * @param reason - what the store holds instead of this version's format.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'NetworkStoreError'
  }
}

/**
 * The network store's path under a resolved Delorun home.
 * @param home - the resolved Delorun home.
 * @returns `<home>/secrets/permission-defaults/network.json`.
 */
export function networkStorePath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.secrets, PERMISSION_STORE_DIR, NETWORK_STORE_FILE)
}

/**
 * Whether a value is a plain JSON object.
 * @param value - the value.
 * @returns true for an object that is not an array or null.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One workspace's network as the store holds it.
 * @param workspace - the workspace key, named in the reason.
 * @param value - the store's value for it.
 * @returns the setting.
 * @throws {NetworkStoreError} when the value is not an object holding only a valid access and a valid allowlist.
 */
function workspaceNetworkOf(workspace: string, value: unknown): WorkspaceNetwork {
  const named = `the network of the workspace ${JSON.stringify(workspace)}`
  if (!isRecord(value)) throw new NetworkStoreError(`${named} is not an object`)
  const extra = Object.keys(value).filter(key => key !== 'access' && key !== 'hosts')
  if (extra.length > 0) throw new NetworkStoreError(`${named} sets ${extra.join(', ')}`)
  const access = value['access']
  if (!isNetworkAccess(access)) throw new NetworkStoreError(`${named} does not hold the access off, allowlist or open`)
  const hosts = value['hosts']
  if (!Array.isArray(hosts) || !hosts.every(host => typeof host === 'string')) throw new NetworkStoreError(`${named} does not hold a list of hosts`)
  const parsed = parseHostList(hosts)
  if ('problem' in parsed) throw new NetworkStoreError(`${named}: ${parsed.problem}`)
  return { access, hosts: parsed.hosts }
}

/**
 * Parse the store's text into its workspace entries.
 * @param text - the store file's text.
 * @returns the entries, keyed by workspace key.
 * @throws {NetworkStoreError} when the text is not this version's format.
 */
export function parseNetworkStore(text: string): ReadonlyMap<string, WorkspaceNetwork> {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (_notJson) {
    // The parser's message quotes the text, which may hold a host list; the reason says what is wrong instead.
    throw new NetworkStoreError('the store holds no JSON document')
  }
  if (!isRecord(document)) throw new NetworkStoreError('the store is not a JSON object')
  if (document['v'] !== NETWORK_STORE_VERSION) {
    throw new NetworkStoreError(`the store's version is ${JSON.stringify(document['v'])}, not ${String(NETWORK_STORE_VERSION)}`)
  }
  const extra = Object.keys(document).filter(key => key !== 'v' && key !== 'workspaces')
  if (extra.length > 0) throw new NetworkStoreError(`the store sets ${extra.join(', ')}`)
  if (!isRecord(document['workspaces'])) throw new NetworkStoreError('the store does not hold a workspaces object')
  const entries = new Map<string, WorkspaceNetwork>()
  for (const [workspace, value] of Object.entries(document['workspaces'])) {
    if (workspace.length === 0) throw new NetworkStoreError('the store holds an entry with an empty workspace key')
    entries.set(workspace, workspaceNetworkOf(workspace, value))
  }
  return entries
}

/**
 * The store's text: one JSON object whose workspaces are sorted by key, with a trailing newline.
 * @param entries - the entries, keyed by workspace key.
 * @returns the text to write.
 */
export function serializeNetworkStore(entries: ReadonlyMap<string, WorkspaceNetwork>): string {
  const workspaces: Record<string, WorkspaceNetwork> = {}
  for (const workspace of [...entries.keys()].sort()) {
    const entry = entries.get(workspace)
    if (entry !== undefined) workspaces[workspace] = { access: entry.access, hosts: [...entry.hosts] }
  }
  return `${JSON.stringify({ v: NETWORK_STORE_VERSION, workspaces }, null, 2)}\n`
}

/** What reading the network store found. */
export type NetworkStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable', readonly entries: ReadonlyMap<string, WorkspaceNetwork> }
  | { readonly kind: 'refused', readonly problem: string }

/**
 * Read the store, applying contract C1's protected-file refusal rule.
 * @param path - the store's absolute path.
 * @returns `absent` while no store exists, `readable` with its entries, or `refused` with the reason a store that
 *   exists could not be read as this version's format.
 */
export async function readNetworkStore(path: string): Promise<NetworkStoreRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'refused', problem: error instanceof Error ? error.message : 'the file could not be read' }
  }
  try {
    return { kind: 'readable', entries: parseNetworkStore(bytes.toString('utf8')) }
  } catch (error) {
    return { kind: 'refused', problem: (error as NetworkStoreError).message }
  }
}

/**
 * Write the store through contract C1's protected-file write, creating its directory at the private mode.
 * @param path - the store's absolute path.
 * @param entries - the entries, keyed by workspace key.
 */
export async function writeNetworkStore(path: string, entries: ReadonlyMap<string, WorkspaceNetwork>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(path, serializeNetworkStore(entries))
}
