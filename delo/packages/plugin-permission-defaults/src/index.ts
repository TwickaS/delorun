/**
 * @delo/plugin-permission-defaults: Delo's per-workspace permission defaults
 * and the one full-access consent a workspace needs.
 *
 * Upstream composes one permission for the whole deployment: every new chat
 * starts on the same preset, and selecting `danger-full-access` takes effect
 * at once. Delo's contract (C16's changed default `permission_defaults`) makes
 * the preset a property of the workspace — a new workspace starts on the safer
 * preset, `workspace-write`, and full access needs one consent for that
 * workspace before anything runs under it. This plugin provides that
 * behaviour:
 *
 * - it mounts the `sandboxModeGuard` of the `@deepseek-ai/dsh-sandbox-policy`
 *   session-mode seam, so a change to `danger-full-access` for a workspace
 *   nobody consented to is refused before a `sandbox/mode` event is appended,
 *   and the session keeps resolving the mode it had — a command started in the
 *   same synchronous step runs inside the sandbox
 *   ({@link PermissionDefaults.review} is that verdict);
 * - it seeds each new chat of a workspace with that workspace's preset before
 *   upstream pins the deployment default, and sets a restored chat whose log
 *   runs it with full access in a workspace without a grant in this home, such
 *   as a chat copied from a stock DeepSeek Harness home, to the safer preset;
 * - it asks the person once per workspace for full access
 *   ({@link PermissionDefaults.select}), and records the consent in the home's
 *   protected state ([`./store.ts`](./store.ts));
 * - it records the answer the studio's consent and `delorun workspace
 *   full-access` ask at the home's own computer
 *   ({@link PermissionDefaults.setFullAccess}, {@link PermissionDefaults.reload}),
 *   over routes that refuse every other arrival ([`./routes.ts`](./routes.ts)).
 * - it gives each workspace's sandboxed commands the network the person chose
 *   for it — `open`, `allowlist` through Delo's egress proxy, or `off` — through
 *   the `sandboxNetwork` resolver of `@deepseek-ai/dsh-sandbox-policy`, keeps
 *   `web_fetch` inside the same setting, and serves the studio's Network
 *   section ([`./command-network.ts`](./command-network.ts)).
 *
 * Every registration sits behind the C16 switch `permission_defaults`
 * ({@link Config.enabled}), off by default: off, the plugin mounts nothing, the
 * deployment default reaches every new chat exactly as upstream seeds it, and
 * any mode switch is recorded (parity replay relies on that).
 *
 * @module @delo/plugin-permission-defaults
 */
import type {} from '@delo/home-auth'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxModeGuard } from '@deepseek-ai/dsh-sandbox-policy'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { resolveDeloHome, shellQuote, workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem } from '@delo/home'
import z from '@deepseek-ai/schemastery'
import {
  defaultPresetOf,
  fullAccessGranted,
  permissionStoreIdentity,
  readPermissionStore,
  readPermissionStoreSync,
  withPermissionStoreLock,
  writePermissionStore,
  permissionStorePath,
  FULL_ACCESS_PRESET,
  SAFER_PRESET,
  type PermissionPresetName,
  type PermissionStoreRead,
  type WorkspacePermission,
} from './store.ts'
import { NO_WORKSPACE, workspaceKey } from './workspace.ts'
import { FullAccessChangeError, fullAccessNote, permissionEntriesDigest, workspaceAccessOf } from './review.ts'
import type { SetFullAccessRequest, WorkspaceAccess, WorkspacesAnswer } from './wire.ts'
import { registerPermissionRoutes } from './routes.ts'
import { CommandNetwork, type CommandNetworkSettings } from './command-network.ts'
import { clearFailedRow, guardFailedRow, mountFailedRow, PERMISSION_DEFAULTS_ROW, type FailedRowGuard } from './failed.ts'
import { NETWORK_ACCESSES, parseHostList, type NetworkAccess } from './network.ts'
import { watchPermissionStore } from './watch.ts'

export {
  defaultPresetOf,
  fullAccessGranted,
  isPermissionPreset,
  parsePermissionStore,
  permissionStoreIdentity,
  permissionStorePath,
  readPermissionStore,
  readPermissionStoreSync,
  withPermissionStoreLock,
  PERMISSION_STORE_LOCK_WAIT_MS,
  serializePermissionStore,
  writePermissionStore,
  FULL_ACCESS_PRESET,
  PERMISSION_PRESETS,
  PERMISSION_STORE_DIR,
  PERMISSION_STORE_FILE,
  PERMISSION_STORE_VERSION,
  PermissionStoreError,
  SAFER_PRESET,
} from './store.ts'
export type { PermissionPresetName, PermissionStoreRead, WorkspacePermission } from './store.ts'
export { NO_WORKSPACE, workspaceKey } from './workspace.ts'
export { FULL_ACCESS_REVIEW_VERSION, FullAccessChangeError, fullAccessNote, fullAccessReviewId, permissionEntriesDigest, REVIEW_ID_LENGTH, REVIEW_ID_PATTERN, workspaceAccessOf } from './review.ts'
export {
  MAX_PERMISSION_REQUEST_BYTES, PERMISSION_REFUSAL_CODES, PERMISSION_ROUTES,
  type PermissionRefusalCode, type ReviewAnswer, type ReviewRequest, type SetFullAccessAnswer, type SetFullAccessRequest,
  type WorkspaceAccess, type WorkspacesAnswer,
} from './wire.ts'
export {
  CommandNetwork, listKey, MAX_NETWORK_BODY_BYTES, NETWORK_LIST_PATH, NETWORK_SET_PATH,
  NetworkChangeError, webFetchRefusal,
} from './command-network.ts'
export type { CommandNetworkSettings, NetworkListAnswer, NetworkListEntry } from './command-network.ts'
export { EgressProxy, parseAuthority, refusalSentence } from './egress-proxy.ts'
export type { EgressProxyOptions, EgressRefusal, EgressRefusalCode, ResolvedAddress } from './egress-proxy.ts'
export {
  DEFAULT_PORTS, entryAdmits, hostAllowed, hostEntryParts, hostEntryProblem, hostListed, isNetworkAccess, loosens, MAX_ALLOWED_HOSTS,
  NETWORK_ACCESSES, normalizeHost, normalizeHostEntry, OPEN_NETWORK, parseHostList,
} from './network.ts'
export type { HostEntryParts, NetworkAccess, WorkspaceNetwork } from './network.ts'
export {
  NETWORK_STORE_FILE, NETWORK_STORE_VERSION, NetworkStoreError, networkStorePath, parseNetworkStore, readNetworkStore,
  serializeNetworkStore, writeNetworkStore,
} from './network-store.ts'
export type { NetworkStoreRead } from './network-store.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'permission-defaults'

