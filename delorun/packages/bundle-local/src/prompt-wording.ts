/**
 * The `delorun-prompt-wording` row of `@delorun/bundle-local`: Delorun's wording in the system prompt. Turned on, the
 * prompt sections that carry a Delorun wording say Delorun where upstream says DeepSeek Harness, and the paragraphs of
 * the workflow and terminal tools and the checkout text follow the Delorun rules (the tool paragraphs only while the
 * step offers the tool; the checkout text only in a real checkout). The sections read the `delorunWording` property of
 * upstream's `systemPrompt` service, which this plugin turns on while it is mounted.
 *
 * The plugin is the C16 switch `model_prompt` ({@link Config.enabled}), off by default: off, it registers nothing and
 * every one of those sections keeps upstream's text, which is the parity value.
 *
 * @module @delorun/bundle-local/prompt-wording
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.systemPrompt merge.
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-prompt-wording'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `model_prompt`: whether the system prompt uses Delorun's wording. Off, the parity value and the default,
   * the plugin registers nothing and the prompt text of the harness-dev-context, tool-terminal and tool-workflow plugins
   * is upstream's, byte for byte. Delorun's composition turns it on.
   */
  readonly enabled: boolean
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * With the `model_prompt` switch on, turn Delorun's wording on in the `systemPrompt` service. Off, register nothing.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.inject(['systemPrompt'], (child) => {
    child.effect(() => child.systemPrompt.useDelorunWording(), `${name}: Delorun wording`)
  })
}
