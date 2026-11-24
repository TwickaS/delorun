/**
 * The per-workspace network of sandboxed commands: the `delorunCommandNetwork` service, the `sandboxNetwork` resolver it
 * mounts for `@deepseek-ai/dsh-sandbox-policy`, one egress proxy per allowlist, the `web_fetch` refusal that keeps the
 * fetch tool inside the same setting, and the two loopback-only routes the studio's Network section reads and writes.
 *
 * A workspace's setting is its entry in the network store ([`./network-store.ts`](./network-store.ts)) or, without
 * one, the deployment's default from the row's configuration. `open` leaves the policy without a network, exactly as
 * stock, so a local runner refuses a command while a host abstract Unix socket listens, unless the setting accepts that
 * risk, which makes the policy's network `host`; `off` asks the sandbox for no network; `allowlist` asks it for the proxy whose list is the workspace's, which
 * listens on a socket under the home's `secrets/permission-defaults/proxy/<pid>/` before any policy names it. A store
 * that exists but cannot be read counts every workspace as `off`, so a restriction the person set is never lifted by a
 * damaged file.
 *
 * @module @delorun/plugin-permission-defaults/command-network
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SandboxNetwork } from '@deepseek-ai/dsh-sandbox'
import type { SandboxNetworkRequest, SandboxNetworkResolver } from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
import { admitApprovedDevice, gateByClass, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { resolveDelorunHome } from '@delorun/home'
import { AbstractSocketConsent } from './abstract-socket-consent.ts'
import { EgressProxy, type EgressProxyOptions, type EgressRefusal } from './egress-proxy.ts'
import { hostAllowed, hostListed, isNetworkAccess, loosens, normalizeHost, parseHostList, type WorkspaceNetwork } from './network.ts'
import { networkStorePath, readNetworkStore, writeNetworkStore } from './network-store.ts'
import { PERMISSION_STORE_DIR } from './store.ts'
import { NO_WORKSPACE, workspaceKey } from './workspace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    delorunCommandNetwork: CommandNetwork
  }
}

/** The route that lists the default network and each workspace's. */
export const NETWORK_LIST_PATH = '/api/delorunNetwork.list'

/** The route that changes one workspace's network. */
export const NETWORK_SET_PATH = '/api/delorunNetwork.set'

/** The action {@link requireComputerOrDevice}'s refusal names for both routes. */
const NETWORK_ACTION = 'Reading or changing a workspace\'s network'

/** The largest request body {@link NETWORK_SET_PATH} reads. */
export const MAX_NETWORK_BODY_BYTES = 64 * 1024

/** The longest Unix socket path Linux accepts, in bytes. */
const MAX_SOCKET_PATH_BYTES = 107

/** The deployment's network settings, from the row's validated configuration. */
export interface CommandNetworkSettings {
  /** The network of a workspace without its own setting. */
  readonly defaultNetwork: WorkspaceNetwork
  /** How long the proxy waits for a listed host's connection to open. */
  readonly proxyConnectTimeoutMs: number
  /** The most connections one proxy holds at once. */
  readonly proxyMaxConnections: number
  /** How long a connection through a proxy may stay idle before it is closed. */
  readonly proxyIdleTimeoutMs: number
}

/** One workspace as the Network section lists it. */
export interface NetworkListEntry {
  /** The workspace's canonical folder, the key of its setting. */
  readonly path: string
  readonly title: string
  readonly network: WorkspaceNetwork
  /** Whether the workspace has a setting of its own rather than the default. */
  readonly own: boolean
}

/** What {@link NETWORK_LIST_PATH} answers. */
export interface NetworkListAnswer {
  readonly default: WorkspaceNetwork
  readonly workspaces: readonly NetworkListEntry[]
  /** Why the network store could not be read, when it could not; every workspace counts as `off` meanwhile. */
  readonly problem?: string
}

/** A change {@link CommandNetwork.set} refused. */
export class NetworkChangeError extends Error {
  /**
   * @param code - `INVALID` for a setting that does not validate, `UNCONFIRMED` for a loosening the person did not
   *   confirm, `STORE` when the store cannot be written or was refused, `PROXY` when the allowlist's proxy cannot listen.
   * @param message - the sentence the studio shows.
   */
  /** What was refused. */
  readonly code: 'INVALID' | 'UNCONFIRMED' | 'STORE' | 'PROXY'

