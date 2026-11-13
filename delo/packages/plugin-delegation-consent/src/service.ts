/**
 * The `delegationConsent` service: the Service Provider of the external-delegation consent seam of
 * `@deepseek-ai/dsh-subagent`. It reviews every start of an external subagent provider, such as Claude Code or Codex,
 * before the provider runs, in this order:
 *
 * 1. A chat that runs read-only is refused, whatever was granted, and so is every chat while no sandbox policy is
 *    composed to tell.
 * 2. A chat without a workspace folder is refused, and so is a run directory outside the chat's workspace.
 * 3. A grants file that cannot be read refuses, so no grant counts.
 * 4. A grant for the provider in the chat's workspace allows the start.
 * 5. Otherwise the person is asked through the composed approval service, with the `external-agent` grant marker,
 *    so a reach device cannot give the answer, naming the folder the agent runs in; only `allowed-once` allows the
 *    start, and it records nothing. A chat whose approval policy is `never`, the full-access preset's, is refused
 *    without anyone being asked.
 *
 * Every allowed start carries the configured run time limit. The service also names an external provider in its
 * delegation tool's description, and lists, records and revokes the grants the studio and `delorun` show.
 *
 * @module @delo/plugin-delegation-consent/service
 */
import { sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  DelegationConsentService, ExternalDelegationReview, ExternalDelegationVerdict,
} from '@deepseek-ai/dsh-subagent'
import { resolveDeloHome, workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem } from '@delo/home'
import { NO_WORKSPACE, workspaceKey } from '@delo/plugin-permission-defaults/workspace'
import {
  agentName, askText, askTextZh, describeAgent, noSandboxPolicyRefusal, notApprovedRefusal, noWorkspaceRefusal, outsideRefusal,
  readOnlyRefusal, storeRefusal,
} from './copy.ts'
import { changeGrantStore, grantOf, grantStorePath, problemOf, readGrantStore, withGrant, withoutGrant, type ExternalAgentGrant } from './store.ts'
import type {
  AllowWorkspaceAnswer, AllowWorkspaceRequest, DelegationRefusalCode, GrantsAnswer, GrantView, RevokeAnswer, RevokeRequest,
} from './wire.ts'

/** A surface call that recorded nothing, with the code its route answers. */
export class DelegationConsentError extends Error {
  /** The code the route answers. */
  readonly code: DelegationRefusalCode

  constructor(code: DelegationRefusalCode, message: string) {
    super(message)
    this.name = 'DelegationConsentError'
    this.code = code
  }
}

/** What the service needs beyond its context. */
export interface ConsentOptions {
  /** The run time limit every allowed start carries, in milliseconds. */
  readonly timeoutMs: number
  /** The environment the Delo home is resolved from. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The clock a new grant records. */
  readonly now: () => number
}

/**
 * Whether a directory is a workspace or inside it. A filesystem root, which Delo never adds as a workspace, contains
 * only itself here, so a chat there starts no external agent in another folder.
 * @param workspace - the workspace key.
 * @param directory - the canonical directory.
 * @returns true when the directory is the workspace or below it.
 */
function inside(workspace: string, directory: string): boolean {
  return directory === workspace || directory.startsWith(`${workspace}${sep}`)
}

/**
 * A grant as a surface shows it.
 * @param grant - the recorded grant.
 * @returns the view.
 */
function viewOf(grant: ExternalAgentGrant): GrantView {
  return { ...grant, agent: agentName(grant.provider) }
}

/** The `delegationConsent` service of Delo's external-agent consent. */
export class DeloDelegationConsent extends Service implements DelegationConsentService {
  private readonly options: ConsentOptions

  constructor(ctx: Context, options: ConsentOptions) {
    super(ctx, 'delegationConsent')
    this.options = options
  }

  describe(provider: string): string {
    return describeAgent(provider)
  }

  async review(review: ExternalDelegationReview): Promise<ExternalDelegationVerdict> {
    const { provider, parent } = review
    const session = parent.session
    const sandbox = this.ctx.get('sandboxPolicy')
    if (sandbox === undefined) return { kind: 'refuse', reason: noSandboxPolicyRefusal(provider) }
    if (sandbox.resolve({ session }).mode === 'read-only') return { kind: 'refuse', reason: readOnlyRefusal(provider) }
    const workspace = workspaceKey(session.header.cwd ?? '')
    if (workspace === NO_WORKSPACE) return { kind: 'refuse', reason: noWorkspaceRefusal(provider) }
    const cwd = workspaceKey(review.cwd)
    if (!inside(workspace, cwd)) return { kind: 'refuse', reason: outsideRefusal(provider, workspace, review.cwd) }
    const read = await readGrantStore(await this.storePath())
    if (read.kind === 'refused') return { kind: 'refuse', reason: storeRefusal(provider, read.problem) }
    const allowed = { kind: 'allow', timeoutMs: this.options.timeoutMs } as const
    if (grantOf(read.grants, workspace, provider) !== undefined) return allowed
    const approval = this.ctx.get('approval')
    if (approval === undefined) return { kind: 'refuse', reason: notApprovedRefusal(provider, 'no-approval', workspace) }
    const facts = { provider, workspace, cwd, label: review.label }
    // The approval service answers `rejected` without asking anyone while the chat's policy is `never`.
    const policy = approval.overrideOf(session) ?? approval.config.policy
    const outcome = await approval.request({
      agent: parent,
      toolName: provider,
      reason: askText(facts),
      displayReason: { en: askText(facts), zh: askTextZh(facts) },
      grants: 'external-agent',
      signal: review.signal,
    })
    if (outcome === 'allowed-once') return allowed
    return { kind: 'refuse', reason: notApprovedRefusal(provider, outcome === 'rejected' && policy === 'never' ? 'never' : outcome, workspace) }
  }

