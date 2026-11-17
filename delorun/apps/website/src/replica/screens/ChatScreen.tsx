/**
 * The drawn studio's chat: the session's events as the simplified transcript draws them, and below it the composer, or
 * the approval card while a command waits for an answer (the studio shows the card in the composer's place).
 * @module @delorun/website/replica/screens/ChatScreen
 */
import type { ReactNode } from 'react'
import { Composer, MessageBubble, ToolCard, Transcript } from '@brand/replica/index.ts'
import { REPLICA_COPY } from '../copy.ts'
import type { ReplicaEvent } from '../model.ts'
import type { ReplicaStrings } from '../strings.ts'
import css from './studio.module.css'

/** A pending approval, for the slot that draws the card. */
export type PendingApproval = Extract<ReplicaEvent, { type: 'approval/asked' }>['data'] & { readonly command: string }

/** The props of {@link ChatScreen}. */
export interface ChatScreenProps {
  readonly events: readonly ReplicaEvent[]
  /** How many events show. */
  readonly shown: number
  readonly draft: string
  readonly typing: boolean
  readonly strings: ReplicaStrings
  /**
   * Draws the approval card for a pending approval. The still passes it too, for an approval pending in the events it
   * starts from (`later`).
   */
  readonly approval?: ((pending: PendingApproval) => ReactNode) | undefined
  /**
   * For the still: the number of events the replay starts from. The events after it, up to `shown`, are drawn in a
   * wrapper the stylesheet shows only where the replay does not play (reduced motion, scripts off), so one markup holds
   * both the replay's first state and the finished chat, which then keeps its end in view. An approval pending at that
   * first state shows its card there, and the composer in the finished chat.
   */
  readonly later?: number | undefined
}

/**
 * The text of a message's parts.
 * @param content - the parts.
 * @returns the text.
 */
function text(content: readonly { readonly text: string }[]): string {
  return content.map(part => part.text).join('\n')
}

/**
 * A tool call's command, from its JSON arguments.
 * @param event - the call.
 * @returns the command, or the raw arguments when they name none.
 */
export function commandOf(event: Extract<ReplicaEvent, { type: 'tool/call' }>): string {
  const parsed: { command?: unknown } = JSON.parse(event.data.arguments)
  return typeof parsed.command === 'string' ? parsed.command : event.data.arguments
}

/**
 * The approval waiting for an answer among the shown events.
 * @param shown - the shown events.
 * @returns the approval with its command, or undefined.
 */
export function pendingApproval(shown: readonly ReplicaEvent[]): PendingApproval | undefined {
  for (const [index, event] of shown.entries()) {
    if (event.type !== 'approval/asked') continue
    if (shown.slice(index + 1).some(later => later.type === 'approval/decided' && later.data.id === event.data.id)) continue
    const call = shown.find(row => row.type === 'tool/call' && row.data.callId === event.data.callId)
    return { ...event.data, command: call?.type === 'tool/call' ? commandOf(call) : '' }
  }
  return undefined
}

/**
 * Render the chat.
 * @param props - see {@link ChatScreenProps}.
 * @returns the transcript and the composer or the card.
 */
export function ChatScreen({ events, shown, draft, typing, strings, approval, later }: ChatScreenProps) {
  const visible = events.slice(0, shown)
  const pending = pendingApproval(visible)
  const rows = visible.map((event, index): ReactNode => {
    switch (event.type) {
      case 'user/message': return <MessageBubble key={index} from="person">{text(event.data.content)}</MessageBubble>
      case 'assistant/message': return <MessageBubble key={index} from="agent">{text(event.data.message.content)}</MessageBubble>
      case 'tool/call': {
        const result = visible.find(row => row.type === 'tool/result' && row.data.message.toolCallId === event.data.callId)
        const done = result?.type === 'tool/result' ? result.data.message : undefined
        const status = done === undefined ? 'running' : done.isError ? 'failed' : 'done'
        return <ToolCard key={index} title={strings.conversation['tool.title.bash']} command={commandOf(event)} status={status}
          statusLabel={status === 'running' ? strings.conversation['bash.running'] : status === 'failed' ? strings.conversation['bash.failed'] : undefined}
          output={done === undefined ? undefined : text(done.content)} />
      }
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
      case 'approval/asked':
      case 'approval/decided':
      case 'tool/result':
        return null
    }
  })
  const atStart = later === undefined || approval === undefined ? undefined : pendingApproval(visible.slice(0, later))
  const composer = <Composer label={strings.conversation['placeholder.default']} placeholder={strings.conversation['placeholder.default']} value={draft} typing={typing} sendLabel={strings.conversation['input.send']} />
  const first = later === undefined ? rows : rows.slice(0, later)
  const rest = later === undefined ? [] : rows.slice(later)
  return <div className={css.chatScreen} data-still-chat={later === undefined ? undefined : ''}>
    <Transcript label={REPLICA_COPY.transcript} className={css.transcript}>
      {first}
      {rest.some(row => row !== null) ? <div className={css.later} data-later="">{rest}</div> : null}
    </Transcript>
    <div className={css.composerSlot}>
      {atStart !== undefined && approval !== undefined
        ? <>
            <div className={css.startOnly} data-start-only="">{approval(atStart)}</div>
            <div className={css.later} data-later="">{composer}</div>
          </>
        : pending !== undefined && approval !== undefined ? approval(pending) : composer}
    </div>
  </div>
}
