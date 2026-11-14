/**
 * The `delorun-update-gate` row's plugin on the production agent loop: while an attached source is held, a new turn is
 * refused with `UPDATE_PENDING` before any model request, a turn that was already running goes on to its next step,
 * with the start hold on no turn reaches the model before the CLI releases the gate, and with the switch off the plugin
 * provides no service.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as UpdateGate from '../src/update-gate.ts'
import { START_CHECK_PENDING, startCheckPendingMessage, UPDATE_PENDING, UPDATE_PENDING_MESSAGE, UpdatePendingError } from '../src/update-gate.ts'

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

  readonly script: StreamChunk[][]

  /** @param script - the steps, consumed in order. */
  constructor(script: StreamChunk[][] = []) {
    super()
    this.script = script
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
 * @param holdUntilChecked - the start hold.
 * @param checkWaitSeconds - the bound of the start hold's wait.
 * @returns the context, the agent, the adapter, a run helper and the held flag.
 */
async function setup(enabled: boolean, holdUntilChecked = false, checkWaitSeconds = 60) {
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // A pre-step listener mounted before the gate: a refused turn must not reach it.
  const reached: number[] = []
  ctx.on('agent/pre-step', ({ step }, next) => {
    reached.push(step)
    return next()
  })
  const gate = ctx.plugin(UpdateGate, { enabled, holdUntilChecked, checkWaitSeconds })
  await gate
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
  return { ctx, gate, agent, adapter, run, state, reached, endings }
}

describe('the update gate with its switch on', () => {
  it('refuses a new turn with UPDATE_PENDING before any model request while a source is held, and lets the next one run once released', async () => {
    const { ctx, agent, adapter, run, state, reached, endings } = await setup(true)
    const detach = ctx.delorunTurnGate.attach(() => state.held)
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
    ctx.delorunTurnGate.attach(() => state.held)
    adapter.script.push(callHold, answer)

    await run(agent, 'Hold the gate, then answer.')

    expect(state.held).toBe(true)
    expect(adapter.requests).toBe(2)
    expect(reached).toEqual([1, 2])
    expect(endings()).toEqual([{ kind: 'completed' }])
  })

  it('is held while any attached source is held, and a detached source no longer counts', () => {
    const service = new UpdateGate.UpdateTurnGateService(new Context(), { enabled: true, holdUntilChecked: false, checkWaitSeconds: 60 })
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

describe('the update gate\'s start hold', () => {
  it('keeps a turn from reaching the model until the gate is released, then lets it run', async () => {
    const { ctx, agent, adapter, reached, endings } = await setup(true, true)
    adapter.script.push(answer)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(adapter.requests).toBe(0)
    expect(reached).toEqual([])

    ctx.delorunTurnGate.release()
    await agent.whenIdle()
    expect(adapter.requests).toBe(1)
    expect(reached).toEqual([1])
    expect(endings()).toEqual([{ kind: 'completed' }])
    ctx.delorunTurnGate.release()
  })

  it('refuses a turn still waiting when the plugin stops, and never asks the model', async () => {
    const { gate, agent, adapter, reached } = await setup(true, true)
    adapter.script.push(answer)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
    await new Promise(resolve => setImmediate(resolve))
    await gate.dispose()
    await agent.whenIdle()
    expect(adapter.requests).toBe(0)
    expect(reached).toEqual([])
  })

  it('ends a turn that waits past the bound as an error with the start-check message, without a model request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { agent, adapter, reached, endings } = await setup(true, true, 5)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(4999)
      expect(endings()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await agent.whenIdle()
      expect(endings()).toEqual([{ kind: 'error', error: { message: startCheckPendingMessage(5), code: 'UNKNOWN' } }])
      expect(startCheckPendingMessage(5)).toContain('delorun start')
      expect(startCheckPendingMessage(5).startsWith(`${START_CHECK_PENDING}: `)).toBe(true)
      expect(adapter.requests).toBe(0)
      expect(reached).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a turn through when the release comes before the bound, and the bound then never fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { ctx, agent, adapter, endings } = await setup(true, true, 5)
      adapter.script.push(answer)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(4000)
      ctx.delorunTurnGate.release()
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(endings()).toEqual([{ kind: 'completed' }])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still ends an aborted turn while it waits, and clears the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { agent, adapter, endings } = await setup(true, true, 5)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(1000)
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(adapter.requests).toBe(0)
      expect(JSON.stringify(endings())).not.toContain(START_CHECK_PENDING)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets turns run at once when the hold is off, the plugin\'s default', async () => {
    const { agent, adapter, run, endings } = await setup(true, false)
    adapter.script.push(answer)
    await run(agent, 'Hello.')
    expect(adapter.requests).toBe(1)
    expect(endings()).toEqual([{ kind: 'completed' }])
  })
})

describe('the update gate with its switch off, the parity value', () => {
  it('provides no service, so no turn is refused', async () => {
    const { ctx, agent, adapter, run, endings } = await setup(false)
    expect(ctx.get('delorunTurnGate')).toBeUndefined()
    adapter.script.push(answer)

    await run(agent, 'Hello.')

    expect(adapter.requests).toBe(1)
    expect(endings()).toEqual([{ kind: 'completed' }])
  })

  it('bounds the wait to whole seconds from 1 to 3600 and refuses a value outside it at load', () => {
    expect(UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: 1 }).checkWaitSeconds).toBe(1)
    expect(UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: 3600 }).checkWaitSeconds).toBe(3600)
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: 0 })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: 3601 })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: -5 })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: Number.NaN })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: Number.NEGATIVE_INFINITY })).toThrow()
    expect(() => UpdateGate.Config({ enabled: true, holdUntilChecked: true, checkWaitSeconds: 1.5 })).toThrow()
  })

  it('defaults the switch to off', () => {
    expect(UpdateGate.Config()).toEqual({ enabled: false, holdUntilChecked: false, checkWaitSeconds: 60 })
  })
})
