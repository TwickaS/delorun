/**
 * The `delo-update-gate` row's plugin on the production agent loop: while an attached source is held, a new turn is
 * refused with `UPDATE_PENDING` before any model request, a turn that was already running goes on to its next step,
 * and with the switch off the plugin provides no service.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as UpdateGate from '../src/update-gate.ts'
import { UPDATE_PENDING, UPDATE_PENDING_MESSAGE, UpdatePendingError } from '../src/update-gate.ts'

const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const

/** A step that answers with text and ends the turn. */
const answer: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
  usage,
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A step that calls the `hold` tool. */
const callHold: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: ToolCallId('h1'), name: 'hold', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('h1'), name: 'hold', arguments: '{}' } },
  usage,
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** Streams its script one step per request and counts the requests. */
class ScriptedAdapter extends LlmAdapter {
  requests = 0

  /** @param script - the steps, consumed in order. */
  constructor(readonly script: StreamChunk[][] = []) {
    super()
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    const step = this.script.shift()
    if (step === undefined) throw new Error('the script has no step for this request')
    yield * step
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * A loop with the plugin mounted, a scripted model and a `hold` tool that holds the gate.
 * @param enabled - the C16 switch.
 * @returns the context, the agent, the adapter, a run helper and the held flag.
 */
async function setup(enabled: boolean) {
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // A pre-step listener mounted before the gate: a refused turn must not reach it.
  const reached: number[] = []
  ctx.on('agent/pre-step', ({ step }, next) => {
    reached.push(step)
    return next()
  })
  await ctx.plugin(UpdateGate, { enabled })
  const state = { held: false }
  ctx.tools.register(defineTool({
    name: 'hold',
    description: 'Hold the update gate.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      state.held = true
      return Promise.resolve('held')
    },
  }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await harness.create(SessionId('update-gate'), { provider: 'mock', model: 'mock' })
  const run = async (target: Agent, message: string): Promise<void> => {
    target.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
    await target.whenIdle()
  }
  const endings = (): unknown[] => agent.session.ownEvents().flatMap(event => (event.type === 'turn/end' ? [event.data.reason] : []))
  return { ctx, agent, adapter, run, state, reached, endings }
}

describe('the update gate with its switch on', () => {
  it('refuses a new turn with UPDATE_PENDING before any model request while a source is held, and lets the next one run once released', async () => {
    const { ctx, agent, adapter, run, state, reached, endings } = await setup(true)
    const detach = ctx.deloTurnGate.attach(() => state.held)
    state.held = true

    await run(agent, 'Hello.')

    expect(adapter.requests).toBe(0)
    expect(reached).toEqual([])
    expect(endings()).toEqual([{ kind: 'error', error: { message: UPDATE_PENDING_MESSAGE, code: 'UNKNOWN' } }])
    expect(UPDATE_PENDING_MESSAGE.startsWith(`${UPDATE_PENDING}: `)).toBe(true)

    state.held = false
    adapter.script.push(answer)
    await run(agent, 'Hello again.')

    expect(adapter.requests).toBe(1)
    expect(endings().at(-1)).toEqual({ kind: 'completed' })
    detach()
  })

  it('lets a turn that was already running take its next step after the gate is held', async () => {
    const { ctx, agent, adapter, run, state, reached, endings } = await setup(true)
    ctx.deloTurnGate.attach(() => state.held)
    adapter.script.push(callHold, answer)

    await run(agent, 'Hold the gate, then answer.')

    expect(state.held).toBe(true)
    expect(adapter.requests).toBe(2)
    expect(reached).toEqual([1, 2])
    expect(endings()).toEqual([{ kind: 'completed' }])
  })

  it('is held while any attached source is held, and a detached source no longer counts', () => {
    const service = new UpdateGate.UpdateTurnGateService(new Context())
    expect(service.held).toBe(false)
    const quiet = service.attach(() => false)
    const busy = service.attach(() => true)
    expect(service.held).toBe(true)
    busy()
    busy()
    expect(service.held).toBe(false)
    quiet()
    expect(service.held).toBe(false)
  })

  it('carries the C19 code on the refusal', () => {
    const error = new UpdatePendingError()
    expect(error.code).toBe('UPDATE_PENDING')
    expect(error.name).toBe('UpdatePendingError')
    expect(error.message).toBe(UPDATE_PENDING_MESSAGE)
  })
})

describe('the update gate with its switch off, the parity value', () => {
  it('provides no service, so no turn is refused', async () => {
    const { ctx, agent, adapter, run, endings } = await setup(false)
    expect(ctx.get('deloTurnGate')).toBeUndefined()
    adapter.script.push(answer)

    await run(agent, 'Hello.')

    expect(adapter.requests).toBe(1)
    expect(endings()).toEqual([{ kind: 'completed' }])
  })

  it('defaults the switch to off', () => {
    expect(UpdateGate.Config()).toEqual({ enabled: false })
  })
})
