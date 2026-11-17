/**
 * A step only the home's own computer can do, shown on a phone: it says plainly that it is done on the computer and
 * why. The dialog's "Do it on my computer" button records the step as deferred and goes on. One column at every width.
 */
import type { ReactNode } from 'react'
import type { StepServices } from '../types.ts'
import css from './steps.module.css'

/** The steps this body explains. */
export type ComputerOnlyId = 'pin'

/**
 * The body of a computer-only step.
 * @param props - the services and which step it explains.
 * @returns the lead, the reason and what the button does.
 */
export function ComputerOnlyStep({ services, id }: { readonly services: StepServices; readonly id: ComputerOnlyId }): ReactNode {
  const { t } = services
  return (
    <div className={css.stack} data-computer-only={id}>
      <p className={css.lead}>{t(`computer.lead.${id}`)}</p>
      <p className={css.hint}>{t(`computer.why.${id}`)}</p>
      <p className={css.hint}>{t('computer.how')}</p>
    </div>
  )
}
