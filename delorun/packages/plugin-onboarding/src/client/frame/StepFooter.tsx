/**
 * The footer every step uses: Skip at the left, then Back, then the primary button. All three are 44px high and share
 * one hit-area rule. A step with nothing to skip, such as the last, passes no Skip.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import css from './frame.module.css'

/** One footer button. */
export interface FooterAction {
  /** Its text. */
  readonly label: string
  /** Press it. */
  readonly onClick: () => void
  /** Whether it cannot be pressed now. */
  readonly disabled?: boolean
  /** A token that moves focus to the button each time it changes to a value; the button persists between screens, so mounting alone is not a signal. */
  readonly focus?: string | undefined
}

/** The props of the footer. */
export interface StepFooterProps {
  /** Skip, where the step can be left for later. */
  readonly skip?: FooterAction
  /** Back, except on the first step. */
  readonly back?: FooterAction
  /** Continue, or Finish on the last step. */
  readonly next: FooterAction
}

/**
 * The footer's buttons.
 * @param props - the actions.
 * @returns the button row.
 */
export function StepFooter({ skip, back, next }: StepFooterProps): ReactNode {
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (next.focus !== undefined) primary.current?.focus({ preventScroll: true }) }, [next.focus])
  return (
    <div className={css.buttons}>
      {skip !== undefined && <Button variant="ghost" className={`${css.button} ${css.skip}`} disabled={skip.disabled} onClick={skip.onClick}>{skip.label}</Button>}
      <span className={css.spacer} />
      {back !== undefined && <Button variant="ghost" className={css.button} disabled={back.disabled} onClick={back.onClick}>{back.label}</Button>}
      <Button ref={primary} variant="primary" className={`${css.button} ${css.next}`} disabled={next.disabled} onClick={next.onClick}>{next.label}</Button>
    </div>
  )
}
