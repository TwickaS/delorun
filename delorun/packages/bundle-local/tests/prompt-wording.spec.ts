/**
 * The `delorun-prompt-wording` row: with the C16 switch `model_prompt` on it turns Delorun's wording on in the
 * `systemPrompt` service while mounted; off it registers nothing.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
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
})
