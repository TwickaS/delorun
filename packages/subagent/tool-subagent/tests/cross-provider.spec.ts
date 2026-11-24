/**
 * A661 scratch-home proof: a parent on one provider spawns a child on another.
 *
 * The composition is the real one — Loader, AgentLoop, the subagent runtime, the
 * in-process spawn provider, the Host settings service and the delegation tool —
 * and the only stand-ins are the two LLM adapters, which is what a scratch home
 * with two configured providers looks like.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'

/** One configured provider that records the route each request used. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override providerInfo(provider: string) {
    return { id: provider, name: provider.toUpperCase() }
  }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'model-a', name: 'Model A' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return (async function* () {
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'text-delta' as const, index: 0, text: 'done' }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'done' } }
      yield { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })()
  }
}

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('cross-provider delegation', () => {
  it('runs a child on a provider the parent is not using', async () => {
    // A scratch home, mode 0700, holding this run's sessions.
    const home = mkdtempSync(join(tmpdir(), 'dsh-cross-provider-'))
    homes.push(home)

    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    // The scratch home's session store, so a continuable child can persist.
    await ctx.plugin(JsonlSessionPersistence, { root: home })
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    // The shipped default: the settings service records a narrowing for new Sessions.
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: [] })

    const parentAdapter = new RecordingAdapter()
    const childAdapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['parent-provider'], parentAdapter)
    ctx.llm.registerAdapter(['child-provider'], childAdapter)

    const { agent: parent } = await ctx.agents.create({
      sessionId: SessionId('cross-provider-parent'),
      agentOptions: { provider: 'parent-provider', model: 'model-a' },
      setup: async (agentCtx) => {
        const fiber = agentCtx.inject(tool.inject, (runtimeCtx) => {
          return tool.apply(runtimeCtx, { provider: 'spawn', modelSelection: true })
        })
        await fiber.await()
      },
    })

    const result = await executeToolFixture(ctx, {
      callId: ToolCallId('cross-provider-call'),
      name: 'subagent',
      arguments: {
        description: 'child on another provider',
        prompt: 'do the work',
        provider: 'child-provider',
        model: 'model-a',
      },
      agent: parent,
      signal: new AbortController().signal,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    // The child ran on the provider the parent is not using.
    await vi.waitFor(() => { expect(childAdapter.requests.length).toBeGreaterThan(0) })
    expect(childAdapter.requests[0]?.provider).toBe('child-provider')
    expect(parentAdapter.requests.every(request => request.provider === 'parent-provider')).toBe(true)
    await ctx.fiber.dispose()
  })
})
