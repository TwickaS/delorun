/**
 * A pane's body: the shared Conversation content of one chat, as the right Sidebar embeds a subagent's chat, in the `pane` variant
 * (compact reply box) or the `embedded` one (full composer). It shows only the chat's newest part: the chat loads its recent
 * messages first and follows the tail.
 */
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaneBodyOwnerProps } from './slots.ts'

/** Props of the pane body entry. */
export type PaneBodyProps = PropsRuntime<'multiview.pane.body'> & PropsRenderFactories & PaneBodyOwnerProps

/**
 * Select the chat view only: a pane has no view tabs.
 * @param props - the content's view seat props.
 * @returns the chat view.
 */
export function ChatOnlyViews(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/**
 * Render the Conversation content of the bound chat.
 * @param props - the chat's sources, the content factory and the pane's composer choice.
 * @returns the content.
 */
export function PaneBody({ sessionId, useSession, useConversation, useSessions, renderFactorySlot, compact }: PaneBodyProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: compact ? 'pane' : 'embedded', phase, hero }, {
    slots: { views: ChatOnlyViews },
  })
}
