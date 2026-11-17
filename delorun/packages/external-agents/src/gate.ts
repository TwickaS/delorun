/**
 * The start gate (`ctx.externalAgents`): the only code that starts an external agent's program (T1). A seat start
 * runs, in order, the consent (review D6, D10), the limit, the capacity, then the driver's open with a spawn bound to
 * this program. The gate keeps one program per seat child, ends it when the child's Agent is disposed, its lease ends,
 * its driver leaves, or this plugin stops, and bounds each seat turn by the consent's time limit: interrupt, wait the
 * grace period, then end the program. While a program runs, the identity of each of its processes that leads a process
 * group is kept in the home's program records, and at the next start the gate stops what a dead Host left (review D15).
 * @module @delorun/external-agents/gate
 */
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { findDelegationConsent } from '@deepseek-ai/dsh-subagent'
import { SENSITIVE_ENV_PATTERN, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  DELEGATION_CONSENT_ROW_ID, GateRefusedError, type AccountObservation, type ExternalAgentDriver, type ExternalAgentName,
  type ExternalAgentsGate, type ProgramApprovalAnswer, type ProgramApprovalRequest, type ProgramEvent,
  type ProgramInterruptOutcome, type ProgramSession, type ProgramSpawn, type ProgramSpawnRequest, type SeatConsent, type SeatSession,
  type SeatRecord, type SeatReviewPhase, type SeatStartRequest,
} from './contract.ts'
import { consentMissingRefusal, consentRowDisabledRefusal, limitRefusal, noRootRefusal } from './copy.ts'
import { ProgramRecords, systemProcessTable, type ProcessTable } from './reap.ts'

/** What the gate needs beyond its context. */
export interface GateOptions {
  /** How many programs may run at once, seats and limits checks together. */
  readonly maxLivePrograms: number
  /** How long a program gets to stop after it is asked, in milliseconds. */
  readonly graceMs: number
  /** Whether a reached limit refuses a seat start (C16 switch `external_agent_limit_refusal`, off in parity). */
  readonly limitRefusal: boolean
  /** The environment whose `DELORUN_*` names every spawn removes. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The clock limits are compared with. */
  readonly now: () => number
  /** Make an empty folder for one limits check; the gate removes it afterwards. */
  readonly probeFolder: () => Promise<string>
  /** The path of the home's program records; absent, nothing is recorded or reaped. */
  readonly programRecords: (() => Promise<string>) | undefined
  /** The process table the records read; absent, the computer's own. */
  readonly processTable: ProcessTable | undefined
}

/** The consent for one seat start: none composed by the person's choice, or the service that reviews it. */
type ConsentMode = { readonly kind: 'off' } | { readonly kind: 'reviewed'; readonly consent: SeatConsent }

/** One program the gate holds. */
interface Live {
  readonly provider: ExternalAgentName
  /** The seat, absent for a limits check. */
  readonly seat?: SeatRecord
  /** Whether the consent reviewed the start; a program started unreviewed stops once the consent appears. */
  readonly reviewed: boolean
  /** Aborts every process of the program. */
  readonly controller: AbortController
  /** The program's processes. */
  readonly handles: Set<SubprocessHandle>
  /** The open session, once the driver opened it. */
  session?: ProgramSession
  /** Settles when the program has ended. */
  ending?: Promise<void>
}

/**
 * Credential and ambient-authority names a driver's overlay may not set, beyond upstream's `SENSITIVE_ENV_PATTERN`: the
 * names the subprocess owner's scrub drops from the Host's own environment, which an explicit overlay would bypass.
 */
const CREDENTIAL_NAME = /^(?:SSH_AUTH_SOCK|DOCKER_HOST|KUBECONFIG|KRB5CCNAME|MYSQL_PWD|(?:AWS|AZURE|SLACK|DISCORD)_.*|.*_CREDENTIALS|.*_WEBHOOK.*|.*PASSPHRASE.*|.*_PASSWD)$/iu

/**
 * The environment overlay a spawn gets: the driver's entries, then `NODE_OPTIONS`, every `DELORUN_*` name (review
 * D16) and every credential-named entry of the overlay removed, so a program signs in only with its own login files.
 * @param overlay - the driver's entries.
 * @param env - the Host's environment.
 * @returns the overlay with the removals.
 */
