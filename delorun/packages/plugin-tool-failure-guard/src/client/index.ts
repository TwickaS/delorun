/**
 * The tool-failure guard's studio half: one Chat row under each turn the guard stopped, saying why and how to carry on.
 * It reads only the recorded `turn/end` events, so the row shows again when the chat is reopened. It registers in the
 * stock look too, because the guard stops turns there as well.
 * @module @delorun/plugin-tool-failure-guard/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Chat node slot and its keyed data map.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: the ctx.uiConversation merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './locales.ts'
import { StopNotice } from './StopNotice.tsx'
import { STOP_NOTICE_KIND, stopNoticeDefinition } from './stop-notice.ts'

export { en, NS, zh, type ToolFailureGuardLocaleKey } from './locales.ts'
export { StopNotice, type StopNoticeProps } from './StopNotice.tsx'
export { isGuardStop, STOP_NOTICE_KIND, stopNoticeDefinition, type ToolFailureStopData } from './stop-notice.ts'

/** The services the notice registers with. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Register the copy, the Conversation Definition and the Chat row renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-tool-failure-guard: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(stopNoticeDefinition), 'delorun-tool-failure-guard: stop notice')
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: STOP_NOTICE_KIND, locale: NS,
  }, StopNotice)), 'delorun-tool-failure-guard: stop notice row')
}
