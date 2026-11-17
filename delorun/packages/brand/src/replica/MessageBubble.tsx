/**
 * One chat message. A person's message is a filled bubble aligned to the end; the agent's is plain full-width text.
 * @module @delorun/brand/replica/MessageBubble
 */
import type { ReactNode } from 'react'
import css from './MessageBubble.module.css'

/** The props of {@link MessageBubble}. */
export interface MessageBubbleProps {
  /** Who wrote the message; it is exposed as `data-from`. */
  readonly from: 'person' | 'agent'
  readonly children: ReactNode
  readonly className?: string | undefined
}

/**
 * Render a message.
 * @param props - see {@link MessageBubbleProps}.
 * @returns the message.
 */
export function MessageBubble({ from, children, className }: MessageBubbleProps) {
  return <div className={`${css.bubble} ${className ?? ''}`.trim()} data-from={from}>{children}</div>
}
