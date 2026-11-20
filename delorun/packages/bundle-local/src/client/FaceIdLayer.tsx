/**
 * The layer the Face ID sheet and the PIN keypad render in: a `<dialog>` opened with `showModal()`, so it sits in the
 * browser's top layer above every studio overlay, whatever their z-index, stacking context or the transform and overflow
 * of the element that renders it, and the page under it takes no taps. Keys pressed in it stop at it: a studio dialog
 * under it neither closes on Escape nor pulls Tab's focus back, and no page shortcut runs. The explicit `dialog` role and
 * `aria-modal` keep it visible to the studio's open-modal lookup (`modalSelector`).
 */
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import css from './FaceId.module.css'

/** Props of the layer. */
export interface FaceIdLayerProps {
  /** The id of the heading that names the dialog. */
  readonly labelledBy: string
  /** `data-*` attributes set on the dialog element. */
  readonly attributes: Readonly<Record<`data-${string}`, string>>
  readonly children: ReactNode
}

/**
 * Render the layer.
 * @param props - see {@link FaceIdLayerProps}.
 * @returns the open dialog.
 */
export function FaceIdLayer({ labelledBy, attributes, children }: FaceIdLayerProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (element === null || element.open) return
    // The dialog takes focus itself, so opening the keypad does not focus its field and raise a phone's keyboard.
    element.setAttribute('autofocus', '')
    // jsdom has no showModal; there the dialog is only marked open.
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
  }, [])
  // Escape is handled by the sheet's own listener; the dialog never closes itself out of step with React.
  return <dialog ref={dialog} className={css.scrim} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...attributes}
    onCancel={(event) => { event.preventDefault() }} onKeyDown={(event) => { event.stopPropagation() }}>
    {children}
  </dialog>
}
