/**
 * The relay wired by the plugin entry, on the production AgentLoop, the seat adapter, the seat executor and the real
 * approval service, with a scripted gate and program: a program's question about a recorded call reaches the person on
 * the seat child, "Allow for this run" reaches the program as a run allowance, Stop settles the question inside the
 * turn, and with the preview flag off nothing is wired.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { appendDelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent'
import ApprovalService, { setApprovalPolicy, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ProgramApprovalAnswer, SeatLease, SeatLeaseEnd, SeatRecord, SeatSession, SeatStartRequest } from '@delorun/external-agents/contract'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as Plugin from '../src/index.ts'
import { Config, mountSeats } from '../src/index.ts'
import { SeatToolExecutor, SEAT_MAX_PARALLEL_HARNESS_TOOLS } from '../src/executor/index.ts'
import { RUN_ANSWER } from '../src/relay/index.ts'
import { ScriptedGate } from './adapter/support.ts'
import { captureWarnings, FakeConnection, FakeFlags, FakePresets, FakeProfile } from './mount-support.ts'
import { FixtureWorkingDirectory } from './provider/harness.ts'
import { describeSeat, until } from './state/support.ts'

/** The gate as a service, over the scripted gate. */
class GateService extends Service {
  readonly gate: ScriptedGate

  constructor(ctx: Context, gate: ScriptedGate) {
    super(ctx, 'externalAgents')
    this.gate = gate
  }

  start(request: SeatStartRequest): Promise<SeatSession> {
    return this.gate.start(request)
  }

  seat(child: SessionId): SeatRecord | undefined {
    return this.gate.seat(child)
  }

  limitRefusal(): Promise<string | undefined> {
    return Promise.resolve(undefined)
  }
}

interface Waiting {
  readonly request: ApprovalRequest
  readonly resolve: (value: never) => void
}

const say = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const RULE = { provider: 'claude-code', summary: 'Run `npm test`', data: { rule: 'Bash(npm test)' } } as const

/**
 * The profile's services, the plugin and a seat child that was delegated with a `never` pin.
 * @param on - whether the preview flag is on.
 * @param relay - whether the mount is given the relay; without it every question is rejected.
 */
async function world(on: boolean, relay = true) {
  FakeFlags.on = on
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const dir = await mkdtemp(join(tmpdir(), 'ea2-seat-relay-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(FixtureWorkingDirectory)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(ApprovalService)
  const gate = new ScriptedGate()
  await ctx.plugin(GateService, gate)
  await ctx.plugin(FakeFlags)
  await ctx.plugin(FakePresets)
  await ctx.plugin(FakeProfile, dir)
  await ctx.plugin(FakeConnection)
  const waiting: Waiting[] = []
  ctx.on('approval/request', request => new Promise((resolve) => { waiting.push({ request, resolve }) }))
  let fiber: ReturnType<Context['plugin']> | undefined
  let mounted: Awaited<ReturnType<typeof mountSeats>> | undefined
  if (relay) {
    fiber = ctx.plugin(Plugin, Config(null))
    await fiber.await()
  } else {
    mounted = await mountSeats(ctx, Config(null))
  }
  const options = { provider: 'claude-code-seat', model: 'program' }
  const root = (await ctx.agents.create({ sessionId: SessionId('root'), meta: { cwd: '/work' }, agentOptions: options })).agent
  setApprovalPolicy(root.session, 'ask')
  const child = (await ctx.agents.create({
    sessionId: SessionId('seat-child'), meta: { cwd: '/work', parentSession: root.id, origin: 'subagent' }, agentOptions: options,
  })).agent
  describeSeat(child.session)
  appendDelegatedPolicyOverrides(child.session, { approvalPolicy: 'never', permissionPreset: undefined, sandboxMode: undefined })
  gate.seats.set(child.id, { child: child.id, root: root.id, provider: 'claude-code' })
  // The seat preset's scope: the executor that records the program's calls.
  const presetKey = { preset: 'claude-code-seat' }
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, presetKey)
    scope.ctx.tools.setExecutor(new SeatToolExecutor({
      ctx: scope.ctx, programs: ctx.seatPrograms, recordPrefix: 'claude_code.', outputCap: { headChars: 1000, tailChars: 1000 }, maxParallel: SEAT_MAX_PARALLEL_HARNESS_TOOLS,
    }))
  }, { inject: ['tools', 'systemPrompt', 'seatPrograms'] }))
  bindScopeParent(child, presetKey)
  const idle = (agent: Agent): Promise<void> => new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', (event) => {
      if (event.agent === agent && event.status === 'idle') { dispose(); resolve() }
    })
  })
  return { ctx, gate, root, child, waiting, idle, fiber, mounted }
}