export function spawnEnvironment(overlay: NodeJS.ProcessEnv | undefined, env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...overlay, NODE_OPTIONS: undefined }
  for (const name of [...Object.keys(env), ...Object.keys(overlay ?? {})]) {
    if (name.toUpperCase().startsWith('DELORUN_')) result[name] = undefined
  }
  for (const name of Object.keys(overlay ?? {})) {
    if (SENSITIVE_ENV_PATTERN.test(name) || CREDENTIAL_NAME.test(name)) result[name] = undefined
  }
  return result
}

/** The start gate. */
export class ExternalAgentsService extends Service implements ExternalAgentsGate {
  private readonly options: GateOptions
  private readonly drivers = new Map<ExternalAgentName, ExternalAgentDriver>()
  private readonly registered = new Set<(provider: ExternalAgentName) => void>()
  private readonly live = new Set<Live>()
  private readonly seats = new Map<SessionId, Live>()
  /** The program records, once their path is known; undefined when they are off or their path failed. */
  private readonly records: Promise<ProgramRecords | undefined>

  constructor(ctx: Context, options: GateOptions) {
    super(ctx, 'externalAgents')
    this.options = options
    this.records = this.openRecords()
    ctx.effect(() => () => this.endAll(), 'external agents: end every program')
    ctx.on('agent/disposed', ({ agent }) => { this.endSeat(agent.id) })
    ctx.inject(['delegationConsent'], (scope) => {
      const consent = scope.delegationConsent
      if (!isSeatConsent(consent)) return
      // A program started while the consent was off stops once a consent appears (review D11).
      for (const live of [...this.live]) if (live.seat !== undefined && !live.reviewed) void this.end(live)
      scope.effect(() => consent.onLeaseEnded(lease => this.endSeat(lease.child)), 'external agents: lease ends stop programs')
    })
  }

  registerDriver(driver: ExternalAgentDriver): () => void {
    if (this.drivers.has(driver.provider)) throw new Error(`a driver for ${driver.provider} is already registered`)
    this.drivers.set(driver.provider, driver)
    for (const listener of [...this.registered]) {
      try {
        listener(driver.provider)
      } catch (error) {
        this.ctx.logger.error(`external agents: a driver-registration listener failed: ${String(error)}`)
      }
    }
    return () => {
      if (this.drivers.get(driver.provider) !== driver) return
      this.drivers.delete(driver.provider)
      for (const live of [...this.live]) if (live.provider === driver.provider) void this.end(live)
    }
  }

  /**
   * Open the program records and stop what a dead Host left, before any program of this start is recorded.
   * @returns the records, or undefined when they are off or their path cannot be resolved.
   */
  private async openRecords(): Promise<ProgramRecords | undefined> {
    const { programRecords } = this.options
    if (programRecords === undefined) return undefined
    let path: string
    try {
      path = await programRecords()
    } catch (error) {
      this.ctx.logger.warn(`external agents: the program records cannot be found, so no program is recorded or reaped: ${String(error)}`)
      return undefined
    }
    const records = new ProgramRecords({
      path,
      table: this.options.processTable ?? systemProcessTable(process.platform, argv => this.runCommand(argv)),
      graceMs: this.options.graceMs,
      warn: message => this.ctx.logger.warn(message),
    })
    const reaped = await records.reap()
    for (const { record, outcome } of reaped) {
      if (outcome === 'stopped-group' || outcome === 'stopped-unit') {
        this.ctx.logger.warn(`external agents: stopped ${record.provider}'s process ${String(record.identity.pid)}, which a Host that ended left running`)
      }
    }
    return records
  }