  constructor(code: 'INVALID' | 'UNCONFIRMED' | 'STORE' | 'PROXY', message: string) {
    super(message)
    this.code = code
    this.name = 'NetworkChangeError'
  }
}

/**
 * The sentence `web_fetch` reads when a workspace's network refuses its URL.
 * @param network - the workspace's network.
 * @param target - the URL's host and port, or `undefined` when the URL could not be read.
 * @returns the refusal reason.
 */
export function webFetchRefusal(network: WorkspaceNetwork, target: { readonly host: string, readonly port: number } | undefined): string {
  if (network.access === 'off') return 'web_fetch refused: this workspace\'s network is off, so neither its commands nor web_fetch reach the internet. The person can change it in Settings, Network, at the computer that runs Delorun.'
  if (target === undefined) return 'web_fetch refused: the URL could not be read, and this workspace\'s network allows only the hosts on its allowlist.'
  if (hostListed(network.hosts, normalizeHost(target.host))) {
    return `web_fetch refused: ${JSON.stringify(target.host)} is on this workspace's network allowlist for ports 80 and 443 only, unless an entry names port ${String(target.port)}. The person can add it in Settings, Network, at the computer that runs Delorun.`
  }
  return `web_fetch refused: ${JSON.stringify(target.host)} is not on this workspace's network allowlist. The person can add it in Settings, Network, at the computer that runs Delorun.`
}

/**
 * The `delorunCommandNetwork` service. It reads the store once at start and keeps it in memory, so the resolver answers
 * without a filesystem call; a change is written through the store, and its proxy listens, before it takes effect.
 */
export class CommandNetwork extends Service {
  /**
   * Test hook: the resolver and dialer each proxy started after it is set uses, so a spec maps documentation addresses
   * to local listeners and no test reaches the internet.
   */
  internals: Pick<EgressProxyOptions, 'resolve' | 'dial'> = {}
  /** The store's entries; empty while nothing is recorded or the store was refused. */
  private entries: ReadonlyMap<string, WorkspaceNetwork> = new Map()
  /** Why the store could not be read, when it could not. */
  private problem: string | undefined
  /** The listening proxies, by allowlist key. */
  private readonly proxies = new Map<string, { readonly proxy: EgressProxy, readonly socket: string }>()
  /** This Host's socket directory, set at start. */
  private socketDirectory = ''
  /** The deployment's validated network settings. */
  private readonly settings: CommandNetworkSettings
  /** Store writes and proxy changes, one after another. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - the plugin context.
   * @param settings - the deployment's validated network settings.
   */
  constructor(ctx: Context, settings: CommandNetworkSettings) {
    super(ctx, 'delorunCommandNetwork')
    this.settings = settings
  }

  /** Read the store, start the proxies it needs, and mount the resolver, the fetch refusal and the routes. */
  protected async [Service.init](): Promise<void> {
    const home = (await resolveDelorunHome(process.env)).path
    const read = await readNetworkStore(networkStorePath(home))
    this.entries = read.kind === 'readable' ? read.entries : new Map()
    this.problem = read.kind === 'refused' ? read.problem : undefined
    if (this.problem !== undefined) this.ctx.logger.warn(`permission-defaults: the network store is refused, so every workspace's commands run with no network until it is fixed: ${this.problem}`)
    this.socketDirectory = await prepareSocketDirectory(home)
    this.ctx.effect(() => () => this.stop())
    await this.reconcile()
    this.ctx.provide('sandboxNetwork', this.resolver())
    // A guard has no allow result, so no pre-execute listener's order can turn this refusal back into permission.
    this.ctx.inject(['tools'], (child) => { child.tools.guard(exec => this.reviewFetch(exec)) })
    this.ctx.inject(['connection'], (child) => { this.mountRoutes(child) })
    // The first refusal in a workspace offers the person the acceptance in the chat; the resolver above still decides.
    this.ctx.inject(['tools'], (child) => {
      const consent = new AbstractSocketConsent(child, this)
      child.on('tools/pre-execute', (exec, next) => consent.review(exec).then(decision => decision.kind === 'allow' ? next() : decision))
    })
  }

