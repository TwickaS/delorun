/**
 * The guard driven through a real agent loop against a scripted model (no network): when a turn stops, what the model
 * reads first, what does not count, and what starts a fresh count.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId, type ContextFormed, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { APPROVAL_CANCELLED, APPROVAL_REJECTED } from '@deepseek-ai/dsh-tools/src/error-codes.ts'
import * as Guard from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message that is not the person's, such as a background job's completion notice. */
    'guard-test-notice': { kind: 'guard-test-notice' } & ContextFormed
  }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** The person's refusals and cancellations, as the tools registry codes them. */
const NEUTRAL_CODES = [APPROVAL_REJECTED, APPROVAL_CANCELLED, TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH]

/** The row's Config with the shipped limits, switched on unless a test says otherwise. */
function configOf(overrides: Partial<Guard.Config> = {}): Guard.Config {
  return { enabled: true, consecutiveFailures: 6, windowSize: 12, windowFailures: 8, reminderAfter: 3, exclude: [], stderrNotice: false, ...overrides }
}

/** Boot the loop with a failing tool, a working tool and the guard; `before` runs before the guard mounts. */
async function harness(config: Guard.Config = configOf(), before?: (ctx: Context) => void): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  before?.(ctx)
  await ctx.plugin(Guard, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'browser', description: 'b', parameters: {},
    async execute() { throw new Error('Executable doesn\'t exist at chromium-1243') },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'ls', description: 'l', parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return ctx
}

/** Calls of `tool`, one per step, named `c<n>`. */
function calls(tool: string, count: number, from = 0): Script {
  return Array.from({ length: count }, (_, index) => toolCallResponse(`c${from + index}`, tool, {}))
}

/** One model response that calls `tool` once for each id, in parallel. */
function parallelCalls(tool: string, ids: string[]): StreamChunk[] {
  return [
    ...ids.flatMap((id, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name: tool, arguments: '{}' } },
    ]),
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A message from someone other than the person. */
function notice(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'guard-test-notice' } })
}

/** Call `act` on the agent once its `n`th tool result is final. */
function onResult(ctx: Context, n: number, act: () => void): void {
  let seen = 0
  ctx.on('tools/result', () => {
    seen += 1
    if (seen === n) act()
  })
}

/** Run one person's message to idle and return the agent's adapter requests. */
async function runTurn(ctx: Context, agent: Agent, text = 'open the page'): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

/** Create an agent served by a scripted adapter; `id` names both its session and its provider. */
async function agentWith(ctx: Context, script: Script, id = 'guard'): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter([id], adapter)
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: id, model: 'mock' })
  return { agent, adapter }
}

/** The agent's turn endings, in order. */
function turnEnds(agent: Agent): SessionEvent<'turn/end'>['data']['reason'][] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    .map(event => event.data.reason)
}

/** The guard's reminders the model read, as text. */
function reminders(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'tool-failure-guard')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

const STOPPED = { kind: 'aborted', reason: { kind: 'hook', reason: Guard.TOOL_FAILURE_GUARD_STOP_REASON } }

