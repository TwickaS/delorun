/**
 * The frame of a Delorun `settings.general.item` row, laid out as upstream's
 * preference rows: the title, a one-line description and a failure line, then
 * the control beside them, or below them for a row of tiles.
 * @module @delorun/settings-controls/SettingRow
 */
import type { ReactNode } from 'react'
import css from './SettingRow.module.css'

/** The props of {@link SettingRow}. */
export interface SettingRowProps {
  /** The localized title. */
  readonly title: string
  /** The title element's id, for a control named by the title. */
  readonly titleId?: string | undefined
  /** The localized one-line description. */
  readonly description: string
  /** The localized failure report, shown as an alert while present. */
  readonly failure?: string | undefined
  /** Put the control below the text, across the row, as tiles need. */
  readonly stacked?: boolean | undefined
  /** Put the control below the text on a phone only, for a control too wide to sit beside the description. */
  readonly stackOnPhone?: boolean | undefined
  /** The control. */
  readonly children: ReactNode
}

/**
 * Render the row.
 * @param props - see {@link SettingRowProps}.
 * @returns the row.
 */
export function SettingRow({ title, titleId, description, failure, stacked, stackOnPhone, children }: SettingRowProps) {
  return (
    <div className={stacked === true ? `${css.row} ${css.stacked}` : stackOnPhone === true ? `${css.row} ${css.phoneStacked}` : css.row}>
      <div className={css.text}>
        <div id={titleId} className={css.title}>{title}</div>
        <div className={css.description}>{description}</div>
        {failure !== undefined && <div className={css.failure} role="alert">{failure}</div>}
      </div>
      {children}
    </div>
  )
}
