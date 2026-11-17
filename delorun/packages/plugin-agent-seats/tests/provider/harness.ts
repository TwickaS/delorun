/**
 * A real subagent runtime, tool runtime and agent loop around the provider side of the seats plugin, with stand-ins
 * for the start gate, the preset registry's presets and the seat route's model.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from '../../src/config.ts'
import { registerSeatProviders } from '../../src/provider/index.ts'

/** The default two seats. */
export const SEATS = Config(null).seats

/** The gate the last plugin mount made. */
let mounted: FakeGate | undefined

/** The stand-in gate: no limit refusal unless a test sets one. */
export class FakeGate extends Service {
  /** The sentence `limitRefusal` answers, by agent. */
  readonly limits = new Map<string, string>()
  /** The agents `limitRefusal` was asked about. */
  readonly asked: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'externalAgents')
    mounted = this
  }

  limitRefusal(provider: string): Promise<string | undefined> {
    this.asked.push(provider)
    return Promise.resolve(this.limits.get(provider))
  }
}

/** Directory selection for an orchestration run. */
class FixtureWorkingDirectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: Session): string {
    return session.header.cwd ?? '/workspace'
  }

  ensure(agent: Agent): Promise<string> {
    return Promise.resolve(this.get(agent.session))
  }

  set(agent: Agent): Promise<string> {
    return Promise.resolve(this.get(agent.session))
  }
}

/** A model that answers every request with one short text. */
class QuietAdapter extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A running stack. */
export interface Stack {
  readonly ctx: Context
  readonly gate: FakeGate
  /** Make a parked agent that is not a child: `depth` is its delegation depth. */
  agent(id: string, depth?: number): Promise<Agent>
  /** Call a tool as an agent through the tool pipeline. */
  call(agent: Agent, name: string, args: object): ReturnType<typeof executeToolFixture>
}

let counter = 0

/**
 * Mount the stack and register the provider side once.
 * @param options - the flag and whether to register upstream-style one-shot tools first.
 * @returns the running stack.
 */
export async function mountStack(options: { readonly flag?: boolean, readonly oneShots?: readonly string[], readonly seats?: typeof SEATS, readonly register?: boolean } = {}): Promise<Stack> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(FixtureWorkingDirectory)
  // Continuable children need a session persistence backend.
  const root = await mkdtemp(join(tmpdir(), 'ea2-seat-provider-'))
  ctx.effect(() => async () => { await rm(root, { recursive: true, force: true }) }, 'harness: scratch folder')
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  for (const id of ['coding', 'claude-code-seat', 'codex-seat']) await ctx.agentPresets.register({ id, plugins: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(FakeGate)
  const gate = mounted
  if (gate === undefined) throw new Error('the stand-in gate did not mount')
  ctx.llm.registerAdapter(['mock', 'claude-code-seat', 'codex-seat'], new QuietAdapter())
  for (const name of options.oneShots ?? []) {
    ctx.tools.register(defineTool({
      name,
      description: `upstream one-shot ${name}`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('ran'),
    }))
  }
  if (options.register !== false) registerSeatProviders(ctx, { seats: options.seats ?? SEATS }, () => options.flag ?? true, { now: () => 1_700_000_000_000 })
  return {
    ctx,
    gate,
    async agent(id, depth = 0) {
      const created = await ctx.agents.create({
        sessionId: SessionId(`${id}-${++counter}`),
        meta: { delegationDepth: depth },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      // A parked agent: the result a child delivers must not start a lead turn in these specs.
      ctx.on('agent/pre-step', ({ agent }, next): Promise<PreStepDecision> => agent === created.agent ? Promise.resolve({ kind: 'reject' }) : next())
      return created.agent
    },
    call: (agent, name, args) => executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${++counter}`),
      name,
      arguments: args,
      agent,
    }),
  }
}
