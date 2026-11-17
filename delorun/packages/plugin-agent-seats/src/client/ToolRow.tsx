/** The cards of a program's own tool calls: "Ran", "Searched", "Edited file" and a generic row. */
import { useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SeatTranslate } from './Banner.tsx'
import { toolCard, type ToolCard, type ToolRecordInput } from './tool-model.ts'
import css from './Seat.module.css'

/** Props the renderer binds for a seat record's card. */
export type SeatToolRowProps = ToolCallViewProps & { readonly t: SeatTranslate }

/**
 * Read the record's name, arguments and result from the phase the call is in.
 * @param props - the slot's props.
 * @returns the model's input.
 */
export function recordInput(props: ToolCallViewProps): ToolRecordInput {
  if (props.phase === 'preparing') return { name: props.toolName, argsRaw: '', result: null }
  if (props.phase === 'start') return { name: props.toolName, argsRaw: props.block.argsRaw, result: null }
  const block = props.block
  const text = block.content.map(part => part.type === 'text' ? part.text : '').join('')
  const seconds = block.callTime === null ? null : Math.max(0, (block.time - block.callTime) / 1000)
  return { name: props.toolName, argsRaw: block.call?.argsRaw ?? '', result: { text, isError: block.isError, seconds } }
}

function Badge({ card, t }: { readonly card: ToolCard; readonly t: SeatTranslate }) {
  if (card.state === 'running') return <span className={css.badge}>{t('tool.running')}</span>
  if (card.kind === 'ran' && card.exitCode !== null && card.exitCode !== 0) {
    return <span className={`${css.badge} ${css.badgeFailed}`}>{t('tool.exit', { code: String(card.exitCode) })}</span>
  }
  if (card.state === 'failed') return <span className={`${css.badge} ${css.badgeFailed}`}>{t('tool.failed')}</span>
  return card.kind === 'ran' ? <span className={`${css.badge} ${css.badgeOk}`}>{t('tool.passed')}</span> : null
}

/**
 * One card.
 * @param props - the call, its phase and the dictionary.
 * @returns the card.
 */
export function SeatToolRow(props: SeatToolRowProps) {
  const { t, inspect } = props
  const card = toolCard(recordInput(props))
  const [open, setOpen] = useState(false)
  const time = card.seconds === null ? null : <span className={css.time}>{card.seconds.toFixed(1)}s</span>
  if (card.kind === 'edited') {
    return (
      <div className={css.editCard} data-seat-tool="edited" data-state={card.state}>
        <span className={css.subject}>{t('tool.edited')} {card.subject}</span>
        {card.diff !== null && (
          <span><span className={css.diffAdd}>+{card.diff.added}</span> <span className={css.diffDel}>−{card.diff.removed}</span></span>
        )}
      </div>
    )
  }
  const verb = card.kind === 'ran' ? t('tool.ran') : card.kind === 'searched' ? t('tool.searched') : t('tool.generic', { name: props.toolName.slice(props.toolName.indexOf('.') + 1) })
  const matches = card.matches === null ? null : card.matches === 1 ? t('tool.matches.one') : t('tool.matches', { count: String(card.matches) })
  return (
    <div className={css.tool} data-seat-tool={card.kind} data-state={card.state}>
      <div className={css.toolRow}>
        <span className={css.verb}>{verb}</span>
        <span className={css.dot} aria-hidden>·</span>
        <span className={css.subject} title={card.subject}>{card.subject}</span>
        {card.where !== null && <span className={css.verb}>{card.where}</span>}
        <span className={css.spacer} />
        {matches !== null && <span className={css.time}>{matches}</span>}
        <Badge card={card} t={t} />
        {time}
        {card.output !== null && card.output !== '' && (
          <button type="button" className={css.toggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{t('tool.output')}</button>
        )}
        {inspect !== undefined && <button type="button" className={css.toggle} aria-label={t('tool.inspect')} onClick={inspect}>⌕</button>}
      </div>
      {open && card.output !== null && <pre className={css.output}>{card.output}</pre>}
    </div>
  )
}
