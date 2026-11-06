/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { DisclosureRow, IconThinkOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatViewSlotProps, UseDisclosure, UsePresentation } from '../contract/slots.ts'
import { reasoningText } from '../reasoning-text.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const THINK_ICON = <IconThinkOutlineRegular size={14} />

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary omits double-asterisk markers; expanded content renders
 * the complete Markdown with secondary typography. A streaming preview advances
 * when a paragraph's first line completes. Mode changes toggle CSS display without unmounting
 * collapsed summaries. The Body Slot receives both original and display-ready text. The policy's
 * `thinking` decides the rest: `title` shows no preview, `live` stays open while the block streams,
 * `expanded` starts open, and `window` shows the body in a window of `thinkingWindowLines` lines
 * that follows the stream until the reader opens it in full.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.usePresentation - live display-policy selector for this reasoning row.
 * @param props.useDisclosure - independent open state with enclosing-Turn resets.
 * @param props.renderSlot - framework renderer for the standard reasoning Body Slot.
 * @param props.t - conversation locale seat for the disclosure and running status.
 * @returns the reasoning disclosure.
 */
export const ReasoningRow = memo(function ReasoningRow({
  text: rawText, running, textInteractionSource = false, usePresentation, useDisclosure, renderSlot, t,
}: {
  text: string
  running: boolean
  textInteractionSource?: boolean
  useDisclosure: UseDisclosure
  usePresentation: UsePresentation
  t: ChatViewSlotProps['t']
} & Pick<PropsRenderSlots<'conversation.chat.reasoning.body'>, 'renderSlot'>) {
  const { expanded, toggle } = useDisclosure()
  const thinking = usePresentation(policy => policy.thinking)
  const windowLines = usePresentation(policy => policy.thinkingWindowLines)
  // `expanded` starts open, so the reader's toggle closes it there.
  const open = thinking === 'expanded' ? !expanded : expanded || (thinking === 'live' && running)
  const windowed = thinking === 'window' && !expanded
  const shown = open || windowed
  const { text, hidden } = useMemo(() => {
    const text = reasoningText(rawText)
    return { text, hidden: text !== rawText && text.trim() === '' }
  }, [rawText])
  const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  const summary = useMemo(() => summaryText.replaceAll('**', ''), [summaryText])
  const preview = usePresentation(policy => !shown && summary !== '' && policy.thinking !== 'title'
    && (running || policy.settledReasoningPreview))
  const windowRef = useRef<HTMLDivElement>(null)
  // The window follows the stream: each new line scrolls it to the end.
  useLayoutEffect(() => {
    const node = windowRef.current
    if (node !== null && running) node.scrollTop = node.scrollHeight
  }, [running, text, windowed])
  const collapsedContent = useMemo(() => (
    <>
      <span className={css.separator} data-shimmer-decoration aria-hidden />
      <span className={css.summary} data-streaming={running || undefined}>
        <span className={css.summaryText}>
          <TextShimmer>{summary}</TextShimmer>
        </span>
      </span>
    </>
  ), [running, summary])
  const content = useMemo(() => {
    if (!shown) return undefined
    const body = (
      <div className={css.thinkBody} data-text-interaction-source={textInteractionSource && !running ? '' : undefined}>
        {renderSlot('conversation.chat.reasoning.body', { rawText, text, running })}
      </div>
    )
    if (!windowed) return body
    return (
      <div ref={windowRef} className={css.thinkWindow} data-streaming={running || undefined}
        style={{ '--think-window-lines': windowLines } as CSSProperties}>
        {body}
      </div>
    )
  }, [shown, windowed, windowLines, renderSlot, running, rawText, text, textInteractionSource])

  if (hidden) return null

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={shown || undefined}
      data-thinking={thinking}
      data-preview={preview || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={THINK_ICON}
        title={t('message.think')}
        running={running}
        open={shown}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={collapsedContent}
      >
        {content}
      </DisclosureRow>
    </div>
  )
})
