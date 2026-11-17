/**
 * The seat relay: a program's permission questions reach the person through the approval service on the seat child.
 * It lifts the child's delegation pin for seats only, holds each question until the seat recorded the call, asks with
 * the `external-agent` marker, and tells the gate when the person chose "Allow for this run".
 * @module @delorun/plugin-agent-seats/relay/relay
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { appendPluginRecord, type SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy, type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramRunRule, SeatConsent } from '@delorun/external-agents/contract'
import { programSays } from './copy.ts'
import { SEAT_RUN_ALLOWED_RECORD } from '../state/record.ts'
import { RunScope, RUN_SCOPE } from './run-scope.ts'

/** The marker every relayed question carries, so only the computer or an unlocked page may allow it (D1). */
export const EXTERNAL_AGENT_GRANT = 'external-agent'

/** What the relay needs from the seat lane. */
export interface SeatRelayOptions {
  /**
   * The exact `subagent/descriptor` provider names of the seat providers (`claude-code-seat`, `codex-seat`), fixed at
   * mount; a seat is a Session the gate knows that also carries one (D13).
   */
  readonly seatProviders: ReadonlySet<string>
  /**
   * Read the child's descriptor provider.
   * @param child - a candidate seat child.
   * @returns the provider name, or undefined without a descriptor.
   */
  descriptorOf(child: Agent): string | undefined
  /**
   * Resolve once the seat wrote the call's `tool-call` record (L36).
   * @param child - the seat child.
   * @param callId - the program's call id.
   * @param signal - aborts the wait.
   */
  recorded(child: Agent, callId: string, signal: AbortSignal): Promise<void>
  /**
   * The name a person knows the seat's agent by, which the card puts before the program's own words.
   * @param child - the seat child.
   * @returns the product name, such as `Claude Code`.
   */
  agentName(child: Agent): string
  /**
   * The name the seat's record gives the program's tool, shown on the card.
   * @param child - the seat child.
   * @param toolName - the program's own tool name.
   * @returns the record's tool name.
   */
  recordName(child: Agent, toolName: string): string
}

/** The program's answer, with the `approval/asked` event of the question when it was asked. */
interface Asked {
  readonly answer: ProgramApprovalAnswer
  readonly askedSeq?: SessionSeq | undefined
}

/** Why a Session is not served by the relay. */
export type PrepareResult = 'lifted' | 'not-a-seat'

interface Pending {
  readonly controller: AbortController
  /** Settles once the question's decision is logged and released. */
  readonly settled: Promise<void>
  readonly finish: () => void
}

/** The relay for all seats of one home. */
export class SeatRelay {
  private readonly pending = new Map<SessionId, Set<Pending>>()
  /** The signal of each seat child's current turn, which Stop aborts; cleared when the turn ends. */
  private readonly turnSignals = new Map<SessionId, AbortSignal>()
  private readonly listeners = new Set<(child: SessionId, waiting: boolean) => void>()

