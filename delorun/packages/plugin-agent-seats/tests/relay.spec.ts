/**
 * Specs of the seat relay (trust path): the lifted pin on a seat child only, the question and its marker, the wait for
 * the call's record, Full access, stop and turn end, and "Allow for this run" through the Host half. A stand-in for the
 * gateway settles the first answer that passes its guard; the guard here applies the reach rule of home-auth's
 * `checkAnswer`. `relay-gateway.spec.ts` drives the denial cases through the real gateway and the real guard.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { buildForkSeed, SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ProgramApprovalRequest, ProgramRunRule } from '@delorun/external-agents/contract'
import { appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides, foldSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, onTestFinished } from 'vitest'
import { assertMarked, EXTERNAL_AGENT_GRANT, RUN_ANSWER, SeatRelay } from '../src/relay/index.ts'
import { agentOf, question, RULE, settle, UnmountedRunScope, world, type World } from './relay-world.ts'


describe('the lifted pin', () => {
  it('appends ask after the delegation pin on a seat child', async () => {
    const w = await world()
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('never')
    expect(w.relay.prepareChild(w.child)).toBe('lifted')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('ask')
    expect(w.events(w.child, 'approval/policy').map(data => data['policy'])).toEqual(['ask'])
  })

  it('leaves a real fork of a seat and a real child of a seat pinned, though both carry the seat descriptor and the fork the lifted ask', async () => {
    const w = await world()
    w.child.session.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'agent-seat', label: 'Fix the tests' } as never)
    const real = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']),
      descriptorOf: agent => foldSubagentDescriptor(agent.session.snapshotEvents())?.provider,
      recorded: () => Promise.resolve(), recordName: (_a, name) => name, agentName: () => 'Claude Code',
    })
    expect(real.prepareChild(w.child)).toBe('lifted')
    const events = w.child.session.snapshotEvents()
    const seed = buildForkSeed(events, SessionSeq(events.length - 1))
    const forkSession = w.ctx.sessions.create(undefined, { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true } })
    const fork = { id: forkSession.id, session: forkSession, ctx: w.ctx } as never
    expect(foldSubagentDescriptor(forkSession.snapshotEvents())?.provider).toBe('agent-seat')
    expect(w.ctx.approval.overrideOf(forkSession)).toBe('ask')
    expect(real.prepareChild(fork)).toBe('not-a-seat')
    await expect(real.onApproval(fork, new AbortController().signal)(question())).resolves.toBe('reject')
    expect(w.waiting).toHaveLength(0)
    const grandSession = w.ctx.sessions.create()
    appendDelegatedPolicyOverrides(grandSession, captureDelegatedPolicyOverrides({ ...w.child, ctx: w.ctx } as never))
    const grandchild = { id: grandSession.id, session: grandSession } as Agent
    expect(w.ctx.approval.overrideOf(grandSession)).toBe('never')
    expect(real.prepareChild(grandchild)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(grandSession)).toBe('never')
  })

  it('leaves a gate-known session pinned when its descriptor is not the seat provider\'s', async () => {
    const w = await world()
    w.descriptors.set(w.child.id, 'subagent_claude_code')
    expect(w.relay.prepareChild(w.child)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('never')
  })

  it('ignores an ordinary child that a plugin set to ask: nothing is asked and the program is refused', async () => {
    const w = await world()
    const ordinary = agentOf(w.ctx)
    setApprovalPolicy(ordinary.session, 'ask')
    const answer = await w.relay.onApproval(ordinary, new AbortController().signal)(question())
    expect(answer).toBe('reject')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(ordinary, 'approval/asked')).toEqual([])
  })
})

describe('the lift at the first question', () => {
  const pin = (w: World): void => { w.child.session.append('approval/policy', { policy: 'never', source: 'delegation' }) }
  const policies = (w: World): unknown[] => w.events(w.child, 'approval/policy').map(data => data['policy'])

  it('lifts the pin once, however many questions follow', async () => {
    const w = await world()
    pin(w)
    expect(w.relay.liftOnce(w.child)).toBe('lifted')
    expect(w.relay.liftOnce(w.child)).toBe('kept')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('ask')
    expect(policies(w)).toEqual(['never', 'ask'])
  })

  it('appends nothing to a child whose latest policy is not the pin: a lift already logged or a switch of its own', async () => {
    const w = await world()
    pin(w)
    setApprovalPolicy(w.child.session, 'never')
    expect(w.relay.liftOnce(w.child)).toBe('kept')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('never')
    expect(policies(w)).toEqual(['never', 'never'])
  })

  it('has no pin to lift on a seat whose log holds no policy event', async () => {
    const w = await world()
    const bare = agentOf(w.ctx)
    w.seats.set(bare.id, { child: bare.id, root: w.root.id, provider: 'claude-code' })
    w.descriptors.set(bare.id, 'agent-seat')
    expect(w.relay.liftOnce(bare)).toBe('kept')
    expect(bare.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(false)
  })

  it('never lifts for a fork of a seat or a child of a seat, though both carry the seat descriptor and the pin', async () => {
    const w = await world()
    w.child.session.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'agent-seat', label: 'Fix the tests' } as never)
    pin(w)
    const real = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']),
      descriptorOf: agent => foldSubagentDescriptor(agent.session.snapshotEvents())?.provider,
      recorded: () => Promise.resolve(), recordName: (_a, name) => name, agentName: () => 'Claude Code',
    })
    const events = w.child.session.snapshotEvents()
    const seed = buildForkSeed(events, SessionSeq(events.length - 1))
    const forkSession = w.ctx.sessions.create(undefined, { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true } })
    const fork = { id: forkSession.id, session: forkSession, ctx: w.ctx } as never
    expect(foldSubagentDescriptor(forkSession.snapshotEvents())?.provider).toBe('agent-seat')
    const before = forkSession.snapshotEvents().length
    expect(real.liftOnce(fork)).toBe('not-a-seat')
    expect(forkSession.snapshotEvents()).toHaveLength(before)
    const grandSession = w.ctx.sessions.create()
    appendDelegatedPolicyOverrides(grandSession, captureDelegatedPolicyOverrides({ ...w.child, ctx: w.ctx } as never))
    grandSession.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'agent-seat', label: 'Nested' } as never)
    const grandchild = { id: grandSession.id, session: grandSession } as Agent
    expect(real.liftOnce(grandchild)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(grandSession)).toBe('never')
  })

  it('checks the registry and the exact descriptor name at the moment it lifts', async () => {
    const w = await world()
    pin(w)
    w.descriptors.set(w.child.id, 'subagent_claude_code')
    expect(w.relay.liftOnce(w.child)).toBe('not-a-seat')
    w.descriptors.set(w.child.id, 'agent-seat')
    w.seats.delete(w.child.id)
    expect(w.relay.liftOnce(w.child)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('never')
    expect(policies(w)).toEqual(['never'])
  })

  it('leaves a Session that is not a seat pinned', async () => {
    const w = await world()
    const ordinary = agentOf(w.ctx)
    ordinary.session.append('approval/policy', { policy: 'never', source: 'delegation' })
    expect(w.relay.liftOnce(ordinary)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(ordinary.session)).toBe('never')
  })
})

describe('the turn signal listener', () => {
  it('runs ahead of an earlier listener that decides the step without calling next', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    const child = agentOf(ctx)
    ctx.provide('externalAgents', { seat: (id: SessionId) => id === child.id ? { child: child.id, root: child.id, provider: 'claude-code' } : undefined } as never)
    ctx.provide('agents', { get: () => child, turnBoundaryOf: () => ({ openTurnStartSeq: 1 }) } as never)
    ctx.on('agent/pre-step', () => Promise.resolve({}) as never)
    let relay: SeatRelay | undefined
    await ctx.plugin(class {
      constructor(scope: Context) {
        relay = new SeatRelay(scope, {
          seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recorded: () => new Promise<void>(() => {}), recordName: (_a, name) => name, agentName: () => 'Claude Code',
        }, new UnmountedRunScope())
      }
    })
    const turn = new AbortController()
    await ctx.waterfall('agent/pre-step', { agent: child, messages: [], turn: 1, step: 1, signal: turn.signal } as never, (() => Promise.resolve({})) as never)
    const result = relay!.onApproval(child, new AbortController().signal)(question())
    await settle()
    expect(relay!.pendingOf(child.id)).toBe(true)
    turn.abort()
    await expect(result).resolves.toBe('cancel')
  })
})

describe('the question', () => {
  it('asks on the seat child with the external-agent marker, the recorded call and a plain reason', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const signal = new AbortController().signal
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ signal }))
    await settle()
    expect(w.waiting).toHaveLength(1)
    expect(w.waiting[0]?.request).toMatchObject({ toolName: 'claude_code.Bash', callId: 'call-1', reason: 'Claude Code says: Run `npm test`', displayReason: { en: 'Claude Code says: Run `npm test`', zh: 'Claude Code说：Run `npm test`' }, grants: 'external-agent' })
    expect(w.waiting[0]?.request.agent).toBe(w.child)
    w.answer('computer', 'allowed-once')
    await expect(result).resolves.toBe('allow-once')
    expect(w.events(w.child, 'approval/asked')).toHaveLength(1)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'allowed-once' }])
  })

  it('maps rejected to reject and an unanswered, unavailable question to reject', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const first = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    w.answer('locked-phone', 'rejected')
    await expect(first).resolves.toBe('reject')
    const second = w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-2' }))
    await settle()
    w.answer('computer', 'unavailable')
    await expect(second).resolves.toBe('reject')
  })

  it('refuses to send a question without the marker', () => {
    expect(() => { assertMarked({ agent: {} as Agent, toolName: 'x' }) }).toThrow('external-agent grant marker')
    expect(() => { assertMarked({ agent: {} as Agent, toolName: 'x', grants: EXTERNAL_AGENT_GRANT }) }).not.toThrow()
  })

  it('rejects, asking nobody, when the record of the call carries another tool name', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    w.child.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-9'), name: 'claude_code.Read', arguments: '{}' })
    const answer = await w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-9' }))
    expect(answer).toBe('reject')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/asked')).toEqual([])
  })

  it('rejects, asking nobody, when the ledger reported a call that the log holds no record of', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    let relay: SeatRelay | undefined
    await w.ctx.plugin(class {
      constructor(scope: Context) {
        relay = new SeatRelay(scope, {
          seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recordName: (_a, name) => `claude_code.${name}`, agentName: () => 'Claude Code',
          recorded: () => Promise.resolve(),
        }, new UnmountedRunScope())
      }
    })
    await expect(relay?.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-8' }))).resolves.toBe('reject')
    expect(w.waiting).toHaveLength(0)
  })

  it('holds the question until the seat recorded the call', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const held = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recordName: (_a, name) => `claude_code.${name}`, agentName: () => 'Claude Code',
      recorded: async (agent, callId) => {
        await gate
        agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name: 'claude_code.Bash', arguments: '{}' })
      },
    })
    const result = held.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/asked')).toEqual([])
    expect(held.pendingOf(w.child.id)).toBe(true)
    release()
    await settle()
    expect(w.waiting).toHaveLength(1)
    w.answer('computer', 'allowed-once')
    await expect(result).resolves.toBe('allow-once')
  })
})

describe('Full access', () => {
  it('allows with no card and logs the decision as allowed', async () => {
    const w = await world('never')
    w.relay.prepareChild(w.child)
    const answer = await w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    expect(answer).toBe('allow-once')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'allowed-once' }])
  })

  it('rejects with the decision logged, and no card, while the consent switch fullAccessStartsAgents is off', async () => {
    const w = await world('never')
    w.consent['fullAccessStartsAgents'] = () => false
    w.relay.prepareChild(w.child)
    const answer = await w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    expect(answer).toBe('reject')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'rejected' }])
  })

  it('rejects with the decision logged when the policy is never but the sandbox is not danger-full-access', async () => {
    const w = await world('never')
    w.sandbox.set(w.root.id, 'workspace-write')
    w.relay.prepareChild(w.child)
    await expect(w.relay.onApproval(w.child, new AbortController().signal)(question())).resolves.toBe('reject')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'rejected' }])
  })

  it('allows a later question without a card when the root enters Full access mid-run', async () => {
    const w = await world('ask')
    w.relay.prepareChild(w.child)
    const first = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    w.answer('computer', 'rejected')
    await first
    setApprovalPolicy(w.root.session, 'never')
    w.sandbox.set(w.root.id, 'danger-full-access')
    await expect(w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-2' }))).resolves.toBe('allow-once')
    expect(w.waiting).toHaveLength(1)
  })

  it('rejects, failing closed, when the consent service has no fullAccessStartsAgents switch', async () => {
    const w = await world('never')
    delete w.consent['fullAccessStartsAgents']
    w.relay.prepareChild(w.child)
    await expect(w.relay.onApproval(w.child, new AbortController().signal)(question())).resolves.toBe('reject')
    expect(w.waiting).toHaveLength(0)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'rejected' }])
  })

  it('asks as usual after the root leaves Full access', async () => {
    const w = await world('never')
    w.relay.prepareChild(w.child)
    setApprovalPolicy(w.root.session, 'ask')
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    expect(w.waiting).toHaveLength(1)
    w.answer('computer', 'rejected')
    await expect(result).resolves.toBe('reject')
  })

  it('does not allow a request another asker built, even with the marker', async () => {
    const w = await world('never')
    w.relay.prepareChild(w.child)
    const outcome = w.ctx.approval.request({ agent: w.child, toolName: 'x', grants: 'external-agent' })
    await settle()
    expect(w.waiting).toHaveLength(1)
    w.answer('computer', 'rejected')
    await expect(outcome).resolves.toBe('rejected')
  })
})

describe('ending a question', () => {
  /** Stop the seat turn as the loop does at its stop boundary, before `turn/end` is written. */
  async function stopTurn(w: World): Promise<void> {
    await w.ctx.serial('agent/turn-stopping', { agent: w.child, turn: 1, signal: new AbortController().signal })
    w.child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }

  it('answers cancel at stop and when the program withdraws it, and clears the waiting state', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const changes: boolean[] = []
    w.relay.onPendingChange((_child, waiting) => { changes.push(waiting) })
    const stop = new AbortController()
    const stopped = w.relay.onApproval(w.child, stop.signal)(question())
    await settle()
    expect(w.relay.pendingOf(w.child.id)).toBe(true)
    stop.abort()
    await expect(stopped).resolves.toBe('cancel')
    const withdrawn = new AbortController()
    const second = w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-2', signal: withdrawn.signal }))
    await settle()
    withdrawn.abort()
    await expect(second).resolves.toBe('cancel')
    expect(w.relay.pendingOf(w.child.id)).toBe(false)
    expect(changes).toEqual([true, false, true, false])
  })

  it('logs the cancelled decision before the turn ends, from the stop boundary', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const types: string[] = []
    w.ctx.on('session/event', (session, event) => { if (session === w.child.session && (event.type === 'approval/decided' || event.type === 'turn/end')) types.push(event.type) })
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    await stopTurn(w)
    await expect(result).resolves.toBe('cancel')
    expect(types).toEqual(['approval/decided', 'turn/end'])
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'cancelled' }])
  })

  it('settles on the turn\'s own abort signal, before turn/end, when Stop writes no stop boundary', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const turn = new AbortController()
    await w.ctx.waterfall('agent/pre-step', { agent: w.child, messages: [], turn: 1, step: 1, signal: turn.signal } as never, (() => Promise.resolve({})) as never)
    const types: string[] = []
    w.ctx.on('session/event', (session, event) => { if (session === w.child.session && (event.type === 'approval/decided' || event.type === 'turn/end')) types.push(event.type) })
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    turn.abort()
    await expect(result).resolves.toBe('cancel')
    w.child.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } } as never)
    expect(types).toEqual(['approval/decided', 'turn/end'])
  })

  it('cancels at a bare turn end with a warning when no stop boundary came', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    w.child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(result).resolves.toBe('cancel')
    expect(w.relay.pendingOf(w.child.id)).toBe(false)
  })

  it('stops a wait for a record that never comes', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const never = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recordName: (_a, name) => name, agentName: () => 'Claude Code', recorded: () => new Promise<void>(() => {}),
    })
    const stop = new AbortController()
    const result = never.onApproval(w.child, stop.signal)(question())
    await settle()
    expect(never.pendingOf(w.child.id)).toBe(true)
    stop.abort()
    await expect(result).resolves.toBe('cancel')
    expect(never.pendingOf(w.child.id)).toBe(false)
  })

  it('cancels when the seat is gone by the time the call is recorded', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    let release: () => void = () => {}
    const held = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recordName: (_a, name) => name, agentName: () => 'Claude Code', recorded: () => new Promise<void>((resolve) => { release = resolve }),
    })
    const result = held.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    w.seats.delete(w.child.id)
    release()
    await expect(result).resolves.toBe('cancel')
    expect(w.waiting).toHaveLength(0)
  })

  it('answers cancel, not reject, for a question between turns', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    w.openTurns.delete(w.child.id)
    await expect(w.relay.onApproval(w.child, new AbortController().signal)(question())).resolves.toBe('cancel')
    expect(w.waiting).toHaveLength(0)
  })
})

