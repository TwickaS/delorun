/**
 * Specs of the real-browser grant through the real agent loop, session log and approval service, with a scripted model:
 * the `use_my_browser` ask and its answers, the events it records, the projection's answer across a fork, the away
 * permission, and the guard that refuses a browse call in a turn that may not use the grant.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { AWAY_REFUSAL, declinedRefusal, grantedAnswer, NO_GRANT_REFUSAL, UNANSWERABLE_REFUSAL } from '../src/copy.ts'
import { applyGrantEvent, registerGrants, type GrantState, type RealBrowserGrants } from '../src/grant.ts'
import { guardBrowseCalls, useMyBrowserTool } from '../src/tool.ts'

interface Harness {
  readonly ctx: Context
  readonly grants: RealBrowserGrants
  readonly asks: ApprovalRequest[]
  readonly clock: { now: number }
  readonly browseCalls: string[]
}

/**
 * The loop with the grant's pieces, a stand-in `mcp__browse__execute` that records each call it runs, and an answerer.
 * @param adapter - the scripted model.
 * @param answer - the person's answer, or none for no answerer at all.
 * @returns the harness.
 */
async function harness(adapter: MockAdapter, answer?: () => ApprovalOutcome): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const clock = { now: 1_000 }
  const grants = await registerGrants(ctx, () => clock.now)
  const asks: ApprovalRequest[] = []
  if (answer !== undefined) {
    ctx.on('approval/request', (request: ApprovalRequest) => {
      asks.push(request)
      return Promise.resolve(answer())
    })
  }
  const browseCalls: string[] = []
  ctx.tools.register(useMyBrowserTool(ctx, grants))
  ctx.tools.register(defineTool({
    name: 'mcp__browse__execute',
    description: 'stand-in for browse',
    parameters: { code: { type: 'string', required: true, description: 'script' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text' as const, text: 'ran' }],
    },
    execute: (args) => { browseCalls.push(args.code); return Promise.resolve({ ran: true }) },
  }))
  guardBrowseCalls(ctx, grants)
  return { ctx, grants, asks, clock, browseCalls }
}

/** Run one prompt to idle. */
async function run(ctx: Context, agent: Agent, text: string, kind: 'user' | 'schedule' = 'user'): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind } as never }))
  await idle
}

/** The model-visible text of every tool result in the log, in order. */
function results(agent: Agent): string[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .map(event => JSON.stringify((event as Extract<SessionEvent, { type: 'tool/result' }>).data.message.content))
}

/** The types of the `approval/*` and `real-browser/*` events, in order. */
function grantEvents(agent: Agent): string[] {
  return agent.session.snapshotEvents().map(event => event.type).filter(type => type.startsWith('approval/') || type.startsWith('real-browser/'))
}

const ASK = toolCallResponse('c1', 'use_my_browser', { reason: 'check my order on the shop' })
const BROWSE = toolCallResponse('c2', 'mcp__browse__execute', { code: 'page.title()' })

describe('use_my_browser', () => {
  it('raises the real-browser card, and Allow records approval/decided then real-browser/granted naming the ask', async () => {
    const h = await harness(new MockAdapter([ASK, BROWSE, textResponse('done')]), () => 'allowed-once')
    const agent = await h.ctx.agentLoop.create(SessionId('allow'), { provider: 'mock', model: 'mock' })
    await run(h.ctx, agent, 'check my order')
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0]).toMatchObject({ toolName: 'use_my_browser', grants: 'real-browser' })
    expect(grantEvents(agent)).toEqual(['approval/asked', 'approval/decided', 'real-browser/granted'])
    const log = agent.session.snapshotEvents()
    const asked = log.find(event => event.type === 'approval/asked')
    expect(log.find(event => event.type === 'real-browser/granted')?.data).toEqual({ source: { kind: 'approval', askedSeq: asked?.seq } })
    expect(h.grants.view(agent.session)).toEqual({ live: true, awayUntil: null })
    expect(results(agent)[0]).toContain(JSON.stringify(grantedAnswer('check my order on the shop')).slice(1, -1))
    // The person's own turn may use the grant.
    expect(h.browseCalls).toEqual(['page.title()'])
  })

  it('records no grant on "Not now", and the browse call is refused before it runs', async () => {
    const h = await harness(new MockAdapter([ASK, BROWSE, textResponse('ok')]), () => 'rejected')
    const agent = await h.ctx.agentLoop.create(SessionId('not-now'), { provider: 'mock', model: 'mock' })
    await run(h.ctx, agent, 'check my order')
    expect(grantEvents(agent)).toEqual(['approval/asked', 'approval/decided'])
    expect(h.grants.live(agent.session)).toBe(false)
    expect(results(agent)[0]).toContain(declinedRefusal('rejected'))
    expect(results(agent)[1]).toContain(NO_GRANT_REFUSAL)
    expect(h.browseCalls).toEqual([])
  })

  it('tells a run where nobody can answer, such as a headless one, in one sentence, and records nothing', async () => {
    const h = await harness(new MockAdapter([ASK, textResponse('ok')]))
    const agent = await h.ctx.agentLoop.create(SessionId('headless'), { provider: 'mock', model: 'mock' })
    await run(h.ctx, agent, 'check my order')
    expect(grantEvents(agent)).toEqual(['approval/asked', 'approval/decided'])
    expect(results(agent)[0]).toContain(UNANSWERABLE_REFUSAL)
  })

  it('asks nobody in a scheduled run, and refuses it in one sentence', async () => {
    const h = await harness(new MockAdapter([ASK, textResponse('ok')]), () => 'allowed-once')
    const agent = await h.ctx.agentLoop.create(SessionId('scheduled-ask'), { provider: 'mock', model: 'mock' })
    await run(h.ctx, agent, 'nightly check', 'schedule')
    expect(h.asks).toEqual([])
    expect(grantEvents(agent)).toEqual([])
    expect(results(agent)[0]).toContain(AWAY_REFUSAL)
  })
})

