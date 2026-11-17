/**
 * The guard driven through a real agent loop against a scripted model (no network): when a turn stops, what the model
 * reads first, what does not count, and what starts a fresh count.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Guard from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** The row's Config with the shipped limits, switched on unless a test says otherwise. */
function configOf(overrides: Partial<Guard.Config> = {}): Guard.Config {
  return { enabled: true, consecutiveFailures: 6, windowSize: 12, windowFailures: 8, reminderAfter: 3, exclude: [], stderrNotice: false, ...overrides }
}

/** Boot the loop with a failing tool, a working tool and the guard. */
async function harness(config: Guard.Config = configOf()): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
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

/** Create an agent served by a scripted adapter. */
async function agentWith(ctx: Context, script: Script): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('guard'), { provider: 'mock', model: 'mock' })
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
  it('ignores calls the person refused', async () => {
    const ctx = await harness()
    ctx.on('tools/pre-execute', () => Promise.resolve({
      kind: 'deny', reason: 'refused', info: { name: 'ApprovalError', code: 'APPROVAL_REJECTED' },
    }))
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

  it('ignores excluded tools, which neither count nor end a run', async () => {
    const ctx = await harness(configOf({ exclude: ['brow*'] }))
    const { agent } = await agentWith(ctx, [...calls('browser', 8), textResponse('done')])
    await runTurn(ctx, agent)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
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