/** The services {@link PermissionDefaults} needs, so this row starts only once they exist; the network needs none of its own. */
export const inject = ['permissionPresets', 'sandboxPolicy']

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `permission_defaults`: whether the plugin mounts the per-workspace
   * default preset, the full-access consent and the per-workspace network of
   * sandboxed commands. Off, the parity value and the default, the plugin mounts
   * nothing: the deployment default reaches every new chat exactly as upstream
   * seeds it, every mode switch is recorded, the resolved policy the model reads
   * is upstream's, and commands share the host's network. Delo's composition
   * turns it on.
   */
  readonly enabled: boolean
  /**
   * The network of a workspace whose person chose none in Settings, Network:
   * `open`, the host's network as stock gives it; `allowlist`, only the hosts of
   * {@link allowedHosts}, through Delo's egress proxy; or `off`, none. Applies
   * to sandboxed commands and to `web_fetch`; a command under full access runs
   * outside the sandbox and reaches the network whatever this says.
   */
  readonly network: NetworkAccess
  /**
   * The allowlist of a workspace without its own setting, used while
   * {@link network} is `allowlist`: host names such as `registry.npmjs.org`,
   * `*.` names such as `*.npmjs.org` for every name below a domain, or public
   * IP addresses; each admits ports 80 and 443, and one written `host:port`,
   * such as `github.com:22`, admits that port instead. Validated at load; an
   * entry with a scheme or a path, a single-label name, a top-level wildcard or
   * a private address fails the load.
   */
  readonly allowedHosts: string[]
  /** How long the egress proxy waits for a connection to a listed host to open, in milliseconds. */
  readonly proxyConnectTimeoutMs: number
  /** The most connections one allowlist's egress proxy holds at once; one more is refused. */
  readonly proxyMaxConnections: number
  /** How long a connection through the egress proxy may carry no byte either way before it is closed, in milliseconds. */
  readonly proxyIdleTimeoutMs: number
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  network: z.union(NETWORK_ACCESSES).default('open'),
  allowedHosts: z.array(z.string()).default([]),
  proxyConnectTimeoutMs: z.natural().default(30_000),
  proxyMaxConnections: z.natural().default(256),
  proxyIdleTimeoutMs: z.natural().default(300_000),
})

/** Stable failure code for a full-access consent the person refused, or no channel could carry. */
export const FULL_ACCESS_CONSENT_REFUSED = 'PERMISSION_FULL_ACCESS_CONSENT_REFUSED'

/**
 * A full-access consent that did not happen: nothing was recorded, and the
 * workspace keeps the safer preset. Typed so a caller that surfaces the
 * refusal to the person or the model branches on the class rather than on
 * message text.
 */
export class FullAccessConsentRefusedError extends Error {
  /** The stable code of every refusal this class carries. */
  readonly code = FULL_ACCESS_CONSENT_REFUSED

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FullAccessConsentRefusedError'
  }
}

/** What turning a workspace's full access on or off did. */
export interface FullAccessChange {
  /** The workspace's full access after the change. */
  readonly access: WorkspaceAccess
  /**
   * How many open chats in the workspace changed: set back to the safer preset when full access was turned off, or the
   * request's chat switched to full access when it was turned on.
   */
  readonly chats: number
}

/**
 * Why a mode change to full access was refused: the workspace needs one
 * consent first. The text reaches the model through the typed refusal, so it
 * says what to do rather than why the code runs as it does.
 * @param workspace - the workspace directory the switch was for.
 * @param problem - a store that could not be read, named so the person can fix it.
 * @returns the refusal reason.
 */
export function fullAccessRefusal(workspace: string, problem?: string): string {
  const where = workspace === NO_WORKSPACE ? 'a chat with no workspace folder' : `the workspace ${JSON.stringify(workspace)}`
  const unreadable = problem === undefined ? '' : ` The permission store could not be read, so no consent counts (${problem}).`
  const command = workspace === NO_WORKSPACE ? 'delorun workspace full-access <folder> on' : `delorun workspace full-access ${shellQuote(workspace)} on`
  return `full access for ${where} needs one consent for that workspace first: the person allows it at the home's own computer, with the approval card's "Allow for this chat", in the studio's Settings, Permissions, or with \`${command}\`; until then keep the safer preset "${SAFER_PRESET}".${unreadable}`
}

/** What reading the store again changed: the workspaces that gained a grant and those that lost one. */
export interface GrantChanges {
  /** The workspaces whose grant the store now holds and this service did not, sorted. */
  readonly added: readonly string[]
  /** The workspaces whose grant this service held and the store no longer does, sorted. */
  readonly lost: readonly string[]
}

