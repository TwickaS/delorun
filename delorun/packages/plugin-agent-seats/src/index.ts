/**
 * Host entry of Delorun's live agents: Claude Code and Codex as child chats of the chat that handed work over.
 * Everything here runs only while the `externalAgents.liveAgents` preview flag is on.
 * @module @delorun/plugin-agent-seats
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.previewFlags merge.
import type {} from '@delorun/preview-flags'
import { Config } from './config.ts'
import { PREVIEW_FLAGS } from './preview-flags.ts'

export { Config, SEATS_ROW_ID, type SeatConfig } from './config.ts'
export { LIVE_AGENTS, PREVIEW_FLAGS } from './preview-flags.ts'

/** The Loader row name. */
export const name = 'delorun-agent-seats'

/** The services the plugin needs before it starts. */
export const inject = ['previewFlags']

export { Config as schema }

/**
 * Declares the preview flag.
 * @param ctx - the plugin context with the injected services.
 * @param config - the validated row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  void config
  for (const flag of PREVIEW_FLAGS) ctx.effect(() => ctx.previewFlags.declare(flag), `delorun-agent-seats: preview flag ${flag.id}`)
}
