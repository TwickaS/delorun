/**
 * The original-look choice on the Look step: a quiet link (or, once chosen, a line with Change) and the screen it opens
 * inside the dialog. The screen says what the original look turns off and what stays, and asks. Choosing only records the
 * choice in the guide; the switch applies when the guide finishes.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useStore, type StepProps } from './shared.ts'
import css from './steps.module.css'

/** The Delorun additions the original look turns off, as locale key suffixes of `look.stock.off.<n>`. */
export const STOCK_OFF = [1, 2, 3, 4, 5, 6, 7] as const

/**
 * The quiet entry on the Look step.
 * @param props - the services and the guide.
 * @returns the link, or the line that says the original look is chosen.
 */
export function StockLookLink({ services, guide, disabled }: StepProps & { readonly disabled: boolean }): ReactNode {
  const { t } = services
  const chosen = useStore(guide.stock)
  return (
    <p className={css.hint}>
      {chosen ? `${t('look.stock.chosen')} · ` : `${t('look.stock.ask')} `}
      <Button className={css.stockLink} variant="ghost" size="sm" disabled={disabled} onClick={() => { guide.setStockScreen(true) }}>
        {chosen ? t('look.stock.change') : t('look.stock.open')}
      </Button>
    </p>
  )
}

/**
 * The screen: what the original look is, what you give up, what stays, when it applies and how to come back.
 * @param props - the services, the guide and what continues to the next step.
 * @returns the screen.
 */
export function StockLookScreen({ services, guide, next }: StepProps & { readonly next: () => void }): ReactNode {
  const { t } = services
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  const keep = (): void => { guide.setStock(false); guide.setStockScreen(false) }
  const confirm = (): void => { guide.setStock(true); guide.setStockScreen(false); next() }
  return (
    <div className={css.stack}>
      <Button className={css.stockLink} variant="ghost" size="sm" onClick={keep}>{t('look.stock.back')}</Button>
      <h4 ref={heading} tabIndex={-1} className={css.lead}>{t('look.stock.title')}</h4>
      <p className={css.lead}>{t('look.stock.what')}</p>
      <p className={css.lead}>{t('look.stock.off.lead')}</p>
      <ul className={css.stockList}>
        {STOCK_OFF.map(number => <li key={number}>{t(`look.stock.off.${number}`)}</li>)}
      </ul>
      <p className={css.lead}>{t('look.stock.stays')}</p>
      <p className={css.lead}>{t('look.stock.reason')}</p>
      <p className={css.hint}>{t('look.stock.when')}</p>
      <p className={css.hint}>{t('look.stock.return')}</p>
      <p className={css.lead}><strong>{t('look.stock.sure')}</strong></p>
      <div className={css.actions}>
        <Button variant="primary" onClick={confirm}>{t('look.stock.yes')}</Button>
        <Button variant="outline" onClick={keep}>{t('look.stock.no')}</Button>
      </div>
    </div>
  )
}