/**
 * The `permissionDefaults` service: the per-workspace default preset, the
 * full-access consent and the mode-switch guard. It keeps the store's entries
 * in memory, so the guard answers synchronously, and before every decision —
 * a mode switch to full access, the preset of a new or restored chat, a
 * surface's listing — it compares the store file's identity with the one it
 * read and reads the file again when another process changed it, so a grant
 * withdrawn by another profile's Host, `delorun workspace full-access` or
 * `delorun headless` stops counting at this service's next decision. The open
 * chats of a workspace that lost its grant are set back to the safer preset
 * right after. The service also watches the store's file, and reads it again
 * ({@link reload}) within a second of another process's write, so those chats
 * go back without waiting for a decision; while the watch cannot run, the
 * decision-time read is the only one. A change is read, checked and written
 * under the store's lock file before it is remembered.
 */
export class PermissionDefaults extends Service {
  /** The permission-preset owner upstream's composition mounts, which seeds and applies presets, and the sandbox policy, which reads a chat's logged mode. */
  static inject = ['permissionPresets', 'sandboxPolicy']

  /** The store's entries; empty while nothing is recorded or the store was refused. */
  private entries: ReadonlyMap<string, WorkspacePermission> = new Map()
  /** Why the store could not be read, when it could not: no consent counts until the person fixes it. */
  private problem: string | undefined
  /** The writes to the store, chained so a consent and a concurrent selection never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The store's path, once the home was resolved; undefined while it cannot be. */
  private path: string | undefined
  /** {@link permissionStoreIdentity} of the file the entries were read from. */
  private identity: string | undefined
  /** The entries the open chats were last set by; a workspace granted here and not in {@link entries} lost its grant. */
  private applied: ReadonlyMap<string, WorkspacePermission> = new Map()
  /**
   * The grants a decision read since the open chats were last set, which may have let a chat switch to full access; a
   * workspace granted here and not in {@link entries} lost its grant too.
   */
  private relied: ReadonlyMap<string, WorkspacePermission> = new Map()

  /**
   * @param ctx - the plugin context.
   */
  constructor(ctx: Context) {
    super(ctx, 'permissionDefaults')
  }

  /**
   * Load the store, mount the mode-switch guard and seed the workspace preset
   * of every new chat. The guard is mounted here rather than at mount time so
   * it answers from the entries read above: before that read, a review could
   * only guess.
   */
  protected async [Service.init](): Promise<void> {
    await this.load()
    this.applied = this.entries
    this.watch()
    this.ctx.provide('sandboxModeGuard', this.guard())
    // A reach device opens a terminal without an unlock inside a workspace with a grant (`@delo/home-auth`, C14).
    this.ctx.provide('reachFullAccessGrants', { grantedFolders: () => this.grantedFolders() })
    // Prepend: the seed must land before upstream's pin, which fills every
    // still-unset knob with the deployment default on the same event.
    this.ctx.on('agent/created', ({ agent }) => { this.seed(agent.session) }, { prepend: true })
  }

  /** Why the store could not be read, or undefined while it reads as this version's format. */
  get storeProblem(): string | undefined {
    this.refresh()
    return this.problem
  }

  /**
   * The preset new chats in a workspace start with.
   * @param cwd - the workspace directory.
   * @returns the recorded preset, or the safer preset for a workspace with no entry.
   */
  defaultPreset(cwd: string): PermissionPresetName {
    this.refresh()
    return defaultPresetOf(this.entries, workspaceKey(cwd))
  }

  /**
   * Whether the person granted full access for a workspace.
   * @param cwd - the workspace directory.
   * @returns true when the store holds a grant for it.
   */
  granted(cwd: string): boolean {
    this.refresh()
    return fullAccessGranted(this.entries, workspaceKey(cwd))
  }

  /**
   * The workspace folders that hold a full-access grant, read again when the store changed, so a withdrawn grant is
   * absent at the next call.
   * @returns the folders; empty while the store cannot be read, as no grant counts then.
   */
  grantedFolders(): readonly string[] {
    this.refresh()
    if (this.problem !== undefined) return []
    return [...this.entries].flatMap(([workspace, entry]) => entry.fullAccessGrantedAt === null ? [] : [workspace])
  }

  /**
   * The mode-switch guard's verdict on one pending `sandbox/mode` change: a
   * change to full access in a workspace nobody consented to is refused, and
   * every other change — and every change at all when the store holds the
   * workspace's consent — is allowed.
   * @param session - the session the switch applies to.
   * @param mode - the mode the switch would set.
   * @returns the refusal reason, or undefined to allow the switch.
   */
  review(session: Session, mode: SandboxMode): string | undefined {
    if (mode !== FULL_ACCESS_PRESET) return undefined
    this.refresh()
    const workspace = workspaceOf(session)
    if (fullAccessGranted(this.entries, workspace)) return undefined
    return fullAccessRefusal(workspace, this.problem)
  }

  /**
   * Every workspace a surface may show: the registered workspaces, the workspaces the store holds an entry for, and the
   * folders of the open chats, each once by its key, with its full access as the entries in memory hold it.
   * @returns the workspaces sorted by key, and the store's problem when it cannot be read.
   */
  workspaces(): WorkspacesAnswer {
    this.refresh()
    const titles = new Map<string, string>()
    for (const workspace of this.ctx.get('workspaceRegistry')?.list() ?? []) titles.set(workspaceKey(workspace.path), workspace.title)
    const keys = new Set<string>([...titles.keys(), ...this.entries.keys()])
    for (const agent of this.ctx.get('agents')?.list() ?? []) keys.add(workspaceOf(agent.session))
    keys.delete(NO_WORKSPACE)
    const workspaces = [...keys].sort().map(key => workspaceAccessOf(this.entries, key, titles.get(key)))
    return this.problem === undefined ? { workspaces } : { workspaces, storeProblem: this.problem }
  }

