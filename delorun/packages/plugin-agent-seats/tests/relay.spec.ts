/**
 * Specs of the seat relay (trust path): the lifted pin on a seat child only, the question and its marker, the wait for
 * the call's record, Full access, stop and turn end, and "Allow for this run" through the Host half. A stand-in for the
 * gateway settles the first answer that passes its guard; the guard here applies the reach rule of home-auth's
 * `checkAnswer`; home-auth's own `authenticator.spec.ts` pins that rule against the real guard, including that an
 * answer outside the four outcomes counts as granting.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ProgramApprovalRequest, SeatRecord } from '@delorun/external-agents/contract'
import { describe, expect, it, onTestFinished } from 'vitest'
import { assertMarked, EXTERNAL_AGENT_GRANT, RUN_ANSWER, RunScope, SeatRelay, type SeatRelayOptions } from '../src/relay/index.ts'

/** Who answers: the home's computer, a PIN-unlocked page, a code-unlocked phone, or a locked phone. */
type Peer = 'computer' | 'pin-page' | 'code-phone' | 'locked-phone'

/** A refusal as the gateway sees it. */
class LoopbackRequired extends Error {
  readonly code = 'LOOPBACK_REQUIRED'
}

/**
 * The reach rule for the `external-agent` marker: any value but a refusal grants; only the computer and a PIN-unlocked
 * page may give it.
 * @param peer - who answers.
 * @param value - the raw answer.
 */
function guard(peer: Peer, value: unknown): void {
  if (value === 'rejected' || value === 'cancelled' || value === 'unavailable') return
  if (peer === 'computer' || peer === 'pin-page') return
  throw new LoopbackRequired('This needs you at your computer')
}

interface Waiting {
  readonly request: ApprovalRequest
  readonly resolve: (value: never) => void
  settled: boolean
}

interface World {
  readonly ctx: Context
  readonly relay: SeatRelay
  readonly root: Agent
  readonly child: Agent
  readonly waiting: Waiting[]
  readonly recorded: Map<string, () => void>
  readonly seats: Map<string, SeatRecord>
  readonly descriptors: Map<string, string>
  readonly events: (agent: Agent, type: string) => Array<Record<string, unknown>>
  /** Answer the latest pending question as a client; returns whether the gateway applied it. */
  answer(peer: Peer, value: unknown, which?: number): 'applied' | 'ignored'
}

/**
 * An agent with a real Session and an open turn.
 * @param ctx - the context holding the session store.
 * @returns the agent.
 */
function agentOf(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }), { surfaceOp: 'append' })
  return { id: session.id, session } as Agent
}

/**
 * The relay over a real approval service and a stand-in gateway.
 * @param rootPolicy - the root chat's approval policy.
 */
async function world(rootPolicy: 'ask' | 'never' = 'ask', mountListener = true): Promise<World> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const root = agentOf(ctx)
  const child = agentOf(ctx)
  setApprovalPolicy(root.session, rootPolicy)
  setApprovalPolicy(child.session, 'never')
  const seats = new Map<string, SeatRecord>([[child.id, { child: child.id, root: root.id, provider: 'claude-code' }]])
  const descriptors = new Map<string, string>([[child.id, 'agent-seat']])
  const agents = new Map<string, Agent>([[root.id, root], [child.id, child]])
  ctx.provide('externalAgents', { seat: (id: SessionId) => seats.get(id) } as never)
  ctx.provide('agents', { get: (id: string) => agents.get(id) } as never)
  const recorded = new Map<string, () => void>()
  const options: SeatRelayOptions = {
    seatProviders: new Set(['agent-seat']),
    descriptorOf: agent => descriptors.get(agent.id),
    recorded: (_agent, callId) => new Promise<void>((resolve) => { recorded.set(callId, resolve); resolve() }),
    recordName: (_agent, toolName) => `claude_code.${toolName}`,
  }
  let relay: SeatRelay | undefined
  await ctx.plugin(class { constructor(scope: Context) { relay = new SeatRelay(scope, options, mountListener ? new RunScope() : new UnmountedRunScope()) } })
  if (relay === undefined) throw new Error('relay not built')
  const log = new Map<string, Array<{ type: string, data: Record<string, unknown> }>>()
  ctx.on('session/event', (session, event) => {
    log.set(session.id, [...log.get(session.id) ?? [], { type: event.type, data: { ...event.data } }])
  })
  const waiting: Waiting[] = []
  ctx.on('approval/request', request => new Promise((resolve) => { waiting.push({ request, resolve, settled: false }) }))
  const events = (agent: Agent, type: string): Array<Record<string, unknown>> => {
    return (log.get(agent.id) ?? []).filter(event => event.type === type).map(event => ({ ...event.data }))
  }
  return {
    ctx, relay, root, child, waiting, recorded, seats, descriptors, events,
    answer(peer, value, which = waiting.length - 1) {
      const entry = waiting[which]
      if (entry === undefined) throw new Error('no question is pending')
      guard(peer, value)
      if (entry.settled) return 'ignored'
      entry.settled = true
      entry.resolve(value as never)
      return 'applied'
    },
  }
}

