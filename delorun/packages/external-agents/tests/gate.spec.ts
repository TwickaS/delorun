/**
 * Loop-tier specs of the start gate over production Agents from the agent-loop testkit, a scripted driver and a fake
 * process table: no process starts. They cover the start order and every refusal, one program per child, the cap, the
 * spawn the gate hands a driver, every event that ends a program, the turn time limit and the "for this run" relay.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DELEGATION_CONSENT_ROW_ID, ExternalAgentsService, GateRefusedError, type AccountRecord, type ExternalAgentDriver,
  type ExternalAgentName, type ProgramApprovalAnswer, type ProgramApprovalRequest, type ProgramEvent, type ProgramOpenRequest,
  type ProgramRunRule, type ProgramSession, type SeatConsent, type SeatLease, type SeatLeaseEnd, type SeatReview,
  type SeatStartRequest, type SeatVerdict,
} from '../src/index.ts'
import { limitRefusal } from '../src/copy.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fake managed process that exits when it is terminated or its signal aborts. */
interface FakeProcess extends SubprocessHandle {
  readonly spec: SubprocessSpawnSpec
  readonly terminated: boolean
}

/**
 * @param spec - the spawn request.
 * @returns a fake handle.
 */
function fakeProcess(spec: SubprocessSpawnSpec): FakeProcess {
  const exit = Promise.withResolvers<{ exitCode: number | null, signal: NodeJS.Signals | null }>()
  let terminated = false
  const terminate = (): void => {
    terminated = true
    exit.resolve({ exitCode: null, signal: 'SIGTERM' })
  }
  spec.signal?.addEventListener('abort', terminate, { once: true })
  return {
    spec,
    get terminated() { return terminated },
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {} as never,
    done: exit.promise,
    terminate,
    waitForExit: async () => { await exit.promise; return true },
  }
}

/** One scripted program session. */
class ScriptedSession implements ProgramSession {
  readonly programSessionId = 'program-1'
  turnRunning = false
  closed = false
  honoursInterrupt = true
  readonly sent: Array<[string, 'start' | 'steer']> = []
  private readonly queue: ProgramEvent[] = []
  private waiter: PromiseWithResolvers<ProgramEvent> | undefined

  push(event: ProgramEvent): void {
    if (event.kind === 'turn-end') this.turnRunning = false
    const waiter = this.waiter
    this.waiter = undefined
    if (waiter !== undefined) waiter.resolve(event)
    else this.queue.push(event)
  }