describe('stopping a turn', () => {
  it('stops after six failed calls in a row, before a seventh model request', async () => {
    const ctx = await harness()
    const { agent, adapter } = await agentWith(ctx, [...calls('browser', 10), textResponse('never')])
    await runTurn(ctx, agent)
    expect(adapter.requests).toHaveLength(6)
    expect(turnEnds(agent)).toEqual([STOPPED])
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(6)
  })

  it('reminds the model once, after the third failure in a row, in a logged notice', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 10), textResponse('never')])
    await runTurn(ctx, agent)
    expect(reminders(agent)).toEqual([
      'The last 3 tool calls failed. If a tool is unavailable or keeps failing the same way, stop and tell the user '
      + 'what failed and what they can do about it, instead of trying other tools to work around it. This turn stops '
      + 'after 6 failed tool calls in a row.',
    ])
    const notice = agent.session.snapshotEvents().find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind === 'tool-failure-guard')
    expect(notice?.data.source).toEqual({ kind: 'tool-failure-guard', form: 'notice', summary: '3 failed tool calls' })
  })

  it('reminds once per count, even when a second run reaches three', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 3), ...calls('ls', 1, 3), ...calls('browser', 3, 4), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(reminders(agent)).toHaveLength(1)
  })

  it('counts each of several failed calls in one step', async () => {
    const ctx = await harness()
    const { agent, adapter } = await agentWith(ctx, [
      parallelCalls('browser', ['p1', 'p2', 'p3', 'p4']), parallelCalls('browser', ['p5', 'p6']), textResponse('never'),
    ])
    await runTurn(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(turnEnds(agent)).toEqual([STOPPED])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(6)
  })

  it('counts calls that fail before tools/post-execute, such as a throwing policy listener', async () => {
    const ctx = await harness()
    ctx.on('tools/pre-execute', () => { throw new Error('policy store unavailable') })
    const { agent } = await agentWith(ctx, [...calls('ls', 8), textResponse('never')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
  })

  it('stops before later pre-step listeners run, so none of them spends a request', async () => {
    let preSteps = 0
    const ctx = await harness(configOf(), (early) => {
      early.on('agent/pre-step', (_payload, next) => { preSteps += 1; return next() })
    })
    const { agent } = await agentWith(ctx, [...calls('browser', 10), textResponse('never')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
    expect(preSteps).toBe(6)
  })

  it('stops a turn that fails 8 of its last 12 calls even when no run reaches six', async () => {
    const ctx = await harness()
    const script: Script = []
    for (let round = 0; round < 6; round++) script.push(...calls('browser', 2, round * 3), ...calls('ls', 1, round * 3 + 2))
    const { agent, adapter } = await agentWith(ctx, [...script, textResponse('never')])
    await runTurn(ctx, agent)
    // F F S F F S F F S F F: the eleventh call is the eighth failure in the window.
    expect(adapter.requests).toHaveLength(11)
    expect(turnEnds(agent)).toEqual([STOPPED])
    expect(reminders(agent)).toEqual([])
  })

  it('lets a turn that recovers finish', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 5), ...calls('ls', 1, 5), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })
})

describe('the headless line', () => {
  it('writes one line to standard error on a stop with stderrNotice on', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const ctx = await harness(configOf({ stderrNotice: true }))
      const { agent } = await agentWith(ctx, [...calls('browser', 6), textResponse('never')])
      await runTurn(ctx, agent)
      expect(write.mock.calls.filter(([chunk]) => chunk === Guard.STDERR_NOTICE)).toHaveLength(1)
    } finally {
      write.mockRestore()
    }
  })

  it('writes nothing with stderrNotice off, the studio value', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const ctx = await harness()
      const { agent } = await agentWith(ctx, [...calls('browser', 6), textResponse('never')])
      await runTurn(ctx, agent)
      expect(turnEnds(agent)).toEqual([STOPPED])
      expect(write.mock.calls.filter(([chunk]) => chunk === Guard.STDERR_NOTICE)).toHaveLength(0)
    } finally {
      write.mockRestore()
    }
  })
})