/** A run-scope state whose listener is not registered. */
class UnmountedRunScope extends RunScope {
  override mount(): () => boolean { return () => false }
}

/** A question from the program. */
function question(overrides: Partial<ProgramApprovalRequest> = {}): ProgramApprovalRequest {
  return { callId: 'call-1', toolName: 'Bash', reason: 'Run `npm test`', signal: new AbortController().signal, ...overrides }
}

const RULE = { provider: 'claude-code', summary: 'Run `npm test`', data: { rule: 'Bash(npm test)' } } as const

/** Let queued promise work finish. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('the lifted pin', () => {
  it('appends ask after the delegation pin on a seat child', async () => {
    const w = await world()
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('never')
    expect(w.relay.prepareChild(w.child)).toBe('lifted')
    expect(w.ctx.approval.overrideOf(w.child.session)).toBe('ask')
    expect(w.events(w.child, 'approval/policy').map(data => data['policy'])).toEqual(['ask'])
  })

  it('leaves a child the gate does not know pinned: a fork, a child of a seat, any other child', async () => {
    const w = await world()
    const other = agentOf(w.ctx)
    setApprovalPolicy(other.session, 'never')
    w.descriptors.set(other.id, 'agent-seat')
    expect(w.relay.prepareChild(other)).toBe('not-a-seat')
    expect(w.ctx.approval.overrideOf(other.session)).toBe('never')
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

describe('the question', () => {
  it('asks on the seat child with the external-agent marker, the recorded call and a plain reason', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const signal = new AbortController().signal
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ signal }))
    await settle()
    expect(w.waiting).toHaveLength(1)
    expect(w.waiting[0]?.request).toMatchObject({ toolName: 'claude_code.Bash', callId: 'call-1', reason: 'Run `npm test`', displayReason: { en: 'Run `npm test`' }, grants: 'external-agent' })
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

  it('holds the question until the seat recorded the call', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const held = new SeatRelay(w.ctx, {
      seatProviders: new Set(['agent-seat']), descriptorOf: () => 'agent-seat', recordName: (_a, name) => name, recorded: () => gate,
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
    w.ctx.provide('delegationConsent', { fullAccessStartsAgents: () => false } as never)
    w.relay.prepareChild(w.child)
    const answer = await w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    expect(answer).toBe('reject')
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
  it('answers cancel at stop, when the program withdraws it and at the end of the turn, and clears the waiting state', async () => {
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
    const third = w.relay.onApproval(w.child, new AbortController().signal)(question({ callId: 'call-3' }))
    await settle()
    w.child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(third).resolves.toBe('cancel')
    expect(w.relay.pendingOf(w.child.id)).toBe(false)
    expect(changes).toEqual([true, false, true, false, true, false])
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

  it('refuses a locked phone\'s for-run answer, leaves the question pending and logs no decision', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    expect(() => w.answer('locked-phone', RUN_ANSWER)).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    await settle()
    expect(w.relay.pendingOf(w.child.id)).toBe(true)
    expect(w.events(w.child, 'approval/decided')).toEqual([])
    w.answer('computer', 'allowed-once')
    await expect(result).resolves.toBe('allow-once')
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

  it('gives allow-once, with no run mark, when another client\'s Allow once came first', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    expect(w.answer('pin-page', 'allowed-once')).toBe('applied')
    expect(w.answer('computer', RUN_ANSWER)).toBe('ignored')
    await expect(result).resolves.toBe('allow-once')
  })

  it('gives allow-once after a refused for-run answer on one client and Allow once on another', async () => {
    const w = await world()
    w.relay.prepareChild(w.child)
    const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
    await settle()
    expect(() => w.answer('locked-phone', RUN_ANSWER)).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(w.answer('computer', 'allowed-once')).toBe('applied')
    await expect(result).resolves.toBe('allow-once')
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
