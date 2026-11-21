/**
 * The `delorun-prompt-wording` row: with the C16 switch `model_prompt` on it turns Delorun's wording on in the
 * `systemPrompt` service while mounted; off it registers nothing.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as HarnessDevContext from '../../../../packages/context/harness-dev-context/src/index.ts'
import * as plugin from '../src/prompt-wording.ts'

/**
 * A context with the system prompt service.
 * @returns the context.
 */
async function world(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  return ctx
}

describe('the prompt wording row', () => {
  it('defaults to the parity value, off', () => {
    expect(plugin.Config(null).enabled).toBe(false)
    expect(plugin.name).toBe('delorun-prompt-wording')
  })

  it('registers nothing with the switch off', async () => {
    const ctx = await world()
    await ctx.plugin(plugin, plugin.Config(null))
    expect(ctx.systemPrompt.delorunWording).toBe(false)
  })

  it('turns Delorun\'s wording on while mounted and off again when the row is disposed', async () => {
    const ctx = await world()
    const fiber = ctx.plugin(plugin, plugin.Config({ enabled: true }))
    await fiber
    expect(ctx.systemPrompt.delorunWording).toBe(true)
    await fiber.dispose()
    expect(ctx.systemPrompt.delorunWording).toBe(false)
  })

  it('changes what the checkout paragraphs say: Delorun\'s installation line with the switch on, upstream\'s checkout text with it off', async () => {
    const installed = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-prompt-wording-')))
    onTestFinished(() => { rmSync(installed, { recursive: true, force: true }) })
    const texts = async (enabled: boolean): Promise<string> => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      ctx.provide('webApp', { getAdvertisedUrl: () => 'http://127.0.0.1:4567' } satisfies Context['webApp'])
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(HarnessDevContext, { sourceRoot: installed })
      await ctx.plugin(plugin, plugin.Config({ enabled }))
      const assembly = await ctx.systemPrompt.assemble()
      return assembly.sections.filter(entry => entry.name === 'harness:source' || entry.name === 'app:web-surface').map(entry => entry.text).join('\n')
    }
    const on = await texts(true)
    expect(on).toContain('Never edit the installed program.')
    expect(on).not.toContain('DeepSeek Harness')
    const off = await texts(false)
    expect(off).toContain('The runtime context names the DeepSeek Harness implementation checkout.')
    expect(off).not.toContain('Never edit the installed program.')
  })
})
