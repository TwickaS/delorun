/**
 * The `delegationConsent` service: the Service Provider of the external-delegation consent seam of
 * `@deepseek-ai/dsh-subagent`. It reviews every start of an external subagent provider, such as Claude Code or Codex,
 * before the provider runs, in this order:
 *
 * 1. A chat that runs read-only is refused, whatever was granted, and so is every chat while no sandbox policy is
 *    composed to tell.
 * 2. A chat without a workspace folder is refused, and so is a run directory outside the chat's workspace.
 * 3. A grants file that cannot be read refuses, so no grant counts.
 * 4. A plan limit of Claude Code or Codex that the start gate reports reached refuses, while its C16 switch
 *    `external_agent_limit_refusal` is on.
 * 5. A grant for the provider in the chat's workspace allows the start.
 * 6. A start whose top-level chat is in Full access, with its own logged approval policy `never` and sandbox mode
 *    `danger-full-access` together, is allowed without anyone being asked while the `fullAccessStartsAgents` switch is
 *    on; the walk up through the delegation ancestry never takes a child's pinned or inherited values. Any other
 *    chat whose policy is `never` is refused without anyone being asked.
 * 7. Otherwise the person is asked through the composed approval service, with the `external-agent` grant marker,
 *    so a reach device cannot give the answer, naming the folder the agent runs in; only `allowed-once` allows the
 *    start, and it records nothing.
 *
 * Every allowed start carries the configured run time limit. The service also names an external provider in its
 * delegation tool's description, and lists, records and revokes the grants the studio and `delorun` show.
 *
 * A live agent seat is reviewed by `reviewSeat` over the same ordered rules, with read-only checked on the seat's root
 * chat and its creator and the workspace taken from the root. A seat whose root chat has Full access (approval policy
 * `never` and sandbox `danger-full-access`) is allowed with no card and no grant while `fullAccessStartsAgents` is on,
 * and the verdict says so; any other `never` root is refused. An allowed seat
 * holds a lease in memory until the child,
 * the root or an ancestor is archived, the person revokes it, the workspace grant is revoked, the consent stops, or a
 * later review refuses or finds the root, workspace, run folder or agent changed. While the lease holds, no card is
 * shown again; each seat turn is reviewed without a card.
 *
 * @module @delorun/plugin-delegation-consent/service
 */
import { sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { CLAUDE_SANDBOX_INSTALL_COMMAND } from '@deepseek-ai/dsh-subagent'
import type {
  DelegationConsentService, ExternalDelegationReview, ExternalDelegationVerdict, SubagentSafetyLevel,
} from '@deepseek-ai/dsh-subagent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ProgramRunRule, SeatAllowReason, SeatConsent, SeatLease, SeatLeaseEnd, SeatReview, SeatVerdict,
} from '@delorun/external-agents/contract'
import { resolveDelorunHome, workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem } from '@delorun/home'
import { NO_WORKSPACE, workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import {
  agentName, archivedRefusal, askText, askTextZh, describeAgent, leaseEndedRefusal, noOpenTurnRefusal, noSandboxPolicyRefusal,
  notApprovedRefusal, noWorkspaceRefusal, outsideRefusal, readOnlyRefusal, storeRefusal,
  type NotApprovedOutcome,
} from './copy.ts'
import { SeatLeases } from './leases.ts'
import { changeGrantStore, grantOf, grantStorePath, problemOf, readGrantStore, withGrant, withoutGrant, type ExternalAgentGrant } from './store.ts'
import {
  AGENT_LEVEL_FIELDS, type AgentLevel, type AgentLevelView, type AllowWorkspaceAnswer, type AllowWorkspaceRequest, type DelegationRefusalCode,
  type GrantsAnswer, type GrantView, type LevelsAnswer, type RevokeAnswer, type RevokeRequest,
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
  /** The run time limit an allowed start carries, in milliseconds, read at each review. */
  readonly timeoutMs: () => number
  /** Whether a Full access root chat starts a live agent with no card (the consent's `fullAccessStartsAgents`), read at each review. */
  readonly fullAccessStartsAgents: () => boolean
  /** The environment the Delorun home is resolved from. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The clock a new grant records. */
  readonly now: () => number
  /** The level saved for a provider, read at each start and each listing so a saved change applies from the next run. */
  readonly levelOf: (provider: keyof typeof AGENT_LEVEL_FIELDS) => AgentLevel
  /** The tools Claude Code's command sandbox lacks on this computer, none when it can run. */
  readonly missingSandboxTools: () => readonly string[]
}

/**
 * Whether a directory is a workspace or inside it. A filesystem root, which Delorun never adds as a workspace, contains
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

/** The facts the shared rules read. */
interface RuleFacts {
  /** The provider the start selects. */
  readonly provider: string
  /** Every Session whose read-only mode refuses the start. */
  readonly readOnlyOf: readonly Session[]
  /** The Session whose folder is the workspace. */
  readonly workspaceOf: Session
  /** The run folder. */
  readonly cwd: string
}

/** How the shared rules ended: a refusal, or the workspace and whether a grant allows the start there. */
type RuleOutcome =
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'pass'; readonly workspace: string; readonly cwd: string; readonly granted: boolean }