  /**
   * The full access of one open chat's workspace, which the studio's consent shows before the person picks full access
   * in that chat.
   * @param sessionId - the chat's session id.
   * @returns the workspace's full access.
   * @throws {FullAccessChangeError} `UNKNOWN_CHAT` when no open chat has the id, `NO_WORKSPACE` when it has no folder.
   */
  reviewChat(sessionId: string): WorkspaceAccess {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (agent === undefined) throw new FullAccessChangeError('UNKNOWN_CHAT', 'no open chat has this id')
    const workspace = workspaceOf(agent.session)
    if (workspace === NO_WORKSPACE) {
      throw new FullAccessChangeError('NO_WORKSPACE', 'this chat has no workspace folder, so it has no per-workspace permission')
    }
    this.refresh()
    return workspaceAccessOf(this.entries, workspace, this.titleOf(workspace))
  }

  /**
   * Turn one workspace's full access on or off after the person answered a surface's consent at the home's own
   * computer; the route that calls this refuses every other arrival first. On records the grant, so the guard lets a
   * chat in the workspace switch to full access and new chats there start with it; off withdraws the grant, records
   * the safer preset and sets every open chat of the workspace that runs with full access back to the safer preset,
   * which appends that chat's `sandbox/mode` and `permission/preset` events; every other Host of the home reads the
   * written store through its own watch. Turning on with the request's `chat` also switches that chat to full access,
   * so the chat the person answered in stops asking. The change is written to the store before it is remembered, and
   * one line without the folder's path goes to the Host's log.
   * @param request - the workspace the consent named, the review id it was shown with, on or off, and the answer.
   * @returns the workspace's full access after the change, and how many open chats were set back.
   * @throws {FullAccessChangeError} `UNCONFIRMED` without the person's answer, `UNKNOWN_WORKSPACE` for a folder no
   *   surface shows or, when turning full access on, a folder Delo never adds as a workspace (a filesystem root, the
   *   home folder, the Delo home, the stock home, or a folder containing one), `UNKNOWN_CHAT` for a `chat` that is not open in the workspace, `STALE_REVIEW` when the
   *   workspace's full access changed after the consent was shown, and `STORE_REFUSED` when the store cannot be read or
   *   written; each records nothing.
   */
  async setFullAccess(request: SetFullAccessRequest): Promise<FullAccessChange> {
    if (!request.confirmed) throw new FullAccessChangeError('UNCONFIRMED', 'the person has not confirmed the change, so nothing is recorded')
    const workspace = workspaceKey(request.workspace)
    if (workspace === NO_WORKSPACE || !this.workspaces().workspaces.some(access => access.workspace === workspace)) {
      throw new FullAccessChangeError('UNKNOWN_WORKSPACE', 'the studio does not know this workspace')
    }
    if (request.on) await this.refuseLocation(workspace)
    const chat = request.chat === undefined ? undefined : this.ctx.get('agents')?.get(SessionId(request.chat))?.session
    if (request.chat !== undefined && (chat === undefined || workspaceOf(chat) !== workspace)) {
      throw new FullAccessChangeError('UNKNOWN_CHAT', 'no open chat in this workspace has this id')
    }
    return this.serial(async () => {
      await this.locked(async () => {
        const entries = await this.readForChange()
        if (workspaceAccessOf(entries, workspace).reviewId !== request.reviewId) {
          throw new FullAccessChangeError('STALE_REVIEW', 'this workspace\'s full access changed after the consent was shown; look at it again before you answer')
        }
        await this.write(entries, workspace, request.on ? FULL_ACCESS_PRESET : SAFER_PRESET)
      })
      const chats = request.on ? this.switchChat(chat) : this.withdrawOpenChats(workspace)
      const grants = [...this.entries.values()].filter(entry => entry.fullAccessGrantedAt !== null).length
      this.ctx.logger.info(`permission-defaults: full access turned ${request.on ? 'on' : 'off'} for one workspace at the home's computer; ${String(grants)} workspace(s) hold a grant`)
      return { access: workspaceAccessOf(this.entries, workspace, this.titleOf(workspace)), chats }
    })
  }

  /**
   * Read the store again, after another process at the home's computer — another profile's Host,
   * `delorun workspace full-access` — changed it, and set the open chats of every workspace that lost its grant back to
   * the safer preset. The store's watch calls it, and the update channel's `permission.reload` (contract C19). The
   * Host's log names how many workspaces gained and lost a grant.
   * @returns the digest of the entries now in memory ({@link permissionEntriesDigest}), which the writer compares with
   *   what it wrote, how many workspaces gained (`added`) and lost (`lost`) a grant since the open chats were last
   *   set, and the store's problem when it cannot be read.
   */
  reload(): Promise<{ readonly digest: string, readonly added: number, readonly lost: number, readonly storeProblem?: string }> {
    return this.serial(async () => {
      await this.load()
      const { added, lost } = this.reconcile()
      const digest = permissionEntriesDigest(this.entries)
      const counts = { digest, added: added.length, lost: lost.length }
      return this.problem === undefined ? counts : { ...counts, storeProblem: this.problem }
    })
  }

  /**
   * Set the open chats of every workspace that lost its grant since they were last set back to the safer preset, and
   * remember the entries they are now set by.
   * @returns the workspaces that gained and lost a grant.
   */
  private reconcile(): GrantChanges {
    const changes = { added: grantChanges(this.applied, this.entries).added, lost: this.lost() }
    for (const workspace of changes.lost) this.withdrawOpenChats(workspace)
    this.applied = this.entries
    this.relied = new Map()
    if (changes.added.length > 0 || changes.lost.length > 0) {
      this.ctx.logger.info(`permission-defaults: the permission store changed in another process: ${String(changes.added.length)} workspace(s) gained a grant and ${String(changes.lost.length)} lost one`)
    }
    return changes
  }