  /** Why the network store could not be read, or undefined while it reads. */
  get storeProblem(): string | undefined {
    return this.problem
  }

  /**
   * The network a workspace's commands get now. A directory inside a registered workspace inherits that workspace's
   * setting, so a session whose cwd is a subdirectory of a workspace set to `off` does not fall through to the
   * deployment default. The nearest containing workspace wins, so a nested workspace keeps its own setting.
   * @param cwd - the workspace directory, or an empty string for none.
   * @returns its own setting, the containing workspace's, the default for a directory in no workspace, or `off` while
   *   the store is refused.
   */
  networkOf(cwd: string): WorkspaceNetwork {
    if (this.problem !== undefined) return { access: 'off', hosts: [] }
    const key = workspaceKey(cwd)
    const own = this.entries.get(key)
    if (own !== undefined) return own
    const containing = this.containingWorkspace(key)
    return containing === undefined ? this.settings.defaultNetwork : this.entries.get(containing) ?? this.settings.defaultNetwork
  }

  /**
   * The nearest registered workspace whose directory contains a path.
   * @param key - the canonical path to look up.
   * @returns the containing workspace's key, or `undefined` when the path is in no registered workspace.
   */
  private containingWorkspace(key: string): string | undefined {
    if (key === NO_WORKSPACE) return undefined
    const registry = this.ctx.get('workspaceRegistry')
    let best: string | undefined
    for (const workspace of registry?.list() ?? []) {
      const root = workspaceKey(workspace.path)
      // A path is inside a workspace when it is the workspace or sits below it, and the separator keeps /a/bc out of /a/b.
      if (key !== root && !key.startsWith(root.endsWith(sep) ? root : root + sep)) continue
      if (best === undefined || root.length > best.length) best = root
    }
    return best
  }

  /**
   * Change one workspace's network, or return it to the default. A change that reaches anything the current setting
   * does not ({@link loosens}) needs `confirmed`, which the studio sends only after the person confirmed it there; a
   * tightening applies at once. The proxy an allowlist needs listens before the store is written.
   * @param cwd - the workspace directory.
   * @param next - the new setting, or `undefined` for the default.
   * @param confirmed - whether the person confirmed a loosening.
   * @returns the setting now in effect.
   * @throws {NetworkChangeError} when the setting does not validate, a loosening is unconfirmed, the proxy cannot
   *   listen or the store cannot be written.
   */
  set(cwd: string, next: WorkspaceNetwork | undefined, confirmed: boolean): Promise<WorkspaceNetwork> {
    return this.serial(() => this.apply(cwd, next, confirmed))
  }

  /**
   * The body of {@link CommandNetwork.set}; runs only inside {@link CommandNetwork.serial}.
   * @param cwd - the workspace directory.
   * @param next - the new setting, or `undefined` for the default.
   * @param confirmed - whether the person confirmed a loosening.
   * @returns the setting now in effect.
   * @throws {NetworkChangeError} as {@link CommandNetwork.set} does.
   */
  private async apply(cwd: string, next: WorkspaceNetwork | undefined, confirmed: boolean): Promise<WorkspaceNetwork> {
    const workspace = workspaceKey(cwd)
    if (workspace === NO_WORKSPACE) throw new NetworkChangeError('INVALID', 'a network setting needs a workspace folder')
    if (this.problem !== undefined) throw new NetworkChangeError('STORE', `the network store is refused, so no setting is recorded until it is fixed: ${this.problem}`)
    const parsed = next === undefined ? undefined : parseHostList(next.hosts)
    if (parsed !== undefined && 'problem' in parsed) throw new NetworkChangeError('INVALID', parsed.problem)
    const wanted: WorkspaceNetwork = next === undefined || parsed === undefined
      ? this.settings.defaultNetwork
      : { access: next.access, hosts: parsed.hosts, ...next.access === 'open' && next.acceptAbstractSockets === true ? { acceptAbstractSockets: true } : {} }
    const current = this.networkOf(workspace)
    if (loosens(current, wanted) && !confirmed) {
      throw new NetworkChangeError('UNCONFIRMED', 'this change lets the workspace\'s commands reach more of the network, so the person confirms it first')
    }
    const entries = new Map(this.entries)
    if (next === undefined) entries.delete(workspace)
    else entries.set(workspace, wanted)
    if (wanted.access === 'allowlist') await this.ensureProxy(wanted.hosts)
    try {
      await writeNetworkStore(networkStorePath((await resolveDelorunHome(process.env)).path), entries)
    } catch (error) {
      throw new NetworkChangeError('STORE', `the network store could not be written: ${reasonOf(error)}`)
    }
    this.entries = entries
    this.ctx.logger.info(`permission-defaults: the network of the workspace ${JSON.stringify(workspace)} is now ${wanted.access}${wanted.access === 'allowlist' ? ` (${wanted.hosts.length} hosts)` : ''}, ${loosens(current, wanted) ? 'loosened at the computer' : 'not loosened'}`)
    await this.closeUnused()
    return wanted
  }

