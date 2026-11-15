/**
 * Requests to the home's network routes, which `@delorun/plugin-permission-defaults` serves to the loopback listener only,
 * the validation of their JSON answers, and the host lists the Network section edits. The settings mirror that
 * package's `WorkspaceNetwork`; requests go through [`./host-api.ts`](./host-api.ts).
 * @module @delorun/bundle-local/client/network-api
 */
import { call, fields, isBoolean, isString, listOf, optional, readServedRoute, type Check, type HostFetch } from './host-api.ts'

/** The three network accesses, most restrictive first. */
export const NETWORK_ACCESSES = ['off', 'allowlist', 'open'] as const

/** One of {@link NETWORK_ACCESSES}: no network, the listed hosts only, or any host. */
export type NetworkAccess = (typeof NETWORK_ACCESSES)[number]

/** A workspace's network for sandboxed commands and `web_fetch`. */
export interface WorkspaceNetwork {
  readonly access: NetworkAccess
  /** The hosts `allowlist` admits, normalized and sorted by the Host; the other accesses keep them for later. */
  readonly hosts: readonly string[]
  /** Under `open` only: the person accepted that the host's abstract Unix sockets stay reachable to commands. Absent otherwise. */
  readonly acceptAbstractSockets?: true
}

/** One workspace as `GET /api/delorunNetwork.list` names it. */
export interface NetworkWorkspace {
  /** The workspace's canonical folder, which a change names. */
  readonly path: string
  readonly title: string
  /** The network its commands get now. */
  readonly network: WorkspaceNetwork
  /** False while the workspace follows the deployment's default. */
  readonly own: boolean
}

/** What `GET /api/delorunNetwork.list` answers. */
export interface NetworkList {
  /** The network of a workspace without a setting of its own. */
  readonly default: WorkspaceNetwork
  readonly workspaces: readonly NetworkWorkspace[]
  /** Why the Host could not read its network store; meanwhile every workspace counts as `off` and changes are refused. */
  readonly problem?: string
}

/** One change `POST /api/delorunNetwork.set` applies. */
export interface NetworkChange {
  /** The workspace's {@link NetworkWorkspace.path}. */
  readonly path: string
  /** The new setting; absent returns the workspace to the default. */
  readonly network?: WorkspaceNetwork
  /** True only after the person confirmed a change that loosens the network. */
  readonly confirmed?: boolean
}

/** The routes this module calls. */
export const NETWORK_ROUTES = {
  list: '/api/delorunNetwork.list',
  set: '/api/delorunNetwork.set',
} as const

/** The Host error code of a change that loosens the network and was sent without `confirmed`. */
export const NETWORK_UNCONFIRMED = 'NETWORK_UNCONFIRMED'

/** Starter hosts the section offers for an allowlist, by package registry; the person reviews them before saving. */
export const COMMON_HOSTS = {
  npm: ['registry.npmjs.org'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  github: ['github.com', 'codeload.github.com', 'objects.githubusercontent.com'],
  crates: ['crates.io', 'static.crates.io', 'index.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** One group of {@link COMMON_HOSTS}. */
export type CommonHostGroup = keyof typeof COMMON_HOSTS

const isWorkspaceNetwork: Check = fields({
  access: value => (NETWORK_ACCESSES as readonly unknown[]).includes(value),
  hosts: listOf(isString),
  acceptAbstractSockets: optional(value => value === true),
})
const isNetworkList: Check = fields({
  default: isWorkspaceNetwork,
  workspaces: listOf(fields({ path: isString, title: isString, network: isWorkspaceNetwork, own: isBoolean })),
  problem: optional(isString),
})
const isNetworkAnswer: Check = fields({ network: isWorkspaceNetwork })

/**
 * Read the default network and each workspace's.
 * @param fetch - the request function, such as the browser's `fetch`.
 * @returns the list, or undefined when this profile does not serve the network setting (the route answers 404).
 * @throws {HostRequestError} for any other refusal (`LOOPBACK_REQUIRED` away from the home's computer), an unreachable Host
 *   or an unreadable answer.
 */
export function readNetworks(fetch: HostFetch): Promise<NetworkList | undefined> {
  return readServedRoute<NetworkList>(fetch, NETWORK_ROUTES.list, isNetworkList)
}

/**
 * Change one workspace's network, or return it to the default. The body carries `confirmed: true` only when the change
 * says so.
 * @param fetch - the request function.
 * @param change - the workspace, the new setting and whether the person confirmed a loosening.
 * @returns the setting now in effect.
 * @throws {HostRequestError} for a refusal (`NETWORK_UNCONFIRMED`, `NETWORK_INVALID`, `NETWORK_STORE`, `NETWORK_PROXY`,
 *   `BAD_REQUEST` or `LOOPBACK_REQUIRED`), an unreachable Host or an unreadable answer.
 */
export async function setNetwork(fetch: HostFetch, change: NetworkChange): Promise<WorkspaceNetwork> {
  const body = {
    path: change.path,
    ...change.network === undefined ? {} : { network: change.network },
    ...change.confirmed === true ? { confirmed: true } : {},
  }
  return (await call<{ network: WorkspaceNetwork }>(fetch, NETWORK_ROUTES.set, isNetworkAnswer, body)).network
}

/**
 * The hosts of the section's one-host-per-line editor, as the request sends them; the Host normalizes and checks them.
 * @param text - the editor's text.
 * @returns each non-empty line, trimmed.
 */
export function hostLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * A host list in the form the section compares: lower case, without duplicates, sorted.
 * @param hosts - the hosts as written.
 * @returns the compared form.
 */
export function comparableHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map(host => host.trim().toLowerCase()))].filter(host => host !== '').sort()
}

/**
 * Whether one setting is the same as another, hosts compared in {@link comparableHosts} form.
 * @param a - one setting.
 * @param b - the other.
 * @returns whether both have the same access, hosts and abstract-socket acceptance.
 */
export function sameNetwork(a: WorkspaceNetwork, b: WorkspaceNetwork): boolean {
  return a.access === b.access && (a.acceptAbstractSockets === true) === (b.acceptAbstractSockets === true) && comparableHosts(a.hosts).join('\n') === comparableHosts(b.hosts).join('\n')
}

/**
 * The hosts an allowlist adds to what a setting reaches: every host when the setting is not an allowlist, and under
 * `allowlist` each host no old entry admits, a `*.` entry admitting the names below its domain.
 * @param previous - the setting in effect.
 * @param hosts - the new allowlist's hosts.
 * @returns the added hosts, in {@link comparableHosts} form.
 */
export function addedHosts(previous: WorkspaceNetwork, hosts: readonly string[]): string[] {
  const next = comparableHosts(hosts)
  if (previous.access !== 'allowlist') return next
  const old = comparableHosts(previous.hosts)
  return next.filter(host => !old.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1)))))
}