  /**
   * Read the store again when its file is not the one the entries were read from, for a decision that cannot wait:
   * another process changed it. When a workspace lost its grant, its open chats are set back to the safer preset
   * after the change queued before, once the decision has been made.
   */
  private refresh(): void {
    if (this.path === undefined) return
    const identity = permissionStoreIdentity(this.path)
    if (identity === this.identity) return
    this.identity = identity
    this.take(readPermissionStoreSync(this.path))
    if (this.lost().length > 0) void this.serial(async () => { this.reconcile() })
  }

  /**
   * The workspaces whose grant the open chats were set by, or a decision read since, and the entries no longer hold.
   * @returns the workspaces, sorted.
   */
  private lost(): readonly string[] {
    return grantChanges(new Map([...this.applied, ...this.relied]), this.entries).lost
  }

  /**
   * Refuse full access for a folder Delo never adds as a workspace.
   * @param workspace - the workspace key.
   * @throws {FullAccessChangeError} `UNKNOWN_WORKSPACE` naming why, or `STORE_REFUSED` when the home cannot be resolved.
   */
  private async refuseLocation(workspace: string): Promise<void> {
    let home: string
    try {
      home = (await resolveDeloHome(process.env)).path
    } catch (error) {
      throw new FullAccessChangeError('STORE_REFUSED', `the Delo home could not be resolved, so no permission is recorded (${reasonOf(error)})`, { cause: error })
    }
    const problem = await workspaceLocationProblem(workspace, workspaceLocationHomes(home))
    if (problem !== undefined) throw new FullAccessChangeError('UNKNOWN_WORKSPACE', `${workspaceLocationMessage(problem)} Nothing was changed.`)
  }

  /**
   * Run a read-check-write of the store under its lock file.
   * @param change - the change.
   * @returns when the change is written.
   * @throws {FullAccessChangeError} `STORE_REFUSED` when the home cannot be resolved or the lock is not free in time,
   *   and the change's own {@link FullAccessChangeError} or {@link FullAccessConsentRefusedError}; any other failure of
   *   the change as `STORE_REFUSED`.
   */
  private async locked(change: () => Promise<void>): Promise<void> {
    let path: string
    try {
      path = permissionStorePath((await resolveDeloHome(process.env)).path)
    } catch (error) {
      throw new FullAccessChangeError('STORE_REFUSED', `the Delo home could not be resolved, so no permission is recorded (${reasonOf(error)})`, { cause: error })
    }
    try {
      await withPermissionStoreLock(path, change)
    } catch (error) {
      if (error instanceof FullAccessChangeError || error instanceof FullAccessConsentRefusedError) throw error
      throw new FullAccessChangeError('STORE_REFUSED', `no permission is recorded: ${reasonOf(error)}`, { cause: error })
    }
  }

  /**
   * The one write path a surface uses to choose a workspace's preset. Full
   * access asks the person once for that workspace
   * ({@link fullAccessNote}); the safer preset never asks, and explicitly
   * choosing it withdraws the workspace's earlier grant, so a later full-access
   * selection asks again. A granted ask is recorded before the preset is
   * applied, so the guard lets the switch through; a refused or unanswerable
   * ask records nothing and the session keeps the preset it had. The store is
   * read again first, so a grant another process withdrew is asked for again.
   * Withdrawing a grant sets the workspace's other open chats that run with
   * full access back to the safer preset, as {@link setFullAccess} does when it
   * turns full access off; the other Hosts of the home read the written store
   * through their own watch.
   * @param agent - the chat the choice was made in; its workspace is the one
   *   the consent covers, and it carries the approval ask.
   * @param preset - the preset to select for the workspace.
   * @returns when the preset is recorded and applied.
   * @throws {FullAccessConsentRefusedError} when the ask was refused,
   *   cancelled, unanswerable, or no approval service can carry it, or when
   *   another process withdrew the grant after the store was read and before
   *   the selection was recorded.
   * @throws {FullAccessChangeError} `STORE_REFUSED` when the store cannot be
   *   read or written.
   */
  async select(agent: Agent, preset: PermissionPresetName): Promise<void> {
    const workspace = workspaceOf(agent.session)
    if (workspace === NO_WORKSPACE) {
      throw new FullAccessConsentRefusedError('this chat has no workspace folder, so it has no per-workspace permission to select')
    }
    // Another process may have withdrawn the grant since this service last read the store.
    this.refresh()
    const asked = preset === FULL_ACCESS_PRESET && !fullAccessGranted(this.entries, workspace)
    if (asked) {
      await this.refuseLocation(workspace)
      await this.ask(agent, workspace)
    }
    await this.record(workspace, preset, asked)
    this.ctx.permissionPresets.set(agent.session, preset)
  }

