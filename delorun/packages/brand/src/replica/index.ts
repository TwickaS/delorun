/**
 * The pieces of a simplified studio chat: a message bubble, a scrolling transcript, a tool card and a composer. They
 * draw only with the brand components and `--dl-*` tokens, and every visible string comes in through props.
 * @module @delorun/brand/replica
 */
export { Composer, type ComposerProps } from './Composer.tsx'
export { MessageBubble, type MessageBubbleProps } from './MessageBubble.tsx'
export { ToolCard, type ToolCardProps, type ToolCardStatus } from './ToolCard.tsx'
export { Transcript, type TranscriptProps } from './Transcript.tsx'
