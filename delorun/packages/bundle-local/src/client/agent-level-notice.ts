/**
 * The Conversation Definition of the level chips under an external agent's start: one Chat node for a call of
 * `subagent_claude_code` or `subagent_codex`, shown once the call's result says the agent started. The agent is read from
 * the logged call's tool name, so each start shows only the level of the agent that was started. It adds no Session event.
 *
 * @module @delorun/bundle-local/client/agent-level-notice
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The Chat node kind and slot key of the line. */
export const AGENT_LEVEL_NOTICE_KIND = 'delorun-agent-level-notice'

/** The provider each external agent's tool is registered for, by tool name. */
export const EXTERNAL_AGENT_TOOLS: Readonly<Record<string, 'claude-code' | 'codex'>> = {
  subagent_claude_code: 'claude-code',
  subagent_codex: 'codex',
}

/** What the line holds: the started agent and when; the levels are read when it shows. */
export interface AgentLevelNoticeData {
  /** The provider of the agent that started, as the levels route names it. */
  readonly provider: 'claude-code' | 'codex'
  /** Unix epoch ms of the tool result that reported the start. */
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** The level chip under an external agent's start. */
    'delorun-agent-level-notice': AgentLevelNoticeData
  }
}

/** The state of one hand-off call: its agent, and the result once it reported a start. */
interface NoticeState {
  readonly provider: AgentLevelNoticeData['provider']
  /** The call's `seq` until a result arrives, then the result's. */
  readonly seq: number
  readonly time: number
  readonly started: boolean
}

/** The line, placed where the hand-off call reported that the agent started. */
export const agentLevelNoticeDefinition: ConversationNodeDefinition<NoticeState> = {
  kind: 'delorun-agent-level-notice-definition',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call') {
      return EXTERNAL_AGENT_TOOLS[event.data.name] === undefined ? null : { id: String(event.data.callId), role: 'start' }
    }
    return event.type === 'tool/result' ? { id: String(event.data.message.source.callId), role: 'update' } : null
  },
  start: (_context, match) => {
    const { event } = match
    const provider = event.type === 'tool/call' ? EXTERNAL_AGENT_TOOLS[event.data.name] : undefined
    if (provider === undefined) throw new Error('delorun-agent-level-notice start requires a hand-off tool/call')
    return { provider, seq: event.seq, time: event.time, started: false }
  },
  update: (context, match) => {
    const { event } = match
    if (event.type !== 'tool/result' || event.data.message.isError === true) return context.state
    return { ...context.state, seq: event.seq, time: event.time, started: true }
  },
  buildViewNode: context => context.state?.started !== true
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
      data: { provider: context.state.provider, time: context.state.time },
    },
}
