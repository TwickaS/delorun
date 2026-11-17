/**
 * Studio entry of Delorun's live agents: the agent's chat view, the agents list rows and the hand-off lines.
 * `src/client/lists/**` belongs to the lists lane; everything else here to the chat lane.
 * @module @delorun/plugin-agent-seats/client
 */
import type { Context } from '@deepseek-ai/cordis'

/** The Loader row name. */
export const name = 'delorun-agent-seats'

/**
 * Mounts the studio half.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  void ctx
}
