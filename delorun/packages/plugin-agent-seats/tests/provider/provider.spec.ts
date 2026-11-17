/**
 * The seats' subagent provider and hand-off tools on a real subagent runtime and tool pipeline: what a provider
 * declares, what the model reads, what a hand-off asks of `ctx.subagents`, and every refusal.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GateRefusedError, type GateRefusal } from '@delorun/external-agents/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FULL_ACCESS_REASON, gateRefusalSentence, handOffDescription, oneShotToolName, registerSeatProviders, seatProviderName, SEAT_MODEL } from '../../src/provider/index.ts'
import { mountStack, SEATS, type Stack } from './harness.ts'

const stacks: Stack[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.ctx.fiber.dispose()
})

async function stack(options: Parameters<typeof mountStack>[0] = {}): Promise<Stack> {
  const mounted = await mountStack(options)
  stacks.push(mounted)
  return mounted
}

function text(result: { readonly content: readonly { readonly type: string, readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The request the next hand-off passes to the runtime, with the real runtime still starting the child. */
function watchStarts(ctx: Context) {
  return vi.spyOn(ctx.subagents, 'startActivation')
}

describe('the seat provider', () => {
  it('declares what a continuable seat child needs and nothing else', async () => {
    const { ctx } = await stack()
    const provider = ctx.subagents.getProvider('claude-code-seat')
    expect(provider).toBeDefined()
    expect(provider?.capabilities).toEqual({ agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true })
    expect(provider?.inheritsParentContext).toBe(false)
    expect(provider?.agentRouteDefaults).toEqual({ provider: 'claude-code-seat', model: SEAT_MODEL })
    expect(provider?.start).toBeUndefined()
    await expect(provider?.prepareContinuable?.({} as never)).resolves.toEqual({})
  })

  it('registers one provider per seat, named from the agent', async () => {
    const { ctx } = await stack()
    expect(seatProviderName('claude-code')).toBe('claude-code-seat')
    expect(seatProviderName('codex')).toBe('codex-seat')
    expect(ctx.subagents.getProvider('codex-seat')?.agentRouteDefaults).toEqual({ provider: 'codex-seat', model: SEAT_MODEL })
  })

  it('removes the provider and the tool when the registering plugin stops', async () => {
    const { ctx } = await stack({ register: false })
    const fiber = ctx.plugin({
      apply: (scope: Context) => { registerSeatProviders(scope, { seats: SEATS }, () => true) },
    })
    await fiber.await()
    expect(ctx.subagents.getProvider('claude-code-seat')).toBeDefined()
    expect(ctx.tools.get('claude_code')).toBeDefined()
    await fiber.dispose()
    expect(ctx.subagents.getProvider('claude-code-seat')).toBeUndefined()
    expect(ctx.subagents.getProvider('codex-seat')).toBeUndefined()
    expect(ctx.tools.get('claude_code')).toBeUndefined()
    expect(ctx.tools.get('codex')).toBeUndefined()
  })
})

describe('the hand-off tool description', () => {
  it('says plainly that it runs the person\'s own Claude Code on their plan and that both can watch and message it', () => {
    const description = handOffDescription('claude-code')
    expect(description).toContain("the person's own Claude Code")
    expect(description).toContain('Claude plan')
    expect(description).toContain('you and the person can both watch')
    expect(description).toContain('message it')
    expect(description).toContain('exactly as you write it')
  })

  it('names Codex and the ChatGPT plan for the Codex tool', () => {
    const description = handOffDescription('codex')
    expect(description).toContain("the person's own Codex")
    expect(description).toContain('ChatGPT plan')
    expect(description).not.toContain('Claude')
  })

  it('is what the registered tool offers the model', async () => {
    const { ctx } = await stack()
    expect(ctx.tools.get('claude_code')?.description).toBe(handOffDescription('claude-code'))
    expect(ctx.tools.get('codex')?.description).toBe(handOffDescription('codex'))
  })
})