/** Hand the seat a task and let its program call `Bash` and raise a question about the call. */
async function askQuestion(w: Awaited<ReturnType<typeof world>>, withRule = true): Promise<{ answer: Promise<ProgramApprovalAnswer>, done: Promise<void> }> {
  const done = w.idle(w.child)
  w.child.followup(say('run the tests'))
  await until(() => w.gate.programs.length === 1, 'the program')
  w.gate.latest.emit({ kind: 'tool-call', id: 'call-1', name: 'Bash', input: '{"command":"npm test"}' }, { kind: 'message-end' })
  const onApproval = w.gate.starts[0]?.onApproval
  if (onApproval === undefined) throw new Error('the start has no approval callback')
  const answer = onApproval({ callId: 'call-1', toolName: 'Bash', reason: 'Run `npm test`', signal: new AbortController().signal, ...withRule ? { runRule: RULE } : {} })
  await until(() => w.waiting.length === 1, 'the question')
  return { answer, done }
}

const policies = (agent: Agent): unknown[] => agent.session.snapshotEvents().flatMap(event => event.type === 'approval/policy' ? [event.data.policy] : [])
const types = (agent: Agent): string[] => agent.session.snapshotEvents().map(event => event.type)

describe('a program question on a seat child', () => {
  it('asks on the child, with the marker and the run scope, once its call is recorded, and shows the question as waiting', async () => {
    const w = await world(true)
    const { answer, done } = await askQuestion(w)
    const [{ request }] = w.waiting as [Waiting]
    expect(request.agent).toBe(w.child)
    expect(request).toMatchObject({ grants: 'external-agent', runScope: 'external-agent-run', toolName: 'claude_code.Bash', callId: 'call-1' })
    expect(types(w.child).indexOf('tool/call')).toBeGreaterThan(-1)
    expect(types(w.child).indexOf('tool/call')).toBeLessThan(types(w.child).indexOf('approval/asked'))
    expect(types(w.root)).not.toContain('approval/asked')
    expect(policies(w.child)).toEqual(['never', 'ask'])
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('ask')
    expect(w.ctx.get('seatPrograms')).toBeDefined()
    expect(w.ctx.get('seatPrograms')?.records).toBeDefined()
    const waiting = w.ctx.sessionProjections.snapshot(w.child.session).values.agentSeat
    expect(waiting?.pending?.since).toEqual(expect.any(Number))

    w.waiting[0]?.resolve('allowed-once' as never)
    await expect(answer).resolves.toBe('allow-once')
    expect(w.ctx.sessionProjections.snapshot(w.child.session).values.agentSeat?.pending).toBeUndefined()
    w.gate.latest.emit({ kind: 'tool-result', id: 'call-1', output: 'ok', isError: false }, { kind: 'text', text: 'Done.' }, { kind: 'turn-end', outcome: 'completed' })
    await done
    expect(w.ctx.sessionProjections.snapshot(w.child.session).values.agentSeat).toMatchObject({ state: 'idle', turns: 1, lastAnswer: 'Done.' })
  })

  it('answers allow-run to the program when the person chose Allow for this run', async () => {
    const w = await world(true)
    const { answer } = await askQuestion(w)
    w.waiting[0]?.resolve(RUN_ANSWER as never)
    await expect(answer).resolves.toBe('allow-run')
  })

  it('lifts the pin once for several questions', async () => {
    const w = await world(true)
    const { answer } = await askQuestion(w)
    w.waiting[0]?.resolve('rejected' as never)
    await expect(answer).resolves.toBe('reject')
    const second = w.gate.starts[0]?.onApproval({ callId: 'call-1', toolName: 'Bash', reason: 'again', signal: new AbortController().signal })
    await until(() => w.waiting.length === 2, 'the second question')
    w.waiting[1]?.resolve('rejected' as never)
    await expect(second).resolves.toBe('reject')
    expect(policies(w.child)).toEqual(['never', 'ask'])
  })

  it('settles a question at Stop as cancelled inside the turn', async () => {
    const w = await world(true)
    const { answer, done } = await askQuestion(w)
    w.child.cancel({ kind: 'user' })
    await expect(answer).resolves.toBe('cancel')
    await done
    const log = types(w.child)
    const decided = log.indexOf('approval/decided')
    expect(decided).toBeGreaterThan(-1)
    expect(decided).toBeLessThan(log.lastIndexOf('turn/end'))
    expect(w.child.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data)).toMatchObject([{ outcome: 'cancelled' }])
    expect(w.ctx.sessionProjections.snapshot(w.child.session).values.agentSeat?.pending).toBeUndefined()
  })

  it('rejects the question, asking nobody, while the mount is given no relay', async () => {
    const w = await world(true, false)
    const done = w.idle(w.child)
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    const answer = w.gate.starts[0]?.onApproval?.({ callId: 'call-1', toolName: 'Bash', reason: 'Run', signal: new AbortController().signal })
    await expect(answer).resolves.toBe('reject')
    expect(w.waiting).toEqual([])
    expect(w.child.session.snapshotEvents().filter(event => event.type === 'external-agent/notice').map(event => event.data))
      .toEqual([{ kind: 'question-refused', text: expect.stringContaining('no way to ask you') }])
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await done
  })

  it('rejects the question, asking nobody, when the asking chat is no live agent', async () => {
    const w = await world(true)
    const done = w.idle(w.child)
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    vi.spyOn(w.ctx.agents, 'get').mockReturnValue(undefined)
    const answer = w.gate.starts[0]?.onApproval?.({ callId: 'call-1', toolName: 'Bash', reason: 'Run', signal: new AbortController().signal })
    await expect(answer).resolves.toBe('reject')
    expect(w.waiting).toEqual([])
    expect(w.child.session.snapshotEvents().filter(event => event.type === 'external-agent/notice').map(event => event.data))
      .toEqual([{ kind: 'question-refused', text: expect.stringContaining('Bash') }])
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await done
  })

  it('still rejects the question when the refusal cannot be shown in the chat', async () => {
    const w = await world(true)
    const warnings = captureWarnings(w.ctx)
    const done = w.idle(w.child)
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    vi.spyOn(w.ctx.agents, 'get').mockReturnValue(undefined)
    const sessions = vi.spyOn(w.ctx.sessions, 'get').mockReturnValue(undefined)
    const answer = w.gate.starts[0]?.onApproval?.({ callId: 'call-1', toolName: 'Bash', reason: 'Run', signal: new AbortController().signal })
    await expect(answer).resolves.toBe('reject')
    sessions.mockRestore()
    expect(warnings.join('\n')).toContain('a refused question of seat-child could not be shown')
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await done
  })

  it('names every program tool with the record prefix, so none reaches the native executor', async () => {
    const w = await world(true)
    const { answer } = await askQuestion(w)
    expect(w.child.session.snapshotEvents().flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])).toEqual(['claude_code.Bash'])
    w.waiting[0]?.resolve('rejected' as never)
    await answer
  })
})