  /**
   * Ask the person for full access to one workspace, through the composed
   * approval service, and refuse unless the answer grants it.
   * @param agent - the chat that carries the ask.
   * @param workspace - the workspace directory the consent covers.
   * @throws {FullAccessConsentRefusedError} on every outcome but a grant.
   */
  private async ask(agent: Agent, workspace: string): Promise<void> {
    const approver = this.ctx.get('approval')
    if (approver === undefined) {
      throw new FullAccessConsentRefusedError(`full access for the workspace ${JSON.stringify(workspace)} needs a consent, but no approval service is composed`)
    }
    let outcome: ApprovalOutcome
    try {
      // `grants` lets the Host refuse this answer from a session that may not grant full access (C14, `LOOPBACK_REQUIRED`).
      outcome = await approver.request({ agent, toolName: 'permission', reason: fullAccessNote(workspace), grants: 'full-access' })
    } catch (error) {
      throw new FullAccessConsentRefusedError(
        `full access for the workspace ${JSON.stringify(workspace)} was not granted: the consent could not be asked (${reasonOf(error)})`,
        { cause: error },
      )
    }
    switch (outcome) {
      case 'allowed-once':
        return
      case 'rejected':
        throw new FullAccessConsentRefusedError(`the person did not grant full access for the workspace ${JSON.stringify(workspace)}; it keeps the safer preset "${SAFER_PRESET}"`)
      case 'cancelled':
        throw new FullAccessConsentRefusedError(`the consent for full access to the workspace ${JSON.stringify(workspace)} was cancelled; it keeps the safer preset "${SAFER_PRESET}"`)
      case 'unavailable':
        throw new FullAccessConsentRefusedError(`full access for the workspace ${JSON.stringify(workspace)} needs a consent, but no approval channel is available`)
    }
  }

  /**
   * Record a workspace's preset in the store. The full-access grant follows the
   * choice: choosing full access records the consent's time, and choosing the
   * safer preset explicitly withdraws it, so returning to full access asks
   * again. A grant is the person's answer for that folder, and going back to
   * the sandbox is that answer changed.
   * Full access is recorded only over a grant the store still holds, or after this selection asked: a grant another
   * process withdrew after this selection read the store is not recorded again without asking.
   * @param workspace - the workspace key.
   * @param preset - the preset to record.
   * @param asked - whether this selection asked the person and the person granted full access.
   * @returns when the store holds the entry; when the record withdrew a grant, the workspace's open chats that run with
   *   full access are set back to the safer preset first.
   * @throws {FullAccessConsentRefusedError} for full access the selection did not ask for, over a store that holds no
   *   grant for the workspace; nothing is recorded.
   * @throws when the store cannot be read or written.
   */
  private record(workspace: string, preset: PermissionPresetName, asked: boolean): Promise<void> {
    return this.serial(async () => {
      let withdrew = false
      await this.locked(async () => {
        const entries = await this.readForChange()
        if (preset === FULL_ACCESS_PRESET && !asked && !fullAccessGranted(entries, workspace)) {
          throw new FullAccessConsentRefusedError(`full access for the workspace ${JSON.stringify(workspace)} was withdrawn while it was being selected, so nothing was recorded; select it again to be asked`)
        }
        withdrew = preset !== FULL_ACCESS_PRESET && fullAccessGranted(entries, workspace)
        await this.write(entries, workspace, preset)
      })
      if (withdrew) this.withdrawOpenChats(workspace)
    })
  }

  /**
   * The store's entries as the file holds them now, for a change: another process at the home's computer may have
   * written the file since this service read it, and a change made over the entries in memory would undo that write.
   * The entries in memory follow the read, and the open chats of a workspace that lost its grant meanwhile are set back
   * to the safer preset.
   * @returns the entries.
   * @throws {FullAccessChangeError} `STORE_REFUSED` when the home cannot be resolved or the store is refused; no
   *   change is made over a store that cannot be read.
   */
  private async readForChange(): Promise<ReadonlyMap<string, WorkspacePermission>> {
    await this.load()
    if (this.problem !== undefined) {
      throw new FullAccessChangeError('STORE_REFUSED', `the permission store is refused, so no permission is recorded: ${this.problem}`)
    }
    this.reconcile()
    return this.entries
  }

  /**
   * Write one workspace's preset over the entries just read, and remember the result.
   * @param entries - the entries the file holds now.
   * @param workspace - the workspace key.
   * @param preset - the preset; full access keeps an earlier grant's time or records now, the safer preset records no grant.
   * @throws {FullAccessChangeError} `STORE_REFUSED` when the store cannot be written; the entries in memory are unchanged then.
   */
  private async write(entries: ReadonlyMap<string, WorkspacePermission>, workspace: string, preset: PermissionPresetName): Promise<void> {
    const next = new Map(entries)
    next.set(workspace, {
      preset,
      fullAccessGrantedAt: preset === FULL_ACCESS_PRESET ? entries.get(workspace)?.fullAccessGrantedAt ?? Date.now() : null,
    })
    let path: string
    try {
      path = permissionStorePath((await resolveDeloHome(process.env)).path)
      await writePermissionStore(path, next)
    } catch (error) {
      throw new FullAccessChangeError('STORE_REFUSED', `the permission store could not be written, so no permission is recorded (${reasonOf(error)})`, { cause: error })
    }
    this.entries = next
    this.applied = next
    this.relied = new Map()
    this.path = path
    this.identity = permissionStoreIdentity(path)
  }

  /**
   * Set every open chat of a workspace that runs with full access back to the safer preset, after its grant was
   * withdrawn. A chat that cannot be set is named in the Host's log and counted out, so the caller reports how many
   * were set.
   * @param workspace - the workspace key.
   * @returns how many chats were set back.
   */
  private withdrawOpenChats(workspace: string): number {
    let chats = 0
    for (const agent of this.ctx.get('agents')?.list() ?? []) {
      const session = agent.session
      if (workspaceOf(session) !== workspace || this.ctx.sandboxPolicy.overrideOf(session) !== FULL_ACCESS_PRESET) continue
      try {
        this.ctx.permissionPresets.set(session, SAFER_PRESET)
        chats++
      } catch (error) {
        this.ctx.logger.warn(`permission-defaults: the chat ${String(session.id)} keeps full access after its workspace's grant was withdrawn, because it could not be set to the safer preset: ${reasonOf(error)}`)
      }
    }
    return chats
  }

