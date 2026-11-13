/**
 * The cost meter's studio half: one `conversation.composer.dock` entry, the cost pill after upstream's activity and
 * usage pills, with its breakdown dialog. It applies only while the Delo look provides `deloStudio`, as every row of
 * `@delo/bundle-studio` does.
 * @module @delo/plugin-cost-meter/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.sessions merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the conversation.composer.dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CostPill, type CostPillInjected } from './CostPill.tsx'
import { en, NS, zh } from './locales.ts'

export { CostBreakdown, type CostBreakdownProps, type CostGroup } from './CostBreakdown.tsx'
export { CostPill, type CostPillInjected, type CostPillProps } from './CostPill.tsx'
export { addCosts, collectAgents, counted, formatCost, formatExact, formatTokens, NO_COST } from './costs.ts'
export type { AgentCost, AgentSessionRow, AgentTree, AgentValues, LoadedValues, Translate } from './costs.ts'
export { en, NS, zh, type CostMeterLocaleKey } from './locales.ts'
export type { CostMeterView, CostModelRow } from '../view.ts'

/** The dock entry's id and place: after upstream's activity (0) and usage (1) pills. */
export const DOCK_ENTRY = { id: 'cost', order: 2 } as const

/** Services every registration needs; `deloStudio` is injected inside {@link apply}, so the stock look registers nothing. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * While the Delo look provides `deloStudio`, register the copy and the pill.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['deloStudio'], applyStudio)
}

/**
 * Everything the plugin registers while the Delo look is on; disposed with the `deloStudio` service or the plugin.
 * @param ctx - the browser plugin context, holding `deloStudio`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-cost-meter: dictionaries')
  const injected: CostPillInjected = {
    loadCosts: (ids: readonly SessionId[]) => {
      for (const id of ids) {
        ctx.sessions.refreshProjections(id).catch(() => {
          // The dialog keeps listing the agent as not available; the next opening asks again.
        })
      }
    },
  }
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', ...DOCK_ENTRY, locale: NS, inject: () => injected,
  }, CostPill)), 'delo-cost-meter: cost pill')
}
