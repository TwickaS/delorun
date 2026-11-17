/**
 * The Conversation Definitions of the "Started without asking" line: one Chat node under an external agent's start in a
 * chat whose last recorded approval policy is `never` and last recorded sandbox mode is `danger-full-access`, the Full
 * access preset's two values together. Both are folded from recorded events (`approval/policy`, `sandbox/mode` and the
 * parent's `subagent/catalog` entry for an external execution), so the line shows again when the chat is reopened and
 * adds no Session event. A value the configuration sets without a recorded event, or one recorded before the loaded
 * window, shows no line.
 *
 * @module @delorun/bundle-local/client/full-access-start
 */
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The Chat node kind and slot key of the line. */
export const FULL_ACCESS_START_KIND = 'delorun-full-access-start'

/** The kind of the state-only Definition that holds each recorded approval policy. */
export const APPROVAL_POLICY_KIND = 'delorun-approval-policy'

/** The kind of the state-only Definition that holds each recorded sandbox mode. */
export const SANDBOX_MODE_KIND = 'delorun-sandbox-mode'

/** What the line shows: when the external agent started. */
export interface FullAccessStartData {
  /** Unix epoch ms of the `subagent/catalog` event. */
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** An external agent that started in a chat whose approval policy is `never`. */
    'delorun-full-access-start': FullAccessStartData
  }
}

/** The state of one recorded policy change. */
interface PolicyState {
  readonly policy: string
}

/** The state of one recorded sandbox mode switch. */
interface ModeState {
  readonly mode: string
}

/** The state of one start: the log position, the time and the policy in force. */
interface StartState extends FullAccessStartData {
  readonly seq: number
  readonly policy: string | undefined
  readonly mode: string | undefined
}

/**
 * The payload of an event of a type this browser half does not import the declaration of: the approval and subagent
 * packages declare these events for the Host only.
 * @param event - one event the Conversation matches.
 * @param type - the event type.
 * @returns the payload as a record, or undefined for another type or a payload that is not an object.
 */
function payloadOf(event: SessionEventLike, type: string): Readonly<Record<string, unknown>> | undefined {
  const eventType: string = event.type
  if (eventType !== type || !('data' in event)) return undefined
  const { data } = event
  return typeof data === 'object' && data !== null ? data as Readonly<Record<string, unknown>> : undefined
}

/** Each recorded `approval/policy` event, which the start Definition reads strictly backwards. */
export const approvalPolicyDefinition: ConversationNodeDefinition<PolicyState> = {
  kind: APPROVAL_POLICY_KIND,
  match: event => payloadOf(event, 'approval/policy') === undefined ? null : { id: String(event.seq), role: 'start' },
  start: (_context, match) => {
    const policy = payloadOf(match.event, 'approval/policy')?.policy
    if (typeof policy !== 'string') throw new Error('delorun-approval-policy start requires an approval/policy event')
    return { policy }
  },
  update: context => context.state,
}

/** Each recorded `sandbox/mode` event, which the start Definition reads strictly backwards. */
export const sandboxModeDefinition: ConversationNodeDefinition<ModeState> = {
  kind: SANDBOX_MODE_KIND,
  match: event => payloadOf(event, 'sandbox/mode') === undefined ? null : { id: String(event.seq), role: 'start' },
  start: (_context, match) => {
    const mode = payloadOf(match.event, 'sandbox/mode')?.mode
    if (typeof mode !== 'string') throw new Error('delorun-sandbox-mode start requires a sandbox/mode event')
    return { mode }
  },
  update: context => context.state,
}

/** The line, placed where the parent recorded the external execution. */
export const fullAccessStartDefinition: ConversationNodeDefinition<StartState> = {
  kind: 'delorun-full-access-start-notice',
  target: 'chat',
  match: (event) => {
    const entry = payloadOf(event, 'subagent/catalog')
    return entry?.mode === 'external' ? { id: String(entry.childId), role: 'start' } : null
  },
  start: (_context, match, reader) => ({
    seq: match.event.seq,
    time: match.event.time,
    policy: reader.previous<PolicyState>(APPROVAL_POLICY_KIND)?.state.policy,
    mode: reader.previous<ModeState>(SANDBOX_MODE_KIND)?.state.mode,
  }),
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state?.policy !== 'never' || context.state.mode !== 'danger-full-access') return null
    return {
      key: context.key,
      kind: FULL_ACCESS_START_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      // Beside the hand-off's tool call, in the turn's process disclosure, as upstream's model-retry row.
      groupTree: 'process',
      data: { time: context.state.time },
    }
  },
}