describe('the grant in later runs', () => {
  it('admits a scheduled run in a granted chat only while the away permission runs, and the end turns everything off', async () => {
    const h = await harness(new MockAdapter([ASK, textResponse('allowed'), BROWSE, textResponse('a'), BROWSE, textResponse('b'), BROWSE, textResponse('c'), BROWSE, textResponse('d')]), () => 'allowed-once')
    const agent = await h.ctx.agentLoop.create(SessionId('scheduled'), { provider: 'mock', model: 'mock' })
    await run(h.ctx, agent, 'check my order')
    expect(h.grants.admitted(agent)).toBe(true)
    // Pins the away rule: without the permission a scheduled turn is refused, with its sentence.
    await run(h.ctx, agent, 'nightly check', 'schedule')
    expect(h.browseCalls).toEqual([])
    expect(results(agent).at(-1)).toContain(AWAY_REFUSAL)
    expect(h.grants.setAway(agent.session, 2_000)).toBe(true)
    await run(h.ctx, agent, 'nightly check', 'schedule')
    expect(h.browseCalls).toEqual(['page.title()'])
    // Pins the lapse: after `until` the scheduled turn is refused again.
    h.clock.now = 2_000
    await run(h.ctx, agent, 'nightly check', 'schedule')
    expect(h.browseCalls).toEqual(['page.title()'])
    expect(results(agent).at(-1)).toContain(AWAY_REFUSAL)
    // Pins the end: turning it off ends the grant and its away permission, logged, and the person's own turn is refused.
    expect(h.grants.end(agent.session)).toBe(true)
    expect(h.grants.view(agent.session)).toEqual({ live: false, awayUntil: null })
    await run(h.ctx, agent, 'check again')
    expect(h.browseCalls).toEqual(['page.title()'])
    expect(results(agent).at(-1)).toContain(NO_GRANT_REFUSAL)
    expect(grantEvents(agent).filter(type => type.startsWith('real-browser/'))).toEqual(['real-browser/granted', 'real-browser/away', 'real-browser/ended'])
    expect(h.grants.end(agent.session)).toBe(false)
    expect(h.grants.setAway(agent.session, 9_000)).toBe(false)
  })
})

describe('the projection', () => {
  const state = (fields: Partial<GrantState> = {}): GrantState => ({ inherited: 0, grantedSeq: null, awayUntil: null, attended: false, ...fields })
  const event = (seq: number, type: string, data: unknown): SessionEvent => ({ seq, time: 0, type, data } as never)

  it('ignores a grant the Session inherited from the chat it was forked from', () => {
    const forked = state({ inherited: 5 })
    expect(applyGrantEvent(forked, event(3, 'real-browser/granted', {}))).toBe(forked)
    expect(applyGrantEvent(forked, event(5, 'real-browser/granted', {}))).toEqual(state({ inherited: 5, grantedSeq: 5 }))
  })

  it('counts only the person\'s own prompt as attending a turn, and starts each turn unattended', () => {
    const user = (kind: string): SessionEvent => event(2, 'user/message', { source: { kind } })
    expect(applyGrantEvent(state(), user('user')).attended).toBe(true)
    expect(applyGrantEvent(state(), user('retry')).attended).toBe(true)
    for (const kind of ['schedule', 'webhook', 'goal', 'tool-jobs', 'time-context', 'an-unknown-kind']) {
      expect(applyGrantEvent(state(), user(kind)), kind).toEqual(state())
    }
    expect(applyGrantEvent(state({ attended: true }), event(3, 'turn/start', { turn: 2 })).attended).toBe(false)
    const quiet = state()
    expect(applyGrantEvent(quiet, event(4, 'step/start', {}))).toBe(quiet)
  })

  it('keeps the away permission only while a grant runs', () => {
    expect(applyGrantEvent(state(), event(1, 'real-browser/away', { until: 9 }))).toEqual(state())
    const granted = state({ grantedSeq: 1 })
    expect(applyGrantEvent(granted, event(2, 'real-browser/away', { until: 9 }))).toEqual(state({ grantedSeq: 1, awayUntil: 9 }))
    expect(applyGrantEvent(state({ grantedSeq: 1, awayUntil: 9 }), event(3, 'real-browser/ended', { reason: 'person' }))).toEqual(state())
  })
})