/** The `delegationConsent` service of Delorun's external-agent consent. */
export class DelorunDelegationConsent extends Service implements DelegationConsentService, SeatConsent {
  private readonly options: ConsentOptions
  private readonly leases: SeatLeases

  constructor(ctx: Context, options: ConsentOptions) {
    super(ctx, 'delegationConsent')
    this.options = options
    this.leases = new SeatLeases((error) => { ctx.logger.error(`delegation-consent: a lease-end listener failed: ${problemOf(error)}`) })
    // The tables live in this service's memory: a stopped service ends every lease, so the gate stops their programs.
    ctx.effect(() => () => { this.leases.endWhere(() => true, 'consent-off') }, 'delegation consent: seat leases')
    ctx.on('workspace/session-archived', ({ sessionId }) => {
      this.leases.endWhere(lease => lease.child === sessionId || lease.root === sessionId, 'archived')
    })
  }

  describe(provider: string): string {
    return describeAgent(provider)
  }

  /**
   * The level a provider runs at: the saved level of Claude Code or Codex, and `careful`, the strictest, for a provider
   * registered under any other name, which has no level setting of its own.
   * @param provider - the provider's registered name.
   * @returns the level.
   */
  permissionLevel(provider: string): SubagentSafetyLevel {
    return Object.hasOwn(AGENT_LEVEL_FIELDS, provider) ? this.options.levelOf(provider as keyof typeof AGENT_LEVEL_FIELDS) : 'careful'
  }

  /**
   * Each external agent's level and, for Claude Code at a level that confines commands, what its sandbox lacks.
   * @returns the agents, Claude Code first.
   */
  levels(): LevelsAnswer {
    const missing = this.options.missingSandboxTools()
    const view = (provider: keyof typeof AGENT_LEVEL_FIELDS): AgentLevelView => {
      const level = this.options.levelOf(provider)
      const confines = provider === 'claude-code' && (level === 'careful' || level === 'standard')
      return {
        provider, agent: agentName(provider), level,
        ...confines && missing.length > 0 ? { sandboxMissing: { tools: missing, installCommand: CLAUDE_SANDBOX_INSTALL_COMMAND } } : {},
      }
    }
    return { levels: [view('claude-code'), view('codex')] }
  }

  async review(review: ExternalDelegationReview): Promise<ExternalDelegationVerdict> {
    const { provider, parent } = review
    const session = parent.session
    const rules = await this.rules({ provider, readOnlyOf: [session], workspaceOf: session, cwd: review.cwd })
    if (rules.kind === 'refuse') return rules
    const limited = await this.limitRefusal(provider)
    if (limited !== undefined) return { kind: 'refuse', reason: limited }
    const allowed = { kind: 'allow', timeoutMs: this.options.timeoutMs() } as const
    if (rules.granted) return allowed
    const approval = this.ctx.get('approval')
    const sandbox = this.ctx.get('sandboxPolicy')
    if (approval !== undefined && sandbox !== undefined && this.options.fullAccessStartsAgents() && this.rootIsFullAccess(parent, approval, sandbox)) return allowed
    const outcome = await this.ask(parent, { provider, workspace: rules.workspace, cwd: rules.cwd, label: review.label, signal: review.signal })
    return outcome === 'allowed-once' ? allowed : { kind: 'refuse', reason: notApprovedRefusal(provider, outcome, rules.workspace) }
  }

  async reviewSeat(review: SeatReview): Promise<SeatVerdict> {
    const verdict = await this.decideSeat(review)
    if (verdict.kind === 'refuse') this.leases.end(review.child.id, 'refused')
    return verdict
  }

  leaseOf(child: SessionId): SeatLease | undefined {
    return this.leases.leaseOf(child)
  }

  endLease(child: SessionId, reason: SeatLeaseEnd): void {
    this.leases.end(child, reason)
  }

  onLeaseEnded(listener: (lease: SeatLease, reason: SeatLeaseEnd) => void): () => void {
    return this.leases.listen(listener)
  }

  runRules(child: SessionId): readonly ProgramRunRule[] {
    return this.leases.rulesOf(child)
  }

  addRunRule(child: SessionId, rule: ProgramRunRule): boolean {
    return this.leases.addRule(child, rule)
  }

