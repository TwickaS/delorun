/**
 * The only Host file of this package that reads the `externalAgents.liveAgents` preview flag. With the flag off the
 * package registers nothing a model or a person meets. The `gates:preview-flags` gate names this file with its reason.
 * @module @delorun/plugin-agent-seats/live-agents
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.previewFlags merge.
import type {} from '@delorun/preview-flags'
import { LIVE_AGENTS } from './preview-flags.ts'

/**
 * Whether live agents are on.
 * @param ctx - a context with `previewFlags`.
 * @returns true when the profile's preview-flags row sets `externalAgents.liveAgents`.
 */
export function liveAgentsOn(ctx: Context): boolean {
  return ctx.previewFlags.isOn(LIVE_AGENTS.id)
}