/**
 * The relay's answer as the start gate settles it: `allow-run` stays only when the consent keeps the rule.
 * @param w - the world.
 * @param request - the program's question.
 * @returns the answer the program gets.
 */
async function viaGate(w: World, request: ProgramApprovalRequest) {
  const answer = await w.relay.onApproval(w.child, new AbortController().signal)(request)
  const consent = w.consent as { addRunRule(child: SessionId, rule: ProgramRunRule): boolean }
  return answer === 'allow-run' && !(request.runRule !== undefined && consent.addRunRule(w.child.id, request.runRule)) ? 'allow-once' : answer
}

const runAllowed = (w: World): Array<{ seq: number, ignorable?: true, data: unknown }> => w.child.session.snapshotEvents()
  .filter(event => (event.type as string) === 'plugin:delorun/agent-seat/run-allowed')

describe('the log of Allow for this run', () => {
  it('appends a run-allowed record naming the question once the gate kept the rule', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = viaGate(w, question({ runRule: RULE }))
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(result).resolves.toBe('allow-run')
    await settle()
    const asked = w.child.session.snapshotEvents().find(event => event.type === 'approval/asked')
    expect(runAllowed(w)).toMatchObject([{ ignorable: true, data: { askedSeq: asked?.seq } }])
    expect(w.kept).toEqual([RULE])
  })

  it('appends nothing when the gate falls back to allow once because the lease is gone', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    w.leased = false
    const result = viaGate(w, question({ runRule: RULE }))
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(result).resolves.toBe('allow-once')
    await settle()
    expect(runAllowed(w)).toEqual([])
    expect(w.kept).toEqual([])
  })

  it('appends nothing for Allow once', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = viaGate(w, question({ runRule: RULE }))
    await settle()
    w.answer('computer', 'allowed-once')
    await expect(result).resolves.toBe('allow-once')
    await settle()
    expect(runAllowed(w)).toEqual([])
  })
})