  send(text: string, mode: 'start' | 'steer'): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'))
    this.sent.push([text, mode])
    this.turnRunning = true
    return Promise.resolve()
  }

  interrupt(): Promise<'interrupted'> {
    if (this.honoursInterrupt && this.turnRunning) this.push({ kind: 'turn-end', outcome: 'interrupted' })
    return Promise.resolve('interrupted')
  }

  next(signal: AbortSignal): Promise<ProgramEvent> {
    const ready = this.queue.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    const waiter = Promise.withResolvers<ProgramEvent>()
    this.waiter = waiter
    signal.addEventListener('abort', () => { waiter.reject(signal.reason) }, { once: true })
    return waiter.promise
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** A driver that starts one fake process per open and records what the gate handed it. */
class ScriptedDriver implements ExternalAgentDriver {
  readonly provider: ExternalAgentName
  readonly opens: ProgramOpenRequest[] = []
  readonly sessions: ScriptedSession[] = []
  readonly processes: FakeProcess[] = []
  probeCwd: string | undefined

  constructor(provider: ExternalAgentName) {
    this.provider = provider
  }

  open(request: ProgramOpenRequest): Promise<ProgramSession> {
    this.opens.push(request)
    this.processes.push(request.spawn({ argv: ['/bin/program', 'serve'], env: { PROGRAM_MODE: 'seat', DELORUN_HOME: '/h', NODE_OPTIONS: '--inspect' }, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }) as FakeProcess)
    const session = new ScriptedSession()
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  probe(request: { spawn: ProgramOpenRequest['spawn'], cwd: string, signal: AbortSignal }): Promise<{ provider: ExternalAgentName, signedIn: 'yes', windows: [], source: 'probe' }> {
    this.probeCwd = request.cwd
    this.processes.push(request.spawn({ argv: ['/bin/program', 'check'], stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }) as FakeProcess)
    return Promise.resolve({ provider: this.provider, signedIn: 'yes', windows: [], source: 'probe' })
  }
}

/** A scripted seat consent. */
class ScriptedConsent implements SeatConsent {
  readonly reviews: SeatReview[] = []
  verdict: (review: SeatReview) => SeatVerdict = () => ({ kind: 'allow', timeoutMs: 60_000 })
  readonly leases = new Map<SessionId, SeatLease>()
  readonly rules = new Map<SessionId, ProgramRunRule[]>()
  private readonly listeners = new Set<(lease: SeatLease, reason: SeatLeaseEnd) => void>()

  reviewSeat(review: SeatReview): Promise<SeatVerdict> {
    this.reviews.push(review)
    const verdict = this.verdict(review)
    if (verdict.kind === 'allow' && review.phase !== 'turn') {
      this.leases.set(review.child.id, { child: review.child.id, root: review.root.id, workspace: review.cwd, cwd: review.cwd, provider: review.provider, workspaceListed: true, grantedAt: 1 })
    }
    return Promise.resolve(verdict)
  }

  leaseOf(child: SessionId): SeatLease | undefined {
    return this.leases.get(child)
  }

  endLease(child: SessionId, reason: SeatLeaseEnd): void {
    const lease = this.leases.get(child)
    if (lease === undefined) return
    this.leases.delete(child)
    this.rules.delete(child)
    for (const listener of this.listeners) listener(lease, reason)
  }

  onLeaseEnded(listener: (lease: SeatLease, reason: SeatLeaseEnd) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  runRules(child: SessionId): readonly ProgramRunRule[] {
    return this.rules.get(child) ?? []
  }

  addRunRule(child: SessionId, rule: ProgramRunRule): boolean {
    if (!this.leases.has(child)) return false
    this.rules.set(child, [...this.rules.get(child) ?? [], rule])
    return true
  }
}

interface World {
  readonly ctx: Context
  readonly gate: ExternalAgentsService
  readonly driver: ScriptedDriver
  readonly consent: ScriptedConsent
  readonly root: Agent
  readonly seat: Agent
  readonly workspace: string
  readonly probeFolders: string[]
  readonly unregister: () => void
  readonly stop: () => Promise<void>
}

interface WorldOptions {
  /** The consent row: absent, disabled, or with its saved `enabled`. */
  readonly row?: 'absent' | 'disabled' | { readonly enabled: boolean }
  /** The consent service: the scripted one, a service without `reviewSeat`, or none. */
  readonly consent?: 'seat' | 'one-shot-only' | 'none'
  readonly maxLivePrograms?: number
  readonly graceMs?: number
  readonly limitRefusal?: boolean
  readonly accounts?: AccountRecord
  readonly now?: number
}

/** The gate over production Agents `root` and `seat` (a subagent of `root`), with fake neighbours. */
async function world(options: WorldOptions = {}): Promise<World> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-gate-')))
  roots.push(base)
  const workspace = join(base, 'work')
  mkdirSync(workspace)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const root = await harness.create(SessionId('root'), {}, { cwd: workspace })
  const seat = await harness.create(SessionId('seat'), {}, { cwd: workspace })
  await harness.create(SessionId('orphan'), {}, { cwd: workspace })
  ctx.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => fakeProcess(spec) } as never)
  ctx.provide('subagents', { rootOf: (agent: Agent) => (agent.id === 'orphan' ? (() => { throw new Error('no owner') })() : root) } as never)
  const row = options.row ?? { enabled: true }
  const entries = row === 'absent' ? [] : [{ id: DELEGATION_CONSENT_ROW_ID, options: { id: DELEGATION_CONSENT_ROW_ID, config: row === 'disabled' ? { enabled: true } : row }, disabled: row === 'disabled' }]
  ctx.provide('loader', { entries: () => entries, unwrapExports: (exports: unknown) => exports } as never)
  const consent = new ScriptedConsent()
  if ((options.consent ?? 'seat') === 'seat') ctx.provide('delegationConsent', consent as never)
  if (options.consent === 'one-shot-only') ctx.provide('delegationConsent', { review: () => Promise.resolve({ kind: 'refuse', reason: 'stub' }) } as never)
  if (options.accounts !== undefined) {
    const record = options.accounts
    ctx.provide('agentAccounts', {
      read: () => Promise.resolve(record),
      reachedLimit: (held: AccountRecord) => {
        const window = held.windows.find(entry => entry.status === 'reached')
        return window?.resetsAt === undefined ? undefined : { provider: held.provider, window: window.kind, resetsAt: window.resetsAt }
      },
      observe: () => undefined,
    } as never)
  }
  const probeFolders: string[] = []
  const fiber = ctx.plugin(ExternalAgentsService, {
    maxLivePrograms: options.maxLivePrograms ?? 4,
    graceMs: options.graceMs ?? 100,
    limitRefusal: options.limitRefusal ?? false,
    env: { DELORUN_HOME: '/home/x', DELORUN_TOKEN_FILE: '/t', PATH: '/bin' },
    now: () => options.now ?? 1_000_000,
    probeFolder: () => {
      const folder = mkdtempSync(join(base, 'check-'))
      probeFolders.push(folder)
      return Promise.resolve(folder)
    },
  })
  await fiber
  const gate = ctx.get('externalAgents') as ExternalAgentsService
  const driver = new ScriptedDriver('claude-code')
  const unregister = gate.registerDriver(driver)
  return { ctx, gate, driver, consent, root, seat, workspace, probeFolders, unregister, stop: () => fiber.dispose() }
}