  /**
   * Record the person's acceptance of the abstract-socket risk for a workspace whose network is open, as the Network
   * section's switch does: the same store entry, written through {@link CommandNetwork.set} with the loosening confirmed.
   * A workspace whose network is no longer open is left as it is.
   * @param cwd - the workspace directory.
   * @returns the setting now in effect.
   * @throws {NetworkChangeError} when the store cannot be written.
   */
  acceptAbstractSockets(cwd: string): Promise<WorkspaceNetwork> {
    // The check and the new value come from the entry as it is once earlier changes (a tightening in flight) have landed.
    return this.serial(() => {
      const current = this.networkOf(cwd)
      if (current.access !== 'open') return Promise.resolve(current)
      return this.apply(cwd, { access: 'open', hosts: current.hosts, acceptAbstractSockets: true }, true)
    })
  }

  /**
   * The Network section's list: the default and each workspace the registry knows, with the setting it has now.
   * @returns the answer.
   */
  list(): NetworkListAnswer {
    const registry = this.ctx.get('workspaceRegistry')
    const workspaces = (registry?.list() ?? []).map((workspace) => {
      const key = workspaceKey(workspace.path)
      return { path: key, title: workspace.title, network: this.networkOf(key), own: this.entries.has(key) }
    })
    return { default: this.settings.defaultNetwork, workspaces, ...this.problem === undefined ? {} : { problem: this.problem } }
  }

  /**
   * The resolver `ctx.sandboxPolicy` asks for each call's network.
   * @returns the resolver.
   */
  private resolver(): SandboxNetworkResolver {
    return (request: SandboxNetworkRequest): SandboxNetwork | undefined => {
      const network = this.networkOf(request.session?.header.cwd ?? request.workspaceRoot)
      switch (network.access) {
        case 'open': return network.acceptAbstractSockets === true ? { mode: 'host', abstractSockets: 'accepted' } : undefined
        case 'off': return { mode: 'off' }
        case 'allowlist': {
          const listening = this.proxies.get(listKey(network.hosts))
          // A list whose proxy could not listen gets no network at all, never the host's.
          return listening === undefined ? { mode: 'off' } : { mode: 'proxy', socket: listening.socket }
        }
      }
    }
  }

  /**
   * Refuse a `web_fetch` call whose URL the calling workspace's network does not reach. `web_fetch` follows only
   * same-origin redirects, so the URL's host is the host of every hop.
   * @param exec - the pending call.
   * @returns the refusal reason, or `undefined` to leave the call as it is.
   */
  reviewFetch(exec: Readonly<ToolExecution>): string | undefined {
    if (exec.name !== 'web_fetch') return undefined
    const network = this.networkOf(exec.agent?.session.header.cwd ?? '')
    if (network.access === 'open') return undefined
    const url = (exec.arguments as { url?: unknown } | undefined)?.url
    let target: { readonly host: string, readonly port: number } | undefined
    try {
      const parsed = typeof url === 'string' ? new URL(url) : undefined
      target = parsed === undefined ? undefined : { host: parsed.hostname, port: parsed.port === '' ? (parsed.protocol === 'http:' ? 80 : 443) : Number(parsed.port) }
    } catch (_invalid) {
      // An unreadable URL names no host the allowlist could admit.
      target = undefined
    }
    if (network.access === 'allowlist' && target !== undefined && hostAllowed(network.hosts, target.host, target.port)) return undefined
    return webFetchRefusal(network, target)
  }