  /**
   * @param ctx - the plugin's context.
   * @param options - what the seat lane supplies.
   * @param scope - the run-scope listener's state; a spec passes one that mounts nothing.
   */
  constructor(private readonly ctx: Context, private readonly options: SeatRelayOptions, private readonly scope = new RunScope()) {
    ctx.effect(() => this.scope.mount(ctx), 'agent seats: the relay\'s approval listener')
    // Prepended: an earlier listener that decides the step without `next()` must not hide the turn's signal from the relay.
    ctx.on('agent/pre-step', (payload, next) => {
      if (this.isSeat(payload.agent)) this.turnSignals.set(payload.agent.id, payload.signal)
      return next()
    }, { prepend: true })
    // The stop boundary comes before `turn/end` is written, so the cancelled decision lands inside the turn.
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      const entries = [...this.pending.get(agent.id) ?? []]
      this.abortAll(agent.id)
      await Promise.all(entries.map(entry => entry.settled))
    })
    // Backstop for a turn that ended without a stop boundary: its question can no longer be decided in the turn.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.turnSignals.delete(session.id)
      if (event.type !== 'turn/end' || !this.pendingOf(session.id)) return
      ctx.logger('agent-seats').warn('a seat turn ended with a question pending; it is cancelled')
      this.abortAll(session.id)
    })
    ctx.effect(() => () => { for (const child of [...this.pending.keys()]) this.abortAll(child) }, 'agent seats: the relay\'s pending questions')
  }

  /**
   * Whether a Session is a seat: the gate holds it and its descriptor names the seat provider (D13). A policy value
   * is never consulted.
   * @param child - a candidate.
   * @returns true for a seat child.
   */
  isSeat(child: Agent): boolean {
    return this.ctx.get('externalAgents')?.seat(child.id) !== undefined && this.options.seatProviders.has(this.options.descriptorOf(child) ?? '')
  }

  /**
   * Lift the delegation pin of a seat child: a later `approval/policy: ask` event after the pin. Whether the root is
   * in Full access is decided at each question, so a switch of the root's policy during a run applies at once.
   * A fork, a child of a seat and any other child keep their pin.
   * @param child - the freshly created child.
   * @returns whether the pin was lifted.
   */
  prepareChild(child: Agent): PrepareResult {
    if (!this.isSeat(child)) return 'not-a-seat'
    setApprovalPolicy(child.session, 'ask')
    return 'lifted'
  }

  /**
   * Lift the delegation pin of a seat child at most once. The lease that makes a Session a seat is granted when the
   * program starts, after the child was created, so the lift happens when its first question arrives. The pin is
   * lifted only while it is still the latest `approval/policy` event: a lift already logged, or a later switch of the
   * child's own policy, stays as it is, and a restarted Host does not append a second one.
   * @param child - the child whose program asks.
   * @returns `lifted`, `kept` when the log holds no pin to lift, or `not-a-seat`.
   */
  liftOnce(child: Agent): PrepareResult | 'kept' {
    if (!this.isSeat(child)) return 'not-a-seat'
    const events = child.session.snapshotEvents()
    const latest = events.findLast(event => event.type === 'approval/policy')
    if (latest?.type !== 'approval/policy' || latest.data.source !== 'delegation') return 'kept'
    return this.prepareChild(child)
  }

  /**
   * Whether a seat child has a question waiting for the person.
   * @param child - the seat child.
   * @returns true while one is pending.
   */
  pendingOf(child: SessionId): boolean {
    return (this.pending.get(child)?.size ?? 0) > 0
  }

  /**
   * Hear when a seat child starts or stops waiting.
   * @param listener - called with the child and whether it now waits.
   * @returns the disposer.
   */
  onPendingChange(listener: (child: SessionId, waiting: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The driver's `onApproval` for one seat child.
   * @param child - the seat child.
   * @param startSignal - the seat start's signal; stop and archive abort it.
   * @returns the callback for `SeatStartRequest.onApproval`.
   */
  onApproval(child: Agent, startSignal: AbortSignal): (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer> {
    return async (request) => {
      const { answer, askedSeq } = await this.ask(child, startSignal, request)
      if (answer === 'allow-run' && request.runRule !== undefined && askedSeq !== undefined) {
        this.logWhenKept(child, request.runRule, askedSeq)
      }
      return answer
    }
  }

  /**
   * Log "Allow for this run" once the gate kept the rule. The gate calls `addRunRule` after the answer is returned
   * and falls back to allow once when the lease is gone, so the log is written a macrotask later, from the rule list.
   * @param child - the seat child.
   * @param rule - the rule the question offered.
   * @param askedSeq - the question's `approval/asked` event.
   */
  private logWhenKept(child: Agent, rule: ProgramRunRule, askedSeq: SessionSeq): void {
    setImmediate(() => {
      try {
        const consent: unknown = this.ctx.get('delegationConsent')
        if (!keepsRunRules(consent) || !consent.runRules(child.id).includes(rule)) return
        appendPluginRecord(child.session, SEAT_RUN_ALLOWED_RECORD, { askedSeq })
      } catch (error) {
        this.ctx.logger('agent-seats').warn('the run allowance could not be logged: %s', error instanceof Error ? error.message : String(error))
      }
    })
  }

  private async ask(child: Agent, startSignal: AbortSignal, request: ProgramApprovalRequest): Promise<Asked> {
    if (!this.isSeat(child)) return { answer: 'reject' }
    const approval = this.ctx.get('approval')
    if (approval === undefined) return { answer: 'reject' }
    let finish: () => void = () => {}
    const settled = new Promise<void>((resolve) => { finish = resolve })
    const entry: Pending = { controller: new AbortController(), settled, finish }
    // Stop and an error abort the turn's own signal and write `turn/end` without a stop boundary, so the question
    // must settle on that signal while the step is still awaited.
    const turnSignal = this.turnSignals.get(child.id)
    const signal = AbortSignal.any([request.signal, startSignal, entry.controller.signal, ...turnSignal === undefined ? [] : [turnSignal]])
    this.hold(child.id, entry)
    try {
      await untilOrAborted(this.options.recorded(child, request.callId, signal), signal)
      if (signal.aborted) return { answer: 'cancel' }
      // The hold can outlast the seat or the turn.
      if (!this.isSeat(child)) return { answer: 'cancel' }
      if (this.ctx.get('agents')?.turnBoundaryOf(child.session).openTurnStartSeq === null) return { answer: 'cancel' }
      const toolName = this.options.recordName(child, request.toolName)
      const recordedAs = recordedNameOf(child, request.callId)
      if (recordedAs !== toolName) {
        // The card names the call by the record the person can read in the transcript; a record that says otherwise is not that call.
        this.ctx.logger('agent-seats').warn('a program question was rejected: call %s is recorded as %s, not %s', request.callId, recordedAs ?? 'nothing', toolName)
        return { answer: 'reject' }
      }
      const full = this.rootIsFullAccess(child)
      const says = programSays(this.options.agentName(child), request.reason)
      const built: ApprovalRequest = {
        agent: child,
        toolName,
        callId: ToolCallId(request.callId),
        reason: says.en,
        displayReason: says,
        grants: EXTERNAL_AGENT_GRANT,
        // A Full access root allows with no card, so it offers no run rule either.
        ...request.runRule !== undefined && full === undefined ? { runScope: RUN_SCOPE } : {},
        signal,
      }
      assertMarked(built)
      this.scope.adopt(built, full)
      const outcome = await approval.request(built)
      const answer = this.answerOf(outcome, built, request)
      return answer === 'allow-run' ? { answer, askedSeq: askedSeqOf(child, request.callId) } : { answer }
    } catch (error) {
      if (signal.aborted) return { answer: 'cancel' }
      this.ctx.logger('agent-seats').warn('a program question could not be asked: %s', error instanceof Error ? error.message : String(error))
      return { answer: 'reject' }
    } finally {
      this.release(child.id, entry)
      entry.finish()
    }
  }

  private answerOf(outcome: ApprovalOutcome, built: ApprovalRequest, request: ProgramApprovalRequest): ProgramApprovalAnswer {
    switch (outcome) {
      case 'allowed-once':
        return this.scope.take(built) && request.runRule !== undefined ? 'allow-run' : 'allow-once'
      case 'cancelled': return 'cancel'
      case 'rejected':
      case 'unavailable': return 'reject'
      default: return assertNever(outcome)
    }
  }

  /**
   * The decision a Full access root makes without a card: allowed, or rejected while the owner's consent switch
   * `fullAccessStartsAgents` is off (EA33).
   * @param child - the seat child.
   * @returns the decision, or undefined when the root is not in Full access.
   */
  private rootIsFullAccess(child: Agent): 'allowed-once' | 'rejected' | undefined {
    const root = this.ctx.get('externalAgents')?.seat(child.id)?.root
    const rootAgent = root === undefined ? undefined : this.ctx.get('agents')?.get(root)
    const approval = this.ctx.get('approval')
    if (rootAgent === undefined || approval === undefined) return undefined
    if ((approval.overrideOf(rootAgent.session) ?? approval.config.policy) !== 'never') return undefined
    // Full access is a `never` policy on the `danger-full-access` sandbox together; `never` alone only refuses.
    const sandbox = this.ctx.get('sandboxPolicy')?.resolve({ session: rootAgent.session }).mode
    return sandbox === 'danger-full-access' && this.fullAccessStartsAgents() ? 'allowed-once' : 'rejected'
  }

  /**
   * The consent service's switch `fullAccessStartsAgents`. A consent service without the switch (it arrives with
   * EA33) fails closed: Full access questions are then rejected.
   * @returns whether a Full access chat's agents may act without asking.
   */
  private fullAccessStartsAgents(): boolean {
    const consent = this.ctx.get('delegationConsent')
    const read: unknown = consent === undefined ? undefined : Reflect.get(consent, 'fullAccessStartsAgents')
    return typeof read === 'function' && read.call(consent) === true
  }

  private hold(child: SessionId, entry: Pending): void {
    const set = this.pending.get(child) ?? new Set<Pending>()
    set.add(entry)
    this.pending.set(child, set)
    if (set.size === 1) for (const listener of this.listeners) listener(child, true)
  }

  private release(child: SessionId, entry: Pending): void {
    const set = this.pending.get(child)
    if (set === undefined || !set.delete(entry)) return
    if (set.size > 0) return
    this.pending.delete(child)
    for (const listener of this.listeners) listener(child, false)
  }

  private abortAll(child: SessionId): void {
    for (const entry of this.pending.get(child) ?? []) entry.controller.abort(new Error('the seat turn ended'))
  }
}

/**
 * The consent service's run rules, which a seat-aware consent has.
 * @param consent - whatever the service provides.
 * @returns true for a consent that lists the rules kept for a child.
 */
function keepsRunRules(consent: unknown): consent is Pick<SeatConsent, 'runRules'> {
  return typeof consent === 'object' && consent !== null && typeof Reflect.get(consent, 'runRules') === 'function'
}

/**
 * The tool name the seat's record gives a call.
 * @param child - the seat child.
 * @param callId - the program's call id.
 * @returns the name, or undefined when the log holds no record of the call.
 */
function recordedNameOf(child: Agent, callId: string): string | undefined {
  const call = child.session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === callId)
  return call?.type === 'tool/call' ? call.data.name : undefined
}

/**
 * The `approval/asked` event of a call's latest question.
 * @param child - the seat child.
 * @param callId - the question's call.
 * @returns its sequence number, or undefined when the log holds none.
 */
function askedSeqOf(child: Agent, callId: string): SessionSeq | undefined {
  return child.session.snapshotEvents().findLast(event => event.type === 'approval/asked' && event.data.callId === callId)?.seq
}

/**
 * Wait for a promise, or for the signal to abort, whichever comes first.
 * @param work - the work awaited.
 * @param signal - ends the wait.
 */
async function untilOrAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  let onAbort: () => void = () => {}
  const aborted = new Promise<void>((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }) })
  try {
    await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Refuse to send a question without the marker (D1).
 * @param request - the request about to be sent.
 */
export function assertMarked(request: ApprovalRequest): void {
  if (request.grants !== EXTERNAL_AGENT_GRANT) throw new Error('a seat question must carry the external-agent grant marker')
}

/**
 * @param value - the value that cannot occur.
 * @throws always.
 */
function assertNever(value: never): never {
  throw new Error(`unexpected approval outcome: ${String(value)}`)
}