describe('Allow for this run', () => {
  it('offers the run scope only when the program offered a rule', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const plain = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    expect(w.waiting[0]?.request.runScope).toBeUndefined()
    w.answer('computer', 'rejected')
    await plain
    const offered = w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-2', runRule: RULE }))
    await settle()
    expect(w.waiting[1]?.request.runScope).toBe('external-agent-run')
    w.answer('computer', 'rejected')
    await offered
  })

  it('turns the computer\'s for-run answer into allowed-once and tells the gate to keep the rule', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(result).resolves.toBe('allow-run')
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'allowed-once' }])
  })

  it('accepts a for-run answer from an unlocked PIN page', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    expect(w.answer('pin-page', RUN_ANSWER)).toBe('applied')
    await expect(result).resolves.toBe('allow-run')
  })

  it('refuses a code-unlocked phone any granting answer and lets it reject', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    expect(() => w.answer('code-phone', 'allowed-once')).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => w.answer('code-phone', RUN_ANSWER)).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(w.answer('code-phone', 'rejected')).toBe('applied')
    await expect(result).resolves.toBe('reject')
  })

  it('refuses a for-run answer to a request without runScope', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question())
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(result).resolves.toBe('reject')
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'unavailable' }])
  })

  it('refuses a for-run answer while the listener is unmounted', async () => {
    const w = await world('ask', false)
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(result).resolves.toBe('reject')
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'unavailable' }])
  })

  it('refuses a for-run answer to a runScope request the relay did not build', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const outcome = w.ctx.approval.request({ agent: w.child, toolName: 'x', grants: 'external-agent', runScope: 'external-agent-run' })
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(outcome).resolves.toBe('unavailable')
  })

  it('does not carry a for-run answer to the next request', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const first = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    w.answer('computer', RUN_ANSWER)
    await expect(first).resolves.toBe('allow-run')
    const second = w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-2', runRule: RULE }))
    await settle()
    w.answer('computer', 'allowed-once')
    await expect(second).resolves.toBe('allow-once')
  })
})
