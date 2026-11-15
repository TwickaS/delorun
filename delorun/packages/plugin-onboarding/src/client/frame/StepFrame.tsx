/**
 * The frame every onboarding step sits in: a pinned header with the step's name and its place in the flow, the one
 * scrolling body, and a pinned footer. The header, scroll and footer look the same at every width.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import css from './frame.module.css'
import scale from './tokens.module.css'

/** Sets the frame's footer, for a step that draws its own in place of the dialog's. */
const FooterSlot = createContext<(footer: ReactNode) => void>(() => {})

/**
 * Draw a step's own footer in the frame's pinned footer while the step shows.
 * @param props - the footer to draw.
 * @returns nothing; the footer appears in the frame.
 */
export function FooterPortal({ children }: { readonly children: ReactNode }): ReactNode {
  const set = useContext(FooterSlot)
  useEffect(() => { set(children) })
  useEffect(() => () => { set(null) }, [set])
  return null
}

/** The props of the frame. */
export interface StepFrameProps {
  /** The step's name, which is also the frame's heading. */
  readonly title: string
  /** The heading's ref, which takes focus when the step changes. */
  readonly headingRef: Ref<HTMLHeadingElement>
  /** The progress text, such as `Step 2 of 7`. */
  readonly count: string
  /** The step's place in the flow, 1-based. */
  readonly place: number
  /** How many steps the flow has. */
  readonly total: number
  /** Every step's name in order, for assistive technology; the header shows only the current one. */
  readonly steps: readonly string[]
  /** The steps list's accessible name. */
  readonly stepsLabel: string
  /** The step key, which resets the body's scroll and state when it changes. */
  readonly stepKey: string
  /** Closes the guide and keeps the progress; drawn quietly beside the heading. */
  readonly later?: { readonly label: string; readonly onClick: () => void }
  /** The dialog's footer; a step that draws its own passes nothing. */
  readonly footer?: ReactNode
  /** The step's body. */
  readonly children: ReactNode
}

/**
 * The step frame.
 * @param props - the step's name, place, body and footer.
 * @returns the frame.
 */
export function StepFrame({ title, headingRef, count, place, total, steps, stepsLabel, stepKey, later, footer, children }: StepFrameProps): ReactNode {
  const [own, setOwn] = useState<ReactNode>(null)
  return (
    <FooterSlot.Provider value={setOwn}>
      <div className={`${css.frame} ${scale.scale}`}>
        <header className={css.header}>
          <div className={css.titleRow}>
            <h2 ref={headingRef} tabIndex={-1} data-modal-autofocus className={css.heading}>{title}</h2>
            {later !== undefined && <button type="button" className={css.later} onClick={later.onClick}>{later.label}</button>}
          </div>
          <div className={css.progress}>
            <span className={css.count}>{count}</span>
            <span className={css.bar} role="progressbar" aria-label={count} aria-valuemin={1} aria-valuemax={total} aria-valuenow={place}>
              <span style={{ width: `${String((place / total) * 100)}%` }} />
            </span>
          </div>
          <nav className={css.visuallyHidden} aria-label={stepsLabel}>
            <ol>
              {steps.map((name, position) => (
                <li key={name} data-state={position + 1 < place ? 'done' : position + 1 === place ? 'current' : 'next'} aria-current={position + 1 === place ? 'step' : undefined}>{name}</li>
              ))}
            </ol>
          </nav>
        </header>
        <div className={css.scroll}>
          <div className={css.body} key={stepKey}>{children}</div>
        </div>
        <footer className={css.footer}>{footer ?? own}</footer>
      </div>
    </FooterSlot.Provider>
  )
}

/** The class the dialog's modal takes, for its size. */
export const DIALOG_CLASS: string = css.dialog as string
