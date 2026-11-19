/**
 * Studio entry of Delorun's live agents: the agent's own chat (look B), its tool cards, the approval card and the
 * states a live agent can be in. `src/client/lists/**` belongs to the lists lane; everything else here to the chat lane.
 * Every entry renders nothing in a chat that is not a live agent's, so the preview flag needs no check here.
 * @module @delorun/plugin-agent-seats/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the conversation slots.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the conversation.approval slots and the pending approval.
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the tool.call.toolview slot.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import './actions.ts'
import { Banner, ComposerNote, type BannerInjected } from './Banner.tsx'
import { SeatApproval, selectSeatApproval, type ApprovalInjected } from './Approval.tsx'
import { en, NS, zh } from './locales.ts'
import type { SeatReachSource } from './actions.ts'
import { createSeatClient } from './host-routes.ts'
import { SeatToolRow } from './ToolRow.tsx'
import { RECORD_TOOL_NAMES } from './tool-model.ts'
import './view.ts'
import { registerLists } from './lists/index.ts'

export { en, NS, zh, type AgentSeatsLocaleKey } from './locales.ts'
export { Banner, chipsOf, ComposerNote, monogram, type BannerInjected, type BannerProps, type SeatTranslate } from './Banner.tsx'
export { agentOfTool, ALLOWED_FOR_RUN, allowedForRunDecision, SeatApproval, selectSeatApproval, type ApprovalInjected, type SeatApprovalProps } from './Approval.tsx'
export { recordInput, SeatToolRow, type SeatToolRowProps } from './ToolRow.tsx'
export { isRecordName, RECORD_PREFIXES, RECORD_TOOL_NAMES, toolCard, type ToolCard, type ToolRecordInput } from './tool-model.ts'
export { AGENT_NAMES, loginCommand, type AgentSeatView, type SeatAgent, type SeatModelPicker, type SeatState } from './view.ts'
export type { SeatAnswerRequest, SeatClient, SeatReach, SeatReachService, SeatReachSource } from './actions.ts'
export { createSeatClient, SEAT_ROUTES, type SeatFetch } from './host-routes.ts'

/** The Loader row name. */
export const name = 'delorun-agent-seats'

/** Services every registration needs. */
export const inject = ['slots', 'locale', 'uiWorkspace']

/** The banner sits first; the composer line sits above the message box. */
export const SLOT_ORDER = { banner: 0, composerNote: 0 } as const

const clock = (epochMs: number): string => new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const copy = (text: string): Promise<void> => navigator.clipboard.writeText(text)

/**
 * Mounts the studio half.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  registerLists(ctx)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-agent-seats: dictionaries')
  const seatClient = createSeatClient((input, init) => globalThis.fetch(input, init))
  const bannerInjected = (): BannerInjected => ({ client: seatClient, copy, clock })
  ctx.effect(() => ctx.slots.inject('conversation.session.banner', () => ctx.slots.register({
    name: 'conversation.session.banner', id: 'agent-seat', order: SLOT_ORDER.banner, locale: NS, inject: bannerInjected,
  }, Banner)), 'delorun-agent-seats: banner')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'agent-seat-note', order: SLOT_ORDER.composerNote, locale: NS,
  }, ComposerNote)), 'delorun-agent-seats: composer line')
  const approvalInjected = (): ApprovalInjected => ({ reach: ctx.get('agentSeatReach') as SeatReachSource | undefined, clock })
  // Priority 0: the chain elects the first entry whose `select` matches, ascending, and upstream's approval panel (1) takes every question.
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: 0, select: selectSeatApproval, locale: NS, inject: approvalInjected,
  }, SeatApproval)), 'delorun-agent-seats: approval card')
  for (const key of RECORD_TOOL_NAMES) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS,
    }, SeatToolRow)), `delorun-agent-seats: tool card ${key}`)
  }
}