  /**
   * Run a short command of the operating system (`ps`, `systemctl`) and read its output.
   * @param argv - the command.
   * @returns its standard output.
   * @throws Error when it exits other than 0.
   */
  private async runCommand(argv: readonly string[]): Promise<string> {
    const handle = this.ctx.subprocess.spawn({
      argv, cwd: tmpdir(), stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 4096 } }, graceMs: this.options.graceMs,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) throw new Error(`${argv[0] ?? 'command'} exited with ${String(outcome.exitCode ?? outcome.signal)}`)
    return handle.collected.stdout?.readFrom(0).text ?? ''
  }

  /**
   * Keep a process's identity in the program records while its managed range runs. A process the provider names no
   * leader for, such as on Windows, is not recorded.
   * @param provider - the agent.
   * @param handle - the process.
   */
  private track(provider: ExternalAgentName, handle: SubprocessHandle): void {
    const pid = handle.pid
    if (pid === undefined) return
    const recorded = this.records.then(async (records) => {
      const identity = await records?.started(provider, pid)
      return records === undefined || identity === undefined ? undefined : { records, identity }
    })
    // A range the provider can no longer observe keeps its record, so the next start checks it.
    handle.waitForExit().then(async () => {
      const entry = await recorded
      await entry?.records.ended(entry.identity)
    }, (error: unknown) => {
      this.ctx.logger.warn(`external agents: ${provider}'s process ${String(pid)} cannot be observed, so its record stays: ${String(error)}`)
    })
  }

  hasDriver(provider: ExternalAgentName): boolean {
    return this.drivers.has(provider)
  }

  onDriverRegistered(listener: (provider: ExternalAgentName) => void): () => void {
    this.registered.add(listener)
    return () => { this.registered.delete(listener) }
  }

  seat(child: SessionId): SeatRecord | undefined {
    const held = this.seats.get(child)?.seat
    if (held !== undefined) return held
    const consent = this.ctx.get('delegationConsent')
    const lease = isSeatConsent(consent) ? consent.leaseOf(child) : undefined
    return lease === undefined ? undefined : { child: lease.child, root: lease.root, provider: lease.provider }
  }

  async start(request: SeatStartRequest): Promise<SeatSession> {
    request.signal.throwIfAborted()
    const driver = this.drivers.get(request.provider)
    if (driver === undefined) throw new GateRefusedError({ category: 'not-installed' })
    if (this.seats.has(request.child)) throw new GateRefusedError({ category: 'seat-running' })
    const agents = this.seatAgents(request)
    const phase: SeatReviewPhase = request.resume === undefined ? 'hand-off' : 'resume'
    const mode = await this.consentMode(request.provider)
    let timeoutMs: number | undefined
    let allowedBy: SeatSession['allowedBy'] = 'consent-off'
    if (mode.kind === 'reviewed') {
      const verdict = await mode.consent.reviewSeat({
        provider: request.provider, ...agents, cwd: request.cwd, phase, signal: request.signal,
      })
      if (verdict.kind === 'refuse') throw new GateRefusedError({ category: 'consent', reason: verdict.reason })
      timeoutMs = verdict.timeoutMs
      allowedBy = verdict.why
    }
    await this.refuseReachedLimit(request.provider)
    // A second start for the child may have passed its own review while this one waited.
    if (this.seats.has(request.child)) throw new GateRefusedError({ category: 'seat-running' })
    const seat: SeatRecord = { child: request.child, root: agents.root.id, provider: request.provider }
    const live = this.admit({ provider: request.provider, seat, reviewed: mode.kind === 'reviewed', controller: new AbortController(), handles: new Set() })
    const onAbort = (): void => { void this.end(live) }
    request.signal.addEventListener('abort', onAbort, { once: true })
    live.controller.signal.addEventListener('abort', () => { request.signal.removeEventListener('abort', onAbort) }, { once: true })
    const consent = mode.kind === 'reviewed' ? mode.consent : undefined
    try {
      const session = await driver.open({
        sessionId: request.child,
        cwd: request.cwd,
        ...request.resume === undefined ? {} : { resume: request.resume },
        ...request.model === undefined ? {} : { model: request.model },
        runRules: consent?.runRules(request.child) ?? [],
        harnessTools: request.harnessTools,
        spawn: this.spawnFor(live, request.cwd),
        onApproval: approval => this.relayApproval(request, consent, approval),
        onLimits: observation => this.observe(observation),
        signal: live.controller.signal,
      })
      live.session = session
      if (live.controller.signal.aborted) throw new GateRefusedError({ category: 'seat-running' })
      return new GateSession(session, {
        provider: request.provider,
        allowedBy,
        timeoutMs,
        graceMs: this.options.graceMs,
        reviewTurn: consent === undefined ? undefined : () => this.reviewTurn(request, consent),
        end: () => this.end(live),
      })
    } catch (error) {
      await this.end(live)
      throw error
    }
  }

  async probe(provider: ExternalAgentName, signal: AbortSignal): Promise<AccountObservation> {
    signal.throwIfAborted()
    const driver = this.drivers.get(provider)
    if (driver === undefined) throw new GateRefusedError({ category: 'not-installed' })
    const folder = await this.options.probeFolder()
    const live = this.admit({ provider, reviewed: false, controller: new AbortController(), handles: new Set() })
    const onAbort = (): void => { live.controller.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await driver.probe({ spawn: this.spawnFor(live, folder), cwd: folder, signal: live.controller.signal })
    } finally {
      signal.removeEventListener('abort', onAbort)
      await this.end(live)
      await rm(folder, { recursive: true, force: true })
    }
  }

  /**
   * Find the seat's Agents: the child, its creator and the chat at the top of its tree.
   * @param request - the seat start.
   * @returns the three Agents.
   * @throws {GateRefusedError} `consent` when one is not running.
   */
  private seatAgents(request: SeatStartRequest): { readonly creator: Agent, readonly root: Agent, readonly child: Agent } {
    const agents = this.ctx.get('agents')
    const child = agents?.get(request.child)
    const creator = agents?.get(request.creator)
    const subagents = this.ctx.get('subagents')
    if (child === undefined || creator === undefined || subagents === undefined) {
      throw new GateRefusedError({ category: 'consent', reason: noRootRefusal(request.provider) })
    }
    let root: Agent
    try {
      root = subagents.rootOf(child)
    } catch (_ownerless) {
      // A child without a running owner has no root chat to review it in; the start is refused below.
      throw new GateRefusedError({ category: 'consent', reason: noRootRefusal(request.provider) })
    }
    return { creator, root, child }
  }

  /**
   * Tell "the person switched the consent off" from "the consent is missing": only a saved `enabled: false` on the
   * consent row starts a seat unreviewed (review D6, L12).
   * @param provider - the agent to start.
   * @returns the consent mode.
   * @throws {GateRefusedError} `consent` when the row is absent or disabled, or the service is missing, failed or
   *   cannot review a seat.
   */
  private async consentMode(provider: ExternalAgentName): Promise<ConsentMode> {
    const row = [...this.ctx.get('loader')?.entries() ?? []].find(entry => entry.options.id === DELEGATION_CONSENT_ROW_ID)
    if (row === undefined) throw new GateRefusedError({ category: 'consent', reason: consentMissingRefusal(provider) })
    let disabled: boolean
    try {
      disabled = row.disabled === true
    } catch (_failedExpression) {
      // A row whose `disabled` expression throws does not start, as upstream's lookup treats it.
      disabled = true
    }
    if (disabled) throw new GateRefusedError({ category: 'consent', reason: consentRowDisabledRefusal(provider) })
    const saved: unknown = row.options.config
    if (typeof saved === 'object' && saved !== null && Reflect.get(saved, 'enabled') === false) return { kind: 'off' }
    let consent: unknown
    try {
      consent = await findDelegationConsent(this.ctx, provider)
    } catch (_unavailable) {
      // `DELEGATION_CONSENT_UNAVAILABLE`: the row is not running, so nothing starts unreviewed.
      throw new GateRefusedError({ category: 'consent', reason: consentMissingRefusal(provider) })
    }
    if (!isSeatConsent(consent)) throw new GateRefusedError({ category: 'consent', reason: consentMissingRefusal(provider) })
    return { kind: 'reviewed', consent }
  }

  async limitRefusal(provider: ExternalAgentName): Promise<string | undefined> {
    const reached = await this.reachedLimit(provider)
    return reached === undefined ? undefined : limitRefusal({ provider, ...reached, now: this.options.now() })
  }

  /**
   * The reached limit that refuses a start now, while the switch is on; stale figures never refuse.
   * @param provider - the agent to start.
   * @returns the window and its reset time, or undefined.
   */
  private async reachedLimit(provider: ExternalAgentName): Promise<{ readonly window: string, readonly resetsAt: number } | undefined> {
    const accounts = this.ctx.get('agentAccounts')
    if (!this.options.limitRefusal || accounts === undefined) return undefined
    const now = this.options.now()
    const reached = accounts.reachedLimit(await accounts.read(provider), now)
    return reached !== undefined && reached.resetsAt > now ? { window: reached.window, resetsAt: reached.resetsAt } : undefined
  }

  /**
   * Refuse a start while a limit is reached.
   * @param provider - the agent to start.
   * @throws {GateRefusedError} `limit`.
   */
  private async refuseReachedLimit(provider: ExternalAgentName): Promise<void> {
    const reached = await this.reachedLimit(provider)
    if (reached !== undefined) throw new GateRefusedError({ category: 'limit', ...reached })
  }

  /**
   * Count a program against `maxLivePrograms` and hold it.
   * @param live - the program.
   * @returns the program.
   * @throws {GateRefusedError} `capacity` at the cap.
   */
  private admit(live: Live): Live {
    if (this.live.size >= this.options.maxLivePrograms) {
      throw new GateRefusedError({ category: 'capacity', busy: [...this.live].map(held => held.provider) })
    }
    this.live.add(live)
    if (live.seat !== undefined) this.seats.set(live.seat.child, live)
    return live
  }

  /**
   * The spawn one program's driver gets: the run folder, the grace period, the program's abort signal and the
   * environment removals are the gate's.
   * @param live - the program.
   * @param cwd - its folder.
   * @returns the spawn.
   */
  private spawnFor(live: Live, cwd: string): ProgramSpawn {
    return (request: ProgramSpawnRequest) => {
      if (live.controller.signal.aborted || !this.live.has(live)) throw new Error('the external agent\'s program has ended; nothing was started')
      const handle = this.ctx.subprocess.spawn({
        argv: request.argv,
        cwd,
        stdio: request.stdio,
        graceMs: this.options.graceMs,
        signal: live.controller.signal,
        env: spawnEnvironment(request.env, this.options.env),
      })
      live.handles.add(handle)
      this.track(live.provider, handle)
      const forget = (): void => { live.handles.delete(handle) }
      handle.done.then(forget, forget)
      return handle
    }
  }

  /**
   * Relay one program question to the seat, keeping an "Allow for this run" answer beside the lease.
   * @param request - the seat start.
   * @param consent - the reviewing consent, absent when it is off.
   * @param approval - the program's question.
   * @returns the answer the program gets.
   */
  private async relayApproval(request: SeatStartRequest, consent: SeatConsent | undefined, approval: ProgramApprovalRequest): Promise<ProgramApprovalAnswer> {
    // Without a lease nothing can keep a rule, so the card offers only Reject and Allow once.
    const canKeep = approval.runRule !== undefined && consent?.leaseOf(request.child) !== undefined
    const { runRule, ...rest } = approval
    const answer = await request.onApproval(canKeep ? approval : rest)
    if (answer !== 'allow-run') return answer
    return runRule !== undefined && canKeep && consent?.addRunRule(request.child, runRule) === true ? 'allow-run' : 'allow-once'
  }

  /**
   * Review one seat turn without a card.
   * @param request - the seat start.
   * @param consent - the reviewing consent.
   * @returns the refusal sentence, or undefined when the turn may run.
   */
  private async reviewTurn(request: SeatStartRequest, consent: SeatConsent): Promise<string | undefined> {
    // The consent that allowed the program was replaced (its switch turned off and on): the program needs a new review.
    const current: unknown = this.ctx.get('delegationConsent')
    if (current !== consent) return consentMissingRefusal(request.provider)
    const agents = this.seatAgents(request)
    const verdict = await consent.reviewSeat({ provider: request.provider, ...agents, cwd: request.cwd, phase: 'turn', signal: request.signal })
    return verdict.kind === 'refuse' ? verdict.reason : undefined
  }

  /**
   * Hand figures a run reported to the limits store.
   * @param observation - the figures.
   */
  private observe(observation: AccountObservation): void {
    this.ctx.get('agentAccounts')?.observe(observation)
  }

  /**
   * End one seat's program, if the gate holds one.
   * @param child - the seat child.
   */
  private endSeat(child: SessionId): void {
    const live = this.seats.get(child)
    if (live !== undefined) void this.end(live)
  }

  /**
   * End every program and wait for each to exit.
   * @returns when all have ended.
   */
  private async endAll(): Promise<void> {
    await Promise.all([...this.live].map(live => this.end(live)))
  }

  /**
   * End one program: close the driver's session, abort its processes, and wait for them to exit within twice the
   * grace period. Idempotent.
   * @param live - the program.
   * @returns when it has ended.
   */
  private end(live: Live): Promise<void> {
    live.ending ??= (async () => {
      try {
        await live.session?.close()
      } catch (error) {
        this.ctx.logger.warn(`external agents: closing a ${live.provider} session failed: ${String(error)}`)
      }
      live.controller.abort()
      const bound = AbortSignal.timeout(this.options.graceMs * 2)
      await Promise.all([...live.handles].map(async (handle) => {
        handle.terminate()
        try {
          await handle.waitForExit(bound)
        } catch (error) {
          this.ctx.logger.warn(`external agents: a ${live.provider} process could not be observed after termination: ${String(error)}`)
        }
      }))
      this.live.delete(live)
      if (live.seat !== undefined && this.seats.get(live.seat.child) === live) this.seats.delete(live.seat.child)
    })()
    return live.ending
  }
}

