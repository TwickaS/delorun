/**
 * A dialog. It renders upstream's `Modal`, which owns the portal, the mask, Escape, the focus trap and the return of
 * focus, and puts the actions in its footer. A headless dialog draws the caller's own frame in the card instead, which
 * is what a notice or a pairing box needs.
 * @module @delorun/brand/components/Dialog
 */
import type { ReactNode } from 'react'
import { Modal } from '#upstream'

/** The props every {@link Dialog} takes. */
interface DialogBaseProps {
  readonly open: boolean
  /** Called for Escape, a click on the mask and the close button. */
  readonly onClose: () => void
  /** The localized heading, which also names the dialog. */
  readonly title: string
  readonly description?: string | undefined
  /** `warning` marks a dialog about something hard to undo. A headless dialog ignores it, because it draws no header. */
  readonly tone?: 'default' | 'warning'
  /** The body. Mark the control to focus first with `data-modal-autofocus`. */
  readonly children?: ReactNode
  /** The action row, usually a {@link Button} pair. A headless dialog ignores it. */
  readonly actions?: ReactNode
  /** A class for the dialog card itself, which a caller uses to size or place it. */
  readonly className?: string | undefined
  /** A class for the scrollable region around the header, the description and the body. A headless dialog draws none. */
  readonly contentClassName?: string | undefined
}

/**
 * The props of {@link Dialog}: a dialog with a header and an action row, or a headless one that draws the caller's own
 * frame and takes no close label.
 */
export type DialogProps = DialogBaseProps & (
  | { readonly headless: true; readonly closeLabel?: never }
  | { readonly headless?: false; readonly closeLabel: string }
)

/**
 * Render a dialog.
 * @param props - see {@link DialogProps}.
 * @returns the dialog, or nothing while it is closed.
 */
export function Dialog(props: DialogProps) {
  const { open, onClose, title, description, tone = 'default', children, actions, className, contentClassName } = props
  const shared = {
    open,
    onClose,
    title,
    ...(description === undefined ? {} : { description }),
    ...(className === undefined ? {} : { className }),
    ...(contentClassName === undefined ? {} : { contentClassName }),
  }
  if (props.headless === true) return <Modal {...shared} headless>{children}</Modal>
  return <Modal {...shared} closeLabel={props.closeLabel} footer={actions} {...(tone === 'warning' ? { tone } : {})}>{children}</Modal>
}
