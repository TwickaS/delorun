/**
 * The four positions Delorun adds to the agents menu (look C): a monogram before each row, the state words on its
 * second line, the 5-hour ring and the Answer button after it, and "· 2 outside" after the trigger's count.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentRowOwner, SubagentTriggerOwner } from '@deepseek-ai/dsh-client-ui-subagent/client'
import type { ListsKey } from './locales.ts'
import { monogramOf, outsideCount, programOf, ringOf, wordsOf } from './format.ts'
import { seatOf, waitingOf } from './read.ts'
import css from './Lists.module.css'

/** The dictionary as the parts' `t`. */
export type ListsTranslate = TranslateNS<'delorunAgentSeatLists'>

/** Business face the parts receive. */
export interface PartsInjected {
  /** Formats an epoch time as a clock time. */
  readonly clock: (epochMs: number) => string
}

/** Props of a row part. */
export type RowPartProps = SubagentRowOwner & { readonly t: ListsTranslate } & PartsInjected

/**
 * The monogram before the row's state dot; ordinary subagents get a letter, outside agents the program's letters and
 * the arrow-out mark.
 * @param props - the row and the dictionary.
 * @returns the monogram.
 */
export function RowMonogram(props: RowPartProps) {
  const { t } = props
  const seat = seatOf(props.values)
  const spec = monogramOf(seat, props.label)
  const label = seat === undefined ? undefined : t('row.outside.aria', { agent: programOf(seat.agent) })
  return (
    <span
      className={css.mono}
      data-colour={spec.colour}
      data-outside={spec.outside || undefined}
      {...label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}
    >
      {spec.letters}
      {spec.outside && <span className={css.arrow} aria-hidden>↗</span>}
    </span>
  )
}

/**
 * The state words of an outside agent; nothing for an ordinary subagent. "Waiting for you" is in words and in the
 * warning colour.
 * @param props - the row and the dictionary.
 * @returns the words, or null.
 */
export function RowWords(props: RowPartProps) {
  const { t, clock } = props
  const seat = seatOf(props.values)
  if (seat === undefined) return null
  const words = wordsOf(seat, waitingOf(props), clock)
  const text = words.key === 'row.limit'
    ? (words.time === undefined ? t('row.limitNoTime') : t('row.limit', { time: words.time }))
    : t(words.key)
  return (
    <span className={css.words} data-waiting={words.key === 'row.waiting' || undefined} data-limit={words.key === 'row.limit' || undefined}>
      {programOf(seat.agent)} · {text}
    </span>
  )
}

/**
 * The 5-hour ring (with its figure as text) and, while the agent waits for an answer, the Answer button that opens
 * its chat at the card.
 * @param props - the row and the dictionary.
 * @returns the indicator, or null.
 */
export function RowTrail(props: RowPartProps) {
  const { t } = props
  const seat = seatOf(props.values)
  if (seat === undefined) return null
  const ring = ringOf(seat)
  const agent = programOf(seat.agent)
  const waiting = waitingOf(props)
  const circumference = 2 * Math.PI * 7
  return (
    <span className={css.trail}>
      {waiting && (
        <button
          type="button"
          className={css.answer}
          aria-label={t('row.answer.aria', { label: props.label, agent })}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.open()
          }}
          onKeyDown={(event) => { event.stopPropagation() }}
        >
          {t('row.answer')}
        </button>
      )}
      {ring !== undefined && (
        <span
          className={css.ring}
          data-near={ring.near || undefined}
          data-reached={ring.reached || undefined}
          role="img"
          aria-label={ring.reached ? t('ring.reached.aria', { agent }) : t('ring.aria', { agent, percent: String(ring.percent) })}
        >
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
            <circle cx="9" cy="9" r="7" className={css.ringTrack} />
            <circle
              cx="9" cy="9" r="7" className={css.ringValue}
              strokeDasharray={`${String((ring.percent / 100) * circumference)} ${String(circumference)}`}
              transform="rotate(-90 9 9)"
            />
          </svg>
          <span className={css.ringText}>{t('ring.text', { percent: String(ring.percent) })}</span>
        </span>
      )}
    </span>
  )
}

/** Props of the trigger's addition. */
export type TriggerPartProps = SubagentTriggerOwner & { readonly t: ListsTranslate }

/**
 * "· 2 outside" after the trigger's "3 agents".
 * @param props - the direct rows and the dictionary.
 * @returns the addition, or null while no row runs outside Delorun.
 */
export function TriggerOutside({ rows, t }: TriggerPartProps) {
  const count = outsideCount(rows.map(row => seatOf(row.values)))
  if (count === 0) return null
  return <span className={css.outside}>{' · '}{t('trigger.outside', { count: String(count) })}</span>
}
