/**
 * The lists half of the live agents' studio entry: the agents menu's monograms, state words, rings and Answer buttons,
 * the "· N outside" trigger addition, and the hand-off lines. The studio entry calls `registerLists` once.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the tool.call.toolview slot.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: the agents menu's row and trigger slots.
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import { HandOffLine, HAND_OFF_TOOLS, type HandOffInjected } from './HandOff.tsx'
import { en, NS, zh } from './locales.ts'
import { RowMonogram, RowTrail, RowWords, TriggerOutside, type PartsInjected } from './Parts.tsx'

export { en, NS, zh, type ListsKey } from './locales.ts'
export { HandOffLine, HAND_OFF_TOOLS, type HandOffInjected, type HandOffProps } from './HandOff.tsx'
export { RowMonogram, RowTrail, RowWords, TriggerOutside, type ListsTranslate, type PartsInjected, type RowPartProps, type TriggerPartProps } from './Parts.tsx'
export {
  monogramOf, outsideCount, parseHandOffInput, parseHandOffResult, ringOf, shortDuration, wordsOf,
  type HandOffInput, type HandOffResult, type MonogramSpec, type RingSpec, type SeatWords,
} from './format.ts'
export { seatOf, waitingOf } from './read.ts'

const clock = (epochMs: number): string => new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Registers the lists' dictionaries, row and trigger positions and hand-off lines.
 * @param ctx - the studio context; needs `slots`, `locale` and `uiWorkspace`.
 */
export function registerLists(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-agent-seats: list dictionaries')
  const parts = (): PartsInjected => ({ clock })
  const row = (name: 'conversation.session.header.actions.subagent.row.lead' | 'conversation.session.header.actions.subagent.row.detail' | 'conversation.session.header.actions.subagent.row.trail', id: string, component: typeof RowMonogram): void => {
    ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, id, locale: NS, inject: parts }, component)), `delorun-agent-seats: ${id}`)
  }
  row('conversation.session.header.actions.subagent.row.lead', 'seat-row-monogram', RowMonogram)
  row('conversation.session.header.actions.subagent.row.detail', 'seat-row-words', RowWords)
  row('conversation.session.header.actions.subagent.row.trail', 'seat-row-trail', RowTrail)
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions.subagent.trigger', () => ctx.slots.register({
    name: 'conversation.session.header.actions.subagent.trigger', id: 'seat-trigger-outside', locale: NS,
  }, TriggerOutside)), 'delorun-agent-seats: trigger addition')
  const handOff = (): HandOffInjected => ({
    openChild: (parentSessionId, childSessionId) => {
      ctx.uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })
    },
  })
  for (const key of Object.keys(HAND_OFF_TOOLS)) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS, inject: handOff,
    }, HandOffLine)), `delorun-agent-seats: hand-off line ${key}`)
  }
}
