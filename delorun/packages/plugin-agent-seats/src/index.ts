/**
 * Host entry of Delorun's live agents: Claude Code and Codex as child chats of the chat that handed work over.
 * The plugin always declares the `externalAgents.liveAgents` preview flag; every other registration happens only while
 * the flag is on, so with it off a chat's tools, models, presets and routes are as without this package.
 * @module @delorun/plugin-agent-seats
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.previewFlags merge.
import type {} from '@delorun/preview-flags'
import { Config } from './config.ts'
import { liveAgentsOn } from './live-agents.ts'
import { mountSeats } from './mount.ts'
import { PREVIEW_FLAGS } from './preview-flags.ts'
import { seatRelay } from './relay/index.ts'

export { Config, SEATS_ROW_ID, type SeatConfig } from './config.ts'
export { mountSeats, type SeatApprover, type SeatMountOptions, type SeatRelayHook, type SeatRelayWiring } from './mount.ts'
export { seatRelay } from './relay/index.ts'
export { LIVE_AGENTS, PREVIEW_FLAGS } from './preview-flags.ts'

/** The Loader row name. */
export const name = 'delorun-agent-seats'

/** The services the plugin needs before it starts. */
export const inject = [
  'previewFlags', 'llm', 'sessions', 'sessionProjections', 'externalAgents', 'subagents', 'tools', 'agentPresets', 'connection', 'profileContext', 'approval', 'agents',
]

export { Config as schema }

/**
 * Declares the preview flag and, while it is on, mounts live agents.
 * @param ctx - the plugin context with the injected services.
 * @param config - the validated row configuration.
 * @returns resolves once the mount has finished; the flag is read once, so a change takes a reload of the row.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const flag of PREVIEW_FLAGS) ctx.effect(() => ctx.previewFlags.declare(flag), `delorun-agent-seats: preview flag ${flag.id}`)
  if (!liveAgentsOn(ctx)) return
  await mountSeats(ctx, config, { relay: seatRelay })
}
