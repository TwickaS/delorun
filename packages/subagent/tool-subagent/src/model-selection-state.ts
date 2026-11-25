/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records this Session’s child provider/model narrowing. Appended before
     * the first model request. Absence leaves the live LLM adapter as the
     * authority, so any configured route is selectable; an empty list refuses
     * explicit selection; a non-empty list narrows it to those routes.
     * Log-only: it carries no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Routes this Session narrows explicit child selection to; empty refuses it. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).nullable()

/**
 * Host-only projection of the durable model-selection policy.
 * Each independently mounted consumer registers this shared definition; the registry reference-counts it.
 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the route narrowing recorded for a Session.
 * @param subagentModelSelectionProjectionHandle - registered policy state reader.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined when the Session recorded none.
 */
export function subagentModelSelectionPolicy(
  subagentModelSelectionProjectionHandle: Pick<ProjectionHandle<AllowedModelRoute[] | null>, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return subagentModelSelectionProjectionHandle.stateOf(session)?.map(route => ({ ...route }))
}