describe('a hand-off', () => {
  it('starts a seat child on the seat provider, route and preset with the task exactly as written', async () => {
    const { ctx, agent, call } = await stack()
    const starts = watchStarts(ctx)
    const lead = await agent('lead')
    const task = '  Fix the build.\n\nKeep every line   of this.  '
    const result = await call(lead, 'claude_code', { description: 'Fix build', prompt: task })
    expect(result.isError).toBeFalsy()
    expect(starts).toHaveBeenCalledOnce()
    const spec = starts.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      provider: 'claude-code-seat',
      label: 'Fix build',
      agentPreset: 'claude-code-seat',
      agentOptions: { provider: 'claude-code-seat', model: SEAT_MODEL },
      maxDepth: 1,
      delivery: 'parent',
    })
    expect(spec?.prompt).toEqual([{ type: 'text', text: task }])
    expect(text(result)).toMatch(/^started Claude Code as /)
  })

  it('hands Codex work to the codex seat provider', async () => {
    const { ctx, agent, call } = await stack()
    const starts = watchStarts(ctx)
    const lead = await agent('lead')
    await call(lead, 'codex', { description: 'Review', prompt: 'Review the diff.', cwd: '/workspace/sub', name: 'reviewer' })
    expect(starts.mock.calls[0]?.[0]).toMatchObject({ provider: 'codex-seat', agentPreset: 'codex-seat', name: 'reviewer', cwd: '/workspace/sub' })
  })

  it('creates a real child of the lead under the seat provider', async () => {
    const { ctx, agent, call } = await stack()
    const lead = await agent('lead')
    const created = new Promise<SessionId>((resolve) => {
      const off = ctx.on('agent/created', ({ agent: made }) => {
        if (made.session.header.parentSession === lead.id) { off(); resolve(made.id) }
        return undefined
      })
    })
    await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    const childId = await created
    expect(ctx.agents.get(childId)?.session.header.origin).toBe('subagent')
  })

  it('asks the gate for a limit refusal before it starts anything', async () => {
    const { ctx, agent, call, gate } = await stack()
    const starts = watchStarts(ctx)
    gate.limits.set('claude-code', 'Claude Code was not started: your Claude plan\'s 5-hour limit is reached until 14:00.')
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('5-hour limit is reached until 14:00')
    expect(gate.asked).toEqual(['claude-code'])
    expect(starts).not.toHaveBeenCalled()
  })

  it('maps a refusal the gate raises while starting to its fixed sentence', async () => {
    const { ctx, agent, call } = await stack()
    vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValue(new GateRefusedError({ category: 'consent', reason: 'Claude Code was not started: the person said no.' }))
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the person said no.')
  })
})

