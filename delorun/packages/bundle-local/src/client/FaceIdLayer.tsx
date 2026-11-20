/**
 * The layer the Face ID sheet and the PIN keypad render in: a `<dialog>` opened with `showModal()`, so it sits in the
 * browser's top layer above every studio overlay, whatever their z-index, stacking context or the transform and overflow
 * of the element that renders it, and the page under it takes no taps. Keys pressed in it stop at the dialog in React's
 * tree, so a studio dialog under it neither closes on Escape nor pulls Tab's focus back. The explicit `dialog` role and
 * `aria-modal` keep it visible to the studio's open-modal lookup (`modalSelector`), which the shortcuts package checks
 * before running a page shortcut.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useSurfaceEdges } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FaceId.module.css'

/** Props of the layer. */
export interface FaceIdLayerProps {
  /** The id of the heading that names the dialog. */
  readonly labelledBy: string
  /** `data-*` attributes set on the dialog element. */
  readonly attributes: Readonly<Record<`data-${string}`, string>>
  /** Escape, or another close request the browser lets the page refuse; the layer stays open until its owner unmounts it. */
  readonly onEscape: () => void
  /** The browser closed the dialog itself, as Chrome does for a repeated close request with no tap between; the owner ends the confirmation. */
  readonly onClosed: () => void
  readonly children: ReactNode
}

/**
 * Render the layer.
 * @param props - see {@link FaceIdLayerProps}.
 * @returns the open dialog.
 */
export function FaceIdLayer({ labelledBy, attributes, onEscape, onClosed, children }: FaceIdLayerProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const handlers = useRef({ onEscape, onClosed })
  handlers.current = { onEscape, onClosed }
  useLayoutEffect(() => {
    const element = dialog.current
    if (element === null || element.open) return
    // The dialog takes focus itself: no control shows a focus ring on open, and opening the keypad does not focus its field and raise a phone's keyboard.
    element.setAttribute('autofocus', '')
    // jsdom has no showModal; there the dialog is only marked open.
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    element.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    let alive = true
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A handled Escape makes no close request, so the browser never reaches the close it does not let the page refuse.
      event.preventDefault()
      handlers.current.onEscape()
    }
    // Capture phase: a card that holds the layer stops Escape from bubbling to the document.
    document.addEventListener('keydown', escape, true)
    const element = dialog.current
    const closed = (): void => { if (alive) handlers.current.onClosed() }
    element?.addEventListener('close', closed)
    return () => {
      alive = false
      document.removeEventListener('keydown', escape, true)
      element?.removeEventListener('close', closed)
    }
  }, [])
  return <dialog ref={dialog} className={css.scrim} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...attributes}
    onCancel={(event) => { event.preventDefault(); handlers.current.onEscape() }} onKeyDown={(event) => { event.stopPropagation() }}>
    {children}
  </dialog>
}

/**
 * The sheet's card inside the layer, held on the edge stack while it shows, so the phone's bars take the scrim's tint.
 * @param props - the card's content.
 * @param props.children - the sheet or keypad panes.
 * @returns the card.
 */
export function FaceIdSheetBox({ children }: { readonly children: ReactNode }): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  useSurfaceEdges(card, true)
  return <div ref={card} className={css.sheet}>{children}</div>
}
