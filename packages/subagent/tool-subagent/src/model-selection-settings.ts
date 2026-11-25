/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled during Agent creation. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Stored user preference; the shipped composition defaults it on. */
export interface SubagentModelSelectionSettings {
  /** Whether new top-level Sessions let agents choose a child route at all. */
  enabled: boolean
  /**
   * Optional narrowing of the routes those Sessions may name. Empty means no
   * narrowing: any provider and model the person has configured is selectable.
   */
  allowedModels: AllowedModelRoute[]
}

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled: Volatile<boolean>
  /** Initial narrowing inherited when the user document does not override it; empty narrows nothing. */
  allowedModels: Volatile<AllowedModelRoute[]>
}

/** Host settings owner that records Session authorization before the first model request. */
export class SubagentModelSelectionConfig extends Service {
  static inject = ['sessionProjections', 'sessions']

  static Config = z.object({
    enabled: z.boolean().default(true).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const policyReady = ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    ctx.on('agent/created', async ({ agent }) => {
      const policy = await policyReady
      ctx.fiber.assertActive()
      const target = agent.session
      if (subagentModelSelectionPolicy(policy, target) !== undefined) return
      let allowedModels: AllowedModelRoute[] | undefined
      const parentId = target.header.origin === 'subagent' ? target.header.parentSession : undefined
      if (parentId !== undefined) {
        const parent = ctx.sessions.get(parentId)
        if (parent !== undefined) allowedModels = subagentModelSelectionPolicy(policy, parent)
      } else if (target.firstLiveSeq === 0
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed') {
        const current = this.current()
        // Three states: no event leaves the live adapter as the authority, an
        // empty list refuses explicit selection, and a non-empty list narrows it.
        allowedModels = current.enabled
          ? current.allowedModels.length === 0 ? undefined : current.allowedModels
          : []
      }
      if (allowedModels !== undefined) target.append('subagent/model-selection-policy', { allowedModels })
    })
    await policyReady
  }

  /**
   * Read a detached selection preference for the next fresh top-level Session.
   * @returns whether agents may choose a child route, and the optional narrowing.
   */
  private current(): SubagentModelSelectionSettings {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    return { enabled, allowedModels: allowedModels.map(route => ({ ...route })) }
  }

}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
