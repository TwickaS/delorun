/**
 * A card for one thing the person can add or tick: a fixed icon slot, a title, a one-line summary with the rest of a
 * long description behind "More", one action area and a state line under them. A card without artwork shows a neutral
 * glyph, so every title in a list starts at the same place.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import css from './Card.module.css'

/** A description longer than this many characters is shortened to one line with the full text behind "More". */
export const SUMMARY_LIMIT = 72

/** The props of the card. */
export interface CardProps {
  /** The title. */
  readonly title: string
  /** The icon's address; a neutral glyph when absent. */
  readonly icon?: string | undefined
  /** The description: its first line is the summary. */
  readonly description?: string | undefined
  /** Labels of the disclosure. */
  readonly labels: { readonly more: string; readonly less: string }
  /** The action area: a button or a mark. */
  readonly action?: ReactNode
  /** The state lines and other content under the card's row. */
  readonly children?: ReactNode
  /** Whether the card is chosen; the whole card is then outlined. */
  readonly selected?: boolean
}

/** A neutral plugin glyph. */
function Glyph(): ReactNode {
  return (
    <svg className={css.glyph} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="9" height="9" rx="2" /><rect x="17" y="6" width="9" height="9" rx="2" />
      <rect x="6" y="17" width="9" height="9" rx="2" /><rect x="17" y="17" width="9" height="9" rx="2" />
    </svg>
  )
}

/**
 * The card.
 * @param props - the title, icon, description, action and what sits under the row.
 * @returns the card.
 */
export function Card({ title, icon, description, labels, action, children, selected = false }: CardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const long = description !== undefined && description.length > SUMMARY_LIMIT
  return (
    <div className={css.card} data-selected={selected || undefined}>
      <div className={css.row}>
        <span className={css.icon}>{icon === undefined ? <Glyph /> : <img className={css.image} src={icon} alt="" />}</span>
        <div className={css.text}>
          <h4 className={css.title}>{title}</h4>
          {description !== undefined && <p id={id} className={css.summary} data-open={open || undefined}>{description}</p>}
          {long && (
            <Button variant="ghost" size="sm" className={css.more} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open) }}>
              {open ? labels.less : labels.more}
            </Button>
          )}
        </div>
        {action !== undefined && <div className={css.action}>{action}</div>}
      </div>
      {children}
    </div>
  )
}