  /**
   * Register the two routes. A request that did not arrive on the loopback listener under a loopback `Host` is
   * placed at the computer or on a reach listener before its body is read; a device reads a workspace's network, and changes
   * it only while it holds an unlock.
   * @param ctx - the context with the Connection.
   */
  private mountRoutes(ctx: Context): void {
    ctx.on('connection/request', async (request, response, next) => {
      const path = routedPathname(request.url)
      if ((path === NETWORK_LIST_PATH || path === NETWORK_SET_PATH) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), NETWORK_ACTION)) return
      await next()
    })
    // Any approved device reads the network settings; changing one is a `face` route.
    ctx.connection.fetch.register({ path: NETWORK_LIST_PATH, methods: ['GET'], requestBody: 'buffered', admitPeer: admitApprovedDevice(), fetch: () => Promise.resolve(json(200, this.list())) })
    ctx.connection.fetch.register({ path: NETWORK_SET_PATH, methods: ['POST'], requestBody: 'buffered', ...gateByClass(() => ctx.get('homeAuth'), request => this.handleSet(request), { row: 'route:plugin-permission-defaults/src/command-network.ts#NETWORK_SET_PATH', action: 'plugin-permission-defaults/network-set', legacy: { grace: false, renews: true } }) })
  }

  /**
   * Answer one change request.
   * @param request - `{ path, network?: { access, hosts }, confirmed? }`; no `network` returns the workspace to the default.
   * @returns 200 with the setting in effect, 400 for a request that cannot be read, 409 for an unconfirmed loosening,
   *   422 for a setting that does not validate, or 500 when the store or the proxy failed.
   */
  private async handleSet(request: Request): Promise<Response> {
    const bytes = await request.arrayBuffer()
    const body = bytes.byteLength > MAX_NETWORK_BODY_BYTES ? undefined : changeRequestOf(new TextDecoder().decode(bytes))
    if (body === undefined) return json(400, { error: 'BAD_REQUEST', message: 'the request must be JSON with a workspace path and a network of access off, allowlist or open with a list of hosts' })
    try {
      const network = await this.set(body.path, body.network, body.confirmed)
      return json(200, { network })
    } catch (error) {
      if (!(error instanceof NetworkChangeError)) throw error
      const status = { INVALID: 422, UNCONFIRMED: 409, STORE: 500, PROXY: 500 }[error.code]
      return json(status, { error: `NETWORK_${error.code}`, message: error.message })
    }
  }

  /**
   * Start the proxy of one allowlist unless it listens already.
   * @param hosts - the normalized list.
   * @throws {NetworkChangeError} when its socket path is too long or the proxy cannot listen.
   */
  private async ensureProxy(hosts: readonly string[]): Promise<void> {
    const key = listKey(hosts)
    if (this.proxies.has(key)) return
    const socket = join(this.socketDirectory, `${key}.sock`)
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
      throw new NetworkChangeError('PROXY', `the egress proxy's socket path ${JSON.stringify(socket)} is longer than ${MAX_SOCKET_PATH_BYTES} bytes; move the Delorun home to a shorter path to use an allowlist`)
    }
    const proxy = new EgressProxy({
      socket,
      hosts,
      connectTimeoutMs: this.settings.proxyConnectTimeoutMs,
      maxConnections: this.settings.proxyMaxConnections,
      idleTimeoutMs: this.settings.proxyIdleTimeoutMs,
      onRefusal: (refusal) => { this.reportRefusal(refusal) },
      ...this.internals,
    })
    try {
      await proxy.listen()
    } catch (error) {
      throw new NetworkChangeError('PROXY', `the egress proxy could not listen: ${reasonOf(error)}`)
    }
    this.proxies.set(key, { proxy, socket })
  }

  /**
   * Start the proxy of every allowlist in effect; one that cannot start is reported, and its workspaces get no network.
   * @returns when every proxy that can listen does.
   */
  private async reconcile(): Promise<void> {
    for (const hosts of this.listsInEffect().values()) {
      try {
        await this.ensureProxy(hosts)
      } catch (error) {
        this.ctx.logger.error(`permission-defaults: ${reasonOf(error)}; commands of workspaces with this allowlist run with no network`)
      }
    }
  }

  /** Close the proxies no setting names any more, so commands they served lose the hosts their list no longer has. */
  private async closeUnused(): Promise<void> {
    const used = this.listsInEffect()
    for (const [key, { proxy }] of [...this.proxies]) {
      if (used.has(key)) continue
      this.proxies.delete(key)
      await proxy.close()
    }
  }

  /**
   * The allowlists some workspace or the default has now, by key.
   * @returns the lists.
   */
  private listsInEffect(): Map<string, readonly string[]> {
    const lists = new Map<string, readonly string[]>()
    for (const network of [this.settings.defaultNetwork, ...this.entries.values()]) {
      if (network.access === 'allowlist') lists.set(listKey(network.hosts), network.hosts)
    }
    return lists
  }

  /**
   * Report one refusal to the owner's log: the host, at most 255 characters, the port and the reason.
   * @param refusal - the refusal.
   */
  private reportRefusal(refusal: EgressRefusal): void {
    this.ctx.logger.warn(`permission-defaults: the egress proxy refused ${JSON.stringify(refusal.host)} port ${refusal.port}: ${refusal.code}`)
  }

  /** Close every proxy and remove this Host's socket directory. */
  private async stop(): Promise<void> {
    const proxies = [...this.proxies.values()]
    this.proxies.clear()
    await Promise.all(proxies.map(({ proxy }) => proxy.close()))
    await rm(this.socketDirectory, { recursive: true, force: true })
  }

  /**
   * Run a change after the changes queued before it, whatever those did.
   * @param change - the change.
   * @returns the change's result.
   */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const result = this.queue.then(change, change)
    this.queue = result.catch(() => undefined)
    return result
  }
}

