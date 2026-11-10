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
 *   protected state ([`./store.ts`](./store.ts)).
 *
 * Every registration sits behind the C16 switch `permission_defaults`
 * ({@link Config.enabled}), off by default: off, the plugin mounts nothing, the
 * deployment default reaches every new chat exactly as upstream seeds it, and
 * any mode switch is recorded (parity replay relies on that).
 *
 * @module @delo/plugin-permission-defaults
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxModeGuard } from '@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { resolveDeloHome } from '@delo/home'
import z from '@deepseek-ai/schemastery'
import {
  defaultPresetOf,
  fullAccessGranted,
  readPermissionStore,
  writePermissionStore,
  permissionStorePath,
  FULL_ACCESS_PRESET,
  SAFER_PRESET,
  type PermissionPresetName,
  type PermissionStoreRead,
  type WorkspacePermission,
} from './store.ts'
import { NO_WORKSPACE, workspaceKey } from './workspace.ts'

export {
  defaultPresetOf,
  fullAccessGranted,
  isPermissionPreset,
  parsePermissionStore,
  permissionStorePath,
  readPermissionStore,
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

/** The plugin's name in the loader's diagnostics. */
export const name = 'permission-defaults'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `permission_defaults`: whether the plugin mounts the per-workspace
   * default preset and the full-access consent. Off, the parity value and the
   * default, the plugin mounts nothing: the deployment default reaches every new
   * chat exactly as upstream seeds it, every mode switch is recorded, and the
   * resolved policy the model reads is upstream's. Delo's composition turns it
   * on.
   */
  readonly enabled: boolean
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
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

/**
 * What the person is told before full access is granted for a workspace: the
 * preset, the folder it covers, and what it drops. Sentence case, one effect
 * per sentence, so the answer is a decision about that workspace only.
 * @param workspace - the workspace directory the consent would cover.
 * @returns the ask's text.
 */
export function fullAccessNote(workspace: string): string {
  return `Turn on full access for the workspace ${JSON.stringify(workspace)}? Chats in this workspace could then write anywhere on this machine and start commands that run outside the sandbox, without asking again. The answer covers this workspace only, and you can go back to the safer preset at any time.`
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
  return `full access for ${where} needs one consent for that workspace first; allow the full-access request for this workspace, or keep the safer preset "${SAFER_PRESET}".${unreadable}`
}

/**
 * The `permissionDefaults` service: the per-workspace default preset, the
 * full-access consent and the mode-switch guard. It reads the store once at
 * mount and keeps the entries in memory, so the guard answers synchronously;
 * a granted consent is written through the store before it is remembered.
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
    await this.reload()
    this.ctx.provide('sandboxModeGuard', this.guard())
    // Prepend: the seed must land before upstream's pin, which fills every
    // still-unset knob with the deployment default on the same event.
    this.ctx.on('agent/created', ({ agent }) => { this.seed(agent.session) }, { prepend: true })
  }

  /** Why the store could not be read, or undefined while it reads as this version's format. */
  get storeProblem(): string | undefined {
    return this.problem
  }

  /**
   * The preset new chats in a workspace start with.
   * @param cwd - the workspace directory.
   * @returns the recorded preset, or the safer preset for a workspace with no entry.
   */
  defaultPreset(cwd: string): PermissionPresetName {
    return defaultPresetOf(this.entries, workspaceKey(cwd))
  }

  /**
   * Whether the person granted full access for a workspace.
   * @param cwd - the workspace directory.
   * @returns true when the store holds a grant for it.
   */
  granted(cwd: string): boolean {
    return fullAccessGranted(this.entries, workspaceKey(cwd))
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
    const workspace = workspaceKey(session.header.cwd ?? '')
    if (fullAccessGranted(this.entries, workspace)) return undefined
    return fullAccessRefusal(workspace, this.problem)
  }

  /**
   * The one write path a surface uses to choose a workspace's preset. Full
   * access asks the person once for that workspace
   * ({@link fullAccessNote}); the safer preset never asks, and explicitly
   * choosing it withdraws the workspace's earlier grant, so a later full-access
   * selection asks again. A granted ask is recorded before the preset is
   * applied, so the guard lets the switch through; a refused or unanswerable
   * ask records nothing and the session keeps the preset it had.
   * @param agent - the chat the choice was made in; its workspace is the one
   *   the consent covers, and it carries the approval ask.
   * @param preset - the preset to select for the workspace.
   * @returns when the preset is recorded and applied.
   * @throws {FullAccessConsentRefusedError} when the ask was refused,
   *   cancelled, unanswerable, or no approval service can carry it, and when
   *   the store cannot be read or written.
   */
  async select(agent: Agent, preset: PermissionPresetName): Promise<void> {
    const workspace = workspaceKey(agent.session.header.cwd ?? '')
    if (workspace === NO_WORKSPACE) {
      throw new FullAccessConsentRefusedError('this chat has no workspace folder, so it has no per-workspace permission to select')
    }
    if (preset === FULL_ACCESS_PRESET && !fullAccessGranted(this.entries, workspace)) {
      await this.ask(agent, workspace)
    }
    await this.record(workspace, preset)
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
      outcome = await approver.request({ agent, toolName: 'permission', reason: fullAccessNote(workspace) })
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
   * @param workspace - the workspace key.
   * @param preset - the preset to record.
   * @returns when the store holds the entry.
   * @throws when the store cannot be written, or was already refused.
   */
  private record(workspace: string, preset: PermissionPresetName): Promise<void> {
    return this.serial(async () => {
      if (this.problem !== undefined) {
        throw new Error(`the permission store is refused, so no permission is recorded: ${this.problem}`)
      }
      const previous = this.entries.get(workspace)
      const next = new Map(this.entries)
      next.set(workspace, {
        preset,
        fullAccessGrantedAt: preset === FULL_ACCESS_PRESET ? previous?.fullAccessGrantedAt ?? Date.now() : null,
      })
      await writePermissionStore(permissionStorePath((await resolveDeloHome(process.env)).path), next)
      this.entries = next
    })
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
    if (!this.ctx.permissionPresets.unset(session)) {
      this.withdrawUngranted(session)
      return
    }
    const workspace = workspaceKey(session.header.cwd ?? '')
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
    const workspace = workspaceKey(session.header.cwd ?? '')
    if (fullAccessGranted(this.entries, workspace)) return
    try {
      this.ctx.permissionPresets.set(session, SAFER_PRESET)
    } catch (error) {
      throw new Error(`permission-defaults: the chat ${String(session.id)} runs with full access in a workspace with no full-access consent, and it could not be set to the safer preset (${reasonOf(error)}), so it does not open`, { cause: error })
    }
  }

  /**
   * The store's entries, read once for this service.
   * @returns when the entries are in memory.
   */
  private async reload(): Promise<void> {
    let read: PermissionStoreRead
    try {
      read = await readPermissionStore(permissionStorePath((await resolveDeloHome(process.env)).path))
    } catch (error) {
      this.entries = new Map()
      this.problem = `the Delo home could not be resolved (${reasonOf(error)})`
      return
    }
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
 * With the `permission_defaults` switch on: mount the service, whose guard
 * refuses a full-access mode change for a workspace nobody consented to, which
 * seeds each new chat with its workspace's preset, and which records the one
 * consent. Off, mount nothing, so upstream's own seeding and mode switches
 * stand, which is what the parity composition asserts.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  if (ctx.get('sandboxModeGuard') !== undefined) {
    throw new Error('permission-defaults: another plugin already provides the sandbox-mode guard; the seam has one provider, so a composition turns on this full-access consent or the other guard, not both')
  }
  await ctx.plugin(PermissionDefaults)
}

/**
 * The reason a failure gives, in words that may reach the person through a refusal error.
 * @param error - the failure.
 * @returns the failure's message, or a plain one when it has none.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'no reason was given'
}
