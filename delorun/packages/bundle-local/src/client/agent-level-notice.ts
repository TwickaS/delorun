/**
 * The Conversation Definition of the level chips under an external agent's start: one Chat node where the parent
 * recorded the external execution (`subagent/catalog`, mode `external`), beside the "Started without asking" line.
 * It adds no Session event.
 *
 * @module @delorun/bundle-local/client/agent-level-notice
 */
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The Chat node kind and slot key of the line. */
export const AGENT_LEVEL_NOTICE_KIND = 'delorun-agent-level-notice'

/** What the line holds: nothing beyond its place; the levels are read when it shows. */
export interface AgentLevelNoticeData {
  /** Unix epoch ms of the `subagent/catalog` event. */
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** The level chips under an external agent's start. */
    'delorun-agent-level-notice': AgentLevelNoticeData
  }
}

/**
 * Whether an event is the catalog entry of an external execution.
 * @param event - one event the Conversation matches.
 * @returns the child's id, or undefined for any other event.
 */
function externalChildOf(event: SessionEventLike): string | undefined {
  const type: string = event.type
  if (type !== 'subagent/catalog' || !('data' in event)) return undefined
  const { data } = event
  const entry = typeof data === 'object' && data !== null ? data as Readonly<Record<string, unknown>> : undefined
  return entry?.mode === 'external' ? String(entry.childId) : undefined
}

/** The line, placed where the parent recorded the external execution. */
export const agentLevelNoticeDefinition: ConversationNodeDefinition<AgentLevelNoticeData & { readonly seq: number }> = {
  kind: 'delorun-agent-level-notice-definition',
  target: 'chat',
  match: (event) => {
    const id = externalChildOf(event)
    return id === undefined ? null : { id, role: 'start' }
  },
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : {
      key: context.key,
      kind: AGENT_LEVEL_NOTICE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: 'process',
      data: { time: context.state.time },
    },
}