describe('the program a seat opens', () => {
  /** Hand the seat a task so its program opens, and make closing that program fail. */
  async function openStuckProgram(w: Awaited<ReturnType<typeof world>>): Promise<void> {
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    w.gate.latest.close = () => Promise.reject(new Error('the program is stuck'))
  }

  it('starts with the model picked for the workspace that lists the chat', async () => {
    const w = await world(true, false)
    w.ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws-1', sessionIds: [w.child.id] }] } as never)
    w.mounted?.choices.set('ws-1', 'the-picked-model')
    await w.mounted?.settled()
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    expect(w.gate.starts[0]).toMatchObject({ model: 'the-picked-model' })
  })

  it('starts with the model picked for the run folder when no workspace lists the chat', async () => {
    const w = await world(true, false)
    w.ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws-other', sessionIds: [] }] } as never)
    w.mounted?.choices.set('/work', 'the-folder-model')
    await w.mounted?.settled()
    w.child.followup(say('run the tests'))
    await until(() => w.gate.programs.length === 1, 'the program')
    expect(w.gate.starts[0]).toMatchObject({ model: 'the-folder-model' })
  })

  it('closes every open program when the plugin stops, and says when one will not close', async () => {
    const w = await world(true)
    const warnings = captureWarnings(w.ctx)
    await openStuckProgram(w)
    await w.fiber?.dispose()
    await until(() => warnings.some(text => text.includes('a program did not close at shutdown: Error: the program is stuck')), 'the warning')
  })

  it('closes the program of a chat whose lease ended, and says when it will not close', async () => {
    const w = await world(true)
    const warnings = captureWarnings(w.ctx)
    const listeners = new Set<(lease: SeatLease, reason: SeatLeaseEnd) => void>()
    w.ctx.provide('delegationConsent', { onLeaseEnded: (listener: (lease: SeatLease, reason: SeatLeaseEnd) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as never)
    await openStuckProgram(w)
    const lease: SeatLease = { child: w.child.id, root: w.root.id, workspace: 'w', cwd: '/work', provider: 'claude-code', workspaceListed: false, grantedAt: 0, why: 'asked' }
    for (const listener of listeners) listener(lease, 'revoked')
    await until(() => warnings.some(text => text.includes('did not close: Error: the program is stuck')), 'the warning')
  })
})

describe('the preview flag off', () => {
  it('wires no relay, no seat state and no route', async () => {
    FakeFlags.on = false
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const dir = await mkdtemp(join(tmpdir(), 'ea2-seat-relay-off-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(GateService, new ScriptedGate())
    await ctx.plugin(FakeFlags)
    await ctx.plugin(FakePresets)
    await ctx.plugin(FakeProfile, dir)
    await ctx.plugin(FakeConnection)
    await ctx.plugin(Plugin, Config(null))
    expect(ctx.get('seatPrograms')).toBeUndefined()
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('claude-code-seat')
  })
})