describe('what does not count', () => {
  it.each(NEUTRAL_CODES)('ignores calls that end with %s', async (code) => {
    const ctx = await harness()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'refused', info: { name: 'ApprovalError', code } }))
    const { agent } = await agentWith(ctx, [...calls('ls', 8), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(reminders(agent)).toEqual([])
  })

  it('counts a call a policy refused', async () => {
    const ctx = await harness()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'outside the workspace' }))
    const { agent } = await agentWith(ctx, [...calls('ls', 8), textResponse('never')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
  })

  it('agrees with the registry\'s codes for refusals and cancellations', () => {
    for (const code of NEUTRAL_CODES) expect(Guard.outcomeOf(true, code)).toBe('neutral')
    expect(Guard.outcomeOf(true, 'UNKNOWN')).toBe('failure')
  })

  it('ignores failed calls of excluded tools', async () => {
    const ctx = await harness(configOf({ exclude: ['brow*'] }))
    const { agent } = await agentWith(ctx, [...calls('browser', 8), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('does not let a working excluded tool end a run of failures', async () => {
    const ctx = await harness(configOf({ exclude: ['ls'] }))
    const { agent } = await agentWith(ctx, [...calls('browser', 3), ...calls('ls', 1, 3), ...calls('browser', 4, 4), textResponse('never')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
  })

  it('registers nothing with the switch off, the parity value', async () => {
    const ctx = await harness(configOf({ enabled: false }))
    const { agent } = await agentWith(ctx, [...calls('browser', 8), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(reminders(agent)).toEqual([])
  })
})

describe('carrying on', () => {
  it('starts a fresh count with the person\'s next message', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [
      ...calls('browser', 4), textResponse('Chromium is missing.'),
      ...calls('browser', 4, 10), textResponse('Still missing.'),
    ])
    await runTurn(ctx, agent)
    await runTurn(ctx, agent, 'try again')
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('starts a fresh count when the person steers during the turn', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 5), ...calls('browser', 5, 5), textResponse('done')])
    onResult(ctx, 5, () => { agent.steer(createUserMessage({ content: [{ type: 'text', text: 'keep trying' }], source: { kind: 'user' } })) })
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('starts a fresh count with each turn, whatever wakes it', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 5), textResponse('Stuck.'), ...calls('browser', 1, 5), textResponse('done')])
    await runTurn(ctx, agent)
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(notice('the build finished'))
    await idle
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('keeps each agent\'s count apart', async () => {
    const ctx = await harness()
    const first = await agentWith(ctx, [...calls('browser', 4), textResponse('done')], 'first')
    const second = await agentWith(ctx, [...calls('browser', 4), textResponse('done')], 'second')
    await Promise.all([runTurn(ctx, first.agent), runTurn(ctx, second.agent)])
    expect(turnEnds(first.agent)).toEqual([{ kind: 'completed' }])
    expect(turnEnds(second.agent)).toEqual([{ kind: 'completed' }])
  })

  it('keeps a message that arrived for the stopped step and sends it with the next turn', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 6), textResponse('The build finished.')])
    onResult(ctx, 6, () => { agent.steer(notice('the build finished')) })
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
    expect(agent.inbox.nextStep.map(message => message.source.kind)).toEqual(['guard-test-notice'])
    await runTurn(ctx, agent, 'carry on')
    expect(turnEnds(agent)).toEqual([STOPPED, { kind: 'completed' }])
    const logged = agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind === 'guard-test-notice')
    expect(logged).toHaveLength(1)
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn]).toEqual([])
  })

  it('drops its own reminder from the stopped step', async () => {
    const ctx = await harness(configOf({ reminderAfter: 5 }))
    const { agent } = await agentWith(ctx, [parallelCalls('browser', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']), textResponse('never')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([STOPPED])
    expect(reminders(agent)).toEqual([])
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn]).toEqual([])
  })

  it('runs the person\'s next message after a stop', async () => {
    const ctx = await harness()
    const { agent } = await agentWith(ctx, [...calls('browser', 6), textResponse('Chromium is missing; install it first.')])
    await runTurn(ctx, agent)
    await runTurn(ctx, agent, 'what happened?')
    expect(turnEnds(agent)).toEqual([STOPPED, { kind: 'completed' }])
  })
})

describe('configuration', () => {
  it.each([
    [{ consecutiveFailures: 1 }, '`consecutiveFailures` is 1; it must be a whole number of at least 2'],
    [{ windowSize: 1 }, '`windowSize` is 1; it must be a whole number of at least 2'],
    [{ windowFailures: 13 }, '`windowFailures` (13) is larger than `windowSize` (12)'],
    [{ reminderAfter: 6 }, '`reminderAfter` (6) must be below `consecutiveFailures` (6), or 0 for no reminder'],
    [{ reminderAfter: 2.5 }, '`reminderAfter` is 2.5; it must be a whole number of at least 0'],
  ])('refuses %o at load', (overrides, message) => {
    expect(() => Guard.resolveLimits(configOf(overrides))).toThrow(new Guard.ToolFailureGuardConfigError(message))
  })

  it('refuses impossible limits at load even with the switch off', () => {
    const ctx = new Context()
    expect(() => { Guard.apply(ctx, configOf({ enabled: false, windowFailures: 20 })) }).toThrow(Guard.ToolFailureGuardConfigError)
  })

  it('sends no reminder with reminderAfter 0', async () => {
    const ctx = await harness(configOf({ reminderAfter: 0 }))
    const { agent } = await agentWith(ctx, [...calls('browser', 6), textResponse('never')])
    await runTurn(ctx, agent)
    expect(reminders(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual([STOPPED])
  })

  it('applies the shipped limits as the schema defaults', () => {
    expect(new Guard.Config()).toEqual(configOf({ enabled: false }))
  })
})