/**
 * The key of one allowlist: 16 hexadecimal digits of the SHA-256 of its sorted entries, so workspaces with the same
 * list share one proxy and a changed list gets a new socket.
 * @param hosts - the normalized, sorted entries.
 * @returns the key.
 */
export function listKey(hosts: readonly string[]): string {
  return createHash('sha256').update(hosts.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Create this Host's socket directory, `<home>/secrets/permission-defaults/proxy/<pid>`, empty and private, and remove
 * the directories of Host processes that no longer run.
 * @param home - the resolved Delorun home.
 * @returns the directory.
 */
async function prepareSocketDirectory(home: string): Promise<string> {
  const parent = join(home, DELORUN_HOME_ENTRIES.secrets, PERMISSION_STORE_DIR, 'proxy')
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE })
  for (const entry of await readdir(parent)) {
    const pid = Number(entry)
    if (Number.isInteger(pid) && pid !== process.pid && processRuns(pid)) continue
    await rm(join(parent, entry), { recursive: true, force: true })
  }
  const directory = join(parent, String(process.pid))
  await mkdir(directory, { mode: PRIVATE_DIR_MODE })
  return directory
}

/**
 * Whether a process runs.
 * @param pid - the process id.
 * @returns false when signalling it reports that it does not exist.
 */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Read a change request.
 * @param text - the body.
 * @returns the request, or `undefined` when it is not one.
 */
function changeRequestOf(text: string): { path: string, network: WorkspaceNetwork | undefined, confirmed: boolean } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The parser's message quotes the body; the request is only refused.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { path, network, confirmed } = value as Record<string, unknown>
  if (typeof path !== 'string' || (confirmed !== undefined && typeof confirmed !== 'boolean')) return undefined
  if (network === undefined) return { path, network: undefined, confirmed: confirmed === true }
  if (typeof network !== 'object' || network === null) return undefined
  const { access, hosts, acceptAbstractSockets } = network as Record<string, unknown>
  if (!isNetworkAccess(access) || !Array.isArray(hosts) || !hosts.every(host => typeof host === 'string')) return undefined
  if (acceptAbstractSockets !== undefined && acceptAbstractSockets !== true && acceptAbstractSockets !== false) return undefined
  return { path, network: { access, hosts, ...acceptAbstractSockets === true ? { acceptAbstractSockets } : {} }, confirmed: confirmed === true }
}

/**
 * One JSON answer, never cached.
 * @param status - the HTTP status.
 * @param body - the answer.
 * @returns the response.
 */
function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * The reason a failure gives.
 * @param error - the failure.
 * @returns its message, or a plain one.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'no reason was given'
}
