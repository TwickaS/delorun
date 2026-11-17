/**
 * The Conversation Definition of the stop notice: one Chat node for each turn whose `turn/end` records the guard's
 * cancel reason.
 *
 * @module @delorun/plugin-tool-failure-guard/client/stop-notice
 */
import type { ConversationMatchHandler, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TOOL_FAILURE_GUARD_STOP_REASON } from '../tally.ts'

/** The Chat node kind and slot key of the stop notice. */
export const STOP_NOTICE_KIND = 'tool-failure-stop'

/** What the stop notice shows: the turn it ended. */
export interface ToolFailureStopData {
  readonly turn: number
  /** Unix epoch ms of the `turn/end` event. */
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A turn the tool-failure guard stopped. */
    'tool-failure-stop': ToolFailureStopData
  }
}

/** The state one notice holds: the `turn/end` event that recorded the stop. */
interface StopState extends ToolFailureStopData {
  readonly seq: number
}

/** One event a Conversation Definition matches: a session event or a live assistant chunk. */
type MatchedEvent = Parameters<ConversationMatchHandler>[0]

/**
 * Whether a `turn/end` records a stop by the guard.
 * @param event - one event the Conversation matches.
 * @returns true for a turn the guard cancelled.
 */
export function isGuardStop(event: MatchedEvent): event is SessionEvent<'turn/end'> {
  if (event.type !== 'turn/end') return false
  const reason = event.data.reason
  return reason.kind === 'aborted' && reason.reason.kind === 'hook' && reason.reason.reason === TOOL_FAILURE_GUARD_STOP_REASON
}

/** The stop notice, placed just after the turn's last event. */
export const stopNoticeDefinition: ConversationNodeDefinition<StopState> = {
  kind: 'tool-failure-stop-notice',
  target: 'chat',
  match: event => isGuardStop(event) ? { id: String(event.data.turn), role: 'start' } : null,
  start: (_context, match) => {
    if (!isGuardStop(match.event)) throw new Error('tool-failure-stop-notice start requires a guard turn/end')
    return { turn: match.event.data.turn, time: match.event.time, seq: match.event.seq }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: STOP_NOTICE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      // At turn level, as upstream's turn-error row; without it the row folds into the turn's collapsed tool calls.
      groupTree: 'turn',
      data: { turn: context.state.turn, time: context.state.time },
    }
  },
}