/**
 * A seat start for the child `seat` created by `root`.
 * @param w - the world.
 * @param change - fields to change.
 */
function start(w: World, change: Partial<SeatStartRequest> = {}): SeatStartRequest {
  return {
    purpose: 'seat',
    provider: 'claude-code',
    creator: w.root.id,
    child: w.seat.id,
    cwd: w.workspace,
    harnessTools: [],
    onApproval: () => Promise.resolve('allow-once'),
    signal: new AbortController().signal,
    ...change,
  }
}

/**
 * @param promise - a start.
 * @returns the refusal it rejected with.
 */
async function refusal(promise: Promise<unknown>): Promise<GateRefusedError['refusal']> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  if (!(error instanceof GateRefusedError)) throw new Error(`expected a gate refusal, got ${String(error)}`)
  return error.refusal
}

/** Let queued promise work settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('the consent a seat start needs (review D6)', () => {
  it('reviews at hand-off, then opens the program through the gate\'s spawn', async () => {
    const w = await world()
    const session = await w.gate.start(start(w))
    expect(w.consent.reviews.map(review => [review.phase, review.root.id, review.creator.id, review.child.id])).toEqual([['hand-off', 'root', 'root', 'seat']])
    expect(w.driver.opens).toHaveLength(1)
    expect(session.programSessionId).toBe('program-1')
    expect(w.gate.seat(w.seat.id)).toEqual({ child: 'seat', root: 'root', provider: 'claude-code' })
  })

  it('reviews a start that resumes a program as a resume', async () => {
    const w = await world()
    await w.gate.start(start(w, { resume: 'program-1' }))
    expect(w.consent.reviews.map(review => review.phase)).toEqual(['resume'])
    expect(w.driver.opens[0]?.resume).toBe('program-1')
  })

  it('refuses when the consent refuses, starting nothing', async () => {
    const w = await world()
    w.consent.verdict = () => ({ kind: 'refuse', reason: 'the person declined' })
    await expect(refusal(w.gate.start(start(w)))).resolves.toEqual({ category: 'consent', reason: 'the person declined' })
    expect(w.driver.opens).toEqual([])
  })

  it('refuses when the consent row is absent', async () => {
    const w = await world({ row: 'absent' })
    await expect(refusal(w.gate.start(start(w)))).resolves.toMatchObject({ category: 'consent' })
    expect(w.driver.opens).toEqual([])
  })

  it('refuses when the consent row is disabled', async () => {
    const w = await world({ row: 'disabled' })
    await expect(refusal(w.gate.start(start(w)))).resolves.toMatchObject({ category: 'consent', reason: expect.stringContaining('disabled in this profile') })
    expect(w.driver.opens).toEqual([])
  })

  it('refuses when the row is enabled but no consent service is registered', async () => {
    const w = await world({ consent: 'none' })
    await expect(refusal(w.gate.start(start(w)))).resolves.toMatchObject({ category: 'consent', reason: expect.stringContaining('is not running') })
    expect(w.driver.opens).toEqual([])
  })

  it('refuses when the consent service cannot review a seat, as the failed stub cannot', async () => {
    const w = await world({ consent: 'one-shot-only' })
    await expect(refusal(w.gate.start(start(w)))).resolves.toMatchObject({ category: 'consent' })
    expect(w.driver.opens).toEqual([])
  })

  it('starts unreviewed only when the row\'s saved enabled is false', async () => {
    const w = await world({ row: { enabled: false }, consent: 'none' })
    await w.gate.start(start(w))
    expect(w.driver.opens).toHaveLength(1)
    expect(w.driver.opens[0]?.runRules).toEqual([])
  })

  it('refuses a seat whose child has no running owner', async () => {
    const w = await world()
    await expect(refusal(w.gate.start(start(w, { child: SessionId('orphan') })))).resolves.toMatchObject({ category: 'consent' })
  })

  it('refuses an agent whose driver is not registered', async () => {
    const w = await world()
    await expect(refusal(w.gate.start(start(w, { provider: 'codex' })))).resolves.toEqual({ category: 'not-installed' })
    await expect(refusal(w.gate.probe('codex', new AbortController().signal))).resolves.toEqual({ category: 'not-installed' })
  })
})

describe('one program per seat child and the cap (T10)', () => {
  it('refuses a second program for the same child', async () => {
    const w = await world()
    await w.gate.start(start(w))
    await expect(refusal(w.gate.start(start(w)))).resolves.toEqual({ category: 'seat-running' })
    expect(w.driver.opens).toHaveLength(1)
  })

  it('refuses a start at maxLivePrograms, naming the busy agents, and counts limits checks', async () => {
    const w = await world({ maxLivePrograms: 1 })
    await w.gate.start(start(w))
    await expect(refusal(w.gate.start(start(w, { child: SessionId('root') })))).resolves.toEqual({ category: 'capacity', busy: ['claude-code'] })
    await expect(refusal(w.gate.probe('claude-code', new AbortController().signal))).resolves.toEqual({ category: 'capacity', busy: ['claude-code'] })
  })
})

describe('the spawn a driver gets', () => {
  it('sets the run folder, the grace period and the abort signal, and removes NODE_OPTIONS and DELORUN_* names', async () => {
    const w = await world()
    await w.gate.start(start(w))
    const spec = w.driver.processes[0]?.spec
    expect(spec?.cwd).toBe(w.workspace)
    expect(spec?.graceMs).toBe(100)
    expect(spec?.signal).toBe(w.driver.opens[0]?.signal)
    expect(spec?.env).toEqual({ PROGRAM_MODE: 'seat', NODE_OPTIONS: undefined, DELORUN_HOME: undefined, DELORUN_TOKEN_FILE: undefined })
  })

  it('refuses to start a process once the program has ended', async () => {
    const w = await world()
    const session = await w.gate.start(start(w))
    await session.close()
    expect(() => w.driver.opens[0]?.spawn({ argv: ['/bin/x'], stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })).toThrow(/has ended/)
  })
})

describe('what ends a program', () => {
  it('ends the child\'s program when its Agent is disposed, and only that one', async () => {
    const w = await world()
    await w.gate.start(start(w))
    await w.gate.start(start(w, { child: w.root.id }))
    w.ctx.emit('agent/disposed', { agent: w.seat })
    await settle()
    expect(w.driver.sessions.map(session => session.closed)).toEqual([true, false])
    expect(w.driver.processes.map(process => process.terminated)).toEqual([true, false])
    // The lease outlives the program, so the seat is still recognised for its next message.
    expect(w.gate.seat(w.seat.id)).toEqual({ child: 'seat', root: 'root', provider: 'claude-code' })
  })

  it('ends the program when its lease ends', async () => {
    const w = await world()
    await w.gate.start(start(w))
    w.consent.endLease(w.seat.id, 'archived')
    await settle()
    expect(w.driver.processes[0]?.terminated).toBe(true)
  })

  it('ends a program started while the consent was off once a consent appears', async () => {
    const w = await world({ row: { enabled: false }, consent: 'none' })
    await w.gate.start(start(w))
    w.ctx.provide('delegationConsent', new ScriptedConsent() as never)
    await settle()
    expect(w.driver.processes[0]?.terminated).toBe(true)
  })

  it('ends every program when the gate stops', async () => {
    const w = await world()
    await w.gate.start(start(w))
    await w.gate.start(start(w, { child: w.root.id }))
    await w.stop()
    expect(w.driver.processes.map(process => process.terminated)).toEqual([true, true])
  })

  it('ends a driver\'s programs when the driver leaves', async () => {
    const w = await world()
    await w.gate.start(start(w))
    w.unregister()
    await settle()
    expect(w.driver.processes[0]?.terminated).toBe(true)
  })

  it('ends the program when the start\'s signal aborts', async () => {
    const w = await world()
    const controller = new AbortController()
    await w.gate.start(start(w, { signal: controller.signal }))
    controller.abort()
    await settle()
    expect(w.driver.processes[0]?.terminated).toBe(true)
  })
})

describe('each seat turn', () => {
  it('is reviewed without a card before it starts; a refusal ends the program', async () => {
    const w = await world()
    const session = await w.gate.start(start(w))
    await session.send('first', 'start')
    w.consent.verdict = review => (review.phase === 'turn' ? { kind: 'refuse', reason: 'approval ended' } : { kind: 'allow', timeoutMs: 60_000 })
    await expect(refusal(session.send('second', 'start'))).resolves.toEqual({ category: 'consent', reason: 'approval ended' })
    expect(w.consent.reviews.map(review => review.phase)).toEqual(['hand-off', 'turn', 'turn'])
    expect(w.driver.sessions[0]?.sent).toEqual([['first', 'start']])
    expect(w.driver.processes[0]?.terminated).toBe(true)
  })

  it('steers without a review', async () => {
    const w = await world()
    const session = await w.gate.start(start(w))
    await session.send('first', 'start')
    await session.send('also this', 'steer')
    expect(w.consent.reviews.map(review => review.phase)).toEqual(['hand-off', 'turn'])
  })

  it('ends at the time limit with the interrupted turn reported as the limit, keeping the program', async () => {
    const w = await world()
    w.consent.verdict = () => ({ kind: 'allow', timeoutMs: 20 })
    const session = await w.gate.start(start(w))
    await session.send('work', 'start')
    const event = await session.next(new AbortController().signal)
    expect(event).toEqual({ kind: 'turn-end', outcome: 'failed', failure: { category: 'time-limit', limitMs: 20 } })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(w.driver.processes[0]?.terminated).toBe(false)
  })

  it('ends the program after the grace period when the interrupt does not end the turn', async () => {
    const w = await world()
    w.consent.verdict = () => ({ kind: 'allow', timeoutMs: 20 })
    const session = await w.gate.start(start(w))
    const program = w.driver.sessions[0]
    if (program === undefined) throw new Error('no program')
    program.honoursInterrupt = false
    await session.send('work', 'start')
    const event = await session.next(new AbortController().signal)
    expect(event).toEqual({ kind: 'turn-end', outcome: 'failed', failure: { category: 'time-limit', limitMs: 20 } })
    expect(w.driver.processes[0]?.terminated).toBe(true)
    await expect(session.next(new AbortController().signal)).rejects.toThrow(/has ended/)
  })
})

describe('"Allow for this run"', () => {
  const rule: ProgramRunRule = { provider: 'claude-code', summary: 'Run npm test', data: 'Bash(npm test)' }
  const question = (runRule?: ProgramRunRule): ProgramApprovalRequest => ({ callId: 'c1', toolName: 'Bash', reason: 'npm test', ...runRule === undefined ? {} : { runRule }, signal: new AbortController().signal })

  it('keeps the rule beside the lease and hands it back on the next open', async () => {
    const w = await world()
    const seen: ProgramApprovalRequest[] = []
    await w.gate.start(start(w, { onApproval: (request) => { seen.push(request); return Promise.resolve('allow-run') } }))
    await expect(w.driver.opens[0]?.onApproval(question(rule))).resolves.toBe('allow-run')
    expect(seen[0]?.runRule).toEqual(rule)
    w.ctx.emit('agent/disposed', { agent: w.seat })
    await settle()
    await w.gate.start(start(w, { resume: 'program-1' }))
    expect(w.driver.opens[1]?.runRules).toEqual([rule])
  })

  it('offers no rule and answers allow-once without a lease', async () => {
    const w = await world({ row: { enabled: false }, consent: 'none' })
    const seen: ProgramApprovalRequest[] = []
    await w.gate.start(start(w, { onApproval: (request) => { seen.push(request); return Promise.resolve('allow-run' as ProgramApprovalAnswer) } }))
    await expect(w.driver.opens[0]?.onApproval(question(rule))).resolves.toBe('allow-once')
    expect(seen[0]?.runRule).toBeUndefined()
  })

  it('answers allow-once for a question that carried no rule', async () => {
    const w = await world()
    await w.gate.start(start(w, { onApproval: () => Promise.resolve('allow-run') }))
    await expect(w.driver.opens[0]?.onApproval(question())).resolves.toBe('allow-once')
    expect(w.consent.runRules(w.seat.id)).toEqual([])
  })
})

describe('the limits check (review D8)', () => {
  it('runs the driver\'s probe in an empty folder the gate makes and removes', async () => {
    const w = await world()
    await expect(w.gate.probe('claude-code', new AbortController().signal)).resolves.toMatchObject({ signedIn: 'yes', source: 'probe' })
    expect(w.driver.probeCwd).toBe(w.probeFolders[0])
    expect(w.driver.processes[0]?.spec.cwd).toBe(w.probeFolders[0])
    expect(w.driver.processes[0]?.terminated).toBe(true)
    expect(existsSync(w.probeFolders[0] ?? '')).toBe(false)
    expect(w.consent.reviews).toEqual([])
  })
})

describe('a reached limit (T12)', () => {
  const now = Date.UTC(2026, 10, 17, 12, 5)
  const reached = (resetsAt: number): AccountRecord => ({
    provider: 'claude-code', signedIn: 'yes', installed: true, windows: [{ kind: 'five_hour', status: 'reached', resetsAt, seenAt: now - 1, source: 'run' }],
  })

  it('refuses a seat start with the window and reset time while the switch is on', async () => {
    const w = await world({ limitRefusal: true, accounts: reached(now + 7_500_000), now })
    await expect(refusal(w.gate.start(start(w)))).resolves.toEqual({ category: 'limit', window: 'five_hour', resetsAt: now + 7_500_000 })
    expect(w.driver.opens).toEqual([])
    await expect(w.gate.limitRefusal('claude-code')).resolves.toBe(limitRefusal({ provider: 'claude-code', window: 'five_hour', resetsAt: now + 7_500_000, now }))
  })

  it('never refuses on stale figures whose reset time has passed', async () => {
    const w = await world({ limitRefusal: true, accounts: reached(now - 1), now })
    await w.gate.start(start(w))
    expect(w.driver.opens).toHaveLength(1)
    await expect(w.gate.limitRefusal('claude-code')).resolves.toBeUndefined()
  })

  it('refuses nothing for a limit while the switch is off, its parity value', async () => {
    const w = await world({ accounts: reached(now + 7_500_000), now })
    await w.gate.start(start(w))
    expect(w.driver.opens).toHaveLength(1)
    await expect(w.gate.limitRefusal('claude-code')).resolves.toBeUndefined()
  })

  it('words the refusal with the plan, the window, the local reset time and the time left', () => {
    expect(limitRefusal({ provider: 'claude-code', window: 'five_hour', resetsAt: now + 7_500_000, now, timeZone: 'UTC' })).toBe(
      'Claude Code was not started: your Claude plan\'s 5-hour limit is reached until 14:10 (in 2 h 5 min). '
      + 'Do not hand work to Claude Code before then; do the task yourself or tell the person.',
    )
    expect(limitRefusal({ provider: 'codex', window: 'secondary', resetsAt: now + 3 * 86_400_000, now, timeZone: 'UTC' })).toBe(
      'Codex was not started: your ChatGPT plan\'s weekly limit is reached until Friday 20 November at 12:05 (in 72 h). '
      + 'Do not hand work to Codex before then; do the task yourself or tell the person.',
    )
  })
})