  /**
   * The start gate's refusal while the agent's plan limit is reached, for Claude Code and Codex.
   * @param provider - the provider the start selects.
   * @returns the sentence, or undefined without the gate, for another provider, or when nothing is reached.
   */
  private async limitRefusal(provider: string): Promise<string | undefined> {
    const gate = this.ctx.get('externalAgents')
    if (gate === undefined || (provider !== 'claude-code' && provider !== 'codex')) return undefined
    return gate.limitRefusal(provider)
  }

  /**
   * The rules every review runs first, in order: no sandbox policy, read-only, no workspace, a run folder outside it,
   * an unreadable grants file; then whether a grant allows the start.
   * @param facts - the Sessions and folder to check.
   * @returns a refusal, or the workspace and whether a grant allows the start.
   */
  private async rules(facts: RuleFacts): Promise<RuleOutcome> {
    const { provider } = facts
    const sandbox = this.ctx.get('sandboxPolicy')
    if (sandbox === undefined) return { kind: 'refuse', reason: noSandboxPolicyRefusal(provider) }
    if (facts.readOnlyOf.some(session => sandbox.resolve({ session }).mode === 'read-only')) return { kind: 'refuse', reason: readOnlyRefusal(provider) }
    const workspace = workspaceKey(facts.workspaceOf.header.cwd ?? '')
    if (workspace === NO_WORKSPACE) return { kind: 'refuse', reason: noWorkspaceRefusal(provider) }
    const cwd = workspaceKey(facts.cwd)
    if (!inside(workspace, cwd)) return { kind: 'refuse', reason: outsideRefusal(provider, workspace, facts.cwd) }
    const read = await readGrantStore(await this.storePath())
    if (read.kind === 'refused') return { kind: 'refuse', reason: storeRefusal(provider, read.problem) }
    return { kind: 'pass', workspace, cwd, granted: grantOf(read.grants, workspace, provider) !== undefined }
  }

