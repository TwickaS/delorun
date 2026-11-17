/**
 * The modal layer of the upstream primitives, for a drawn studio that takes no focus and no keys: a dialog the chapter
 * script opens must not move the page's focus, swallow Tab or close on the page's Escape. The replica's build answers
 * the primitives' `./useModalLayer.ts` import with this module.
 * @module @delorun/website/replica/studio/modal-layer
 */
import type { RefObject } from 'react'

/** The selector upstream uses for dialogs and menus. */
export const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'

/**
 * Do nothing: the drawn studio's dialogs take no keyboard and move no focus.
 * @param _dialog - the dialog element.
 * @param _open - whether it is open.
 * @param _onClose - its close action.
 */
export function useModalLayer(_dialog: RefObject<HTMLElement | null>, _open: boolean, _onClose: () => void): void {}

/**
 * Whether an anchor sits behind a modal: never, since no dialog takes the keyboard.
 * @param _anchor - the anchor.
 * @returns false.
 */
export function isBehindModal(_anchor: HTMLElement | null): boolean {
  return false
}

/**
 * Close the top modal: nothing to close.
 * @param _document - the document.
 */
export function closeTopModal(_document: Document): void {}
