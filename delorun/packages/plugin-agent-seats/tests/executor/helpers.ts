/**
 * Test doubles for the seat executor specs: a scripted model that streams program messages as tool-call blocks, and
 * live program sessions whose results a test releases one by one.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { onTestFinished } from 'vitest'
import {
  CallRecordLedger, SEAT_MAX_PARALLEL_HARNESS_TOOLS, SeatToolExecutor, type OutputCap, type SeatProgram, type SeatProgramResult, type SeatPrograms,
} from '../../src/executor/index.ts'

/** One tool call of a scripted program message. */
export interface ProgramCall {
  readonly id: string
  readonly name: string
  readonly input?: object
}

/** A program message that calls tools and ends the step. */
export function calls(...list: ProgramCall[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, call] of list.entries()) {
    const id = ToolCallId(call.id)
    const json = JSON.stringify(call.input ?? {})
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: json },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: json } },
    )
  }
  chunks.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

/** A program message that answers with text and ends the turn. */
export function answer(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Streams its script one step per request. */
export class ScriptedModel extends LlmAdapter {
  readonly script: StreamChunk[][] = []
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift()
    if (step === undefined) throw new Error('the script has no step for this request')
    yield * step
  }
}

/** One live program session whose results a test releases. */
export class FakeProgram implements SeatProgram {
  /** Call ids the executor has asked a result for, in order. */
  readonly asked: string[] = []
  /** How many times Stop reached the program. */
  stops = 0
  /** Makes the next `stop()` fail. */
  failStop = false
  private readonly pending = new Map<string, PromiseWithResolvers<SeatProgramResult>>()

  private slot(callId: string): PromiseWithResolvers<SeatProgramResult> {
    let slot = this.pending.get(callId)
    if (slot === undefined) this.pending.set(callId, slot = Promise.withResolvers<SeatProgramResult>())
    return slot
  }

  result(callId: string, signal: AbortSignal): Promise<SeatProgramResult> {
    this.asked.push(callId)
    const slot = this.slot(callId)
    return new Promise<SeatProgramResult>((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      slot.promise.then(resolve, reject)
    })
  }

  stop(): Promise<void> {
    this.stops++
    return this.failStop ? Promise.reject(new Error('the program is gone')) : Promise.resolve()
  }

  /** Report the program's result for a call. */
  finish(callId: string, output: string, isError = false): void {
    this.slot(callId).resolve({ output, isError })
  }

  /** Make the wait for a call fail as a lost program does. */
  lose(callId: string, error: Error): void {
    this.slot(callId).reject(error)
  }
}

/** The live programs of a test, by Session. */
export class FakePrograms implements SeatPrograms {
  readonly records = new CallRecordLedger()
  readonly live = new Map<SessionId, FakeProgram>()

  program(sessionId: SessionId): FakeProgram | undefined {
    return this.live.get(sessionId)
  }
}

export interface SeatHarness {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly model: ScriptedModel
  readonly programs: FakePrograms
  readonly scope: Scope
  readonly executor: SeatToolExecutor
  /** Create a seat child whose scope mounts the seat executor, with a live fake program. */
  readonly seatAgent: (id: string) => Promise<{ agent: Agent; program: FakeProgram }>
}

export const PREFIX = 'claude_code.'

/** A tiny output cap so a test needs no large strings. */
export const TINY_CAP: OutputCap = { headChars: 8, tailChars: 6 }

/** Mount the loop, the scripted model and a seat preset scope holding the seat executor. */
export async function setup(options: { outputCap?: OutputCap } = {}): Promise<SeatHarness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['seat-test'], model)
  const programs = new FakePrograms()
  const presetKey = { preset: 'seat-test' }
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, presetKey) }, { inject: ['tools', 'systemPrompt'] }))
  const executor = new SeatToolExecutor({
    ctx: scope.ctx,
    programs,
    recordPrefix: PREFIX,
    outputCap: options.outputCap ?? { headChars: 1000, tailChars: 1000 },
    maxParallel: SEAT_MAX_PARALLEL_HARNESS_TOOLS,
  })
  scope.ctx.tools.setExecutor(executor)
  const seatAgent = async (id: string) => {
    const agent = await harness.create(SessionId(id), { provider: 'seat-test', model: 'program' })
    bindScopeParent(agent, presetKey)
    const program = new FakeProgram()
    programs.live.set(agent.id, program)
    return { agent, program }
  }
  return { ctx, harness, model, programs, scope, executor, seatAgent }
}

export function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', (event) => {
      if (event.agent === agent && event.status === 'idle') { dispose(); resolve() }
    })
  })
}

export function say(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export const types = (agent: Agent) => agent.session.snapshotEvents().map(event => event.type)

export const ofType = <T extends SessionEvent['type']>(agent: Agent, type: T) =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<T> => event.type === type)
