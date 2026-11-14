/**
 * A status row: an icon disc, a title with an optional detail line, and a pill that names the state.
 * @module @delorun/brand/components/StatusCard
 */
import type { NoticeIcon } from './Notice.tsx'
import { Pill } from './Pill.tsx'
import css from './StatusCard.module.css'

/** The props of {@link StatusCard}. */
export interface StatusCardProps {
  readonly Icon: NoticeIcon
  /** Whether the state is on; it colours the disc and the pill. */
  readonly on: boolean
  readonly title: string
  readonly detail?: string | undefined
  /** The localized name of the state. */
  readonly pill: string
  /** A `data-state` value on the title, which tests may select. */
  readonly titleAttribute?: string | undefined
}

/**
 * Render a status row.
 * @param props - see {@link StatusCardProps}.
 * @returns the row.
 */
export function StatusCard({ Icon, on, title, detail, pill, titleAttribute }: StatusCardProps) {
  return (
    <div className={css.status}>
      <span className={css.disc} data-on={on ? '' : undefined} aria-hidden="true"><Icon /></span>
      <div className={css.text}>
        <p className={css.title} data-state={titleAttribute}>{title}</p>
        {detail === undefined ? null : <p className={css.detail}>{detail}</p>}
      </div>
      <Pill tone={on ? 'accent' : 'neutral'}>{pill}</Pill>
    </div>
  )
}