  /**
   * Ask the person through the approval service on one chat's open turn.
   * @param agent - the chat the card belongs to.
   * @param facts - what the card names.
   * @returns the outcome; `never` for a refusal the chat's policy gave without asking, `no-approval` without a service.
   */
  private async ask(agent: Agent, facts: { readonly provider: string, readonly workspace: string, readonly cwd: string, readonly label?: string | undefined, readonly signal: AbortSignal }): Promise<'allowed-once' | NotApprovedOutcome> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) return 'no-approval'
    const ask = { provider: facts.provider, workspace: facts.workspace, cwd: facts.cwd, label: facts.label }
    // The approval service answers `rejected` without asking anyone while the chat's policy is `never`.
    const policy = approval.overrideOf(agent.session) ?? approval.config.policy
    const outcome = await approval.request({
      agent,
      toolName: facts.provider,
      reason: askText(ask),
      displayReason: { en: askText(ask), zh: askTextZh(ask) },
      grants: 'external-agent',
      signal: facts.signal,
    })
    return outcome === 'rejected' && policy === 'never' ? 'never' : outcome
  }

  /**
   * Decide one seat review: the shared rules on the root and the creator, archived chats, the lease, the grant, the
   * root's policy, then a card at hand-off or resume.
   * @param review - the facts of the review.
   * @returns the verdict.
   */
  private async decideSeat(review: SeatReview): Promise<SeatVerdict> {
    const { provider, root, child } = review
    const rules = await this.rules({ provider, readOnlyOf: [root.session, review.creator.session], workspaceOf: root.session, cwd: review.cwd })
    if (rules.kind === 'refuse') return rules
    if (this.archivedAbove(child, root)) return { kind: 'refuse', reason: archivedRefusal(provider) }
    const allowed = (why: SeatAllowReason): SeatVerdict => ({ kind: 'allow', timeoutMs: this.options.timeoutMs(), why })
    const listed = this.workspaceListed(rules.workspace)
    const lease = this.leases.leaseOf(child.id)
    if (lease !== undefined) {
      const same = lease.root === root.id && lease.workspace === rules.workspace && lease.cwd === rules.cwd && lease.provider === provider
      const stillFullAccess = lease.why !== 'full-access' || this.fullAccessRoot(root)
      if (same && stillFullAccess && (!lease.workspaceListed || listed !== false)) return allowed('lease')
      this.leases.end(child.id, 'refused')
    }
    const record = (why: Exclude<SeatAllowReason, 'lease'>): SeatVerdict => {
      this.leases.record({
        child: child.id, root: root.id, workspace: rules.workspace, cwd: rules.cwd, provider, workspaceListed: listed === true, grantedAt: this.options.now(),
        why,
      })
      return allowed(why)
    }
    if (rules.granted) return record('granted')
    if (review.phase === 'turn') return { kind: 'refuse', reason: leaseEndedRefusal(provider) }
    const approval = this.ctx.get('approval')
    if (approval === undefined) return { kind: 'refuse', reason: notApprovedRefusal(provider, 'no-approval', rules.workspace) }
    if ((approval.overrideOf(root.session) ?? approval.config.policy) === 'never') {
      // Full access starts the seat with no card and no grant (owner, EA28, EA33); any other `never` chat refuses (D10).
      if (this.fullAccessRoot(root)) return record('full-access')
      return { kind: 'refuse', reason: notApprovedRefusal(provider, 'never', rules.workspace) }
    }
    const asked = this.hasOpenTurn(root) ? root : review.phase === 'resume' ? child : undefined
    if (asked === undefined) return { kind: 'refuse', reason: noOpenTurnRefusal(provider, rules.workspace) }
    const outcome = await this.ask(asked, { provider, workspace: rules.workspace, cwd: rules.cwd, label: review.label, signal: review.signal })
    return outcome === 'allowed-once' ? record('asked') : { kind: 'refuse', reason: notApprovedRefusal(provider, outcome, rules.workspace) }
  }

  /**
   * Whether a root chat is Full access (lead decision 10): its approval policy is `never`, its sandbox runs
   * `danger-full-access`, and the consent's `fullAccessStartsAgents` is on.
   * @param root - the root chat.
   * @returns true for Full access.
   */
  private fullAccessRoot(root: Agent): boolean {
    if (!this.options.fullAccessStartsAgents()) return false
    const approval = this.ctx.get('approval')
    if (approval === undefined || (approval.overrideOf(root.session) ?? approval.config.policy) !== 'never') return false
    return this.ctx.get('sandboxPolicy')?.resolve({ session: root.session }).mode === 'danger-full-access'
  }

  /**
   * Whether a chat has a turn open, so a card can be shown in it.
   * @param agent - the chat.
   * @returns true while a turn is open.
   */
  private hasOpenTurn(agent: Agent): boolean {
    return this.ctx.get('agents')?.turnBoundaryOf(agent.session).openTurnStartSeq != null
  }

  /**
   * Whether the child, the root or a creator between them is archived. Archiving a chat names only that chat, so a
   * chat between the root and the child is found here, at the next review.
   * @param child - the seat child.
   * @param root - the root chat.
   * @returns true when any of them is archived.
   */
  private archivedAbove(child: Agent, root: Agent): boolean {
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds
    if (archived === undefined) return false
    const seen = new Set<SessionId>([child.id, root.id])
    let header = child.session.header
    while (header.origin === 'subagent' && header.parentSession !== undefined && !seen.has(header.parentSession)) {
      seen.add(header.parentSession)
      const parent = this.ctx.get('agents')?.get(header.parentSession)
      if (parent === undefined) break
      header = parent.session.header
    }
    return [...seen].some(id => archived.includes(id))
  }

  /**
   * Whether a workspace is in Delorun's workspace list.
   * @param workspace - the workspace key.
   * @returns whether it is listed, or undefined without a workspace registry or before its state is read.
   */
  private workspaceListed(workspace: string): boolean | undefined {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    let paths: readonly string[]
    try {
      paths = registry.list().map(entry => entry.path)
    } catch (_unread) {
      // The registry throws until its state is read; whether the workspace is listed is then unknown.
      return undefined
    }
    return paths.includes(workspace)
  }

  /**
   * Whether the top-level chat that this start descends from is in Full access: its own logged approval policy is
   * `never` and its own sandbox mode is `danger-full-access`, together. A local subagent is always pinned to `never`
   * and inherits its parent's sandbox, so a child's values never count; an ancestor that cannot be found counts as not
   * Full access.
   * @param parent - the agent calling the delegation tool.
   * @param approval - the composed approval service.
   * @param sandbox - the composed sandbox policy.
   * @returns true when the root chat is in Full access.
   */
  private rootIsFullAccess(parent: Agent, approval: ApprovalService, sandbox: SandboxPolicyService): boolean {
    const agents = this.ctx.get('agents')
    const visited = new Set<SessionId>([parent.id])
    let root = parent
    while (root.session.header.origin === 'subagent') {
      const next = root.session.header.parentSession
      if (next === undefined || visited.has(next)) return false
      visited.add(next)
      const ancestor = agents?.get(next)
      if (ancestor === undefined) return false
      root = ancestor
    }
    const policy = approval.overrideOf(root.session) ?? approval.config.policy
    return policy === 'never' && sandbox.resolve({ session: root.session }).mode === 'danger-full-access'
  }

  /**
   * Every recorded grant, for the External agents section.
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
    const home = (await resolveDelorunHome(this.options.env)).path
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
    this.leases.endWhere(lease => lease.workspace === request.workspace && lease.provider === request.provider, 'grant-revoked')
    this.ctx.logger.info(`external agent ${request.provider} revoked for a workspace`)
    return { revoked }
  }

  /** The grants file of the home this process runs with. */
  private async storePath(): Promise<string> {
    return grantStorePath((await resolveDelorunHome(this.options.env)).path)
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
