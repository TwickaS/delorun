/**
 * What both halves of the chat-states plugin share: the exact Connection
 * Fetch routes under `/api`, which the harness serves only to an admitted
 * peer, and their JSON messages. Browser-safe, so the studio half imports it.
 * @module @delo/plugin-chat-states/wire
 */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'

/** The harness's paths. The studio fetches each without its leading `/`, relative to the document. */
export const CHAT_STATE_PATHS = {
  /** `GET`: every chat's snooze and settle state, as {@link ChatStatesResponse}. */
  list: '/api/deloChatStates.list',
  /** `POST` a {@link ChatStateRequest}: answers {@link ChatStatesResponse} once the change is stored. */
  set: '/api/deloChatStates.set',
} as const

/** The characters and length of a chat's session id as the routes take it. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

/** A chat's session id as the harness stores and answers it. */
export const storedSessionKey = z.string().regex(SESSION_ID_PATTERN)

/** A chat's session id in a request, branded once it passes validation. */
export const sessionKey = storedSessionKey.transform(SessionId)

/** The longest snooze, one year in milliseconds. A protocol limit, not a deployment setting. */
export const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000

/** One chat's state, each time in epoch milliseconds from the harness's clock. */
export const ChatState = z.strictObject({
  /** When the person settled the chat. */
  settledAt: z.number().int().nonnegative().optional(),
  /** When the person snoozed the chat. */
  snoozedAt: z.number().int().nonnegative().optional(),
  /** When the snooze ends. */
  snoozedUntil: z.number().int().nonnegative().optional(),
  /** When a snooze ended by its time, kept until the person sees the chat. */
  wokeAt: z.number().int().nonnegative().optional(),
  /** When the person last returned the chat to the list; auto-settle counts idle days from then at the earliest. */
  keptAt: z.number().int().nonnegative().optional(),
})

/** One chat's state. */
export type ChatState = z.output<typeof ChatState>

/**
 * A chat's state as the harness stores it: the state plus when the chat was first seen missing from the session list,
 * which is how a chat moved to the trash keeps its state until its retention ends. Never sent to the studio.
 */
export const StoredChatState = ChatState.extend({
  /** When a sweep first found the chat missing from the session list; cleared when it reappears. */
  missingSince: z.number().int().nonnegative().optional(),
})

/** A chat's state as the harness stores it. */
export type StoredChatState = z.output<typeof StoredChatState>

/** Every chat that is settled, snoozed or woke, by session id. */
export const ChatStatesResponse = z.strictObject({ chats: z.record(storedSessionKey, ChatState) })

/** Every chat that is settled, snoozed or woke, by session id. */
export type ChatStatesResponse = z.output<typeof ChatStatesResponse>

/** A change to one chat: settle it, return it to the list, snooze it until a time, wake it, or mark its waking seen. */
export const ChatStateRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('settle'), session: sessionKey }),
  z.strictObject({ action: z.literal('unsettle'), session: sessionKey }),
  z.strictObject({ action: z.literal('snooze'), session: sessionKey, until: z.number().int().positive() }),
  z.strictObject({ action: z.literal('wake'), session: sessionKey }),
  z.strictObject({ action: z.literal('seen'), session: sessionKey }),
])

/** A change to one chat, with its session id branded. */
export type ChatStateRequest = z.output<typeof ChatStateRequest>

/**
 * Why the harness answered a route with a refusal: the request is not a change to a chat (400), a snooze does not end
 * between now and a year from now (400), or the states could not be stored (500).
 */
export const CHAT_STATE_REFUSAL_CODES = ['invalid-request', 'snooze-out-of-range', 'failed'] as const

/** One of {@link CHAT_STATE_REFUSAL_CODES}. */
export type ChatStateRefusalCode = typeof CHAT_STATE_REFUSAL_CODES[number]

/** A refused request: a stable code and a sentence that does not name internal details. */
export const ChatStateRefusal = z.strictObject({ code: z.enum(CHAT_STATE_REFUSAL_CODES), message: z.string() })

/** A refused request. */
export type ChatStateRefusal = z.output<typeof ChatStateRefusal>
