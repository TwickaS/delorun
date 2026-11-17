/**
 * The dialog's pinned footer. The dialog owns the footer element; the screen that shows draws its buttons into it, so the
 * footer stays at the bottom while the body scrolls and each screen decides its own buttons.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './NewWorkspaceDialog.module.css'

/** Where the footer is drawn and the note it shows on the left. */
export interface FooterTarget {
  /** The footer's element; null until the dialog has mounted. */
  readonly element: HTMLElement | null
  /** The progress line at the footer's left, such as `Cloning site · 42 %`. */
  readonly note: string | undefined
}

/** The footer the screens draw into. */
export const FooterContext = createContext<FooterTarget>({ element: null, note: undefined })

/** One footer button. */
export interface FooterAction {
  /** Its text. */
  readonly label: string
  /** Press it. */
  readonly onClick: () => void
  /** Whether it cannot be pressed now. */
  readonly disabled?: boolean
}

/** The props of the footer. */
export interface DialogFooterProps {
  /** Back, or Cancel on the first screen; absent on a screen that only goes on. */
  readonly back?: FooterAction
  /** A secondary action between Back and the primary, such as Create now. */
  readonly extra?: FooterAction
  /** The primary action, at the right. */
  readonly primary: FooterAction
}

/**
 * Draw a screen's buttons in the dialog's footer.
 * @param props - the back, secondary and primary actions.
 * @returns the buttons, portalled into the footer.
 */
export function DialogFooter({ back, extra, primary }: DialogFooterProps): ReactNode {
  const { element, note } = useContext(FooterContext)
  if (element === null) return null
  return createPortal((
    <div className={css.buttons}>
      {note !== undefined && <p className={css.note} role="status">{note}</p>}
      <span className={css.spacer} />
      {back !== undefined && <Button variant="outline" className={css.button} disabled={back.disabled} onClick={back.onClick}>{back.label}</Button>}
      {extra !== undefined && <Button variant="outline" className={css.button} disabled={extra.disabled} onClick={extra.onClick}>{extra.label}</Button>}
      <Button variant="primary" className={css.button} disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Button>
    </div>
  ), element)
}