  /**
   * Every recorded grant, for the Permissions section.
   * @returns the grants, or none with the file's problem when it cannot be read.
   */
  async grants(): Promise<GrantsAnswer> {
    const read = await readGrantStore(await this.storePath())
    if (read.kind === 'refused') return { grants: [], storeProblem: read.problem }
    const grants = read.grants.map(viewOf)
      .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.provider.localeCompare(b.provider))
    return { grants }
  }

  /**
   * Record that an external agent may start without asking in an open chat's workspace: the approval card's "Allow
   * for this workspace", answered at the home's own computer.
   * @param request - the chat, the provider and the confirmation.
   * @returns the recorded grant.
   * @throws {DelegationConsentError} `UNCONFIRMED`, `UNKNOWN_CHAT`, `UNKNOWN_AGENT`, `NO_WORKSPACE`,
   *   `UNKNOWN_WORKSPACE` or `STORE_REFUSED`; nothing is recorded.
   */
  async allowWorkspace(request: AllowWorkspaceRequest): Promise<AllowWorkspaceAnswer> {
    if (!request.confirmed) throw new DelegationConsentError('UNCONFIRMED', 'nothing was recorded: the request did not confirm the grant')
    const provider = this.ctx.get('subagents')?.getProvider(request.provider)
    if (provider === undefined || provider.prepareContinuable !== undefined) {
      throw new DelegationConsentError('UNKNOWN_AGENT', `nothing was recorded: "${request.provider}" is not an external agent of this studio`)
    }
    const chat = this.ctx.get('agents')?.get(SessionId(request.sessionId))
    if (chat === undefined) throw new DelegationConsentError('UNKNOWN_CHAT', 'nothing was recorded: the chat is not open')
    const workspace = workspaceKey(chat.session.header.cwd ?? '')
    if (workspace === NO_WORKSPACE) throw new DelegationConsentError('NO_WORKSPACE', 'nothing was recorded: the chat has no workspace folder')
    const home = (await resolveDeloHome(this.options.env)).path
    const problem = await workspaceLocationProblem(workspace, workspaceLocationHomes(home))
    if (problem !== undefined) throw new DelegationConsentError('UNKNOWN_WORKSPACE', `nothing was recorded: ${workspaceLocationMessage(problem)}`)
    const written = await this.change(grants => withGrant(grants, workspace, request.provider, this.options.now()))
    this.ctx.logger.info(`external agent ${request.provider} allowed for a workspace`)
    return { grant: viewOf(grantOf(written, workspace, request.provider) as ExternalAgentGrant) }
  }

  /**
   * Remove one grant, so the agent asks again at its next start there. It only takes access away, so it asks nothing.
   * @param request - the workspace and the provider.
   * @returns whether a grant was removed.
   * @throws {DelegationConsentError} `STORE_REFUSED` when the grants file cannot be changed.
   */
  async revoke(request: RevokeRequest): Promise<RevokeAnswer> {
    let revoked = false
    await this.change((grants) => {
      const next = withoutGrant(grants, request.workspace, request.provider)
      revoked = next.length !== grants.length
      return next
    })
    this.ctx.logger.info(`external agent ${request.provider} revoked for a workspace`)
    return { revoked }
  }

  /** The grants file of the home this process runs with. */
  private async storePath(): Promise<string> {
    return grantStorePath((await resolveDeloHome(this.options.env)).path)
  }

  /**
   * Change the grants file, reporting a refused or unwritable file as `STORE_REFUSED`.
   * @param change - the grants to write, from the grants read.
   * @returns the grants written.
   */
  private async change(change: (grants: readonly ExternalAgentGrant[]) => readonly ExternalAgentGrant[]): Promise<readonly ExternalAgentGrant[]> {
    const path = await this.storePath()
    try {
      return await changeGrantStore(path, change)
    } catch (error) {
      throw new DelegationConsentError('STORE_REFUSED', `nothing was recorded: ${problemOf(error)}`)
    }
  }
}