  /**
   * Switch the chat a granting consent was asked from to full access.
   * @param session - the chat, or undefined when the consent named none.
   * @returns 1 when the chat was switched; 0 without a chat or when it could not be switched, which the Host's log names.
   */
  private switchChat(session: Session | undefined): number {
    if (session === undefined) return 0
    try {
      this.ctx.permissionPresets.set(session, FULL_ACCESS_PRESET)
      return 1
    } catch (error) {
      this.ctx.logger.warn(`permission-defaults: the chat ${String(session.id)} keeps its preset after its workspace's grant, because it could not be switched to full access: ${reasonOf(error)}`)
      return 0
    }
  }

  /**
   * The title of the registered workspace at a key.
   * @param workspace - the workspace key.
   * @returns the title, or undefined when no registered workspace is at the key.
   */
  private titleOf(workspace: string): string | undefined {
    return this.ctx.get('workspaceRegistry')?.list().find(entry => workspaceKey(entry.path) === workspace)?.title
  }

  /**
   * Seed one new chat with its workspace's preset, before upstream's pin fills
   * the knob defaults. A chat that already holds a choice, or that was seeded
   * by its constructor, keeps the permission it has, with one exception: a
   * chat whose log runs it with full access in a workspace this home holds no
   * grant for, such as a chat copied from a stock DeepSeek Harness home or one
   * whose grant the person withdrew, is set to the safer preset before it runs
   * anything ({@link withdrawUngranted}).
   * @param session - the chat being created.
   * @throws Error when such a chat cannot be set to the safer preset, so the chat does not open with full access.
   */
  private seed(session: Session): void {
    this.refresh()
    if (!this.ctx.permissionPresets.unset(session)) {
      this.withdrawUngranted(session)
      return
    }
    const workspace = workspaceOf(session)
    const preset = defaultPresetOf(this.entries, workspace)
    try {
      this.ctx.permissionPresets.set(session, preset)
      // `set` records a change, and a workspace whose preset is the one the
      // composed defaults already resolve to is no change: nothing is
      // appended, the session stays unset, and upstream's pin would fill it
      // with the deployment default. The seeded identity is the durable fact
      // this plugin promises for every new chat, so record it here in that
      // case; the pin then reads the session as seeded and keeps the preset.
      if (this.ctx.permissionPresets.unset(session)) session.append('permission/preset', { preset })
    } catch (error) {
      // A workspace whose recorded preset the mounted preset table does not
      // know, or a refusal from another consent layer, must not fail chat
      // creation: upstream's pin then seeds the deployment default, exactly as
      // it does without this plugin.
      this.ctx.logger.warn(`permission-defaults: seeding the preset of ${String(session.id)} failed: ${reasonOf(error)}`)
    }
  }

  /**
   * Set a restored chat that runs with full access, in a workspace this home
   * holds no grant for, to the safer preset. The full-access
   * consent covers a workspace in this home, and a log written elsewhere or
   * before a withdrawal carries none.
   * @param session - the restored chat.
   * @throws Error when the preset cannot be set; the caller's chat creation fails rather than open with full access.
   */
  private withdrawUngranted(session: Session): void {
    if (this.ctx.sandboxPolicy.overrideOf(session) !== FULL_ACCESS_PRESET) return
    const workspace = workspaceOf(session)
    if (fullAccessGranted(this.entries, workspace)) return
    try {
      this.ctx.permissionPresets.set(session, SAFER_PRESET)
    } catch (error) {
      throw new Error(`permission-defaults: the chat ${String(session.id)} runs with full access in a workspace with no full-access consent, and it could not be set to the safer preset (${reasonOf(error)}), so it does not open`, { cause: error })
    }
  }

  /**
   * Watch the store's file, read when the service starts, and read it again ({@link reload}) when another process
   * writes it; the watch closes with the plugin. A watch that cannot start or fails is named in the Host's log once,
   * and the store is then read again only at the next decision. While the home cannot be resolved, nothing is watched.
   */
  private watch(): void {
    const path = this.path
    if (path === undefined) return
    const failed = (error: unknown): void => {
      this.ctx.logger.warn(`permission-defaults: the permission store is not watched (${reasonOf(error)}); a change another process writes is read at this Host's next decision, and its open chats keep their preset until then`)
    }
    this.ctx.effect(() => watchPermissionStore(path, {
      changed: () => {
        this.reload().catch((error: unknown) => {
          this.ctx.logger.warn(`permission-defaults: the permission store changed and could not be read again (${reasonOf(error)}); it is read again at this Host's next decision`)
        })
      },
      failed,
    }))
  }

  /**
   * Read the store's entries into memory; a store that cannot be read leaves no entry and names its problem.
   * @returns when the entries are in memory.
   */
  private async load(): Promise<void> {
    try {
      this.path = permissionStorePath((await resolveDeloHome(process.env)).path)
    } catch (error) {
      this.path = undefined
      this.identity = undefined
      this.take({ kind: 'refused', problem: `the Delo home could not be resolved (${reasonOf(error)})` })
      return
    }
    // The identity is taken before the read, so a write that lands during the read is read again at the next decision.
    this.identity = permissionStoreIdentity(this.path)
    this.take(await readPermissionStore(this.path))
  }

  /**
   * Keep what a read of the store found. The grants of the entries it replaces join {@link relied} first, so a reread
   * through {@link refresh}, {@link reload} or a change finds every workspace that lost a grant a decision may have
   * relied on.
   * @param read - the read.
   */
  private take(read: PermissionStoreRead): void {
    // A grant read since the open chats were last set may have let a chat switch, so it counts as one to withdraw.
    this.relied = new Map([...this.relied, ...[...this.entries].filter(([, entry]) => entry.fullAccessGrantedAt !== null)])
    this.entries = read.kind === 'readable' ? read.entries : new Map()
    this.problem = read.kind === 'refused' ? read.problem : undefined
  }

