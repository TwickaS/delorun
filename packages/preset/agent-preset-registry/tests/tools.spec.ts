import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as PresetTools from '../src/tools.ts'
import { agentOn, contribution, declare, harness } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Build a context with the roster; `false` leaves the module out, for comparing the stock tool list. */
async function setup(config: PresetTools.Config | false = { presetInspect: true }): Promise<Context> {
  const ctx = await harness()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  if (config !== false) await ctx.plugin(PresetTools, config)
  await declare(ctx, { ...contribution('standard'), name: 'Standard', description: 'General work', order: 1 })
  await declare(ctx, { id: 'minimal', order: 2, plugins: [{ name: 'missing-plugin', disabled: true }] })
  return ctx
}

let calls = 0
function inspect(ctx: Context, agent: Awaited<ReturnType<typeof agentOn>>, args: Record<string, unknown>) {
  return executeToolFixture(ctx, { signal: new AbortController().signal, callId: ToolCallId(`inspect-${++calls}`), name: 'preset_inspect', arguments: args, agent })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

describe('preset_inspect', () => {
  it('lists every preset with the default and the calling Agent\'s current one marked', async () => {
    const ctx = await setup()
    const agent = await agentOn(ctx, 'roster')
    const result = await inspect(ctx, agent, {})
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('standard (default, current) — Standard: General work\nminimal')
  })

  it('names a preset\'s rows and, for the current preset, its skills with their source and provider', async () => {
    const ctx = await setup()
    ctx.skills.register({ name: 'house-style', description: 'Write in the house style', source: 'runtime', content: 'body' })
    const agent = await agentOn(ctx, 'own')
    const own = await inspect(ctx, agent, { preset: 'standard' })
    expect(text(own)).toMatch(
      /^preset standard \(current\)\nrows:\n {2}\S+ \S+contribute\.js\nskills:\n {2}house-style \[runtime\] — Write in the house style$/,
    )
    const other = await inspect(ctx, agent, { preset: 'minimal' })
    expect(text(other)).toMatch(
      /^preset minimal\nrows:\n {2}\S+ missing-plugin \(disabled\)\nskills: listed only for the current preset, whose skills are mounted$/,
    )
  })

  it('refuses a preset the roster does not name, pointing at the roster', async () => {
    const ctx = await setup()
    const agent = await agentOn(ctx, 'unknown')
    const result = await inspect(ctx, agent, { preset: 'nonexistent' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no preset named "nonexistent"; call preset_inspect with no arguments for the roster')
  })

  it('changes neither the roster nor the mounted skills when it answers', async () => {
    const ctx = await setup()
    ctx.skills.register({ name: 'house-style', description: 'Write in the house style', source: 'runtime', content: 'body' })
    const agent = await agentOn(ctx, 'readonly')
    const before = { roster: await ctx.agentPresets.list(), skills: (await ctx.skills.list({ scope: agent })).map(skill => skill.name) }
    await inspect(ctx, agent, {})
    await inspect(ctx, agent, { preset: 'standard' })
    const after = { roster: await ctx.agentPresets.list(), skills: (await ctx.skills.list({ scope: agent })).map(skill => skill.name) }
    expect(after).toEqual(before)
  })
})

describe('the presetInspect switch', () => {
  it('registers no tool when off, so the model sees the same tools as without the module', async () => {
    const ctx = await setup({ presetInspect: false })
    const agent = await agentOn(ctx, 'off')
    const bare = await setup(false)
    const bareAgent = await agentOn(bare, 'off')
    const names = (tools: Context, scope: typeof agent) => tools.tools.schemas(scope).map(schema => schema.name).sort()
    expect(names(ctx, agent)).not.toContain('preset_inspect')
    expect(names(ctx, agent)).toEqual(names(bare, bareAgent))
  })

  it('registers the tool when on, and the model sees it in the agent tool list', async () => {
    const ctx = await setup({ presetInspect: true })
    const agent = await agentOn(ctx, 'on')
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toContain('preset_inspect')
  })
})