describe('the depth rule', () => {
  it('refuses a hand-off from a seat child at the depth limit, without asking the gate or starting a child', async () => {
    const { ctx, agent, call, gate } = await stack()
    const starts = watchStarts(ctx)
    const child = await agent('seat-child', 1)
    const result = await call(child, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Claude Code was not started: this agent is at delegation depth 1 and a hand-off may reach depth 1 at most. Carry out the work directly.')
    expect(starts).not.toHaveBeenCalled()
    expect(gate.asked).toEqual([])
  })

  it('allows a deeper chain when the seat\'s maxDepth says so', async () => {
    const seats = SEATS.map(seat => ({ ...seat, maxDepth: 2 }))
    const { ctx, agent, call } = await stack({ seats })
    const starts = watchStarts(ctx)
    const child = await agent('seat-child', 1)
    const result = await call(child, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBeFalsy()
    expect(starts.mock.calls[0]?.[0]).toMatchObject({ maxDepth: 2 })
  })
})

describe('the gate refusals', () => {
  const now = 1_700_000_000_000
  const cases: readonly { readonly refusal: GateRefusal, readonly expected: string | RegExp }[] = [
    { refusal: { category: 'not-installed' }, expected: 'Claude Code was not started: Claude Code is not added to this Delorun. Tell the person; do not retry.' },
    { refusal: { category: 'consent', reason: 'The consent said no.' }, expected: 'The consent said no.' },
    { refusal: { category: 'limit', window: 'five_hour', resetsAt: now + 7_500_000 }, expected: /^Claude Code was not started: your Claude plan's 5-hour limit is reached until .* \(in 2 h 5 min\)\. Do not hand work to Claude Code before then; do the task yourself or tell the person\.$/ },
    { refusal: { category: 'capacity', busy: ['codex', 'claude-code'] }, expected: 'Claude Code was not started: 2 live agents already run (Codex, Claude Code), which is the most this Delorun runs at once. Wait for one to finish, or do the task yourself.' },
    { refusal: { category: 'seat-running' }, expected: 'Claude Code was not started: this agent already has a running program. Send it a message instead of starting it again.' },
  ]

  it.each(cases)('words a $refusal.category refusal for the model', ({ refusal, expected }) => {
    const sentence = gateRefusalSentence('claude-code', refusal, now)
    if (typeof expected === 'string') expect(sentence).toBe(expected)
    else expect(sentence).toMatch(expected)
  })

  it.each(cases)('reaches the model through the tool for a $refusal.category refusal', async ({ refusal, expected }) => {
    const { ctx, agent, call } = await stack()
    vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValue(new GateRefusedError(refusal))
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBe(true)
    if (typeof expected === 'string') expect(text(result)).toBe(expected)
    else expect(text(result)).toMatch(expected)
  })

  it('names Codex in its own sentences', () => {
    expect(gateRefusalSentence('codex', { category: 'not-installed' }, now)).toContain('Codex is not added')
  })
})

describe('Full access', () => {
  async function withPolicy(policy: 'ask' | 'never') {
    const mounted = await stack()
    mounted.ctx.provide('approval', {
      config: { policy },
      overrideOf: () => undefined,
    } as never)
    return mounted
  }

  it('says in the tool result that the chat has Full access when nobody is asked', async () => {
    const { agent, call } = await withPolicy('never')
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain(FULL_ACCESS_REASON)
  })

  it('adds nothing when the chat asks', async () => {
    const { agent, call } = await withPolicy('ask')
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(text(result)).not.toContain('Full access')
  })

  it('adds nothing without an approval service', async () => {
    const { agent, call } = await stack()
    const lead = await agent('lead')
    const result = await call(lead, 'claude_code', { description: 'Task', prompt: 'Do it.' })
    expect(text(result)).not.toContain('Full access')
  })
})

describe('the flag', () => {
  it('registers nothing while it is off, so the tool list is as without the plugin', async () => {
    const before = await stack({ flag: true })
    const baseline = await stack({ flag: false, oneShots: ['subagent_claude_code', 'subagent_codex'] })
    expect(baseline.ctx.subagents.getProvider('claude-code-seat')).toBeUndefined()
    expect(baseline.ctx.subagents.getProvider('codex-seat')).toBeUndefined()
    const lead = await baseline.agent('lead')
    const names = baseline.ctx.tools.definitions(lead).map(tool => tool.name).sort()
    expect(names).not.toContain('claude_code')
    expect(names).not.toContain('codex')
    expect(names).toEqual(expect.arrayContaining(['subagent_claude_code', 'subagent_codex']))
    expect(before.ctx.tools.get('claude_code')).toBeDefined()
  })

  it('leaves both one-shot tools visible to a new agent while it is off', async () => {
    const { ctx, agent } = await stack({ flag: false, oneShots: ['subagent_claude_code', 'subagent_codex'] })
    const lead = await agent('lead')
    expect(ctx.tools.get('subagent_claude_code', lead)).toBeDefined()
    expect(ctx.tools.get('subagent_codex', lead)).toBeDefined()
  })
})

describe('hiding the one-shot tools', () => {
  it('names the tool upstream registers for each agent', () => {
    expect(oneShotToolName('claude-code')).toBe('subagent_claude_code')
    expect(oneShotToolName('codex')).toBe('subagent_codex')
  })

  it('hides both from an agent that has both seat tools and keeps the seat tools', async () => {
    const { ctx, agent } = await stack({ oneShots: ['subagent_claude_code', 'subagent_codex'] })
    const lead = await agent('lead')
    expect(ctx.tools.get('subagent_claude_code', lead)).toBeUndefined()
    expect(ctx.tools.get('subagent_codex', lead)).toBeUndefined()
    expect(ctx.tools.get('claude_code', lead)).toBeDefined()
    expect(ctx.tools.get('codex', lead)).toBeDefined()
  })

  it('hides a one-shot tool only where its own seat tool is present', async () => {
    const { ctx, agent } = await stack({ oneShots: ['subagent_claude_code', 'subagent_codex'], seats: SEATS.filter(seat => seat.provider === 'codex') })
    const lead = await agent('lead')
    expect(ctx.tools.get('subagent_codex', lead)).toBeUndefined()
    expect(ctx.tools.get('subagent_claude_code', lead)).toBeDefined()
    expect(ctx.tools.get('claude_code', lead)).toBeUndefined()
  })

  it('does not throw for a one-shot tool that is not registered', async () => {
    const { ctx, agent } = await stack({ oneShots: ['subagent_codex'] })
    const lead = await agent('lead')
    expect(ctx.tools.get('subagent_codex', lead)).toBeUndefined()
  })

  it('leaves the one-shot tools to an agent whose seat tool another rule removed', async () => {
    const { ctx } = await stack({ oneShots: ['subagent_claude_code'] })
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ deny: ['claude_code'] })
      return undefined
    }, true)
    const created = await ctx.agents.create({ sessionId: SessionId('restricted'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.tools.get('claude_code', created.agent)).toBeUndefined()
    expect(ctx.tools.get('subagent_claude_code', created.agent)).toBeDefined()
  })
})

describe('the seat list', () => {
  it('refuses a seat whose agent the gate does not run', async () => {
    await expect(mountStack({ seats: [{ ...SEATS[0]!, provider: 'gemini' }] })).rejects.toThrow('not an external agent')
  })

  it('refuses two seats that share a tool name', async () => {
    await expect(mountStack({ seats: [SEATS[0]!, { ...SEATS[1]!, toolName: 'claude_code' }] })).rejects.toThrow('share the toolName "claude_code"')
  })

  it('does not check the list while the flag is off', async () => {
    await expect(mountStack({ flag: false, seats: [{ ...SEATS[0]!, provider: 'gemini' }] })).resolves.toBeDefined()
  })
})