/**
 * Whether a consent service can review a seat.
 * @param consent - the composed consent service.
 * @returns true when it has the seat side.
 */
function isSeatConsent(consent: unknown): consent is SeatConsent {
  return typeof consent === 'object' && consent !== null && typeof Reflect.get(consent, 'reviewSeat') === 'function'
}

/** What a gate session needs from the gate. */
interface GateSessionOptions {
  /** The agent. */
  readonly provider: ExternalAgentName
  /** Why the start was allowed. */
  readonly allowedBy: SeatSession['allowedBy']
  /** The consent's time limit for one turn; none when the consent is off. */
  readonly timeoutMs: number | undefined
  /** How long an interrupted turn gets to end before the program is ended. */
  readonly graceMs: number
  /** Review one turn; absent when the consent is off. */
  readonly reviewTurn: (() => Promise<string | undefined>) | undefined
  /** End the program. */
  readonly end: () => Promise<void>
}

/**
 * A driver session as the seat sees it: every turn is reviewed before it starts and bounded by the time limit, and
 * after the limit the turn ends as failed, naming it.
 */
class GateSession implements SeatSession {
  private readonly inner: ProgramSession
  private readonly options: GateSessionOptions
  private timer: ReturnType<typeof setTimeout> | undefined
  private timedOut = false
  /** The turn end delivered when the time limit ended the program. */
  private readonly stoppedEnd: ProgramEvent = { kind: 'turn-end', outcome: 'failed' }
  private readonly stopped = Promise.withResolvers<ProgramEvent>()
  private finished = false

