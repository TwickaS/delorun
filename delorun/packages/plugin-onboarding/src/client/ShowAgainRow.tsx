/**
 * The General row that opens onboarding again: its name, one sentence and a button.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import css from './ShowAgainRow.module.css'

/** What the row calls. */
export interface ShowAgainInjected {
  /** Close Settings and open onboarding from its first screen after the preview notice. */
  readonly show: () => void
}

/** The props of the row. */
export type ShowAgainRowProps = PropsLocale<'delorunOnboarding'> & InjectFace<ShowAgainInjected>

/**
 * Render the row.
 * @param props - this plugin's copy and the service.
 * @returns the row.
 */
export function ShowAgainRow({ t, show }: ShowAgainRowProps): ReactNode {
  return (
    <div className={css.row}>
      <div className={css.text}>
        <div className={css.title}>{t('row.title')}</div>
        <div className={css.description}>{t('row.description')}</div>
      </div>
      <Button variant="outline" size="sm" onClick={show}>{t('row.show')}</Button>
    </div>
  )
}
