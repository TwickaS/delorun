/**
 * A dialog. It renders upstream's `Modal`, which owns the portal, the mask, Escape, the focus trap and the return of
 * focus, and puts the actions in its footer.
 * @module @delorun/brand/components/Dialog
 */
import type { ReactNode } from 'react'
import { Modal } from '#upstream'

/** The props of {@link Dialog}. */
export interface DialogProps {
  readonly open: boolean
  /** Called for Escape, a click on the mask and the close button. */
  readonly onClose: () => void
  /** The localized heading, which also names the dialog. */
  readonly title: string
  /** The localized name of the close button. */
  readonly closeLabel: string
  readonly description?: string | undefined
  /** `warning` marks a dialog about something hard to undo. */
  readonly tone?: 'default' | 'warning'
  /** The body. Mark the control to focus first with `data-modal-autofocus`. */
  readonly children?: ReactNode
  /** The action row, usually a {@link Button} pair. */
  readonly actions?: ReactNode
}

/**
 * Render a dialog.
 * @param props - see {@link DialogProps}.
 * @returns the dialog, or nothing while it is closed.
 */
export function Dialog({ open, onClose, title, closeLabel, description, tone = 'default', children, actions }: DialogProps) {
  return <Modal open={open} onClose={onClose} title={title} closeLabel={closeLabel} footer={actions} {...(description === undefined ? {} : { description })} {...(tone === 'warning' ? { tone } : {})}>{children}</Modal>
}