  constructor(inner: ProgramSession, options: GateSessionOptions) {
    this.inner = inner
    this.options = options
  }

  get allowedBy(): SeatSession['allowedBy'] {
    return this.options.allowedBy
  }

  get programSessionId(): string {
    return this.inner.programSessionId
  }

  get turnRunning(): boolean {
    return this.inner.turnRunning
  }

  async send(text: string, mode: 'start' | 'steer'): Promise<void> {
    if (mode === 'start') {
      let refusal: string | undefined
      try {
        refusal = await this.options.reviewTurn?.()
      } catch (error) {
        // A review that cannot finish is no approval: the program ends before the error reaches the seat.
        await this.options.end()
        throw error
      }
      if (refusal !== undefined) {
        await this.options.end()
        throw new GateRefusedError({ category: 'consent', reason: refusal })
      }
    }
    await this.inner.send(text, mode)
    if (mode === 'start') this.arm()
  }

  interrupt(): Promise<ProgramInterruptOutcome> {
    return this.inner.interrupt()
  }

  async next(signal: AbortSignal): Promise<ProgramEvent> {
    if (this.finished) throw new Error('the external agent\'s program has ended')
    const wait = new AbortController()
    const onAbort = (): void => { wait.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const event = await Promise.race([this.inner.next(wait.signal), this.stopped.promise])
      if (event === this.stoppedEnd) this.finished = true
      if (event.kind !== 'turn-end') return event
      this.disarm()
      if (!this.timedOut) return event
      this.timedOut = false
      const failure = { category: 'time-limit', limitMs: this.options.timeoutMs ?? 0 } as const
      return { kind: 'turn-end', outcome: 'failed', ...event.usage === undefined ? {} : { usage: event.usage }, failure }
    } finally {
      signal.removeEventListener('abort', onAbort)
      wait.abort()
    }
  }

  async close(): Promise<void> {
    this.disarm()
    await this.options.end()
  }

  /** Start the turn's time limit. */
  private arm(): void {
    const limit = this.options.timeoutMs
    if (limit === undefined) return
    this.disarm()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timedOut = true
      void this.expire()
    }, limit)
  }

  /** Stop the turn's time limit. */
  private disarm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Interrupt the expired turn, then end the program if it still runs after the grace period. */
  private async expire(): Promise<void> {
    try {
      await this.inner.interrupt()
    } catch (_ignored) {
      // An interrupt that fails leaves the turn running; the grace period below ends the program.
    }
    await new Promise(resolve => setTimeout(resolve, this.options.graceMs))
    if (!this.timedOut) return
    await this.options.end()
    this.stopped.resolve(this.stoppedEnd)
  }
}