  /**
   * The guard function the context carries: {@link review}, with the seam's
   * signature.
   * @returns the mode-switch guard.
   */
  private guard(): SandboxModeGuard {
    return (session, mode) => this.review(session, mode)
  }

  /**
   * Run a change to the store after the changes queued before it, whatever those did.
   * @param change - the change.
   * @returns the change's result.
   */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change)
    this.queue = next
    return next
  }
}

/**
 * The store's key for a chat's workspace.
 * @param session - the chat.
 * @returns the key of its folder, or {@link NO_WORKSPACE} for a chat with none.
 */
function workspaceOf(session: Session): string {
  return workspaceKey(session.header.cwd ?? '')
}

/**
 * The workspaces whose grant one set of entries holds and another does not.
 * @param before - the earlier entries.
 * @param after - the later entries.
 * @returns the workspaces granted only after (`added`) and only before (`lost`), each sorted.
 */
export function grantChanges(before: ReadonlyMap<string, WorkspacePermission>, after: ReadonlyMap<string, WorkspacePermission>): GrantChanges {
  const granted = (entries: ReadonlyMap<string, WorkspacePermission>): Set<string> =>
    new Set([...entries].filter(([, entry]) => entry.fullAccessGrantedAt !== null).map(([workspace]) => workspace))
  const was = granted(before)
  const is = granted(after)
  return { added: [...is].filter(workspace => !was.has(workspace)).sort(), lost: [...was].filter(workspace => !is.has(workspace)).sort() }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's per-workspace permission defaults, mounted while the `permission_defaults` switch is on. */
    permissionDefaults: PermissionDefaults
  }
}

/**
 * With the `permission_defaults` switch on: mount the service, whose guard
 * refuses a full-access mode change for a workspace nobody consented to, which
 * seeds each new chat with its workspace's preset, and which records the one
 * consent, and, where a Connection serves the studio, the routes of the
 * studio's consent and its Permissions section ([`./routes.ts`](./routes.ts)).
 * Off, mount nothing, so upstream's own seeding and mode switches
 * stand, which is what the parity composition asserts.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  clearFailedRow(ctx)
  if (!config.enabled) return
  if (ctx.get('sandboxModeGuard') !== undefined) {
    throw new Error('permission-defaults: another plugin already provides the sandbox-mode guard; the seam has one provider, so a composition turns on this full-access consent or the other guard, not both')
  }
  if (ctx.get('sandboxNetwork') !== undefined) {
    throw new Error('permission-defaults: another plugin already provides the sandbox network resolver; the seam has one provider, so a composition turns on this per-workspace network or the other resolver, not both')
  }
  const failedGuard = guardFailedRow(ctx)
  try {
    // Validated inside the guarded try: a hot reload does not run the boot check, so a refused value must mount the stand-ins too.
    await mountServices(ctx, config, validatedHosts(config), failedGuard.track)
  } catch (error) {
    // The row fails loudly, and the seams its services decide answer their most restrictive value meanwhile, because
    // an absent seam reads as stock permissive.
    const reason = reasonOf(error)
    ctx.logger.error(`permission-defaults: the row ${PERMISSION_DEFAULTS_ROW} failed to start a service, so commands get no network and full access is refused until it starts again: ${reason}`)
    failedGuard.fail(reason)
    mountFailedRow(ctx)
    throw error
  }
}

/**
 * Check the row's allowlist and proxy limits.
 * @param config - the row's configuration.
 * @returns the validated default allowlist.
 * @throws when `allowedHosts` has a refused entry or a proxy limit is not positive (0 would disable the timeout or refuse every connection).
 */
function validatedHosts(config: Config): readonly string[] {
  const allowed = parseHostList(config.allowedHosts)
  if ('problem' in allowed) throw new Error(`permission-defaults: allowedHosts is refused: ${allowed.problem}`)
  for (const field of ['proxyConnectTimeoutMs', 'proxyMaxConnections', 'proxyIdleTimeoutMs'] as const) {
    if (!(config[field] > 0)) throw new Error(`permission-defaults: ${field} must be a positive number`)
  }
  return allowed.hosts
}

/**
 * Mount the row's services in order, each awaited.
 * @param ctx - the plugin context.
 * @param config - the row's configuration.
 * @param hosts - the validated default allowlist.
 * @param track - receives the permission service's fiber.
 */
async function mountServices(ctx: Context, config: Config, hosts: readonly string[], track: FailedRowGuard['track']): Promise<void> {
  // Awaited, with the service's own injections declared on the plugin, so the store is read and the guard provided
  // before the Loader counts this row as started; the network's proxies listen and its resolver is provided the same way.
  const service = ctx.plugin(PermissionDefaults)
  track(service)
  await service.await()
  // A service whose activation failed may leave its fiber's await resolved, so its registration is what counts.
  if (ctx.root.get('permissionDefaults') === undefined) throw new Error('the permission service did not start; its failure is in the log above')
  // The studio's routes, in a profile that serves a studio.
  ctx.inject(['connection', 'permissionDefaults'], (child) => { registerPermissionRoutes(child) })
  await ctx.plugin(CommandNetwork, {
    defaultNetwork: { access: config.network, hosts },
    proxyConnectTimeoutMs: config.proxyConnectTimeoutMs,
    proxyMaxConnections: config.proxyMaxConnections,
    proxyIdleTimeoutMs: config.proxyIdleTimeoutMs,
  } satisfies CommandNetworkSettings).await()
  if (ctx.root.get('deloCommandNetwork') === undefined) throw new Error('the network service did not start; its failure is in the log above')
}

/**
 * The reason a failure gives, in words that may reach the person through a refusal error.
 * @param error - the failure.
 * @returns the failure's message, or a plain one when it has none.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'no reason was given'
}
