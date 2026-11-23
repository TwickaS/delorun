/**
 * A card for one thing the person can add or tick: a fixed icon slot, a title, a summary of up to two lines with the rest of a
 * long description behind "More", which sits under the summary, one action area and a state line under them. A card without artwork shows a tinted
 * letter tile, so every title in a list starts at the same place.
 */
import { CardIcon } from '@delorun/brand'
import type { ReactNode } from 'react'
import css from './ListRow.module.css'
import { Summary } from './Summary.tsx'

export { SUMMARY_LIMIT } from './Summary.tsx'

/** The props of the card. */
export interface CardProps {
  /** The title. */
  readonly title: string
  /** The icon's address; a monogram or a neutral glyph when absent. */
  readonly icon?: string | undefined
  /** The letters of a monogram tile, shown in the icon slot when there is no icon address. */
  readonly monogram?: string | undefined
  /** The description: its first line is the summary. */
  readonly description?: string | undefined
  /** Labels of the disclosure. */
  readonly labels: { readonly more: string; readonly less: string }
  /** A control before the icon, such as the tick of a list of choices. */
  readonly leading?: ReactNode
  /** The action area: a button or a mark. */
  readonly action?: ReactNode
  /** The state lines and other content under the card's row. */
  readonly children?: ReactNode
  /** Whether the card is chosen; the whole card is then outlined. */
  readonly selected?: boolean
}

/**
 * The tinted letter tile for something that has no logo here; brand's {@link CardIcon} draws it.
 * @param props - the name the tint comes from and, optionally, the letter to show and the side in pixels (32 by default).
 * @returns the tile, hidden from assistive technology because the title says the same.
 */
export function Monogram({ name, letters, size }: { readonly name: string; readonly letters?: string | undefined; readonly size?: number | undefined }): ReactNode {
  return <CardIcon name={name} letter={letters} size={size} />
}

/**
 * The card.
 * @param props - the title, icon, description, action and what sits under the row.
 * @returns the card.
 */
export function Card({ title, icon, monogram, description, labels, leading, action, children, selected = false }: CardProps): ReactNode {
  return (
    <div className={css.card} data-selected={selected || undefined}>
      <div className={css.row} data-described={description !== undefined || undefined}>
        {leading !== undefined && <span className={css.leading}>{leading}</span>}
        <span className={css.icon}>
          {icon !== undefined ? <img className={css.image} src={icon} alt="" /> : <Monogram name={title} letters={monogram} />}
        </span>
        <div className={css.text}>
          <h4 className={css.title}>{title}</h4>
          {description !== undefined && <Summary text={description} labels={labels} />}
        </div>
        {action !== undefined && <div className={css.action}>{action}</div>}
      </div>
      {children}
    </div>
  )
}
